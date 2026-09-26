/**
 * disk-detection.test.ts
 *
 * Verifies idea#82: USB disk detection failures are repaired or reported.
 *
 *   1. checkDiskDetection finds a missing/different udev rule, a missing watch
 *      folder and sd* devices without a watch-folder entry
 *   2. The startup self-check is skipped in test runs (IDEA_WATCH_DIR set), re-checks
 *      once, and reports only what is still wrong as one failed `diskDetection` trace
 *   3. recordDiskDetectionFailure writes a completed trace with status 'error'
 *   4. boot.sh's ensure_docking_rule reinstalls a missing or different rule and
 *      reloads + re-triggers udev, and does nothing when the rule is in place
 *   5. The monitor start, mount, META, dock, undock and watcher failures are wired
 *      to recordDiskDetectionFailure
 *
 * Everything runs in private temp folders: nothing touches /etc/udev, /dev/engine,
 * /sys or /disks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { $, fs } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import {
    checkDiskDetection,
    runDiskDetectionSelfCheck,
    recordDiskDetectionFailure,
    DiskDetectionPaths,
    DISK_DETECTION_COMMAND,
} from '../../src/monitors/diskDetection.js'

const ROOT = process.cwd()
const RULE_ASSET = path.join(ROOT, 'script/build_image_assets/90-docking.rules')
const BOOT_SH = path.join(ROOT, 'script/build_image_assets/boot.sh')
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const newCommandLog = (): DocHandle<CommandLogStore> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
}
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] =>
    h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])

/** A fake udev setup: rule, asset, watch folder and /sys/class/block, all in tmp. */
const makeFakeSystem = async (tmp: string, blockDevices: string[], watchEntries: string[]): Promise<DiskDetectionPaths> => {
    const paths: DiskDetectionPaths = {
        rulePath: path.join(tmp, 'etc/90-docking.rules'),
        ruleAsset: RULE_ASSET,
        watchDir: path.join(tmp, 'dev-engine'),
        sysBlockDir: path.join(tmp, 'sys-class-block'),
    }
    await fs.ensureDir(path.dirname(paths.rulePath))
    await fs.copy(RULE_ASSET, paths.rulePath)
    await fs.ensureDir(paths.watchDir)
    await fs.ensureDir(paths.sysBlockDir)
    for (const d of blockDevices) await fs.ensureDir(path.join(paths.sysBlockDir, d))
    for (const d of watchEntries) await fs.writeFile(path.join(paths.watchDir, d), '')
    return paths
}

let tmp: string
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-diskdet-')) })
afterEach(async () => { await fs.remove(tmp) })

describe('checkDiskDetection (idea#82)', () => {
    const block = ['sda', 'sda1', 'sda2', 'sdb', 'sdb1', 'sdc3', 'mmcblk0', 'mmcblk0p1', 'loop0']

    it('reports nothing when the rule is installed and every covered device has an entry', async () => {
        const paths = await makeFakeSystem(tmp, block, ['sda', 'sda1', 'sda2', 'sdb', 'sdb1'])
        expect(checkDiskDetection(paths)).toEqual([])
    })

    it('reports a missing udev rule', async () => {
        const paths = await makeFakeSystem(tmp, [], [])
        await fs.remove(paths.rulePath)
        expect(checkDiskDetection(paths)).toEqual([`udev rule ${paths.rulePath} is missing`])
    })

    it('reports a udev rule that differs from the shipped asset', async () => {
        const paths = await makeFakeSystem(tmp, [], [])
        await fs.writeFile(paths.rulePath, 'KERNEL=="sd?1", SYMLINK+="engine/%k"\n')
        expect(checkDiskDetection(paths)).toEqual([`udev rule ${paths.rulePath} differs from ${RULE_ASSET}`])
    })

    it('reports a missing watch folder', async () => {
        const paths = await makeFakeSystem(tmp, block, [])
        await fs.remove(paths.watchDir)
        expect(checkDiskDetection(paths)).toEqual([`${paths.watchDir} does not exist`])
    })

    it('reports covered sd* devices without a watch-folder entry (the empty /dev/engine case)', async () => {
        const paths = await makeFakeSystem(tmp, block, [])
        expect(checkDiskDetection(paths)).toEqual([`no ${paths.watchDir} entry for sda, sda1, sda2, sdb, sdb1`])
    })
})

