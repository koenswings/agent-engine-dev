/**
 * backup-scheduler.test.ts (idea#400 PR C): the 60 s tick and the scheduled run.
 *
 * Fake wall / monotonic / uptime clock (test/harness/fakeScheduleClock.ts) and a
 * fake runBackup that records results the way backupInstance does; one case runs
 * the real backupInstance with borg skipped. Wrong-clock cases live here only:
 * the Engine never runs NODE_ENV=test under pm2 (Steve, #346 call 3).
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os, YAML } from 'zx'
import { execFileSync } from 'node:child_process'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { BackupResultCode, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { recordBackupResult } from '../../src/data/BackupResults.js'
import { createOperation, recoverInterruptedOperations } from '../../src/data/Operations.js'
import { backupInstance, runCleanupTracked } from '../../src/monitors/backupMonitor.js'
import {
    BackupScheduler, SchedulerDeps, freePctOf, newestBackupTimeFor, isScheduledHere, RETRY_DELAY_MS, SCHEDULED_BACKUP_CAUSE,
} from '../../src/monitors/backupScheduler.js'
import { backupCleanupRunner } from '../../src/utils/backupCleanup.js'
import { parseBuildInfo, readBuildInfo } from '../../src/utils/buildInfo.js'
import { resourceLock, instanceKey, diskKey } from '../../src/utils/ResourceLock.js'
import { CommandLogStore, CommandTrace, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
import { fakeScheduleClock, FakeScheduleClock } from '../harness/fakeScheduleClock.js'
import { config } from '../../src/data/Config.js'

const A = 'sched-a' as InstanceID
const B = 'sched-b' as InstanceID
const BD = 'bd-sched' as DiskID
const AD = 'ad-sched' as DiskID
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

let backupDevice = ''
let appDevice = ''
let clock: FakeScheduleClock
let ntp = true
let buildTime: number | null = null
/** What the fake runBackup records per instance; default OK. A function gets the attempt number. */
let outcome: Record<string, BackupResultCode | ((n: number) => BackupResultCode)> = {}
let runs: { id: string, cause: string, at: number }[] = []
let sleeps: number[] = []
let logHandle: DocHandle<CommandLogStore>

const yamlPath = () => `${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`
const readYaml = async (): Promise<any> => YAML.parse(await fs.readFile(yamlPath(), 'utf-8'))
const slot = (dayOffset: number, h = 2, m = 30) => {
    const d = new Date(2026, 10, 13 + dayOffset, h, m, 0, 0)
    return d.getTime()
}
const yamlText = (o: { mode?: string, daily?: string | null, lastRun?: number | null, extra?: string } = {}) => [
    `mode: ${o.mode ?? 'scheduled'}`,
    ...(o.daily === null ? [] : [`schedule:`, `  daily: "${o.daily ?? '02:30'}"`]),
    'links:',
    `  - instanceId: ${A}`, '    lastBackup: 0',
    `  - instanceId: ${B}`, '    lastBackup: 0',
    ...(o.lastRun != null ? ['lastRun:', `  time: ${o.lastRun}`, '  uptimeS: 100', `  bootId: ${clock.bootId}`] : []),
    o.extra ?? '',
].join('\n') + '\n'

const deps = (over: Partial<SchedulerDeps> = {}): SchedulerDeps => ({
    wallMs: () => clock.wallMs,
    monoMs: () => clock.monoMs,
    uptimeS: () => clock.uptimeS,
    bootId: () => clock.bootId,
    ntpSynced: () => ntp,
    buildTimeMs: () => buildTime,
    diskUsage: async () => ({ totalBytes: 1000, freeBytes: 437 }),
    runBackup: async (h, id, _disk, cause) => {
        const n = runs.filter(r => r.id === id).length + 1
        runs.push({ id, cause, at: clock.wallMs })
        const o = outcome[id] ?? 'OK'
        recordBackupResult(h, id, 'stop', typeof o === 'function' ? o(n) : o, clock.wallMs)
    },
    sleep: async (ms) => { sleeps.push(ms) },
    ...over,
})

const newStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const h = repo.create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} })
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}

const makeDisk = (id: DiskID, device: string | null, backup: boolean, dockedTo: string = String(localEngineId)): Disk => ({
    id, name: `${id}-name` as DiskName, device: device as any, dockedTo: dockedTo as EngineID,
    created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: backup ? ['backup'] : ['app'],
    backupConfig: backup ? { mode: 'scheduled', links: [A, B], schedule: { daily: '02:30' }, scheduleError: null } : null,
})

const setup = async (o: { dockedTo?: string, mode?: 'scheduled' | 'immediate' } = {}) => {
    const h = await newStore()
    h.change(doc => {
        doc.diskDB[AD] = makeDisk(AD, appDevice, false)
        doc.diskDB[BD] = makeDisk(BD, backupDevice, true, o.dockedTo)
        if (o.mode) doc.diskDB[BD].backupConfig!.mode = o.mode
        for (const id of [A, B]) {
            doc.instanceDB[id] = {
                id, instanceOf: 'sample-app' as any, name: id as any, status: 'Stopped' as any, port: 8080 as any,
                serviceImages: [], created: 1 as Timestamp, lastBackup: null, lastStarted: 1 as Timestamp, statusCondition: null,
                storedOn: AD, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            } as any
        }
    })
    return h
}

/** Count store changes (storeHandle.change calls) made while fn runs. */
const countChanges = async (h: DocHandle<Store>, fn: () => Promise<void>): Promise<number> => {
    const spy = vi.spyOn(h, 'change')
    try {
        await fn()
        return spy.mock.calls.length
    } finally { spy.mockRestore() }
}

const tick = async (s: BackupScheduler) => { await s.tick(); await s.idle() }
const disk = (h: DocHandle<Store>) => h.doc()!.diskDB[BD]

