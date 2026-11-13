/**
 * set-backup-mode.test.ts (idea#400 PR D)
 *
 * setBackupMode <diskIdOrName> <immediate|on-demand|scheduled> [HH:MM]: switches the
 * mode of a docked Backup Disk through the preserving BACKUP.yaml writer and keeps
 * the schedule. Harness copied from backup-links.test.ts.
 *
 * No hardware: a Backup Disk is a <DISKS_ROOT>/<device>/ folder under the private
 * per-run mount root, its state is set up in the store. processDisk is wrapped in a
 * spy that calls the real one, so "not called" is checked without changing behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, YAML } from 'zx'
import { createHash } from 'crypto'

vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, processDisk: vi.fn((...args: any[]) => actual.processDisk(...args)) }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { processDisk } from '../../src/data/Disk.js'
import { commands } from '../../src/data/Commands.js'
import { backupLinkIo } from '../../src/data/BackupLinks.js'
import { setBackupMode } from '../../src/data/BackupModeCommand.js'
import { resourceLock, diskKey } from '../../src/utils/ResourceLock.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const A = 'inst-link-a' as InstanceID
const B = 'inst-link-b' as InstanceID
const OTHER_ENGINE = 'ENGINE_other-pi' as EngineID

const BASE_YAML = `# Backup Disk config, edited by hand on purpose
mode: immediate
links:
  - instanceId: ${A}
    lastBackup: 1762900000111
  - instanceId: ${B}
    lastBackup: 1762900000222
schedule:
  daily: "04:00"
lastRun:
  time: 1762900000333
  uptimeS: 1200
  bootId: boot-a
futureKey:
  nested: [1, 2]
`

let h: DocHandle<Store>
let backupDev: string
let appDev: string
const BACKUP_DISK = 'disk-backup-400d' as DiskID
const APP_DISK = 'disk-app-400d' as DiskID

const yamlPath = () => `${DISKS_ROOT}/${backupDev}/BACKUP.yaml`
const sha = async (): Promise<string> => createHash('sha256').update(await fs.readFile(yamlPath())).digest('hex')
const readYaml = async (): Promise<any> => YAML.parse(await fs.readFile(yamlPath(), 'utf-8'))
const storeConfig = (): string => JSON.stringify(h.doc().diskDB[BACKUP_DISK]?.backupConfig ?? null)

const createMinimalStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const handle = repo.create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as unknown as Store)
    await handle.whenReady()
    await createOrUpdateEngine(handle, localEngineId)
    return handle
}

const putDisk = (id: DiskID, device: string | null, types: string[], dockedTo: EngineID = localEngineId as EngineID, name?: string) => {
    h.change(doc => {
        doc.diskDB[id] = {
            id, name: (name ?? `${id}-name`) as DiskName, device: device as any, dockedTo,
            created: Date.now() as Timestamp, lastDocked: Date.now() as Timestamp,
            diskTypes: types as any,
            backupConfig: types.includes('backup') ? { mode: 'immediate', links: [A, B] } : null,
        } as any
    })
}

const putInstance = (id: InstanceID, name: string, diskId: DiskID) => {
    h.change(doc => {
        doc.instanceDB[id] = {
            id, instanceOf: 'sample-app' as any, name: name as any, status: 'Running' as any,
            port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
            lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: diskId,
            currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })
}

const expectRefusal = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toThrow(new RegExp(`^${code}: `))
}

/** Every refusal: the file bytes, the store config and the disk lock are unchanged. */
const refusesWithNothingWritten = async (run: () => Promise<unknown>, code: string) => {
    const before = await fs.pathExists(yamlPath()) ? await sha() : null
    const config = storeConfig()
    await expectRefusal(run(), code)
    expect(await fs.pathExists(yamlPath()) ? await sha() : null).toBe(before)
    expect(storeConfig()).toBe(config)
    expect(resourceLock.isLocked(diskKey(BACKUP_DISK))).toBe(false)
    expect((await fs.readdir(`${DISKS_ROOT}/${backupDev}`)).filter(f => f.includes('.tmp-'))).toEqual([])
}

