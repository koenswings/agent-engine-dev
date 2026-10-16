/**
 * start-error-after-undock.test.ts: a start that fails after its disk was
 * ejected must leave the instance Undocked, not Error.
 *
 * r53 (Stage 2, idea03): a cross-engine copy started wyiqp7umpxrm6mq060e. While
 * the start was still running (compose up, then assertInstancePortReady), the
 * operator ejected its disk. The eject stopped the instance, set it Undocked and
 * unmounted the disk. Then the start resumed, its force-recreate hit ENOENT
 * (cwd /disks/sdb1/instances/... was gone), and startInstance's catch called
 * markInstanceError, which set Error unconditionally: Error overwrote Undocked.
 * runInstance's success path already skips the Running write when the disk was
 * undocked during compose up; the error path did not.
 *
 * Test: the real flow. The fixture disk is docked through the real USB monitor,
 * which auto-starts its instance with the real startInstance. `docker` is a fake
 * on PATH whose `compose up -d` blocks until the test releases it. While it
 * blocks, the real `ejectDisk` command runs (stopInstance → Undocked), the disk
 * folder is removed (what the unmount does), and then compose up is released
 * and fails. The instance must stay Undocked. A second test checks that a start
 * that fails on a docked disk still ends in Error.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// stopInstance (called by the eject) talks to Docker through node-docker-api: no containers here
vi.mock('node-docker-api', () => ({
    Docker: class { container = { list: async () => [] } },
}))

import os from 'os'
import path from 'path'
import { fs } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { CommandLogStore, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { config } from '../../src/data/Config.js'
import { commands } from '../../src/data/Commands.js'
import { markInstanceError, undockedReason, Instance } from '../../src/data/Instance.js'
import { Disk } from '../../src/data/Disk.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    FIXTURES_DIR, createTestStore, dockFixture, cleanupDisk, diskPath, sentinelPath, uniqueTestDevice, waitFor,
} from '../harness/diskSim.js'

const DISK_ID = 'test-fixture-sample-v1'
const INSTANCE_ID = 'sample-00000000-test1'

const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-fake-docker-'))
const bin = path.join(fakeDir, 'bin')
const marker = (name: string) => path.join(fakeDir, name)

/**
 * Fake docker: every call succeeds with no output, except `compose up -d`
 * (the first up, not --force-recreate):
 *   - `fail-now` present: fails at once (a start that fails on a docked disk);
 *   - otherwise: writes `up-started`, waits for `release`, then fails like
 *     compose does when its project folder is gone (ENOENT).
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
D="${fakeDir}"
echo "$PWD :: $*" >> "$D/calls.log"
if [ "$1" = "compose" ] && [ "$2" = "up" ] && [ "$3" = "-d" ] && [ -z "$4" ]; then
  if [ -e "$D/fail-now" ]; then echo "fake compose up failed" >&2; exit 1; fi
  touch "$D/up-started"
  for i in $(seq 1 300); do [ -e "$D/release" ] && break; sleep 0.1; done
  if [ ! -e "$PWD/compose.yaml" ]; then
    echo "open $PWD/compose.yaml: no such file or directory" >&2; exit 14
  fi
  echo "fake compose up failed after release" >&2; exit 1
fi
exit 0
`

const savedPath = process.env.PATH
const saved = { dockerAvailable: config.settings.dockerAvailable, skipImageLoad: config.settings.skipImageLoad }
let handle: DocHandle<Store>
let watcher: any

const startOpOf = (s: Store) =>
    Object.values(s.operationDB ?? {}).filter((o: any) => o.kind === 'startApp' && o.args?.instanceId === INSTANCE_ID)
const finishedStarts = (s: Store) => startOpOf(s).filter((o: any) => o.status === 'Failed' || o.status === 'Done')
const status = () => String(handle.doc()!.instanceDB[INSTANCE_ID as any]?.status)
const ejectDisk = commands.find(c => c.name === 'ejectDisk')!

const waitFile = async (p: string, ms = 20_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (fs.existsSync(p)) return true; await new Promise(r => setTimeout(r, 50)) }
    return false
}

beforeAll(async () => {
    fs.mkdirpSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 })
    process.env.PATH = `${bin}:${savedPath}`
    config.settings.dockerAvailable = false   // no docker ps / logs probes: only the start's own compose calls
    config.settings.skipImageLoad = true
    const repo = new Repo({ network: [], storage: undefined })
    setCommandLogHandle(repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] }))
    ;({ storeHandle: handle } = await createTestStore())
    watcher = await enableUsbDeviceMonitor(handle)
})

afterAll(async () => {
    process.env.PATH = savedPath
    config.settings.dockerAvailable = saved.dockerAvailable
    config.settings.skipImageLoad = saved.skipImageLoad
    await watcher?.close?.()
    await fs.remove(fakeDir)
})

describe('start fails after its disk was ejected mid-start (r53, Error must not overwrite Undocked)', () => {
    it('eject during compose up → the failing start leaves the instance Undocked', async () => {
        const device = uniqueTestDevice()
        try {
            await dockFixture(path.join(FIXTURES_DIR, 'disk-sample-v1'), device)
            // The dock auto-starts the instance with the real startInstance; it blocks in compose up
            expect(await waitFile(marker('up-started')), 'auto-start reached compose up').toBe(true)
            // createInstanceContainers already wrote Pauzed (containers created) before compose up
            expect(['Starting', 'Pauzed']).toContain(status())

            // The operator ejects the disk while the start is still running
            await ejectDisk.execute(handle, DISK_ID)
            expect(status(), 'eject moved the instance to Undocked').toBe('Undocked')
            expect(handle.doc()!.diskDB[DISK_ID as any]?.dockedTo ?? null).toBeNull()
            await fs.remove(diskPath(device))     // the unmount removes /disks/<dev> (testMode keeps the fixture)

            // The start resumes and fails (no project folder any more)
            fs.writeFileSync(marker('release'), '')
            expect(await waitFor(handle, s => finishedStarts(s).length > 0, 20_000), 'the start finished').toBe(true)
            expect(fs.readFileSync(marker('calls.log'), 'utf8')).toMatch(/compose up -d/)
            expect((finishedStarts(handle.doc()!)[0] as any).status).toBe('Failed')

            await new Promise(r => setTimeout(r, 300))   // any late store write
            expect(status(), 'Error must not overwrite Undocked').toBe('Undocked')
        } finally {
            await fs.remove(sentinelPath(device))
            await cleanupDisk(device)
            for (const m of ['up-started', 'release']) await fs.remove(marker(m))
        }
    }, 60_000)

    it('a start that fails while the disk stays docked still ends in Error', async () => {
        const device = uniqueTestDevice()
        fs.writeFileSync(marker('fail-now'), '')
        try {
            const before = finishedStarts(handle.doc()!).length
            await dockFixture(path.join(FIXTURES_DIR, 'disk-sample-v1'), device)
            expect(await waitFor(handle, s => finishedStarts(s).length > before, 20_000), 'the start finished').toBe(true)
            expect(await waitFor(handle, () => status() === 'Error', 5_000), `status ${status()}`).toBe(true)
            expect(handle.doc()!.diskDB[DISK_ID as any]?.dockedTo).toBeTruthy()
            expect(handle.doc()!.instanceDB[INSTANCE_ID as any]?.statusCondition).toBeTruthy()
        } finally {
            await fs.remove(marker('fail-now'))
            await fs.remove(sentinelPath(device))
            await cleanupDisk(device)
        }
    }, 60_000)
})

describe('markInstanceError guard (unit)', () => {
    const put = (diskDocked: boolean | 'gone', instStatus: string) => {
        const id = `guard-${Math.random().toString(36).slice(2, 8)}`
        handle.change((doc: any) => {
            if (diskDocked !== 'gone') doc.diskDB[`${id}-disk`] = { id: `${id}-disk`, name: 'd', device: diskDocked ? 'x' : null, dockedTo: diskDocked ? 'ENGINE_x' : null, diskTypes: [] }
            doc.instanceDB[id] = { id, name: id, storedOn: `${id}-disk`, status: instStatus, statusCondition: null }
        })
        return { inst: { id, name: id } as unknown as Instance, disk: { id: `${id}-disk` } as unknown as Disk }
    }
    const st = (id: string) => (handle.doc()!.instanceDB as any)[id]

    it.each([
        ['disk gone', 'gone' as const, 'Starting', /is gone/],
        ['disk not docked', false, 'Starting', /no longer docked/],
        ['instance already Undocked', true, 'Undocked', /already Undocked/],
    ])('%s → not marked Error, status unchanged', async (_n, docked, initial, reason) => {
        const { inst, disk } = put(docked, initial)
        expect(undockedReason(handle.doc()!, inst.id, disk.id)).toMatch(reason)
        expect(await markInstanceError(handle, inst, disk, new Error('spawn /usr/bin/bash ENOENT'))).toBe(false)
        expect(st(inst.id).status).toBe(initial)
        expect(st(inst.id).statusCondition).toBeNull()
    })

    it('disk docked, instance Starting → Error with a diagnosis (unchanged behaviour)', async () => {
        const { inst, disk } = put(true, 'Starting')
        expect(undockedReason(handle.doc()!, inst.id, disk.id)).toBeNull()
        expect(await markInstanceError(handle, inst, disk, new Error('compose up failed'))).toBe(true)
        expect(st(inst.id).status).toBe('Error')
        expect(st(inst.id).statusCondition).toBeTruthy()
    })
})
