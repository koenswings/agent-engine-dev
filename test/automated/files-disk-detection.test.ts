/**
 * files-disk-detection.test.ts (idea#131, Files Disk step 1)
 *
 * Covers:
 *   - FILES.yaml detection: ['files'], filesConfig, sizeBytes/freeBytes on dock
 *   - password in FILES.yaml → passwordProtected, filesConfig.error, never in the store
 *   - combined disks: ['app', 'files'] and ['app', 'backup', 'files'] (fixed order)
 *   - processDisk runs Files before App (store patch order)
 *   - a Files-role error (bad FILES.yaml) is recorded and App processing still runs
 *   - undock, redock and duplicate-record clearing reset filesConfig and the size
 *   - the size write rule (1% / 100 MB), and the 10-minute pass only touches
 *     disks docked to this engine
 *
 * testMode: no sudo, no mount; disks are copies of test/fixtures under DISKS_ROOT.
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { Disk, clearDuplicateDiskRecords, createOrUpdateDisk, processDisk, diskFsRoot } from '../../src/data/Disk.js'
import { FILES_PASSWORD_ERROR, readFilesConfig, validateShareName } from '../../src/data/FilesDisk.js'
import { FREE_CHANGE_BYTES, readDiskSize, refreshDiskSizes, sizeNeedsWrite, updateDiskSize } from '../../src/data/DiskSize.js'
import { undockDisk } from '../../src/monitors/usbDeviceMonitor.js'
import { CommandLogStore, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { DeviceName, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { DISKS_ROOT, FIXTURES_DIR, uniqueTestDevice } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID
const OTHER = 'ENGINE_other-engine-000000' as EngineID

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}

/** Copy a fixture (or nothing) to a fresh test device and register it in the store. */
const dock = async (h: DocHandle<Store>, id: string, fixture: string | null, extra?: (root: string) => Promise<void>): Promise<{ disk: Disk, root: string, device: string }> => {
    const device = uniqueTestDevice()
    const root = `${DISKS_ROOT}/${device}`
    if (fixture) await fs.copy(path.join(FIXTURES_DIR, fixture), root)
    else await fs.ensureDir(root)
    if (extra) await extra(root)
    const disk = createOrUpdateDisk(h, LOCAL, device as DeviceName, id as DiskID, `Disk ${id}` as DiskName, 1 as Timestamp)
    return { disk, root, device }
}
const stored = (h: DocHandle<Store>, id: string): Disk => h.doc()!.diskDB[id as DiskID]