beforeEach(async () => {
    vi.mocked(processDisk).mockClear()
    backupLinkIo.rename = (from: string, to: string) => fs.rename(from, to)
    h = await createMinimalStore()
    backupDev = uniqueTestDevice()
    appDev = uniqueTestDevice()
    await fs.ensureDir(`${DISKS_ROOT}/${backupDev}`)
    await fs.ensureDir(`${DISKS_ROOT}/${appDev}`)
    await fs.writeFile(yamlPath(), BASE_YAML)
    putDisk(BACKUP_DISK, backupDev, ['backup'])
    putDisk(APP_DISK, appDev, ['app'])
    putInstance(A, 'alpha', APP_DISK)
    putInstance(B, 'bravo', APP_DISK)
})

afterEach(() => {
    resourceLock.releaseAll([diskKey(BACKUP_DISK)])
})

const def = () => commands.find(c => c.name === 'setBackupMode')!

describe('registration and capability (idea#400 PR D)', () => {
    it('advertises scheduledBackups', () => {
        expect(ENGINE_CAPABILITIES).toContain('scheduledBackups')
    })

    it('registers setBackupMode with backupDiskId, mode and an optional time, engine scope', () => {
        expect(def()).toBeDefined()
        expect(def().scope).toBe('engine')
        expect(def().args.map((a: any) => a.name)).toEqual(['backupDiskId', 'mode', 'time'])
        expect(def().args[2]).toMatchObject({ variadic: true, optional: true })
    })

    it('the wrapper refuses more than one time token with BAD_TIME', async () => {
        await refusesWithNothingWritten(async () => def().execute(h, BACKUP_DISK, 'scheduled', '03:00', '04:00'), 'BAD_TIME')
    })

    it('the wrapper passes the time through', async () => {
        await def().execute(h, BACKUP_DISK, 'scheduled', '05:45')
        expect((await readYaml()).schedule).toEqual({ daily: '05:45' })
    })
})

