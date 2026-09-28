/**
 * meta-first-dock.test.ts
 *
 * idea#121: a disk docked without META.yaml gets one written on its first dock,
 * so its diskId stays the same on every later dock. Before this fix a disk
 * without a readable hardware serial got a new random id on every dock and left
 * an orphan diskDB entry behind.
 *
 * testMode normally skips the write (skipMetaWrite() follows testMode, like
 * readMetaUpdateId). These tests set settings.skipMetaWrite = false to run the
 * real write on fixture disks without META.yaml.
 *
 * On a real Engine the mount roots under /disks are root:root, so META.yaml is
 * written with `sudo /usr/bin/tee /disks/<device>/META.yaml` (sudoers file
 * 11-engine-files). The sudo tests put a fake `sudo` first on PATH that records
 * the arguments and stdin it gets, so they prove the exact command line without
 * root and without touching /disks.
 *
 * Also unit-tests the orphan rule used by script/cleanup-store.ts.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import os from 'os'
import { fs, path, YAML } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { CommandLogStore, CommandTrace, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { config, skipMetaWrite } from '../../src/data/Config.js'
import { localEngineId } from '../../src/data/Engine.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import { DISK_DETECTION_COMMAND } from '../../src/monitors/diskDetection.js'
import { findOrphanDiskIds } from '../../script/cleanup-store-lib.js'
import { DiskMeta, SUDO_META_PATH, SUDO_TEE, writeMetaFile } from '../../src/data/Meta.js'
import { $ } from 'zx'
import {
    createTestStore,
    dockFixture,
    triggerUndock,
    cleanupDisk,
    waitFor,
    uniqueTestDevice,
    diskPath,
    sentinelPath,
} from '../harness/diskSim.js'

const newCommandLog = (): DocHandle<CommandLogStore> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
}
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] =>
    h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])

const disksOnDevice = (store: Store, device: string) =>
    Object.values(store.diskDB).filter(d => d.device === device && d.dockedTo === localEngineId)

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe('META.yaml is written on the first dock (idea#121)', () => {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>
    const logHandle = newCommandLog()
    const savedSkip = config.settings.skipMetaWrite
    const devices: string[] = []
    let fixtureDir = ''

    beforeAll(async () => {
        // A disk with some content but no META.yaml and no apps (no Docker needed)
        fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-121-fixture-'))
        await fs.writeFile(path.join(fixtureDir, 'README.txt'), 'A disk that was never docked before\n')
        config.settings.skipMetaWrite = false
        setCommandLogHandle(logHandle)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        watcher = await enableUsbDeviceMonitor(storeHandle)
    }, 15_000)

    afterAll(async () => {
        await watcher?.close()
        for (const device of devices) {
            await fs.remove(sentinelPath(device)).catch(() => {})
            await fs.chmod(diskPath(device), 0o755).catch(() => {})
            await cleanupDisk(device).catch(() => {})
        }
        if (fixtureDir) await fs.remove(fixtureDir).catch(() => {})
        setCommandLogHandle(null)
        config.settings.skipMetaWrite = savedSkip
    })

    it('skipMetaWrite() follows testMode unless settings.skipMetaWrite is set', () => {
        const saved = config.settings.skipMetaWrite
        try {
            config.settings.skipMetaWrite = undefined
            expect(skipMetaWrite()).toBe(config.settings.testMode)
            config.settings.skipMetaWrite = false
            expect(skipMetaWrite()).toBe(false)
            config.settings.skipMetaWrite = true
            expect(skipMetaWrite()).toBe(true)
        } finally {
            config.settings.skipMetaWrite = saved
        }
    })

    it('docking a fixture without META.yaml writes one', { timeout: 20_000 }, async () => {
        const device = uniqueTestDevice()
        devices.push(device)
        const metaPath = path.join(diskPath(device), 'META.yaml')

        await dockFixture(fixtureDir, device)
        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 1)).toBe(true)

        const disk = disksOnDevice(storeHandle.doc()!, device)[0]
        expect(fs.existsSync(metaPath)).toBe(true)
        const meta = YAML.parse(await fs.readFile(metaPath, 'utf-8'))
        expect(meta.diskId).toBe(disk.id)
        expect(meta.diskName).toBe(disk.name)
        expect(typeof meta.created).toBe('number')
    })

    it('a second dock of the same disk gives the same diskId', { timeout: 30_000 }, async () => {
        const device = uniqueTestDevice()
        devices.push(device)

        await dockFixture(fixtureDir, device)
        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 1)).toBe(true)
        const firstId = disksOnDevice(storeHandle.doc()!, device)[0].id

        await triggerUndock(device)
        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 0)).toBe(true)

        // Re-dock the same disk content (META.yaml written by the first dock stays)
        await fs.writeFile(sentinelPath(device), '')
        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 1)).toBe(true)
        const secondId = disksOnDevice(storeHandle.doc()!, device)[0].id

        expect(secondId).toBe(firstId)
        // No second diskDB entry for the same disk
        const store = storeHandle.doc()!
        const entries = Object.values(store.diskDB).filter(d => d.id === firstId)
        expect(entries).toHaveLength(1)
        expect(Object.keys(store.diskDB).filter(id => id === firstId)).toHaveLength(1)
    })

    it.skipIf(isRoot)('an unwritable fixture records a detection failure and is still registered', { timeout: 20_000 }, async () => {
        const device = uniqueTestDevice()
        devices.push(device)
        const target = diskPath(device)

        // Read-only disk (like a root-owned or read-only mount): content, no META.yaml
        await fs.ensureDir(target)
        await fs.copy(fixtureDir, target)
        await fs.chmod(target, 0o555)
        await fs.ensureDir(path.dirname(sentinelPath(device)))
        await fs.writeFile(sentinelPath(device), '')

        expect(await waitFor(storeHandle, s => disksOnDevice(s, device).length === 1)).toBe(true)
        expect(fs.existsSync(path.join(target, 'META.yaml'))).toBe(false)

        const failure = traces(logHandle).find(t => {
            if (t.command !== DISK_DETECTION_COMMAND) return false
            const args = JSON.parse(t.args)
            return args.step === 'writeMeta' && args.device === device
        })
        expect(failure, 'failed writeMeta trace').toBeDefined()
        expect(failure!.status).toBe('error')
        expect(failure!.errorMessage).toContain('Could not write META.yaml')
        const disk = disksOnDevice(storeHandle.doc()!, device)[0]
        expect(JSON.parse(failure!.args).diskId).toBe(disk.id)
    })
})

describe('cleanup-store orphan disk entries (idea#121)', () => {
    const base = { name: 'Unnamed Disk', created: 1, lastDocked: 1, diskTypes: [], backupConfig: null }

    it('only undocked, unreferenced, non-system, non-backup disks are orphans', () => {
        const store = {
            engineDB: { ENGINE_sys1: {} },
            diskDB: {
                orphan1: { ...base, id: 'orphan1', device: null, dockedTo: null },
                orphan2: { ...base, id: 'orphan2', device: null, dockedTo: null },
                docked: { ...base, id: 'docked', device: 'sda1', dockedTo: 'ENGINE_sys1' },
                sys1: { ...base, id: 'sys1', device: null, dockedTo: null },
                sysType: { ...base, id: 'sysType', device: null, dockedTo: null, diskTypes: ['system'] },
                withApp: { ...base, id: 'withApp', device: null, dockedTo: null },
                backup: { ...base, id: 'backup', device: null, dockedTo: null, backupConfig: { mode: 'copy', links: [] } },
                inOp: { ...base, id: 'inOp', device: null, dockedTo: null },
            },
            instanceDB: { i1: { storedOn: 'withApp' } },
            operationDB: { op1: { args: { targetDiskId: 'inOp' } } },
        }
        expect(findOrphanDiskIds(store).sort()).toEqual(['orphan1', 'orphan2'])
    })

    it('an empty store has no orphans', () => {
        expect(findOrphanDiskIds({})).toEqual([])
    })
})

describe('META.yaml under /disks is written with sudo tee (idea#121)', () => {
    const SUDOERS_11 = path.join(process.cwd(), 'script/build_image_assets/11-engine-files.sudoers')
    const meta = {
        diskId: 'test-disk-121', isHardwareId: false, diskName: 'Unnamed Disk',
        created: 1, lastDocked: 1,
    } as unknown as DiskMeta
    let binDir = ''
    let argsFile = ''
    let stdinFile = ''
    const savedPath = process.env.PATH
    const savedExit = process.env.FAKE_SUDO_EXIT

    beforeAll(async () => {
        // Fake sudo: records its arguments (one per line) and stdin, exits with FAKE_SUDO_EXIT
        binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-121-fake-sudo-'))
        argsFile = path.join(binDir, 'args')
        stdinFile = path.join(binDir, 'stdin')
        await fs.writeFile(path.join(binDir, 'sudo'),
            `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat > '${stdinFile}'\nexit \${FAKE_SUDO_EXIT:-0}\n`,
            { mode: 0o755 })
        process.env.PATH = `${binDir}:${savedPath}`
    })

    afterAll(async () => {
        process.env.PATH = savedPath
        if (savedExit === undefined) delete process.env.FAKE_SUDO_EXIT
        else process.env.FAKE_SUDO_EXIT = savedExit
        if (binDir) await fs.remove(binDir).catch(() => {})
    })

    const resetFake = async () => {
        await fs.remove(argsFile)
        await fs.remove(stdinFile)
        delete process.env.FAKE_SUDO_EXIT
    }
    const sudoArgs = async (): Promise<string[]> =>
        (await fs.readFile(argsFile, 'utf-8')).split('\n').slice(0, -1)

    // The command part of the single pi rule in 11-engine-files, as a regex
    // (sudo globbing: [..] is a character class, everything else is literal here).
    const sudoersCommand = (): string => {
        const rules = fs.readFileSync(SUDOERS_11, 'utf-8').split('\n').filter(l => /^\s*pi\s/.test(l))
        expect(rules).toHaveLength(1)
        const m = rules[0].match(/^pi ALL=\(root\) NOPASSWD: (.+)$/)
        expect(m, rules[0]).not.toBeNull()
        return m![1]
    }
    const globToRegex = (glob: string): RegExp =>
        new RegExp('^' + glob.split(/(\[[^\]]+\])/).map(part =>
            part.startsWith('[') ? part : part.replace(/[.*+?^${}()|\\/]/g, c => (c === '*' ? '.*' : '\\' + c))
        ).join('') + '$')

    it('a plain write as pi fails under /disks, the sudo tee path succeeds with the exact sudoers arguments', async () => {
        await resetFake()
        const target = '/disks/sdz1/META.yaml'
        // Without sudo the write fails: the folder is not the Engine user's
        // (on an Engine it is root:root; on a dev box /disks/sdz1 does not exist).
        const plain = await fs.writeFile(target, 'x').then(() => null, (e: NodeJS.ErrnoException) => e.code)
        expect(plain, 'plain write to /disks/sdz1 unexpectedly worked').not.toBeNull()

        await writeMetaFile(meta, target)

        const args = await sudoArgs()
        expect(args).toEqual(['/usr/bin/tee', '/disks/sdz1/META.yaml'])
        expect(args[0]).toBe(SUDO_TEE)
        expect(YAML.parse(await fs.readFile(stdinFile, 'utf-8'))).toEqual(meta)
        // What sudo sees matches the sudoers entry exactly
        expect(args.join(' ')).toMatch(globToRegex(sudoersCommand()))
    })

    it('11-engine-files has exactly the agreed entry, matching SUDO_META_PATH', async (ctx) => {
        expect(sudoersCommand()).toBe(`${SUDO_TEE} /disks/sd[a-z][12]/META.yaml`)
        const rule = globToRegex(sudoersCommand())
        for (const device of ['sda1', 'sda2', 'sdb1', 'sdz2']) {
            const p = `/disks/${device}/META.yaml`
            expect(SUDO_META_PATH.test(p), p).toBe(true)
            expect(`${SUDO_TEE} ${p}`, p).toMatch(rule)
        }
        for (const p of ['/disks/sda/META.yaml', '/disks/sda3/META.yaml', '/disks/old/sda1/META.yaml',
                         '/disks/sda1/META.yaml.bak', '/disks/sda1/x/META.yaml', '/tmp/disks/sda1/META.yaml']) {
            expect(SUDO_META_PATH.test(p), p).toBe(false)
            expect(`${SUDO_TEE} ${p}`, p).not.toMatch(rule)
        }
        const visudo = ['/usr/sbin/visudo', '/sbin/visudo'].find(p => fs.existsSync(p))
        if (!visudo) ctx.skip()
        const out = await $`${visudo} -cf ${SUDOERS_11}`.nothrow()
        expect(out.exitCode, out.stderr).toBe(0)
    })

    it('the path is normalised before matching, so the command still matches the entry', async () => {
        const calls: [string, string][] = []
        await writeMetaFile(meta, '/disks//sdb2/./META.yaml', async (p, c) => { calls.push([p, c]) })
        expect(calls).toHaveLength(1)
        expect(calls[0][0]).toBe('/disks/sdb2/META.yaml')
    })

    it('a failing sudo tee makes writeMetaFile throw (the monitor records writeMeta)', async () => {
        await resetFake()
        process.env.FAKE_SUDO_EXIT = '1'
        await expect(writeMetaFile(meta, '/disks/sdz2/META.yaml')).rejects.toThrow()
        delete process.env.FAKE_SUDO_EXIT
    })

    it('test and fixture roots (not /disks/sdXN) are written as pi without sudo', async () => {
        await resetFake()
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-121-root-'))
        try {
            const target = path.join(dir, 'sda1', 'META.yaml')
            await fs.ensureDir(path.dirname(target))
            await writeMetaFile(meta, target)
            expect(fs.existsSync(argsFile), 'sudo was called').toBe(false)
            expect(YAML.parse(await fs.readFile(target, 'utf-8'))).toEqual(meta)
            expect(fs.statSync(target).uid).toBe(process.getuid!())
        } finally {
            await fs.remove(dir)
        }
    })
})