describe('Files Disk detection (idea#131)', () => {
    let h: DocHandle<Store>
    let logHandle: DocHandle<CommandLogStore>
    const roots: string[] = []
    beforeEach(async () => {
        h = await newStore()
        logHandle = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
        setCommandLogHandle(logHandle)
    })
    afterEach(async () => {
        setCommandLogHandle(null)
        for (const r of roots.splice(0)) await fs.remove(r)
    })

    it('a Files Disk gets [files], filesConfig from FILES.yaml, and its size and free space', async () => {
        const { disk, root } = await dock(h, 'f-1', 'disk-files'); roots.push(root)
        await processDisk(h, disk)
        const d = stored(h, 'f-1')
        expect([...d.diskTypes]).toEqual(['files'])
        expect({ ...d.filesConfig }).toEqual({ shareName: 'School Files', readOnly: false, passwordProtected: false, error: null })
        expect(d.sizeBytes).toBeGreaterThan(0)
        expect(d.freeBytes).toBeGreaterThanOrEqual(0)
        expect(d.sizeBytes! % 1_000_000).toBe(0)
        expect(d.freeBytes! % 1_000_000).toBe(0)
        expect(d.freeBytes!).toBeLessThanOrEqual(d.sizeBytes!)
    })

    it('a password in FILES.yaml: passwordProtected with the error; the password never reaches the store', async () => {
        const { disk, root } = await dock(h, 'f-pw', 'disk-files', async r => {
            await fs.writeFile(`${r}/FILES.yaml`, 'version: 1\nshareName: Secret\nreadOnly: false\npassword: hunter2\n')
        }); roots.push(root)
        await processDisk(h, disk)
        const d = stored(h, 'f-pw')
        expect([...d.diskTypes]).toEqual(['files'])
        expect({ ...d.filesConfig }).toEqual({ shareName: 'Secret', readOnly: false, passwordProtected: true, error: FILES_PASSWORD_ERROR })
        expect(JSON.stringify(h.doc())).not.toContain('hunter2')
    })

    it('a missing shareName falls back to the disk name', async () => {
        const dir = `${DISKS_ROOT}/${uniqueTestDevice()}`; roots.push(dir)
        await fs.ensureDir(dir)
        await fs.writeFile(`${dir}/FILES.yaml`, 'version: 1\npassword: null\n')
        expect((await readFilesConfig(dir, 'My Disk')).shareName).toBe('My Disk')
    })

    it('an empty disk stays [empty] with no filesConfig', async () => {
        const { disk, root } = await dock(h, 'e-1', null, async r => { await fs.writeFile(`${r}/META.yaml`, 'diskId: e-1\n') }); roots.push(root)
        await processDisk(h, disk)
        expect([...stored(h, 'e-1').diskTypes]).toEqual(['empty'])
        expect(stored(h, 'e-1').filesConfig).toBeNull()
    })

    it('combined disks: [app, files] and [app, backup, files], in that order', async () => {
        const a = await dock(h, 'c-1', 'disk-files-app'); roots.push(a.root)
        await processDisk(h, a.disk)
        expect([...stored(h, 'c-1').diskTypes]).toEqual(['app', 'files'])
        expect(stored(h, 'c-1').filesConfig?.shareName).toBe('Sample Share')
        expect(h.doc()!.appDB['sample-files-1.0' as any]).toBeDefined()

        const b = await dock(h, 'c-2', 'disk-files-app', async r => {
            await fs.writeFile(`${r}/BACKUP.yaml`, 'mode: on-demand\nlinks: []\n')
        }); roots.push(b.root)
        await processDisk(h, b.disk)
        expect([...stored(h, 'c-2').diskTypes]).toEqual(['app', 'backup', 'files'])
        expect(stored(h, 'c-2').backupConfig?.mode).toBe('on-demand')
        expect(stored(h, 'c-2').filesConfig?.shareName).toBe('Sample Share')
    })

    it('processDisk runs Files before App: filesConfig is written before the App is registered', async () => {
        const { disk, root } = await dock(h, 'o-1', 'disk-files-app'); roots.push(root)
        const order: string[] = []
        const onChange = ({ patches }: any) => {
            for (const p of patches) {
                if (p.path[0] === 'diskDB' && p.path[1] === 'o-1' && p.path[2] === 'filesConfig' && p.action === 'put') order.push('files')
                if (p.path[0] === 'appDB' && p.path.length === 2 && p.action === 'put') order.push('app')
            }
        }
        h.on('change', onChange)
        await processDisk(h, disk)
        h.off('change', onChange)
        expect(order.indexOf('files')).toBeGreaterThanOrEqual(0)
        expect(order.indexOf('app')).toBeGreaterThanOrEqual(0)
        expect(order.indexOf('files')).toBeLessThan(order.indexOf('app'))
    })

    it('a Files-role error (bad FILES.yaml) is recorded as a failed diskDetection trace; App and Backup still run', async () => {
        const { disk, root } = await dock(h, 'bad-1', 'disk-files-app', async r => {
            await fs.writeFile(`${r}/FILES.yaml`, 'shareName: [unclosed\n')
            await fs.writeFile(`${r}/BACKUP.yaml`, 'mode: on-demand\nlinks: []\n')
        }); roots.push(root)
        await processDisk(h, disk)
        const d = stored(h, 'bad-1')
        expect([...d.diskTypes]).toEqual(['app', 'backup', 'files'])
        expect(d.filesConfig).toBeNull()
        expect(d.backupConfig?.mode).toBe('on-demand')
        expect(h.doc()!.appDB['sample-files-1.0' as any]).toBeDefined()
        const traces = Object.values(logHandle.doc()!.traces)
        const t = traces.find(t => t.command === 'diskDetection' && JSON.parse(t.args).step === 'files')
        expect(t?.status).toBe('error')
        expect(t?.errorMessage).toMatch(/Files Disk bad-1: FILES.yaml is not valid YAML/)
        expect(JSON.parse(t!.args).diskId).toBe('bad-1')
    })

    it('FILES.yaml removed at runtime: the next processDisk drops the role and filesConfig', async () => {
        const { disk, root } = await dock(h, 'r-1', 'disk-files-app'); roots.push(root)
        await processDisk(h, disk)
        expect(stored(h, 'r-1').filesConfig).not.toBeNull()
        await fs.remove(`${root}/FILES.yaml`)
        await processDisk(h, stored(h, 'r-1'))
        expect([...stored(h, 'r-1').diskTypes]).toEqual(['app'])
        expect(stored(h, 'r-1').filesConfig).toBeNull()
    })

    it('undock clears filesConfig, sizeBytes and freeBytes; a redock resets filesConfig until processDisk', async () => {
        const { disk, root, device } = await dock(h, 'u-1', 'disk-files'); roots.push(root)
        await processDisk(h, disk)
        expect(stored(h, 'u-1').sizeBytes).not.toBeNull()
        await undockDisk(h, stored(h, 'u-1'))
        const d = stored(h, 'u-1')
        expect(d.dockedTo).toBeNull()
        expect(d.filesConfig).toBeNull()
        expect(d.sizeBytes).toBeNull()
        expect(d.freeBytes).toBeNull()

        await fs.ensureDir(root)
        await fs.copy(path.join(FIXTURES_DIR, 'disk-files'), root)
        const again = createOrUpdateDisk(h, LOCAL, device as DeviceName, 'u-1' as DiskID, 'Disk u-1' as DiskName, 1 as Timestamp)
        expect(stored(h, 'u-1').filesConfig).toBeNull()
        await processDisk(h, again)
        expect(stored(h, 'u-1').filesConfig?.shareName).toBe('School Files')
    })

    it('a stale record cleared from the same device loses filesConfig and size too', async () => {
        const { disk, root, device } = await dock(h, 's-old', 'disk-files'); roots.push(root)
        await processDisk(h, disk)
        h.change(doc => { clearDuplicateDiskRecords(doc, LOCAL, device as DeviceName, 's-new' as DiskID) })
        const d = stored(h, 's-old')
        expect(d.device).toBeNull()
        expect(d.filesConfig).toBeNull()
        expect(d.sizeBytes).toBeNull()
        expect(d.freeBytes).toBeNull()
    })
})