let prevSkipBorg: boolean | undefined
beforeEach(async () => {
    prevSkipBorg = config.settings.skipBorg
    config.settings.skipBorg = true
    appDevice = uniqueTestDevice()
    do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
    await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${A}`)
    await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${B}`)
    for (const id of [A, B]) {
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${id}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${id}/config`, '[repository]\n')
    }
    clock = fakeScheduleClock(slot(0, 2, 29), 3 * HOUR / 1000)
    ntp = true
    buildTime = null
    outcome = {}
    runs = []
    sleeps = []
    const repo = new Repo({ network: [], storage: undefined })
    logHandle = repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
    setCommandLogHandle(logHandle)
})
afterEach(async () => {
    config.settings.skipBorg = prevSkipBorg
    vi.restoreAllMocks()
    setCommandLogHandle(null)
    resourceLock.releaseAll([diskKey(BD), instanceKey(A), instanceKey(B)])
    await fs.remove(`${DISKS_ROOT}/${appDevice}`)
    await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
})

describe('scheduled run on a trusted clock', () => {
    it('fires once at the slot, runs the links in turn with cause scheduled-backup, and claims the window on the disk', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1), extra: 'futureKey: kept' }))
        const h = await setup()
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)                       // 02:29: not due
        expect(runs).toEqual([])
        clock.advance(MIN)                  // 02:30
        await tick(s)
        expect(runs.map(r => `${r.id}:${r.cause}`)).toEqual([`${A}:${SCHEDULED_BACKUP_CAUSE}`, `${B}:${SCHEDULED_BACKUP_CAUSE}`])
        const y = await readYaml()
        expect(y.lastRun).toEqual({ time: slot(0), uptimeS: clock.uptimeS, bootId: clock.bootId })
        expect(y.lastAttempt).toBe(slot(0))
        expect(y.missedRuns).toBe(0)
        expect(y.uptimeCounter).toEqual({ bootId: clock.bootId, baseUptimeS: clock.uptimeS, seenUptimeS: clock.uptimeS, carriedS: 0 })
        expect(y.futureKey).toBe('kept')
        const d = disk(h)
        expect(d.lastAttempt).toBe(slot(0))
        expect(d.missedRuns).toBe(0)
        expect(d.freePct).toBe(44)
        expect(d.clockTrusted).toBe(true)
        expect(d.clockReason).toBeNull()
        for (let i = 0; i < 5; i++) { clock.advance(MIN); await tick(s) }
        expect(runs).toHaveLength(2)        // no second run in the same window
    })

    it('a tick with nothing to do writes nothing to the store; a run is one summary change plus one result per instance', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)                       // first tick sets clockTrusted (a change of value)
        expect(await countChanges(h, async () => { for (let i = 0; i < 3; i++) { await tick(s) } })).toBe(0)
        clock.advance(MIN)
        expect(await countChanges(h, () => tick(s))).toBe(2 + 1)
        expect(await countChanges(h, async () => { clock.advance(MIN); await tick(s) })).toBe(0)
    })

    it('after missed days the overdue run happens once and missedRuns counts the skipped slots', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-3) }))
        const h = await setup()
        clock = fakeScheduleClock(slot(0, 9, 0), 3600)
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        expect(runs).toHaveLength(2)
        expect((await readYaml()).missedRuns).toBe(2)
        expect(disk(h).missedRuns).toBe(2)
        clock.advance(MIN); await tick(s)
        expect(runs).toHaveLength(2)
    })

    it('a disk docked to another Engine, or not in scheduled mode, never runs', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        clock.advance(MIN)
        const other = await setup({ dockedTo: 'some-other-engine' })
        await tick(new BackupScheduler(other, deps(), localEngineId))
        const immediate = await setup({ mode: 'immediate' })
        await tick(new BackupScheduler(immediate, deps(), localEngineId))
        expect(runs).toEqual([])
        expect(isScheduledHere(other.doc()!.diskDB[BD], String(localEngineId))).toBe(false)
        expect(other.doc()!.diskDB[BD].clockTrusted ?? null).toBeNull()
    })

    it('an invalid schedule runs at the 02:30 default and is shown as backupConfig.scheduleError until fixed (#347 call 5, #351 call 1)', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1), daily: '25:99' }))
        const h = await setup()
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)                                   // 02:29: the default slot is not due yet
        expect(runs).toEqual([])
        expect(disk(h).backupConfig?.schedule).toBeNull()
        expect(disk(h).backupConfig?.scheduleError).toMatch(/^BAD_TIME: '25:99'/)
        clock.advance(MIN); await tick(s)               // 02:30: runs at the default
        expect(runs).toHaveLength(2)
        expect(disk(h).backupConfig?.scheduleError).toMatch(/^BAD_TIME: '25:99'/)
        await fs.writeFile(yamlPath(), (await fs.readFile(yamlPath(), 'utf-8')).replace('"25:99"', '"03:00"'))
        clock.advance(MIN); await tick(s)
        expect(disk(h).backupConfig?.scheduleError).toBeNull()
        expect(disk(h).backupConfig?.schedule).toEqual({ daily: '03:00' })
        expect(runs).toHaveLength(2)                    // 03:00 today is after this run's 02:30 slot: next at 03:00
        clock.advance(30 * MIN); await tick(s)
        expect(runs).toHaveLength(4)
    })

    it('Engine restarts after the slot: the catch-up is worked out from the stored lastRun and runs once (#351 call 8)', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        // the Engine was down across 02:30 and comes back at 04:10 (after the 05:00-style reboot pattern, any time works)
        clock.advance(100 * MIN)
        clock.reboot()
        let s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        expect(runs).toHaveLength(2)                    // one catch-up for the missed window
        expect((await readYaml()).missedRuns).toBe(0)
        clock.advance(MIN); await tick(s)
        expect(runs).toHaveLength(2)
        // a second restart inside the same window: lastRun on the disk says it ran, so no second run
        clock.reboot()
        s = new BackupScheduler(h, deps(), localEngineId)
        for (let i = 0; i < 3; i++) { await tick(s); clock.advance(MIN) }
        expect(runs).toHaveLength(2)
    })

    it('a restart in the middle of a run never runs that window again (lastRun is claimed at the start)', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        clock.advance(MIN)
        // the first instance's backup "crashes the Engine": the run never finishes
        const crashing = new BackupScheduler(h, deps({ runBackup: (_h, id) => { runs.push({ id, cause: 'x', at: clock.wallMs }); return new Promise<void>(() => {}) } }), localEngineId)
        await crashing.tick()                           // the run hangs in A's backup; the Engine then "dies"
        await new Promise(r => setTimeout(r, 50))
        expect((await readYaml()).lastRun.time).toBe(slot(0))
        clock.advance(MIN); clock.reboot()
        const runsBefore = runs.length
        expect(runsBefore).toBe(1)
        const s = new BackupScheduler(h, deps(), localEngineId)
        for (let i = 0; i < 3; i++) { await tick(s); clock.advance(MIN) }
        expect(runs.length).toBe(runsBefore)
    })
})

describe('locks, retry and catch-up (Steve, Q2 / Q3)', () => {
    it('SKIPPED_LOCKED catches up once when the lock frees, in the same window only', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        outcome[A] = () => resourceLock.isLocked(instanceKey(A)) ? 'SKIPPED_LOCKED' : 'OK'
        expect(resourceLock.acquire(instanceKey(A), 'restoreApp')).toBe(true)
        clock.advance(MIN)
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        expect(h.doc()!.instanceDB[A].lastResult?.result).toBe('SKIPPED_LOCKED')
        expect(h.doc()!.instanceDB[B].lastResult?.result).toBe('OK')
        clock.advance(MIN); await tick(s)
        expect(runs.filter(r => r.id === A)).toHaveLength(1)     // still locked: no catch-up yet
        resourceLock.release(instanceKey(A))
        clock.advance(MIN); await tick(s)
        expect(runs.filter(r => r.id === A)).toHaveLength(2)     // the one catch-up
        expect(runs.filter(r => r.id === B)).toHaveLength(1)
        expect(h.doc()!.instanceDB[A].lastResult?.result).toBe('OK')
        clock.advance(MIN); await tick(s)
        expect(runs).toHaveLength(3)
    })

    it('a catch-up is used once: skipped again, it waits for the next slot; the next window starts afresh', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        let lockedNow = true
        outcome[A] = () => lockedNow ? 'SKIPPED_LOCKED' : 'OK'
        clock.advance(MIN)
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        lockedNow = true
        clock.advance(MIN); await tick(s)                        // lock is free (nothing holds it), result is SKIPPED again
        expect(runs.filter(r => r.id === A)).toHaveLength(2)
        clock.advance(MIN); await tick(s)
        expect(runs.filter(r => r.id === A)).toHaveLength(2)     // catch-up used
        lockedNow = false
        clock.advance(DAY - 2 * MIN); await tick(s)              // next day's slot (02:30)
        expect(runs.filter(r => r.id === A)).toHaveLength(3)
        expect(s.skippedFor(BD).size).toBe(0)
    })

    it('a FAILED attempt is retried once after the delay; a second failure waits for the next slot', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        outcome[A] = 'FAILED'
        outcome[B] = (n) => n === 1 ? 'FAILED' : 'OK'
        clock.advance(MIN)
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        expect(sleeps).toEqual([RETRY_DELAY_MS])
        expect(runs.map(r => r.id)).toEqual([A, B, A, B])
        expect(h.doc()!.instanceDB[B].lastResult?.result).toBe('OK')
        expect(h.doc()!.instanceDB[A].backupHistory?.map(x => x.result)).toEqual(['FAILED', 'FAILED'])
        for (let i = 0; i < 3; i++) { clock.advance(MIN); await tick(s) }
        expect(runs).toHaveLength(4)
    })

    it('no retry for BACKUP_DISK_FULL, HELPER_OUTDATED or APP_DISK_NOT_DOCKED', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        outcome[A] = 'BACKUP_DISK_FULL'
        outcome[B] = 'APP_DISK_NOT_DOCKED'
        clock.advance(MIN)
        await tick(new BackupScheduler(h, deps(), localEngineId))
        expect(runs.map(r => r.id)).toEqual([A, B])
        expect(sleeps).toEqual([])
    })

    it('a stale lock is never retried: that instance is left to clearBackupLock + backupApp (idea#446), the others run', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${A}/.backup-in-progress`, JSON.stringify({ instanceId: A, startedAt: 1 }))
        const h = await setup()
        clock.advance(MIN)
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        expect(runs.map(r => r.id)).toEqual([B])
        clock.advance(MIN); await tick(s)
        expect(runs.map(r => r.id)).toEqual([B])
    })

    it('a manual backupApp while a scheduled backup holds the locks is refused with BUSY naming the scheduled run (Q4)', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        createOperation(h, 'backupApp', { instanceId: B, backupDiskId: BD }, SCHEDULED_BACKUP_CAUSE, { type: 'instance', id: B })
        // the operation is Pending; runningBackupOnDisk counts Pending and Running
        expect(resourceLock.acquireAll([instanceKey(B), diskKey(BD)], 'backupApp')).toBe(true)
        await backupInstance(h, A, h.doc()!.diskDB[BD] as Disk, undefined, 'console-command')
        const t = logHandle.doc()!.recentTraceIds.map(id => logHandle.doc()!.traces[id]).find((x: CommandTrace) => x.command === 'backupApp')
        expect(t?.errorMessage).toMatch(/^BUSY: .*a scheduled backup is running on this Backup Disk$/)
        expect(h.doc()!.instanceDB[A].lastResult ?? null).toBeNull()
    })
})

