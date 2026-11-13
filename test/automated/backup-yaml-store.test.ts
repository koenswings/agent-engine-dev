/**
 * backup-yaml-store.test.ts (idea#400 PR B)
 *
 *  - BackupYamlDoc: document-preserving BACKUP.yaml edits (link lastBackup, the
 *    scheduled-run state keys), the lenient state reader, atomic write.
 *  - BackupResults: lastResult / backupHistory (newest 7, trimmed in place) and the
 *    result-code mapping.
 *  - backupInstance writes a result per attempt (OK, BUSY refusal with no result,
 *    SKIPPED_LOCKED for an automatic trigger, APP_DISK_NOT_DOCKED, FAILED), and its
 *    BACKUP.yaml update keeps schedule / lastRun / unknown keys.
 *  - processBackupDisk mirrors schedule / missedRuns / lastAttempt and records a
 *    stale lock as INTERRUPTED once; createBackupDisk adds the 02:30 default.
 *
 * testMode: borg is skipped; store, BACKUP.yaml, lock files and traces are real.
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { BACKUP_HISTORY_LENGTH, BackupResult, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { backupInstance, processBackupDisk, createBackupDiskConfig } from '../../src/monitors/backupMonitor.js'
import { resourceLock, diskKey } from '../../src/utils/ResourceLock.js'
import { CommandLogStore, CommandTrace, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import {
    backupYamlIo, setLinkLastBackup, writeBackupScheduleState, readBackupYamlState, parseBackupYamlState,
} from '../../src/data/BackupYamlDoc.js'
import { backupLinkIo } from '../../src/data/BackupLinks.js'
import { applyBackupResult, successResultCode, failureResultCode, isManualBackupCause } from '../../src/data/BackupResults.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
import { config } from '../../src/data/Config.js'

let prevSkipBorg: boolean | undefined
beforeEach(() => { prevSkipBorg = config.settings.skipBorg; config.settings.skipBorg = true })
afterEach(() => { config.settings.skipBorg = prevSkipBorg })

const INST = 'inst-400b' as InstanceID
const FIXTURES = path.resolve(process.cwd(), 'test/fixtures/backup-schedule')
const BASE_YAML = `# hand-written comment stays
mode: scheduled
schedule:
  daily: "03:15"
links:
  - instanceId: ${INST}
    lastBackup: 0
  - instanceId: other-inst
    lastBackup: 1794447005000
lastRun:
  time: 1794447005000
  uptimeS: 77405
  bootId: boot-a
missedRuns: 2
lastAttempt: 1794447005000
uptimeCounter:
  bootId: boot-a
  baseUptimeS: 77405
  seenUptimeS: 80000
  carriedS: 0
futureKey:
  nested: [1, 2]
`

let appDevice = ''
let backupDevice = ''
let logHandle: DocHandle<CommandLogStore>
const yamlPath = () => `${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`
const readYaml = async (): Promise<any> => YAML.parse(await fs.readFile(yamlPath(), 'utf-8'))

const newStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const h = repo.create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} })
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}
const newCommandLog = (): DocHandle<CommandLogStore> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
}
const traces = (): CommandTrace[] => logHandle.doc()!.recentTraceIds.map(id => logHandle.doc()!.traces[id])

const makeDisk = (id: string, device: string | null, backup = false): Disk => ({
    id: id as DiskID, name: `${id}-name` as DiskName, device: device as any, dockedTo: localEngineId as EngineID,
    created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: backup ? ['backup'] : ['app'], backupConfig: null,
})

const setup = async (appDocked = true) => {
    const storeHandle = await newStore()
    const appDisk = makeDisk('ad-400b', appDocked ? appDevice : null)
    const backupDisk = makeDisk('bd-400b', backupDevice, true)
    storeHandle.change(doc => {
        doc.diskDB[appDisk.id] = appDisk
        doc.diskDB[backupDisk.id] = backupDisk
        doc.instanceDB[INST] = {
            id: INST, instanceOf: 'sample-app' as any, name: INST as any, status: 'Stopped' as any, port: 8080 as any,
            serviceImages: [], created: 1 as Timestamp, lastBackup: null, lastStarted: 1 as Timestamp, statusCondition: null,
            storedOn: appDisk.id, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })
    return { storeHandle, appDisk, backupDisk }
}

beforeEach(async () => {
    appDevice = uniqueTestDevice()
    do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
    await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
    await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
    await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`, '[repository]\n')
    await fs.writeFile(yamlPath(), BASE_YAML)
    backupYamlIo.rename = (from: string, to: string) => fs.rename(from, to)
    logHandle = newCommandLog()
    setCommandLogHandle(logHandle)
})
afterEach(async () => {
    vi.restoreAllMocks()
    setCommandLogHandle(null)
    resourceLock.releaseAll([diskKey('bd-400b')])
    await fs.chmod(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`, 0o755).catch(() => {})
    await fs.remove(`${DISKS_ROOT}/${appDevice}`)
    await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
})

describe('BackupYamlDoc (document-preserving writer)', () => {
    it('setLinkLastBackup changes only that link; comment, schedule state and unknown keys stay', async () => {
        expect(await setLinkLastBackup(backupDevice, INST, 1794500000000)).toBe(true)
        const raw = await fs.readFile(yamlPath(), 'utf-8')
        expect(raw).toContain('# hand-written comment stays')
        const y = YAML.parse(raw)
        expect(y.links).toEqual([{ instanceId: INST, lastBackup: 1794500000000 }, { instanceId: 'other-inst', lastBackup: 1794447005000 }])
        expect(y.schedule).toEqual({ daily: '03:15' })
        expect(y.lastRun.bootId).toBe('boot-a')
        expect(y.uptimeCounter.seenUptimeS).toBe(80000)
        expect(y.futureKey).toEqual({ nested: [1, 2] })
        expect(await setLinkLastBackup(backupDevice, 'not-linked', 1)).toBe(false)
    })

    it('writeBackupScheduleState writes only the named keys; null deletes', async () => {
        await writeBackupScheduleState(backupDevice, {
            lastRun: { time: 1794500000000, uptimeS: 100, bootId: 'boot-b' },
            uptimeCounter: { bootId: 'boot-b', baseUptimeS: 100, seenUptimeS: 100, carriedS: 0 },
            missedRuns: null,
        })
        const y = await readYaml()
        expect(y.lastRun).toEqual({ time: 1794500000000, uptimeS: 100, bootId: 'boot-b' })
        expect(y.uptimeCounter.bootId).toBe('boot-b')
        expect('missedRuns' in y).toBe(false)
        expect(y.lastAttempt).toBe(1794447005000)
        expect(y.schedule).toEqual({ daily: '03:15' })
        expect(y.futureKey).toEqual({ nested: [1, 2] })
    })

    it('a failed rename leaves BACKUP.yaml and no temp file; BackupLinks shares the same io object', async () => {
        expect(backupLinkIo).toBe(backupYamlIo)
        const before = await fs.readFile(yamlPath(), 'utf-8')
        backupYamlIo.rename = async () => { throw new Error('simulated rename failure') }
        await expect(writeBackupScheduleState(backupDevice, { missedRuns: 5 })).rejects.toThrow('simulated rename failure')
        expect(await fs.readFile(yamlPath(), 'utf-8')).toBe(before)
        expect((await fs.readdir(`${DISKS_ROOT}/${backupDevice}`)).filter(f => f.includes('.tmp-'))).toEqual([])
    })

    it('the state reader: fixtures, an invalid schedule, malformed state keys and a missing file', async () => {
        const ran = parseBackupYamlState(YAML.parse(await fs.readFile(`${FIXTURES}/scheduled-ran.yaml`, 'utf-8')))!
        expect(ran.schedule).toEqual({ daily: '02:30' })
        expect(ran.lastRun).toEqual({ time: 1794447005000, uptimeS: 77405, bootId: '6f1c1d1e-0000-4000-8000-000000000001' })
        expect(ran.uptimeCounter?.carriedS).toBe(9000)
        expect(ran.missedRuns).toBe(0)
        const dflt = parseBackupYamlState(YAML.parse(await fs.readFile(`${FIXTURES}/scheduled-default.yaml`, 'utf-8')))!
        expect(dflt).toMatchObject({ mode: 'scheduled', schedule: null, scheduleError: null, lastRun: null, uptimeCounter: null })
        const bad = parseBackupYamlState({ mode: 'scheduled', links: [], schedule: { daily: '25:00' }, lastRun: 'x', missedRuns: -1, uptimeCounter: { bootId: 'b' } })!
        expect(bad.schedule).toBeNull()
        expect(bad.scheduleError).toMatch(/^BAD_TIME: /)
        expect(bad).toMatchObject({ lastRun: null, missedRuns: null, uptimeCounter: null })
        expect(parseBackupYamlState({ links: [] })).toBeNull()
        expect(await readBackupYamlState('no-such-device')).toBeNull()
    })
})

describe('BackupResults', () => {
    it('keeps the newest 7, oldest first, trimmed in place', () => {
        const inst: { lastResult?: BackupResult | null, backupHistory?: BackupResult[] | null } = {}
        for (let i = 1; i <= 10; i++) applyBackupResult(inst, { time: i as Timestamp, method: 'stop', result: 'OK' })
        expect(inst.backupHistory!.map(r => r.time)).toEqual([4, 5, 6, 7, 8, 9, 10])
        expect(inst.backupHistory!.length).toBe(BACKUP_HISTORY_LENGTH)
        expect(inst.lastResult).toEqual({ time: 10, method: 'stop', result: 'OK' })
    })

    it('maps outcomes to one code', () => {
        expect(successResultCode({ hookFallback: false, hookWarning: false, cleanupHelperOutdated: false })).toBe('OK')
        expect(successResultCode({ hookFallback: true, hookWarning: true, cleanupHelperOutdated: true })).toBe('HOOK_FALLBACK')
        expect(successResultCode({ hookFallback: false, hookWarning: true, cleanupHelperOutdated: true })).toBe('HOOK_POST_WARNING')
        expect(successResultCode({ hookFallback: false, hookWarning: false, cleanupHelperOutdated: true })).toBe('HELPER_OUTDATED')
        expect(failureResultCode('BACKUP_DISK_FULL: Backup Disk full: add a bigger disk')).toBe('BACKUP_DISK_FULL')
        expect(failureResultCode('HELPER_OUTDATED: needs v8')).toBe('HELPER_OUTDATED')
        expect(failureResultCode('App Disk for instance x is not docked')).toBe('APP_DISK_NOT_DOCKED')
        expect(failureResultCode('borg exited 2')).toBe('FAILED')
        expect(isManualBackupCause('console-command')).toBe(true)
        expect(isManualBackupCause('backup-app-docked')).toBe(false)
    })
})

describe('backupInstance results (idea#400)', () => {
    it('a successful backup records OK / stop and keeps the schedule state in BACKUP.yaml', async () => {
        const { storeHandle, backupDisk } = await setup()
        await backupInstance(storeHandle, INST, backupDisk)
        const inst = storeHandle.doc()!.instanceDB[INST]
        expect(inst.lastResult).toMatchObject({ method: 'stop', result: 'OK' })
        expect(inst.backupHistory?.length).toBe(1)
        const y = await readYaml()
        expect(y.links[0].lastBackup).toBeGreaterThan(0)
        expect(y.schedule).toEqual({ daily: '03:15' })
        expect(y.lastRun.time).toBe(1794447005000) // a backupApp never moves the schedule's lastRun (Q5)
        expect(y.futureKey).toEqual({ nested: [1, 2] })
    })

    it('a manual backupApp while the disk is locked is refused with BUSY and records nothing', async () => {
        const { storeHandle, backupDisk } = await setup()
        expect(resourceLock.acquire(diskKey(backupDisk.id), 'scheduledBackup')).toBe(true)
        await backupInstance(storeHandle, INST, backupDisk)
        const t = traces().find(x => x.command === 'backupApp')
        expect(t?.status).toBe('error')
        expect(t?.errorMessage).toMatch(/^BUSY: .*locked by 'scheduledBackup'/)
        expect(storeHandle.doc()!.instanceDB[INST].lastResult ?? null).toBeNull()
    })

    it('an automatic trigger that finds a lock records SKIPPED_LOCKED', async () => {
        const { storeHandle, backupDisk } = await setup()
        expect(resourceLock.acquire(diskKey(backupDisk.id), 'restoreApp')).toBe(true)
        await backupInstance(storeHandle, INST, backupDisk, undefined, 'backup-app-docked')
        expect(storeHandle.doc()!.instanceDB[INST].lastResult?.result).toBe('SKIPPED_LOCKED')
        expect(traces().find(x => x.command === 'backupApp')?.errorMessage).toMatch(/^SKIPPED_LOCKED: /)
    })

    it('an App Disk that is not docked records APP_DISK_NOT_DOCKED', async () => {
        const { storeHandle, backupDisk } = await setup(false)
        await backupInstance(storeHandle, INST, backupDisk)
        expect(storeHandle.doc()!.instanceDB[INST].lastResult?.result).toBe('APP_DISK_NOT_DOCKED')
    })

    it.skipIf(process.getuid?.() === 0)('any other failure records FAILED', async () => {
        const { storeHandle, backupDisk } = await setup()
        await fs.chmod(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`, 0o555)
        await backupInstance(storeHandle, INST, backupDisk)
        expect(storeHandle.doc()!.instanceDB[INST].lastResult?.result).toBe('FAILED')
    })
})

describe('processBackupDisk mirror and createBackupDisk (idea#400)', () => {
    it('mirrors schedule, missedRuns and lastAttempt; never the uptime counter', async () => {
        const { storeHandle, backupDisk } = await setup()
        await processBackupDisk(storeHandle, backupDisk)
        const d = storeHandle.doc()!.diskDB[backupDisk.id]
        expect(d.backupConfig).toEqual({ mode: 'scheduled', links: [INST, 'other-inst'], schedule: { daily: '03:15' } })
        expect(d.missedRuns).toBe(2)
        expect(d.lastAttempt).toBe(1794447005000)
        expect(JSON.stringify(d)).not.toContain('uptimeCounter')
    })

    it('an invalid schedule mirrors as null', async () => {
        await fs.writeFile(yamlPath(), BASE_YAML.replace('"03:15"', '"3pm"'))
        const { storeHandle, backupDisk } = await setup()
        await processBackupDisk(storeHandle, backupDisk)
        expect(storeHandle.doc()!.diskDB[backupDisk.id].backupConfig?.schedule).toBeNull()
    })

    it('a stale lock is recorded as INTERRUPTED once, not on every dock', async () => {
        const { storeHandle, backupDisk } = await setup()
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/.backup-in-progress`, JSON.stringify({ instanceId: INST, startedAt: Date.now() - 1000 }))
        await processBackupDisk(storeHandle, backupDisk)
        await processBackupDisk(storeHandle, backupDisk)
        const inst = storeHandle.doc()!.instanceDB[INST]
        expect(inst.lastResult?.result).toBe('INTERRUPTED')
        expect(inst.backupHistory?.length).toBe(1)
    })

    it('createBackupDisk scheduled adds 02:30 when there is no schedule and keeps an existing one, lastRun and unknown keys', async () => {
        const { storeHandle, backupDisk } = await setup()
        await createBackupDiskConfig(storeHandle, backupDisk, 'scheduled', [INST])
        let y = await readYaml()
        expect(y.schedule).toEqual({ daily: '03:15' })
        expect(y.links).toEqual([{ instanceId: INST, lastBackup: 0 }])
        expect(y.lastRun.bootId).toBe('boot-a')
        expect(y.futureKey).toEqual({ nested: [1, 2] })
        await createBackupDiskConfig(storeHandle, backupDisk, 'immediate', [INST])
        expect((await readYaml()).schedule).toEqual({ daily: '03:15' }) // kept for a later switch back
        await fs.remove(yamlPath())
        await createBackupDiskConfig(storeHandle, backupDisk, 'scheduled', [INST])
        y = await readYaml()
        expect(y).toEqual({ mode: 'scheduled', links: [{ instanceId: INST, lastBackup: 0 }], schedule: { daily: '02:30' } })
    })
})