describe('runDiskDetectionSelfCheck (idea#82)', () => {
    let savedWatchDir: string | undefined
    beforeEach(() => { savedWatchDir = process.env.IDEA_WATCH_DIR })
    afterEach(() => { process.env.IDEA_WATCH_DIR = savedWatchDir })

    it('is skipped in test runs (IDEA_WATCH_DIR is set)', async () => {
        expect(process.env.IDEA_WATCH_DIR).toBeTruthy()
        const paths = await makeFakeSystem(tmp, ['sda1'], [])
        await fs.remove(paths.rulePath)
        const handle = newCommandLog()
        let settled = 0
        const problems = await runDiskDetectionSelfCheck({ paths, handle, retryDelayMs: 0, settle: async () => { settled++ } })
        expect(problems).toEqual([])
        expect(settled).toBe(0)
        expect(traces(handle)).toEqual([])
    })

    it('reports what is still wrong after the re-check as one failed diskDetection trace', async () => {
        delete process.env.IDEA_WATCH_DIR
        const paths = await makeFakeSystem(tmp, ['sda1'], [])
        await fs.remove(paths.rulePath)
        const handle = newCommandLog()
        let settled = 0
        const problems = await runDiskDetectionSelfCheck({ paths, handle, retryDelayMs: 0, settle: async () => { settled++ } })
        expect(settled).toBe(2)
        expect(problems).toEqual([`udev rule ${paths.rulePath} is missing`, `no ${paths.watchDir} entry for sda1`])
        const t = traces(handle)
        expect(t).toHaveLength(1)
        expect(t[0].command).toBe(DISK_DETECTION_COMMAND)
        expect(t[0].status).toBe('error')
        expect(t[0].completedAt).not.toBeNull()
        expect(t[0].errorMessage).toContain('is missing')
        expect(JSON.parse(t[0].args).step).toBe('selfCheck')
    })

    it('reports nothing when the problem is repaired before the re-check (boot.sh still running)', async () => {
        delete process.env.IDEA_WATCH_DIR
        const paths = await makeFakeSystem(tmp, ['sda1'], [])
        await fs.remove(paths.rulePath)
        const handle = newCommandLog()
        let settled = 0
        const settle = async () => {
            settled++
            if (settled === 2) {
                await fs.copy(RULE_ASSET, paths.rulePath)
                await fs.writeFile(path.join(paths.watchDir, 'sda1'), '')
            }
        }
        expect(await runDiskDetectionSelfCheck({ paths, handle, retryDelayMs: 0, settle })).toEqual([])
        expect(traces(handle)).toEqual([])
    })
})

describe('recordDiskDetectionFailure (idea#82)', () => {
    it('adds a completed error trace with the step and details in args', () => {
        const handle = newCommandLog()
        recordDiskDetectionFailure('mount', 'Could not mount /dev/sdb1', { device: 'sdb1' }, handle)
        const [t] = traces(handle)
        expect(t.command).toBe('diskDetection')
        expect(t.status).toBe('error')
        expect(t.errorMessage).toBe('Could not mount /dev/sdb1')
        expect(JSON.parse(t.args)).toEqual({ step: 'mount', device: 'sdb1' })
    })

    it('only logs when there is no command log', () => {
        expect(() => recordDiskDetectionFailure('undock', 'x', {}, null)).not.toThrow()
    })
})