describe('clock trust and the uptime path (fake clock only)', () => {
    it('never synced: NEVER_SYNCED, no clock-based run; 24 h of uptime across a reboot runs once', async () => {
        ntp = false
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1), extra: [
            'uptimeCounter:', `  bootId: ${clock.bootId}`, `  baseUptimeS: ${clock.uptimeS - 10 * 3600}`, `  seenUptimeS: ${clock.uptimeS}`, '  carriedS: 0',
        ].join('\n') }))
        const h = await setup()
        clock.advance(MIN)
        let s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        expect(runs).toEqual([])
        expect(disk(h).clockTrusted).toBe(false)
        expect(disk(h).clockReason).toBe('NEVER_SYNCED')
        // 13 h more on this boot, then the 05:00-style reboot: 23 h counted, not due
        clock.advance(13 * HOUR); await tick(s)
        expect((await readYaml()).uptimeCounter.seenUptimeS).toBe(clock.uptimeS)   // persisted hourly
        clock.reboot()
        s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        expect(runs).toEqual([])
        const y = await readYaml()
        expect(y.uptimeCounter.bootId).toBe(clock.bootId)
        expect(y.uptimeCounter.carriedS).toBeGreaterThanOrEqual(23 * 3600)
        clock.advance(HOUR + MIN); await tick(s)
        expect(runs).toHaveLength(2)
        expect((await readYaml()).uptimeCounter.carriedS).toBe(0)                 // reset by the run
        clock.advance(MIN); await tick(s)
        expect(runs).toHaveLength(2)
    })

    it('a clock before the build commit time is BEFORE_BUILD and the slot does not fire', async () => {
        buildTime = slot(30)
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        clock.advance(MIN)
        await tick(new BackupScheduler(h, deps(), localEngineId))
        expect(disk(h).clockReason).toBe('BEFORE_BUILD')
        expect(runs).toEqual([])
    })

    it('without NTP, a clock before the newest backup timestamp is BEFORE_STORE and the slot does not fire', async () => {
        ntp = false
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        h.change(doc => { doc.instanceDB[A].lastBackup = (slot(0) + 7 * MIN) as Timestamp })
        expect(newestBackupTimeFor(h.doc()!, disk(h))).toBe(slot(0) + 7 * MIN)
        clock.advance(MIN)                                          // 02:30, newest backup 02:37
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        expect(disk(h).clockReason).toBe('BEFORE_STORE')
        expect(runs).toEqual([])
        clock.advance(3 * MIN); await tick(s)                       // 02:33: within the 5 min tolerance, BEFORE_STORE gone; NEVER_SYNCED
        expect(disk(h).clockReason).toBe('NEVER_SYNCED')
        expect(runs).toEqual([])
    })

    it('NTP-synchronized clears BEFORE_STORE: the slot fires (Steve, #351 call 6)', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        h.change(doc => { doc.instanceDB[A].lastBackup = (slot(0) + 3 * HOUR) as Timestamp })
        clock.advance(MIN)
        await tick(new BackupScheduler(h, deps(), localEngineId))
        expect(disk(h).clockTrusted).toBe(true)
        expect(disk(h).clockReason).toBeNull()
        expect(runs).toHaveLength(2)
    })

    it('a backward jump after a run never runs again: CLOCK_JUMP until NTP confirms, and lastRun is stale', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        clock.advance(MIN)
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        expect(runs).toHaveLength(2)
        ntp = false                                                   // the step happens while NTP no longer confirms
        clock.advance(MIN); clock.jumpWall(-2 * DAY)
        for (let i = 0; i < 3; i++) { await tick(s); clock.advance(MIN) }
        expect(disk(h).clockTrusted).toBe(false)
        expect(disk(h).clockReason).toBe('CLOCK_JUMP')                // NTP was seen this boot, so not BEFORE_STORE (#351 call 6)
        clock.advance(12 * HOUR)                                      // the old day's slot passes again: still no run
        await tick(s)                                                 // (only 24 h of uptime would allow one, by design)
        expect(runs).toHaveLength(2)
        ntp = true                                                    // trusted again, but lastRun lies in the future: stale, no run
        clock.advance(MIN); await tick(s)
        expect(disk(h).clockTrusted).toBe(true)
        expect(runs).toHaveLength(2)
    })

    it('a forward jump marks CLOCK_JUMP until the next sync, then trust returns; no extra run', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        clock.advance(MIN)
        const s = new BackupScheduler(h, deps(), localEngineId)
        await tick(s)
        ntp = false
        clock.advance(MIN); clock.jumpWall(3 * HOUR)
        await tick(s)
        expect(disk(h).clockReason).toBe('CLOCK_JUMP')
        clock.advance(MIN); await tick(s)
        expect(disk(h).clockReason).toBe('CLOCK_JUMP')
        ntp = true
        clock.advance(MIN); await tick(s)
        expect(disk(h).clockTrusted).toBe(true)
        expect(disk(h).clockReason).toBeNull()
        expect(runs).toHaveLength(2)
    })

    it('trust changes write clockTrusted / clockReason once per change', async () => {
        clock = fakeScheduleClock(slot(0, 3, 0), 3600)
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(0) }))
        const h = await setup()
        ntp = false
        const s = new BackupScheduler(h, deps(), localEngineId)
        expect(await countChanges(h, () => tick(s))).toBe(1)
        expect(await countChanges(h, async () => { clock.advance(MIN); await tick(s) })).toBe(0)
        ntp = true
        expect(await countChanges(h, async () => { clock.advance(MIN); await tick(s) })).toBe(1)
        expect(disk(h).clockTrusted).toBe(true)
    })
})

