/**
 * engine-id-freeze.test.ts (idea#524, Koen 15 Nov 2026)
 *
 * Once an Engine has an id it is frozen: redeploys and updates never overwrite the
 * /META.yaml diskId (Engine id = ENGINE_<diskId>) with a newly readable root drive
 * serial. engine#361 made hdparm readable and flipped golden (ENGINE_i3qlub… →
 * ENGINE_AA000000000000055000) and production (→ ENGINE_AA000000000000000724).
 * Only a first boot with no diskId (a sanitised image, or no /META.yaml at all)
 * takes ENGINE_<serial>, or a random id without a serial.
 *
 * The system META is a temp file (IDEA_SYSTEM_META, honoured only under NODE_ENV=test)
 * and the serial lookup is mocked. Never touches the real /META.yaml.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import { fs, path, YAML } from 'zx'
import { config } from '../../src/data/Config.js'
import { readMetaUpdateId, systemDiskIdFrozen, addMeta, readRemoteSystemDiskId, DiskMeta } from '../../src/data/Meta.js'
import { createEngineIdFromDiskId } from '../../src/data/Engine.js'
import { DiskID, DeviceName } from '../../src/data/CommonTypes.js'

const savedSettings = { ...config.settings }
const savedEnv = { meta: process.env.IDEA_SYSTEM_META, nodeEnv: process.env.NODE_ENV }

const PRODUCTION = { diskId: 'AA000000000000000724', isHardwareId: true, diskName: '0dmlarhzg41l4ie4agg', created: 1700000000000, lastDocked: 1700000000000, version: '1.0' }
const GOLDEN = { diskId: 'AA000000000000055000', isHardwareId: true, diskName: 'i3qlubws0txx4k23wje', created: 1700000000000, lastDocked: 1700000000000, version: '1.0' }
// Golden before engine#361: a random id, written while hdparm was not readable
const GOLDEN_PRE_361 = { diskId: 'i3qlubws0txx4k23wje', isHardwareId: false, diskName: 'i3qlubws0txx4k23wje', created: 1700000000000, lastDocked: 1700000000000, version: '1.0' }
const SANITISED = { diskName: 'i3qlubws0txx4k23wje', created: 1700000000000, lastDocked: 1700000000000, version: '1.0' }
const NEW_SERIAL = 'AA000000000000099999'

let dirs: string[] = []
const newRoot = async (meta?: object): Promise<string> => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-id-freeze-'))
    dirs.push(d)
    if (meta) await fs.writeFile(path.join(d, 'META.yaml'), YAML.stringify(meta))
    return d
}
const metaOf = async (root: string) => YAML.parse(await fs.readFile(path.join(root, 'META.yaml'), 'utf8'))

/** One Engine start (a redeploy, update or reboot) on `root`: the Engine id it derives. */
const boot = async (root: string, serial: string | undefined) => {
    process.env.IDEA_SYSTEM_META = path.join(root, 'META.yaml')
    const readHardwareId = vi.fn(async (_d: DeviceName) => serial as DiskID | undefined)
    const meta = await readMetaUpdateId(undefined, { readHardwareId })
    return { id: String(createEngineIdFromDiskId(meta.diskId)), readHardwareId }
}

