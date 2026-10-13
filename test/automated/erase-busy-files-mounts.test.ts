/**
 * erase-busy-files-mounts.test.ts — eraseDisk refuses up front when a running
 * instance on another disk holds the target open via filesMounts or an app
 * volume (wh 2026-10-13: wipefs "Device or resource busy").
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { createOrUpdateDisk, processDisk } from '../../src/data/Disk.js'
import { eraseDisk, setEraseOpsForTests, instancesUsingDisk, composeVolumeHostPaths, instancesUsingDiskMessage, ERASE_STAGING_ROOT } from '../../src/data/EraseDisk.js'
import { setSystemDiskOpsForTests } from '../../src/data/SystemDisk.js'
import { CommandLogStore, setCommandLogHandle, addTrace } from '../../src/data/CommandLogStore.js'
import { DeviceName, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { DISKS_ROOT } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID

describe('eraseDisk refuses a disk held by another instance (filesMounts / volumes)', () => {
    let h: DocHandle<Store>
    const roots: string[] = []
    let scriptCalls = 0
    let downCalls = 0

    const dock = async (device: string, diskId: string, name: string) => {
        const root = `${DISKS_ROOT}/${device}`
        await fs.ensureDir(root)
        await fs.writeFile(path.join(root, 'META.yaml'), YAML.stringify({ diskId, diskName: name, isHardwareId: false, created: 1, version: '1.0' }))
        roots.push(root)
        const d = createOrUpdateDisk(h, LOCAL, device as DeviceName, diskId as DiskID, name as DiskName, 1 as Timestamp)
        await processDisk(h, d)
        return root
    }
    const putInstance = (id: string, name: string, storedOn: string, status: string, filesMounts: string[] | null) => {
        h.change(doc => {
            doc.instanceDB[id as any] = { id, name, instanceOf: 'nextcloud-1.1', storedOn, status, statusCondition: null, filesMounts } as any
        })
    }
    const putSummary = (logHandle: DocHandle<CommandLogStore>, targetId: string, label: string) => {
        addTrace(logHandle, {
            traceId: 'sum-busy', command: 'summariseDisk', args: JSON.stringify({ targetId }),
            startedAt: Date.now(), completedAt: Date.now(), status: 'ok', errorMessage: null,
            result: JSON.stringify({ targetId, label, serial: 'FAKE1', model: null, sizeBytes: 32e9, fsType: 'ext4',
                usedBytes: null, readable: true, apps: [], instances: [], backups: [], files: null, other: null,
                otherPartitions: [], computedAt: Date.now() }),
        } as any)
        return 'sum-busy'
    }

    beforeEach(async () => {
        h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, LOCAL)
        scriptCalls = 0
        downCalls = 0
        setEraseOpsForTests({
            runScript: async () => { scriptCalls++; throw new Error('should not partition') },
            runSlotErase: async () => { scriptCalls++; throw new Error('should not slot-erase') },
            composeDownV: async () => { downCalls++ },
            udevadmSettle: async () => {},
            addDevice: async () => {},
            isMountPoint: async () => false,
            lsblkSizeSerial: async () => ({ sizeBytes: 32e9, serial: 'FAKE1' }),
        })
        setSystemDiskOpsForTests({ findmntSource: async (mp) => mp === '/' ? '/dev/sda2' : null, pkname: async () => 'sda' })
    })
    afterEach(async () => {
        setEraseOpsForTests(null)
        setSystemDiskOpsForTests(null)
        setCommandLogHandle(null)
        for (const r of roots.splice(0)) await fs.remove(r).catch(() => {})
        await fs.remove(ERASE_STAGING_ROOT).catch(() => {})
    })

    it('refuses before touching anything and names the Nextcloud instance using the Files Disk', async () => {
        const logHandle = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
        await logHandle.whenReady()
        setCommandLogHandle(logHandle)
        await dock('sdb1', 'app-disk', 'App Disk')
        await dock('sdc1', 'files-disk', 'School Files')
        putInstance('nc-1', 'nextcloud-1', 'app-disk', 'Running', ['files-disk'])
        const tid = putSummary(logHandle, 'files-disk', 'School Files')

        await expect(eraseDisk(h, 'files-disk', tid, 'School Files'))
            .rejects.toThrow(/School Files is in use by nextcloud-1 \(Files mount\).*nothing was erased/)
        expect(scriptCalls).toBe(0)
        expect(downCalls).toBe(0)
        expect(h.doc()!.diskDB['files-disk' as DiskID]).toBeTruthy()
        expect(h.doc()!.engineDB[LOCAL].eraseInProgress ?? null).toBeNull()
    })

    it('ignores stopped instances and instances stored on the target disk itself', async () => {
        await dock('sdb1', 'app-disk', 'App Disk')
        await dock('sdc1', 'files-disk', 'School Files')
        putInstance('nc-stopped', 'nc-stopped', 'app-disk', 'Stopped', ['files-disk'])
        putInstance('on-target', 'on-target', 'files-disk', 'Running', ['files-disk'])
        putInstance('other', 'other', 'app-disk', 'Running', ['another-disk'])
        const disk = h.doc()!.diskDB['files-disk' as DiskID]
        expect(await instancesUsingDisk(h.doc()!, disk, async () => [])).toEqual([])
    })

    it('detects an app volume whose host path is under the disk mount root (compose.yaml)', async () => {
        const appRoot = await dock('sdb1', 'app-disk', 'App Disk')
        const filesRoot = await dock('sdc1', 'files-disk', 'School Files')
        putInstance('kiwix-1', 'kiwix-1', 'app-disk', 'Running', null)
        await fs.ensureDir(path.join(appRoot, 'instances', 'kiwix-1'))
        await fs.writeFile(path.join(appRoot, 'instances', 'kiwix-1', 'compose.yaml'), YAML.stringify({
            services: { kiwix: { volumes: [`${filesRoot}/zim:/data:ro`, { type: 'bind', source: '/srv/x', target: '/y' }, 'named:/z'] } },
        }))
        const paths = await composeVolumeHostPaths(h.doc()!, h.doc()!.instanceDB['kiwix-1' as any])
        expect(paths).toEqual([`${filesRoot}/zim`, '/srv/x'])
        const disk = h.doc()!.diskDB['files-disk' as DiskID]
        expect(await instancesUsingDisk(h.doc()!, disk)).toEqual([{ id: 'kiwix-1', name: 'kiwix-1', via: 'volume' }])
        // a sibling mount root with the same prefix is not a match
        expect(await instancesUsingDisk(h.doc()!, disk, async () => [`${filesRoot}0/x`])).toEqual([])
    })

    it('message lists several instances', () => {
        expect(instancesUsingDiskMessage('X', [{ name: 'a', via: 'filesMounts' }, { name: 'b', via: 'volume' }]))
            .toBe('X is in use by a (Files mount), b (app volume). Stop those instances or remove the Files mount first; nothing was erased.')
    })
})