describe('real backupInstance, crash recovery, helpers', () => {
    it('the scheduler runs the real backupInstance (borg skipped): OK results and backupApp ops with cause scheduled-backup', async () => {
        await fs.writeFile(yamlPath(), yamlText({ lastRun: slot(-1) }))
        const h = await setup()
        clock.advance(MIN)
        const real = deps({ runBackup: (hh, id, d, cause) => backupInstance(hh, id, d, undefined, cause) })
        await tick(new BackupScheduler(h, real, localEngineId))
        expect(h.doc()!.instanceDB[A].lastResult?.result).toBe('OK')
        expect(h.doc()!.instanceDB[B].lastResult?.result).toBe('OK')
        const ops = Object.values(h.doc()!.operationDB ?? {}).filter((o: any) => o.kind === 'backupApp') as any[]
        expect(ops.map(o => `${o.cause}:${o.status}`).sort()).toEqual([`${SCHEDULED_BACKUP_CAUSE}:Done`, `${SCHEDULED_BACKUP_CAUSE}:Done`])
        const y = await readYaml()
        expect(y.lastRun.time).toBe(slot(0))
        expect(y.links.every((l: any) => l.lastBackup > 0)).toBe(true)
    })

    it('crash recovery never retries a scheduled backup; it is marked INTERRUPTED and left to idea#446', async () => {
        const h = await setup()
        const opId = createOperation(h, 'backupApp', { instanceId: A, backupDiskId: BD }, SCHEDULED_BACKUP_CAUSE, { type: 'instance', id: A })
        const manualId = createOperation(h, 'backupApp', { instanceId: B, backupDiskId: BD }, 'console-command', { type: 'instance', id: B })
        h.change(doc => { doc.operationDB![opId].status = 'Running'; doc.operationDB![manualId].status = 'Running' })
        const handler = vi.fn(async (_args: Record<string, string>) => {})
        await recoverInterruptedOperations(h, { backupApp: handler }, localEngineId)
        expect(handler).toHaveBeenCalledTimes(1)                       // only the manual one (existing behaviour)
        expect(handler.mock.calls[0][0]).toMatchObject({ instanceId: B })
        const op = h.doc()!.operationDB![opId]
        expect(op.status).toBe('Failed')
        expect(op.error).toMatch(/^INTERRUPTED: .*scheduled backup — not retried/)
    })

    it('runCleanupTracked sets Disk.cleaning only while archives are deleted', async () => {
        const h = await setup()
        const seen: (boolean | null | undefined)[] = []
        vi.spyOn(backupCleanupRunner, 'run').mockImplementation(async (opts) => {
            opts.onDeleteStart?.()
            seen.push(h.doc()!.diskDB[BD].cleaning)
            return { status: 'ok', deleted: [{ instanceId: A, archive: 'x' }], compacted: true }
        })
        await runCleanupTracked(h, BD, { backupDevice, mountRoot: '/x', currentInstanceId: A, phase: 'before' })
        expect(seen).toEqual([true])
        expect(disk(h).cleaning).toBe(false)
        expect(typeof disk(h).cleaningStartedAt).toBe('number')
        vi.spyOn(backupCleanupRunner, 'run').mockImplementation(async () => ({ status: 'ok', deleted: [], compacted: false }))
        const h2 = await setup()
        expect(await countChanges(h2, async () => { await runCleanupTracked(h2, BD, { backupDevice, mountRoot: '/x', currentInstanceId: A, phase: 'after' }) })).toBe(0)
    })

    it('freePctOf rounds; an unknown size is null', () => {
        expect(freePctOf({ totalBytes: 1000, freeBytes: 437 })).toBe(44)
        expect(freePctOf({ totalBytes: 0, freeBytes: 0 })).toBeNull()
    })

    it('build info: the build script writes the git commit time; a missing or bad file gives null', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-info-'))
        try {
            const out = path.join(dir, 'build-info.json')
            execFileSync('node', ['script/write-build-info.mjs', out], { stdio: 'ignore' })
            const info = readBuildInfo(out)
            const ct = Number(execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], { encoding: 'utf8' }).trim()) * 1000
            expect(info?.commitTimeMs).toBe(ct)
            expect(info?.commit).toMatch(/^[0-9a-f]{40}$/)
            expect(readBuildInfo(path.join(dir, 'missing.json'))).toBeNull()
            expect(parseBuildInfo({ commit: 'abc', commitTimeMs: 1 })).toBeNull()
            expect(parseBuildInfo({ commit: 'a'.repeat(40), commitTimeMs: -5 })).toBeNull()
            // a bare file name (no directory part) is written in the working directory, not made a directory
            execFileSync('node', [path.resolve('script/write-build-info.mjs'), 'bare-build-info.json'], { stdio: 'ignore', cwd: dir, env: { ...process.env, GIT_DIR: path.resolve('.git') } })
            expect(readBuildInfo(path.join(dir, 'bare-build-info.json'))?.commitTimeMs).toBe(ct)
        } finally {
            await fs.remove(dir)
        }
    })
})
