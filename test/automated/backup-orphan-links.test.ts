/**
 * backup-orphan-links.test.ts (idea#400 follow-up)
 *
 * A BACKUP.yaml link to an instance id that is not in the store is kept in the
 * file and in backupConfig.links, and shown on backupConfig.orphanLinks so the
 * Console can display it. The yaml is never rewritten or pruned for this.
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { processBackupDisk, checkPendingBackups } from '../../src/monitors/backupMonitor.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const INST = 'inst-live' as InstanceID
const ORPHAN = 'old-hub-id' as InstanceID

const YAML_TEXT = `mode: scheduled
schedule:
  daily: "02:30"
links:
  - instanceId: ${INST}
    lastBackup: 0
  - instanceId: ${ORPHAN}
    lastBackup: 1000
`

let appDevice = ''
let backupDevice = ''
const yamlPath = () => `${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}

const makeDisk = (id: string, device: string | null, backup = false): Disk => ({
    id: id as DiskID, name: `${id}-name` as DiskName, device: device as any, dockedTo: localEngineId as EngineID,
    created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: backup ? ['backup'] : ['app'], backupConfig: null,
})

const setup = async () => {
    const storeHandle = await newStore()
    const appDisk = makeDisk('ad-orphan', appDevice)
    const backupDisk = makeDisk('bd-orphan', backupDevice, true)
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

describe('backupConfig.orphanLinks (idea#400 follow-up)', () => {
    beforeEach(async () => {
        appDevice = uniqueTestDevice()
        do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
        await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
        await fs.writeFile(yamlPath(), YAML_TEXT)
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.remove(`${DISKS_ROOT}/${appDevice}`).catch(() => {})
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`).catch(() => {})
    })

    it('shows an orphan link in the store and leaves BACKUP.yaml bytes unchanged', async () => {
        const { storeHandle, backupDisk } = await setup()
        const before = await fs.readFile(yamlPath(), 'utf8')
        await processBackupDisk(storeHandle, backupDisk)
        const after = await fs.readFile(yamlPath(), 'utf8')
        expect(after).toBe(before)
        const cfg = storeHandle.doc()!.diskDB[backupDisk.id].backupConfig
        expect(cfg?.links).toEqual([INST, ORPHAN])
        expect(cfg?.orphanLinks).toEqual([ORPHAN])
        const yaml = YAML.parse(after.toString('utf8'))
        expect(yaml.links.map((l: any) => l.instanceId)).toEqual([INST, ORPHAN])
    })

    it('clears the orphan status when the instance appears, without rewriting BACKUP.yaml', async () => {
        const { storeHandle, appDisk, backupDisk } = await setup()
        const before = await fs.readFile(yamlPath(), 'utf8')
        await processBackupDisk(storeHandle, backupDisk)
        expect(storeHandle.doc()!.diskDB[backupDisk.id].backupConfig?.orphanLinks).toEqual([ORPHAN])

        storeHandle.change(doc => {
            doc.instanceDB[ORPHAN] = {
                id: ORPHAN, instanceOf: 'sample-app' as any, name: ORPHAN as any, status: 'Stopped' as any, port: 8080 as any,
                serviceImages: [], created: 1 as Timestamp, lastBackup: null, lastStarted: 1 as Timestamp, statusCondition: null,
                storedOn: appDisk.id, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            } as any
        })
        await checkPendingBackups(storeHandle, appDisk)
        const cfg = storeHandle.doc()!.diskDB[backupDisk.id].backupConfig
        expect(cfg?.links).toEqual([INST, ORPHAN])
        expect(cfg?.orphanLinks ?? []).toEqual([])
        const after = await fs.readFile(yamlPath(), 'utf8')
        expect(after).toBe(before)
    })
})