describe('Disk size and free space (idea#131)', () => {
    const GB = 1_000_000_000
    it('write rule: first value, size change, or free space moved by more than 1% of the size or 100 MB', () => {
        expect(sizeNeedsWrite({ sizeBytes: null, freeBytes: null }, { sizeBytes: 32 * GB, freeBytes: GB })).toBe(true)
        expect(sizeNeedsWrite({ sizeBytes: 32 * GB, freeBytes: GB }, { sizeBytes: 33 * GB, freeBytes: GB })).toBe(true)
        // 1 TB disk: 1% is 10 GB, so the 100 MB rule decides
        expect(sizeNeedsWrite({ sizeBytes: 1000 * GB, freeBytes: 500 * GB }, { sizeBytes: 1000 * GB, freeBytes: 500 * GB + FREE_CHANGE_BYTES })).toBe(false)
        expect(sizeNeedsWrite({ sizeBytes: 1000 * GB, freeBytes: 500 * GB }, { sizeBytes: 1000 * GB, freeBytes: 500 * GB + FREE_CHANGE_BYTES + 1_000_000 })).toBe(true)
        // 4 GB stick: 1% is 40 MB, so the 1% rule decides
        expect(sizeNeedsWrite({ sizeBytes: 4 * GB, freeBytes: 2 * GB }, { sizeBytes: 4 * GB, freeBytes: 2 * GB - 40_000_000 })).toBe(false)
        expect(sizeNeedsWrite({ sizeBytes: 4 * GB, freeBytes: 2 * GB }, { sizeBytes: 4 * GB, freeBytes: 2 * GB - 41_000_000 })).toBe(true)
    })

    it('readDiskSize uses statfs and rounds to whole MB', async () => {
        const s = await readDiskSize(DISKS_ROOT)
        expect(s.sizeBytes).toBeGreaterThan(0)
        expect(s.sizeBytes % 1_000_000).toBe(0)
        expect(s.freeBytes % 1_000_000).toBe(0)
    })

    it('updateDiskSize skips a small change unless forced; the 10-minute pass only touches disks docked here', async () => {
        const h = await newStore()
        const mk = (id: string, device: string | null, dockedTo: EngineID | null) => h.change(doc => {
            doc.diskDB[id as DiskID] = {
                id: id as DiskID, name: id as DiskName, device: device as DeviceName | null, dockedTo,
                created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: ['empty'], backupConfig: null,
            }
        })
        const real = await readDiskSize(DISKS_ROOT)
        mk('here', 'idea-test-1', LOCAL)
        mk('remote', 'idea-test-2', OTHER)
        mk('gone', null, null)
        h.change(doc => { doc.diskDB['here' as DiskID].sizeBytes = real.sizeBytes; doc.diskDB['here' as DiskID].freeBytes = real.freeBytes + 1_000_000 })
        expect(await updateDiskSize(h, 'here' as DiskID, DISKS_ROOT)).toBe(false)
        expect(h.doc()!.diskDB['here' as DiskID].freeBytes).toBe(real.freeBytes + 1_000_000)
        expect(await updateDiskSize(h, 'here' as DiskID, DISKS_ROOT, true)).toBe(true)

        h.change(doc => { doc.diskDB['here' as DiskID].sizeBytes = null; doc.diskDB['here' as DiskID].freeBytes = null })
        await refreshDiskSizes(h, LOCAL, async () => DISKS_ROOT)
        const doc = h.doc()!
        expect(doc.diskDB['here' as DiskID].sizeBytes).toBe(real.sizeBytes)
        expect(doc.diskDB['remote' as DiskID].sizeBytes).toBeUndefined()
        expect(doc.diskDB['gone' as DiskID].sizeBytes).toBeUndefined()
    })

    it('diskFsRoot gives the mount point the size is read from', async () => {
        const d = { id: 'x', device: 'idea-test-9', diskTypes: [] } as any
        expect(await diskFsRoot(d)).toBe(`${DISKS_ROOT}/idea-test-9`)
    })
})

describe('share name rule (idea#131, E6)', () => {
    it('accepts 1–16 characters from A–Z a–z 0–9 space - _ ( )', () => {
        for (const ok of ['School Files', 'My Share (2)', 'a', 'A-b_c (D) 0123', '1234567890123456']) expect(validateShareName(ok)).toBeNull()
    })
    it('refuses over 16 bytes, other characters, empty, and a leading or trailing space', () => {
        for (const bad of ['12345678901234567', 'Schul-Dateien ä', 'a/b', 'a.b', 'x"y', '', ' Lead', 'Trail ', 'tab\there', 'émoji']) {
            expect(validateShareName(bad)).not.toBeNull()
        }
    })
})
