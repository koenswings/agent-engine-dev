/**
 * meta-created-default.test.ts (idea#394, found in idea#139)
 *
 * A META.yaml without `created` crashed the dock: createOrUpdateDisk assigned
 * undefined into the Automerge store ("Cannot assign undefined value at
 * /diskDB/<id>/created"). readMetaUpdateId now defaults `created` (previous
 * lastDocked, else now) with a warning naming the disk, and persists it through
 * the normal META rewrite. createOrUpdateDisk never assigns undefined
 * `created` / `name`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fs, YAML } from 'zx'
import { Repo } from '@automerge/automerge-repo'
import { config, disksRoot } from '../../src/data/Config.js'
import { readMetaUpdateId, applyMetaDefaults, DiskMeta } from '../../src/data/Meta.js'
import { createOrUpdateDisk } from '../../src/data/Disk.js'
import { Store } from '../../src/data/Store.js'
import { setVerbosity, verbosityLevel } from '../../src/utils/utils.js'
import { DeviceName, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'

const DEV = 'idea-test-394' as DeviceName
const metaPath = () => `${disksRoot()}/${DEV}/META.yaml`
const saved = { ...config.settings }
const savedVerbosity = verbosityLevel
let info: ReturnType<typeof vi.spyOn>
const logged = () => info.mock.calls.map(c => c.map(String).join(' ')).join('\n')

const writeMeta = async (meta: Record<string, unknown>) => {
    await fs.ensureDir(`${disksRoot()}/${DEV}`)
    await fs.writeFile(metaPath(), YAML.stringify(meta))
}
const newStore = () => new Repo({ network: [] }).create<Store>({ diskDB: {} } as unknown as Store)

beforeEach(() => {
    config.settings.isDev = false
    config.settings.testMode = true
    config.settings.skipHardwareId = undefined
    config.settings.skipMetaUpdate = undefined
    setVerbosity(2)
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
    vi.restoreAllMocks()
    setVerbosity(savedVerbosity)
    Object.assign(config.settings, saved)
    if (saved.skipHardwareId === undefined) delete config.settings.skipHardwareId
    if (saved.skipMetaUpdate === undefined) delete config.settings.skipMetaUpdate
    await fs.remove(`${disksRoot()}/${DEV}`)
})

describe('applyMetaDefaults', () => {
    it('missing created → previous lastDocked, with a warning naming the disk', () => {
        const meta = { diskId: 'diskb202610301203', diskName: 'B', lastDocked: 2000 } as unknown as DiskMeta
        expect(applyMetaDefaults(meta, '/x/META.yaml', () => 9999)).toBe(true)
        expect(meta.created).toBe(2000)
        expect(logged()).toMatch(/WARNING.*diskb202610301203.*created/)
    })
    it('missing created and lastDocked → now', () => {
        const meta = { diskId: 'd1', diskName: 'B' } as unknown as DiskMeta
        expect(applyMetaDefaults(meta, '/x/META.yaml', () => 9999)).toBe(true)
        expect(meta.created).toBe(9999)
    })
    it('present created → unchanged, no warning', () => {
        const meta = { diskId: 'd1', diskName: 'B', created: 1000, lastDocked: 2000 } as unknown as DiskMeta
        expect(applyMetaDefaults(meta, '/x/META.yaml', () => 9999)).toBe(false)
        expect(meta.created).toBe(1000)
        expect(logged()).not.toMatch(/WARNING/)
    })
})

describe('dock path: readMetaUpdateId → createOrUpdateDisk', () => {
    it('META without created docks; created defaulted in the store (was: Automerge undefined crash)', async () => {
        await writeMeta({ diskId: 'diskb202610301203', isHardwareId: false, diskName: 'Files Disk B', lastDocked: 2000 })
        const meta = await readMetaUpdateId(DEV)
        expect(meta.created).toBe(2000)
        const h = newStore()
        expect(() => createOrUpdateDisk(h, 'ENGINE_x' as EngineID, DEV, meta.diskId, meta.diskName, meta.created)).not.toThrow()
        expect(h.doc().diskDB['diskb202610301203' as DiskID].created).toBe(2000)
        expect(logged()).toMatch(/WARNING.*diskb202610301203/)
    })
    it('present created is kept as is', async () => {
        await writeMeta({ diskId: 'd-present', isHardwareId: false, diskName: 'A', created: 1000, lastDocked: 2000 })
        const meta = await readMetaUpdateId(DEV)
        expect(meta.created).toBe(1000)
        expect(logged()).not.toMatch(/WARNING/)
    })
    it('skipMetaUpdate false: the defaulted created is persisted to META.yaml', async () => {
        config.settings.skipMetaUpdate = false
        await writeMeta({ diskId: 'd-persist', isHardwareId: false, diskName: 'A', lastDocked: 2000 })
        await readMetaUpdateId(DEV)
        expect(YAML.parse(await fs.readFile(metaPath(), 'utf8')).created).toBe(2000)
    })
    it('diskName: null in META is upgraded to the disk id (never undefined/null in the store)', async () => {
        await writeMeta({ diskId: 'd-noname', isHardwareId: false, diskName: null, created: 1, lastDocked: 2 })
        const meta = await readMetaUpdateId(DEV)
        expect(meta.diskName).toBe('d-noname')
    })
})

describe('createOrUpdateDisk guards', () => {
    it('new record: undefined created/name are defaulted, not assigned', () => {
        const h = newStore()
        const t0 = Date.now()
        createOrUpdateDisk(h, 'ENGINE_x' as EngineID, DEV, 'd2' as DiskID, undefined as unknown as DiskName, undefined as unknown as Timestamp)
        const d = h.doc().diskDB['d2' as DiskID]
        expect(d.created).toBeGreaterThanOrEqual(t0)
        expect(d.name).toBe('d2')
    })
    it('existing record: undefined created/name keep the stored values', () => {
        const h = newStore()
        createOrUpdateDisk(h, 'ENGINE_x' as EngineID, DEV, 'd3' as DiskID, 'Named' as DiskName, 1000 as Timestamp)
        createOrUpdateDisk(h, 'ENGINE_x' as EngineID, DEV, 'd3' as DiskID, undefined as unknown as DiskName, undefined as unknown as Timestamp)
        const d = h.doc().diskDB['d3' as DiskID]
        expect(d.created).toBe(1000)
        expect(d.name).toBe('Named')
    })
})