describe('setBackupMode (idea#400 PR D)', () => {
    it('immediate → scheduled HH:MM: changes only mode and schedule, keeps links, lastRun, comments and unknown keys', async () => {
        const before = await readYaml()
        const r = await setBackupMode(h, BACKUP_DISK, 'scheduled', '03:15')
        expect(r).toMatchObject({ backupDiskId: BACKUP_DISK, previousMode: 'immediate', mode: 'scheduled', schedule: { daily: '03:15' }, scheduleError: null, changed: true })
        const after = await readYaml()
        expect(Object.keys(after)).toEqual(Object.keys(before))
        expect(after).toEqual({ ...before, mode: 'scheduled', schedule: { daily: '03:15' } })
        expect(await fs.readFile(yamlPath(), 'utf-8')).toContain('# Backup Disk config, edited by hand on purpose')
        expect(h.doc().diskDB[BACKUP_DISK].backupConfig).toEqual({ mode: 'scheduled', links: [A, B], schedule: { daily: '03:15' }, scheduleError: null })
        expect(processDisk).not.toHaveBeenCalled()
        expect(Object.values(h.doc().operationDB ?? {}).filter((o: any) => o?.kind === 'backupApp')).toEqual([])
        expect(resourceLock.isLocked(diskKey(BACKUP_DISK))).toBe(false)
        expect((await fs.readdir(`${DISKS_ROOT}/${backupDev}`)).filter(f => f.includes('.tmp-'))).toEqual([])
    })

    it('scheduled without a time keeps a valid schedule', async () => {
        const r = await setBackupMode(h, BACKUP_DISK, 'scheduled')
        expect(r.schedule).toEqual({ daily: '04:00' })
        expect((await readYaml()).schedule).toEqual({ daily: '04:00' })
        expect(h.doc().diskDB[BACKUP_DISK].backupConfig?.schedule).toEqual({ daily: '04:00' })
    })

    it('scheduled without a time adds 02:30 when there is no schedule', async () => {
        await fs.writeFile(yamlPath(), 'mode: on-demand\nlinks:\n  - instanceId: inst-link-a\n    lastBackup: 5\n')
        const r = await setBackupMode(h, BACKUP_DISK, 'scheduled')
        expect(r.schedule).toEqual({ daily: '02:30' })
        expect(await readYaml()).toEqual({ mode: 'scheduled', links: [{ instanceId: A, lastBackup: 5 }], schedule: { daily: '02:30' } })
    })

    it('scheduled without a time replaces an invalid schedule with 02:30 and clears scheduleError', async () => {
        await fs.writeFile(yamlPath(), BASE_YAML.replace('daily: "04:00"', 'daily: "25:99"'))
        h.change(doc => { (doc.diskDB[BACKUP_DISK].backupConfig as any).scheduleError = 'BAD_TIME: old' })
        const r = await setBackupMode(h, BACKUP_DISK, 'scheduled')
        expect(r).toMatchObject({ schedule: { daily: '02:30' }, scheduleError: null, changed: true })
        expect((await readYaml()).schedule).toEqual({ daily: '02:30' })
        expect(h.doc().diskDB[BACKUP_DISK].backupConfig?.scheduleError).toBeNull()
    })

    it('scheduled HH:MM replaces an invalid schedule', async () => {
        await fs.writeFile(yamlPath(), BASE_YAML.replace('daily: "04:00"', 'weekly: monday'))
        const r = await setBackupMode(h, BACKUP_DISK, 'scheduled', '06:00')
        expect(r.schedule).toEqual({ daily: '06:00' })
        expect((await readYaml()).schedule).toEqual({ daily: '06:00' })
    })

    it('accepts H:MM and normalises it to HH:MM', async () => {
        const r = await setBackupMode(h, BACKUP_DISK, 'scheduled', '3:05')
        expect(r.schedule).toEqual({ daily: '03:05' })
        expect((await readYaml()).schedule).toEqual({ daily: '03:05' })
    })

    it('scheduled → on-demand keeps the schedule, so switching back keeps the time', async () => {
        await setBackupMode(h, BACKUP_DISK, 'scheduled', '03:15')
        const r = await setBackupMode(h, BACKUP_DISK, 'on-demand')
        expect(r).toMatchObject({ previousMode: 'scheduled', mode: 'on-demand', schedule: { daily: '03:15' }, changed: true })
        expect((await readYaml()).schedule).toEqual({ daily: '03:15' })
        expect(h.doc().diskDB[BACKUP_DISK].backupConfig).toMatchObject({ mode: 'on-demand', schedule: { daily: '03:15' } })
        const back = await setBackupMode(h, BACKUP_DISK, 'scheduled')
        expect(back.schedule).toEqual({ daily: '03:15' })
    })

    it('a non-scheduled mode leaves an invalid schedule alone and reports scheduleError', async () => {
        await fs.writeFile(yamlPath(), BASE_YAML.replace('daily: "04:00"', 'daily: "noon"'))
        const r = await setBackupMode(h, BACKUP_DISK, 'on-demand')
        expect(r.schedule).toBeNull()
        expect(r.scheduleError).toMatch(/^BAD_TIME: /)
        expect((await readYaml()).schedule).toEqual({ daily: 'noon' })
        expect(h.doc().diskDB[BACKUP_DISK].backupConfig).toMatchObject({ mode: 'on-demand', schedule: null, scheduleError: r.scheduleError })
    })

    it('the same mode and schedule writes nothing (changed: false)', async () => {
        await setBackupMode(h, BACKUP_DISK, 'scheduled', '04:00')
        const before = await sha()
        const r = await setBackupMode(h, BACKUP_DISK, 'scheduled', '04:00')
        expect(r.changed).toBe(false)
        expect(await sha()).toBe(before)
        const again = await setBackupMode(h, BACKUP_DISK, 'scheduled')
        expect(again.changed).toBe(false)
    })

    it('accepts a disk given by name', async () => {
        await setBackupMode(h, `${BACKUP_DISK}-name`, 'on-demand')
        expect((await readYaml()).mode).toBe('on-demand')
    })
})