beforeEach(() => {
    process.env.NODE_ENV = 'test'
    config.settings.isDev = false
    config.settings.testMode = false
    config.settings.skipMetaUpdate = false   // a real Engine writes META back (lastDocked, a new id)
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

describe('Engine id freeze: an existing id survives redeploys (idea#524)', () => {
    for (const skip of [false, true]) {
        it(`production keeps ENGINE_AA000000000000000724 when another serial becomes readable (skipHardwareId=${skip})`, async () => {
            config.settings.skipHardwareId = skip
            const root = await newRoot(PRODUCTION)
            for (let i = 0; i < 3; i++) {
                const { id, readHardwareId } = await boot(root, NEW_SERIAL)
                expect(id).toBe('ENGINE_AA000000000000000724')
                expect(readHardwareId).not.toHaveBeenCalled()
            }
            const m = await metaOf(root)
            expect(m.diskId).toBe('AA000000000000000724')
            expect(m.isHardwareId).toBe(true)
            expect(m.diskName).toBe(PRODUCTION.diskName)
        })

        it(`golden keeps ENGINE_AA000000000000055000 when another serial becomes readable (skipHardwareId=${skip})`, async () => {
            config.settings.skipHardwareId = skip
            const root = await newRoot(GOLDEN)
            const { id, readHardwareId } = await boot(root, NEW_SERIAL)
            expect(id).toBe('ENGINE_AA000000000000055000')
            expect(readHardwareId).not.toHaveBeenCalled()
            expect((await metaOf(root)).diskId).toBe('AA000000000000055000')
        })
    }

    it('golden before engine#361: a random id is no longer replaced by the now readable hdparm serial', async () => {
        config.settings.skipHardwareId = false
        const root = await newRoot(GOLDEN_PRE_361)
        const { id } = await boot(root, 'AA000000000000055000')
        expect(id).toBe('ENGINE_i3qlubws0txx4k23wje')
        const m = await metaOf(root)
        expect(m.diskId).toBe('i3qlubws0txx4k23wje')
        expect(m.isHardwareId).toBe(false)
    })

    it('a hardware id stays even when its serial can no longer be read', async () => {
        config.settings.skipHardwareId = false
        const root = await newRoot(PRODUCTION)
        expect((await boot(root, undefined)).id).toBe('ENGINE_AA000000000000000724')
    })

    it('systemDiskIdFrozen: only the system disk with a diskId; App Disk partitions keep their own rules', () => {
        const frozen = (m: object, dev?: DeviceName) => systemDiskIdFrozen(m as Partial<DiskMeta>, dev)
        expect(frozen(PRODUCTION)).toBe(true)
        expect(frozen(GOLDEN_PRE_361)).toBe(true)
        expect(frozen(SANITISED)).toBe(false)
        expect(frozen({ ...SANITISED, diskId: '' })).toBe(false)
        expect(frozen({ ...SANITISED, diskId: 'undefined' })).toBe(false)
        expect(systemDiskIdFrozen(null)).toBe(false)
        expect(frozen(PRODUCTION, 'sdb1' as DeviceName)).toBe(false)
    })
})

describe('Engine id freeze: first boot with no id (idea#524)', () => {
    it('sanitised META (no diskId) with a readable serial: ENGINE_<serial>, then frozen', async () => {
        config.settings.skipHardwareId = false
        const root = await newRoot(SANITISED)
        expect((await boot(root, 'AA000000000000055001')).id).toBe('ENGINE_AA000000000000055001')
        const m = await metaOf(root)
        expect(m.diskId).toBe('AA000000000000055001')
        expect(m.isHardwareId).toBe(true)
        // a later boot reading another serial keeps it
        const again = await boot(root, NEW_SERIAL)
        expect(again.id).toBe('ENGINE_AA000000000000055001')
        expect(again.readHardwareId).not.toHaveBeenCalled()
    })

    it('sanitised META (no diskId) without a serial: a random id, then frozen when a serial becomes readable', async () => {
        config.settings.skipHardwareId = false
        const root = await newRoot(SANITISED)
        const first = (await boot(root, undefined)).id
        expect(first).toMatch(/^ENGINE_[0-9a-z-]{10,}$/)
        expect(first).not.toBe('ENGINE_undefined')
        expect((await metaOf(root)).isHardwareId).toBe(false)
        expect((await boot(root, NEW_SERIAL)).id).toBe(first)
    })

    it('no /META.yaml at all with a readable serial: created as ENGINE_<serial>, then frozen', async () => {
        config.settings.skipHardwareId = false
        const root = await newRoot()
        expect((await boot(root, 'AA000000000000055002')).id).toBe('ENGINE_AA000000000000055002')
        expect((await metaOf(root)).isHardwareId).toBe(true)
        expect((await boot(root, NEW_SERIAL)).id).toBe('ENGINE_AA000000000000055002')
    })

    it('no /META.yaml at all without a serial: created with a random id, then frozen', async () => {
        config.settings.skipHardwareId = false
        const root = await newRoot()
        const first = (await boot(root, undefined)).id
        expect(first).toMatch(/^ENGINE_[0-9a-z-]{10,}$/)
        expect((await boot(root, NEW_SERIAL)).id).toBe(first)
    })
})

describe('build-engine addMeta keeps an existing id on a rebuild (idea#524)', () => {
    /** A fake remote exec: records commands, answers `sudo cat /META.yaml` and hdparm. */
    const fakeExec = (existingMeta: string | null, serial: string | null) => {
        const cmds: string[] = []
        const exec = async (pieces: TemplateStringsArray, ...args: unknown[]) => {
            const cmd = pieces.reduce((a, p, i) => a + p + (i < args.length ? String(args[i]) : ''), '')
            cmds.push(cmd)
            if (cmd === 'sudo cat /META.yaml') {
                if (existingMeta === null) throw new Error('No such file or directory')
                return { stdout: existingMeta }
            }
            if (cmd.startsWith('findmnt')) return { stdout: '/dev/sda2\n' }
            if (cmd === 'which hdparm') return { stdout: '/usr/sbin/hdparm\n' }
            if (cmd.includes('-I /dev/')) {
                if (serial === null) throw new Error('no serial')
                return { stdout: `\tSerial Number:      ${serial}\n` }
            }
            return { stdout: '' }
        }
        return { exec, cmds, writes: () => cmds.filter(c => c.includes('/META.yaml') && c !== 'sudo cat /META.yaml') }
    }

    it('keepExistingId: an existing diskId is kept and /META.yaml is not rewritten', async () => {
        const f = fakeExec(YAML.stringify(PRODUCTION), NEW_SERIAL)
        expect(await addMeta(f.exec, 'idea', '1.0', { keepExistingId: true })).toBe('AA000000000000000724')
        expect(f.writes()).toEqual([])
        expect(f.cmds.some(c => c.includes('hdparm'))).toBe(false)
    })

    it('keepExistingId with no /META.yaml or no diskId: writes the serial id', async () => {
        for (const existing of [null, YAML.stringify(SANITISED)]) {
            const f = fakeExec(existing, NEW_SERIAL)
            expect(await addMeta(f.exec, 'idea', '1.0', { keepExistingId: true })).toBe(NEW_SERIAL)
            expect(f.writes()).toContain(`echo 'diskId: ${NEW_SERIAL}' | sudo tee -a /META.yaml`)
        }
    })

    it('without keepExistingId (--personalize on a MASTER clone, reset-engine --meta): regenerates as before', async () => {
        const f = fakeExec(YAML.stringify(PRODUCTION), NEW_SERIAL)
        expect(await addMeta(f.exec, 'idea', '1.0')).toBe(NEW_SERIAL)
        expect(f.writes()).toContain('sudo rm -f /META.yaml')
    })

    it('readRemoteSystemDiskId: the diskId, or undefined for no file / no diskId', async () => {
        expect(await readRemoteSystemDiskId(fakeExec(YAML.stringify(GOLDEN), null).exec)).toBe('AA000000000000055000')
        expect(await readRemoteSystemDiskId(fakeExec(YAML.stringify(SANITISED), null).exec)).toBeUndefined()
        expect(await readRemoteSystemDiskId(fakeExec(null, null).exec)).toBeUndefined()
        expect(await readRemoteSystemDiskId(fakeExec('', null).exec)).toBeUndefined()
    })
})
