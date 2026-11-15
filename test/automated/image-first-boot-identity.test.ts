/**
 * image-first-boot-identity.test.ts (idea#524, image safety)
 *
 * Two Pis flashed from one sanitised Engine image must get two different Engine ids.
 * sanitise (Engine IDENTITY_PATHS + idea tools/engine-image/sanitise.sh) leaves a
 * /META.yaml without diskId and isHardwareId (diskName and the rest stay). This
 * simulates the first boot of two such copies: two temp roots, each with its own
 * META.yaml, read through readMetaUpdateId() as the system disk (IDEA_SYSTEM_META,
 * honoured only under NODE_ENV=test) with the hardware serial lookup mocked.
 *
 * The id freeze (once set, the Engine id never changes) is in engine-id-freeze.test.ts;
 * this pins the first boot of a sanitised image. Never touches /META.yaml.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import { fs, path, YAML } from 'zx'
import { config } from '../../src/data/Config.js'
import { readMetaUpdateId } from '../../src/data/Meta.js'
import { createEngineIdFromDiskId } from '../../src/data/Engine.js'
import { DiskID, DeviceName } from '../../src/data/CommonTypes.js'

const savedSettings = { ...config.settings }
const savedEnv = { meta: process.env.IDEA_SYSTEM_META, nodeEnv: process.env.NODE_ENV }

// What a sanitised image carries: golden's diskName and the rest, no diskId / isHardwareId
const SANITISED_META = { diskName: 'i3qlubws0txx4k23wje', created: 1700000000000, lastDocked: 1700000000000, version: '1.0' }

let dirs: string[] = []
const newRoot = async (): Promise<string> => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-image-copy-'))
    dirs.push(d)
    await fs.writeFile(path.join(d, 'META.yaml'), YAML.stringify(SANITISED_META))
    return d
}

/** One Engine start on the copy at `root`: the Engine id it derives. */
const boot = async (root: string, serial: string | undefined): Promise<string> => {
    process.env.IDEA_SYSTEM_META = path.join(root, 'META.yaml')
    const readHardwareId = vi.fn(async (_d: DeviceName) => serial as DiskID | undefined)
    const meta = await readMetaUpdateId(undefined, { readHardwareId })
    return String(createEngineIdFromDiskId(meta.diskId))
}

beforeEach(() => {
    process.env.NODE_ENV = 'test'
    config.settings.isDev = false
    config.settings.testMode = false
    config.settings.skipMetaUpdate = false   // a real first boot writes the new id back to META.yaml
    vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(async () => {
    vi.restoreAllMocks()
    Object.assign(config.settings, savedSettings)
    if (savedSettings.skipHardwareId === undefined) delete config.settings.skipHardwareId
    if (savedSettings.skipMetaUpdate === undefined) delete config.settings.skipMetaUpdate
    if (savedEnv.meta === undefined) delete process.env.IDEA_SYSTEM_META; else process.env.IDEA_SYSTEM_META = savedEnv.meta
    if (savedEnv.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv.nodeEnv
    for (const d of dirs) await fs.remove(d)
    dirs = []
})

describe('two first boots of one sanitised Engine image (idea#524)', () => {
    for (const skip of [true, false]) {
        it(`no hardware serial, skipHardwareId=${skip}: two different Engine ids, each stable on the next boot`, async () => {
            config.settings.skipHardwareId = skip
            const a = await newRoot(), b = await newRoot()
            const idA = await boot(a, undefined), idB = await boot(b, undefined)
            expect(idA).toMatch(/^ENGINE_[0-9a-z-]{10,}$/)
            expect(idB).toMatch(/^ENGINE_[0-9a-z-]{10,}$/)
            expect(idA).not.toBe('ENGINE_undefined')
            expect(idA).not.toBe(idB)
            // the generated id was written back, so the second boot keeps it
            expect(await boot(a, undefined)).toBe(idA)
            expect(await boot(b, undefined)).toBe(idB)
            const m = YAML.parse(await fs.readFile(path.join(a, 'META.yaml'), 'utf8'))
            expect(m.isHardwareId).toBe(false)
            expect(m.diskName).toBe(SANITISED_META.diskName)   // the display name is copied (cosmetic)
        })
    }

    it('two different hardware serials (skipHardwareId=false): ENGINE_<serial> each, different', async () => {
        config.settings.skipHardwareId = false
        const a = await newRoot(), b = await newRoot()
        const idA = await boot(a, 'AA000000000000055001'), idB = await boot(b, 'AA000000000000055002')
        expect(idA).toBe('ENGINE_AA000000000000055001')
        expect(idB).toBe('ENGINE_AA000000000000055002')
        expect(idA).not.toBe(idB)
    })

    it('skipHardwareId=true ignores the serial but still gives each copy its own id', async () => {
        config.settings.skipHardwareId = true
        const a = await newRoot(), b = await newRoot()
        const idA = await boot(a, 'AA000000000000055001'), idB = await boot(b, 'AA000000000000055002')
        expect(idA).not.toBe(idB)
        expect(idA).not.toContain('AA0000')
    })

    it('contrast: an UNSANITISED copy (diskId kept) with skipHardwareId=true shares the id', async () => {
        config.settings.skipHardwareId = true
        const a = await newRoot(), b = await newRoot()
        for (const d of [a, b]) await fs.writeFile(path.join(d, 'META.yaml'), YAML.stringify({ ...SANITISED_META, diskId: 'AA000000000000055000', isHardwareId: false }))
        expect(await boot(a, undefined)).toBe('ENGINE_AA000000000000055000')
        expect(await boot(b, undefined)).toBe('ENGINE_AA000000000000055000')
    })
})