describe('setBackupMode refusals write nothing (idea#400 PR D)', () => {
    it('BAD_MODE', async () => {
        for (const m of ['nightly', '', 'Scheduled']) await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, m), 'BAD_MODE')
    })

    it('BAD_TIME for a bad time, or a time with a mode other than scheduled', async () => {
        for (const t of ['25:00', '12:60', 'noon', '1230', '12:3']) await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, 'scheduled', t), 'BAD_TIME')
        await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, 'immediate', '03:00'), 'BAD_TIME')
        await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, 'on-demand', '03:00'), 'BAD_TIME')
    })

    it('NOT_DOCKED for an unknown, undocked or remote disk', async () => {
        await refusesWithNothingWritten(() => setBackupMode(h, 'disk-unknown', 'on-demand'), 'NOT_DOCKED')
        h.change(doc => { doc.diskDB[BACKUP_DISK].dockedTo = OTHER_ENGINE })
        await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, 'on-demand'), 'NOT_DOCKED')
        h.change(doc => { doc.diskDB[BACKUP_DISK].dockedTo = localEngineId as EngineID; doc.diskDB[BACKUP_DISK].device = null as any })
        await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, 'on-demand'), 'NOT_DOCKED')
    })

    it('NOT_A_BACKUP_DISK and SYSTEM_DISK', async () => {
        await refusesWithNothingWritten(() => setBackupMode(h, APP_DISK, 'on-demand'), 'NOT_A_BACKUP_DISK')
        h.change(doc => { doc.diskDB[BACKUP_DISK].diskTypes = ['system', 'backup'] as any })
        await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, 'on-demand'), 'SYSTEM_DISK')
    })

    it('BAD_BACKUP_YAML for a missing, unparsable or wrongly shaped file', async () => {
        for (const text of ['mode: [unclosed\n', '- just\n- a list\n', 'links: []\n', 'mode: immediate\nlinks: nope\n']) {
            await fs.writeFile(yamlPath(), text)
            await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, 'on-demand'), 'BAD_BACKUP_YAML')
        }
        await fs.remove(yamlPath())
        await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, 'on-demand'), 'BAD_BACKUP_YAML')
        expect(await fs.pathExists(yamlPath())).toBe(false)
    })

    it('BUSY while the disk lock is held, and the holder keeps it', async () => {
        expect(resourceLock.acquire(diskKey(BACKUP_DISK), 'backupApp')).toBe(true)
        const before = await sha()
        const config = storeConfig()
        await expectRefusal(setBackupMode(h, BACKUP_DISK, 'on-demand'), 'BUSY')
        expect(await sha()).toBe(before)
        expect(storeConfig()).toBe(config)
        expect(resourceLock.getLockInfo(diskKey(BACKUP_DISK))?.kind).toBe('backupApp')
    })

    it('BUSY while a backupApp to this disk runs (a scheduled run too)', async () => {
        h.change(doc => {
            (doc as any).operationDB['op-400d'] = {
                id: 'op-400d', kind: 'backupApp', status: 'Running', args: { instanceId: B, backupDiskId: BACKUP_DISK },
                createdAt: Date.now(), cause: 'scheduled-backup',
            }
        })
        await refusesWithNothingWritten(() => setBackupMode(h, BACKUP_DISK, 'immediate'), 'BUSY')
    })

    it('a failure between the temp write and the rename leaves the old file and the store', async () => {
        backupLinkIo.rename = async () => { throw new Error('simulated rename failure') }
        const before = await sha()
        const config = storeConfig()
        await expect(setBackupMode(h, BACKUP_DISK, 'scheduled', '03:00')).rejects.toThrow('simulated rename failure')
        expect(await sha()).toBe(before)
        expect(storeConfig()).toBe(config)
        expect((await fs.readdir(`${DISKS_ROOT}/${backupDev}`)).filter(f => f.includes('.tmp-'))).toEqual([])
        expect(resourceLock.isLocked(diskKey(BACKUP_DISK))).toBe(false)
    })
})