describe('boot.sh udev rule self-repair (idea#82)', () => {
    const boot = fs.readFileSync(BOOT_SH, 'utf8')
    const fn = boot.slice(
        boot.indexOf('# --- ensure_docking_rule: begin'),
        boot.indexOf('# --- ensure_docking_rule: end'),
    )

    // Run ensure_docking_rule with a fake udevadm that records its calls.
    const run = async (dst: string) => {
        const bin = path.join(tmp, 'bin')
        const calls = path.join(tmp, 'udevadm.calls')
        await fs.ensureDir(bin)
        await fs.writeFile(path.join(bin, 'udevadm'), `#!/bin/sh\necho "$*" >> ${calls}\n`, { mode: 0o755 })
        const script = path.join(tmp, 'ensure.sh')
        await fs.writeFile(script, `${fn}\nensure_docking_rule\n`)
        const out = await $({ env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKING_RULE_SRC: RULE_ASSET, DOCKING_RULE_DST: dst } })`bash ${script}`.nothrow()
        const udevadm = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []
        return { code: out.exitCode, udevadm }
    }

    it('runs on every boot, outside the first-boot block', () => {
        expect(fn).toContain('ensure_docking_rule()')
        const call = boot.indexOf('\nensure_docking_rule >>')
        expect(call).toBeGreaterThan(boot.indexOf('# This part runs on every boot'))
        expect(boot).toContain('DOCKING_RULE_SRC:-/home/pi/idea/agents/agent-engine-dev/script/build_image_assets/90-docking.rules')
    })

    it('reinstalls a missing rule, then reloads and re-triggers udev', async () => {
        const dst = path.join(tmp, 'rules.d/90-docking.rules')
        const r = await run(dst)
        expect(r.code).toBe(0)
        expect(fs.readFileSync(dst, 'utf8')).toBe(fs.readFileSync(RULE_ASSET, 'utf8'))
        expect(r.udevadm).toEqual(['control --reload', 'trigger'])
    })

    it('replaces a rule that differs from the shipped asset', async () => {
        const dst = path.join(tmp, 'rules.d/90-docking.rules')
        await fs.outputFile(dst, 'KERNEL=="sd?1", SYMLINK+="engine/%k"\n')
        const r = await run(dst)
        expect(r.code).toBe(0)
        expect(fs.readFileSync(dst, 'utf8')).toBe(fs.readFileSync(RULE_ASSET, 'utf8'))
        expect(r.udevadm).toEqual(['control --reload', 'trigger'])
    })

    it('leaves an identical rule alone and does not touch udev', async () => {
        const dst = path.join(tmp, 'rules.d/90-docking.rules')
        await fs.outputFile(dst, fs.readFileSync(RULE_ASSET, 'utf8'))
        const r = await run(dst)
        expect(r.code).toBe(0)
        expect(r.udevadm).toEqual([])
    })

    it('fails (non-zero) when the rule cannot be written, without reloading udev', async () => {
        const blocker = path.join(tmp, 'not-a-dir')
        await fs.writeFile(blocker, '')
        const r = await run(path.join(blocker, '90-docking.rules'))
        expect(r.code).not.toBe(0)
        expect(r.udevadm).toEqual([])
    })
})

describe('disk detection failures are reported, not only logged (idea#82)', () => {
    it('start.ts runs the self-check and catches a USB monitor start failure', () => {
        const start = src('src/start.ts')
        expect(start).toMatch(/runDiskDetectionSelfCheck\(\)\.catch\(/)
        expect(start).toMatch(/enableUsbDeviceMonitor\(storeHandle\)\.catch\(e =>\s*recordDiskDetectionFailure\('monitorStart'/)
        expect(start).not.toMatch(/^\s*enableUsbDeviceMonitor\(storeHandle\)\s*$/m)
    })

    it('usbDeviceMonitor.ts records mount, META, dock, undock and watcher failures', () => {
        const monitor = src('src/monitors/usbDeviceMonitor.ts')
        for (const step of ['mount', 'readMeta', 'dock', 'undock', 'watcher']) {
            expect(monitor, step).toContain(`recordDiskDetectionFailure('${step}'`)
        }
    })

    it('the self-check needs no root', () => {
        expect(src('src/monitors/diskDetection.ts')).not.toMatch(/sudo/)
    })
})
