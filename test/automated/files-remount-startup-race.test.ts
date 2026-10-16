/**
 * files-remount-startup-race.test.ts — startup Files remount race (idea03, 2026-10-15 14:17)
 *
 * Two Files Disks dock at the same time. Disk A (Files + App, like sdb1 with
 * Nextcloud) has read FILES.yaml but is still processing its apps and instances.
 * Disk B (Files only, like sdb2 "F") finishes and its dock sets off a Files remount
 * of the opted-in instance on A. Before the fix, A's record still had
 * diskTypes [] (processDisk only wrote the roles at the very end), so
 * mountableFilesDisks() skipped A and the remount wrote filesMounts=[B] only.
 *
 * Compose / occ are injected via setFilesMountOpsForTests — no real Docker.
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { createOrUpdateDisk, processDisk } from '../../src/data/Disk.js'
import { processFilesDisk } from '../../src/data/FilesDisk.js'
import { createOrUpdateApp } from '../../src/data/App.js'
import {
    mountableFilesDisks, writeInstanceOverride, scheduleFilesRemount,
    flushFilesRemountNow, resetFilesRemountScheduleForTests,
    setFilesMountOpsForTests, ensureEngineStateDir,
} from '../../src/data/FilesMount.js'
import { resourceLock } from '../../src/utils/ResourceLock.js'
import { AppID, DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Instance } from '../../src/data/Instance.js'
import { DISKS_ROOT, FIXTURES_DIR, uniqueTestDevice } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID
const APP = 'sample-files-1.0' as AppID

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}

const addInstance = (h: DocHandle<Store>, id: string, diskId: string): void => {
    const inst: Instance = {
        id: id as InstanceID, instanceOf: APP, name: id as any, status: 'Running', statusCondition: null,
        port: 0 as any, serviceImages: [], created: 1 as Timestamp, lastBackup: null, lastStarted: 1 as Timestamp,
        storedOn: diskId as DiskID, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        filesMounts: null,
    }
    h.change(doc => { doc.instanceDB[inst.id] = inst })
}

describe('startup Files remount race: a Files+App disk still processing its apps', () => {
    let h: DocHandle<Store>
    let composeCalls: { dir: string; override: string; args: string[] }[]
    const roots: string[] = []
    let devA: string, devB: string

    beforeEach(async () => {
        h = await newStore()
        composeCalls = []
        resetFilesRemountScheduleForTests()
        setFilesMountOpsForTests({
            composeUp: async (dir, override, args) => { composeCalls.push({ dir, override, args }) },
            nextcloudOccStatus: async () => ({ installed: true, maintenance: false, needsDbUpgrade: false }),
        })
        await ensureEngineStateDir()

        // Disk A: Files + App (the Nextcloud disk, sdb1 on idea03)
        devA = uniqueTestDevice()
        const rootA = `${DISKS_ROOT}/${devA}`
        await fs.copy(path.join(FIXTURES_DIR, 'disk-files-app'), rootA)
        await fs.ensureDir(`${rootA}/instances/nc-1`)
        await fs.copy(`${rootA}/apps/${APP}/compose.yaml`, `${rootA}/instances/nc-1/compose.yaml`)
        roots.push(rootA)

        // Disk B: Files only (F, sdb2 on idea03)
        devB = uniqueTestDevice()
        const rootB = `${DISKS_ROOT}/${devB}`
        await fs.copy(path.join(FIXTURES_DIR, 'disk-files'), rootB)
        roots.push(rootB)
    })

    afterEach(async () => {
        setFilesMountOpsForTests(null)
        resetFilesRemountScheduleForTests()
        resourceLock.releaseAll([...resourceLock.allLocks().keys()])
        for (const r of roots.splice(0)) await fs.remove(r)
    })

    /** Dock A up to the point where its Files role is read but processAppDisk has not finished. */
    const dockAMidProcessing = async (): Promise<void> => {
        const diskA = createOrUpdateDisk(h, LOCAL, devA as DeviceName, 'disk-a' as DiskID, 'A' as DiskName, 1 as Timestamp)
        // createOrUpdateDisk resets diskTypes to [] on dock (Disk.ts)
        expect([...(h.doc()!.diskDB['disk-a' as DiskID].diskTypes ?? [])]).toEqual([])
        await processFilesDisk(h, 'disk-a' as DiskID, 'A', `${DISKS_ROOT}/${devA}`)
        // The app and instance records already exist from the previous run (persisted store)
        await createOrUpdateApp(h, APP, diskA)
        addInstance(h, 'nc-1', 'disk-a')
    }

    it('processFilesDisk marks the files role right away, so A counts as a mountable Files Disk', async () => {
        await dockAMidProcessing()
        const rec = h.doc()!.diskDB['disk-a' as DiskID]
        expect([...rec.diskTypes!]).toContain('files')
        expect(mountableFilesDisks(h.doc()!).map(d => d.id)).toContain('disk-a')
    })

    it('remount set off by B docking while A is still processing keeps both Files Disks', async () => {
        await dockAMidProcessing()
        // B docks and finishes completely; its processFilesDisk schedules a remount
        const diskB = createOrUpdateDisk(h, LOCAL, devB as DeviceName, 'disk-b' as DiskID, 'B' as DiskName, 1 as Timestamp)
        await processDisk(h, diskB)
        scheduleFilesRemount(h, { skipSameDiskId: 'disk-b' as DiskID })
        await flushFilesRemountNow(h)

        expect(composeCalls).toHaveLength(1)
        const mounts = [...(h.doc()!.instanceDB['nc-1' as InstanceID].filesMounts ?? [])].sort()
        expect(mounts).toEqual(['disk-a', 'disk-b'])
        const ov = YAML.parse(await fs.readFile(composeCalls[0].override, 'utf8'))
        const sources = ov.services.sample.volumes.map((v: any) => v.source)
        expect(sources).toContain(`${DISKS_ROOT}/${devA}/files`)
        expect(sources).toContain(`${DISKS_ROOT}/${devB}/files`)
    })

    it('an instance on A starting mid-processing gets A\'s own files/ in its override', async () => {
        await dockAMidProcessing()
        const written = await writeInstanceOverride(h.doc()!, h.doc()!.instanceDB['nc-1' as InstanceID])
        expect(written!.diskIds).toContain('disk-a')
    })

    it('after processDisk finishes, roles are in the fixed order and files is not duplicated', async () => {
        const diskA = createOrUpdateDisk(h, LOCAL, devA as DeviceName, 'disk-a' as DiskID, 'A' as DiskName, 1 as Timestamp)
        await processDisk(h, diskA)
        expect([...h.doc()!.diskDB['disk-a' as DiskID].diskTypes!]).toEqual(['app', 'files'])
    })

    it('a disk whose FILES.yaml is gone on redock loses the files role and filesConfig', async () => {
        const diskB = createOrUpdateDisk(h, LOCAL, devB as DeviceName, 'disk-b' as DiskID, 'B' as DiskName, 1 as Timestamp)
        await processDisk(h, diskB)
        expect([...h.doc()!.diskDB['disk-b' as DiskID].diskTypes!]).toContain('files')
        await fs.remove(`${DISKS_ROOT}/${devB}/FILES.yaml`)
        const again = createOrUpdateDisk(h, LOCAL, devB as DeviceName, 'disk-b' as DiskID, 'B' as DiskName, 1 as Timestamp)
        await processDisk(h, again)
        const rec = h.doc()!.diskDB['disk-b' as DiskID]
        expect([...rec.diskTypes!]).not.toContain('files')
        expect(rec.filesConfig).toBeNull()
        expect(mountableFilesDisks(h.doc()!).map(d => d.id)).not.toContain('disk-b')
    })
})
