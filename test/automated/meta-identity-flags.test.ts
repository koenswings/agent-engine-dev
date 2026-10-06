/**
 * meta-identity-flags.test.ts (idea#168 Stage 1)
 *
 * readMetaUpdateId's two testMode gates are now flags of their own, defaulting
 * to the old gate (isDev || testMode), like skipBorg / skipImageLoad:
 *   - skipHardwareId (IDEA_SKIP_HARDWARE_ID): keep the META diskId, no serial lookup
 *   - skipMetaUpdate (IDEA_SKIP_META_UPDATE): no lastDocked / id / format rewrite of
 *     an existing META.yaml, and no creation of a missing /META.yaml
 * Both must work under fixture mounts: a pi-owned IDEA_DISKS_ROOT (set by
 * script/test-run.sh) and device names like idea-test-N with no /sys/block entry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fs, YAML } from 'zx'
import { config, disksRoot, skipHardwareId, skipMetaUpdate } from '../../src/data/Config.js'
import { readMetaUpdateId, allowSystemMetaCreate } from '../../src/data/Meta.js'
import { DeviceName } from '../../src/data/CommonTypes.js'

const DEV = 'idea-test-81' as DeviceName
const metaPath = () => `${disksRoot()}/${DEV}/META.yaml`
const saved = { ...config.settings }

const writeFixtureMeta = async (extra: Record<string, unknown> = {}) => {
    await fs.ensureDir(`${disksRoot()}/${DEV}`)
    const meta = { diskId: 'duration-kolibri-grade5a-001', isHardwareId: false, diskName: 'Duration Tests — Kolibri', created: 1000, lastDocked: 2000, ...extra }
    await fs.writeFile(metaPath(), YAML.stringify(meta))
    return fs.readFile(metaPath(), 'utf8')
}

beforeEach(() => {
    config.settings.isDev = false
    config.settings.testMode = true
    config.settings.skipHardwareId = undefined
    config.settings.skipMetaUpdate = undefined
    vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(async () => {
    vi.restoreAllMocks()
    Object.assign(config.settings, saved)
    if (saved.skipHardwareId === undefined) delete config.settings.skipHardwareId
    if (saved.skipMetaUpdate === undefined) delete config.settings.skipMetaUpdate
    await fs.remove(`${disksRoot()}/${DEV}`)
})

describe('skipHardwareId() / skipMetaUpdate() resolution', () => {
    it('unset → isDev || testMode; explicit true/false wins', () => {
        expect([skipHardwareId(), skipMetaUpdate(), allowSystemMetaCreate()]).toEqual([true, true, false])
        config.settings.testMode = false
        expect([skipHardwareId(), skipMetaUpdate(), allowSystemMetaCreate()]).toEqual([false, false, true])
        config.settings.isDev = true
        expect([skipHardwareId(), skipMetaUpdate(), allowSystemMetaCreate()]).toEqual([true, true, false])
        config.settings.skipHardwareId = false
        config.settings.skipMetaUpdate = false
        expect([skipHardwareId(), skipMetaUpdate(), allowSystemMetaCreate()]).toEqual([false, false, true])
        config.settings.isDev = false
        config.settings.skipHardwareId = true
        config.settings.skipMetaUpdate = true
        expect([skipHardwareId(), skipMetaUpdate(), allowSystemMetaCreate()]).toEqual([true, true, false])
    })

    it('IDEA_SKIP_HARDWARE_ID / IDEA_SKIP_META_UPDATE = true|false set the settings at load; other values leave them unset', async () => {
        const prev = { h: process.env.IDEA_SKIP_HARDWARE_ID, m: process.env.IDEA_SKIP_META_UPDATE }
        try {
            for (const [env, want] of [['false', false], ['true', true], ['no', undefined]] as const) {
                vi.resetModules()
                process.env.IDEA_SKIP_HARDWARE_ID = env
                process.env.IDEA_SKIP_META_UPDATE = env
                const fresh = await import('../../src/data/Config.js')
                expect(fresh.config.settings.skipHardwareId, `IDEA_SKIP_HARDWARE_ID=${env}`).toBe(want)
                expect(fresh.config.settings.skipMetaUpdate, `IDEA_SKIP_META_UPDATE=${env}`).toBe(want)
            }
        } finally {
            for (const [k, v] of [['IDEA_SKIP_HARDWARE_ID', prev.h], ['IDEA_SKIP_META_UPDATE', prev.m]] as const) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
            vi.resetModules()
        }
    })
})

describe('readMetaUpdateId on a fixture mount (pi-owned IDEA_DISKS_ROOT)', () => {
    it('testMode, flags unset: META.yaml left byte-for-byte, diskId kept (even with isHardwareId: true)', async () => {
        const before = await writeFixtureMeta({ isHardwareId: true })
        const meta = await readMetaUpdateId(DEV)
        expect(meta.diskId).toBe('duration-kolibri-grade5a-001')
        expect(await fs.readFile(metaPath(), 'utf8')).toBe(before)
    })

    it('skipMetaUpdate false under testMode: lastDocked rewritten as pi (plain write), diskId and name kept', async () => {
        config.settings.skipMetaUpdate = false
        await writeFixtureMeta()
        const t0 = Date.now()
        const meta = await readMetaUpdateId(DEV)
        const onDisk = YAML.parse(await fs.readFile(metaPath(), 'utf8'))
        expect(onDisk.diskId).toBe('duration-kolibri-grade5a-001')
        expect(onDisk.diskName).toBe('Duration Tests — Kolibri')
        expect(onDisk.lastDocked).toBeGreaterThanOrEqual(t0)
        expect(meta.lastDocked).toBe(onDisk.lastDocked)
        expect((await fs.stat(metaPath())).uid).toBe(process.getuid!())
    })

    it('skipMetaUpdate false: an older META without diskName is upgraded on disk', async () => {
        config.settings.skipMetaUpdate = false
        await fs.ensureDir(`${disksRoot()}/${DEV}`)
        await fs.writeFile(metaPath(), YAML.stringify({ diskId: 'duration-empty-001', isHardwareId: false, created: 1, lastDocked: 2, hostname: 'idea01' }))
        await readMetaUpdateId(DEV)
        const onDisk = YAML.parse(await fs.readFile(metaPath(), 'utf8'))
        expect(onDisk.diskName).toBe('duration-empty-001')
        expect(onDisk.hostname).toBeUndefined()
    })

    it('skipHardwareId false under testMode: the lookup runs; a fixture (no /sys/block entry, isHardwareId: false) keeps its id', async () => {
        config.settings.skipHardwareId = false
        const before = await writeFixtureMeta()
        const meta = await readMetaUpdateId(DEV)
        expect(meta.diskId).toBe('duration-kolibri-grade5a-001')
        expect(await fs.readFile(metaPath(), 'utf8')).toBe(before)        // skipMetaUpdate still follows testMode
    })

    it('skipHardwareId false: META claiming a hardware id on a device without one is treated as a clone (proves the lookup ran)', async () => {
        config.settings.skipHardwareId = false
        await writeFixtureMeta({ diskId: 'AA000000000000000724', isHardwareId: true })
        const meta = await readMetaUpdateId(DEV)
        expect(meta.diskId).not.toBe('AA000000000000000724')
        expect(meta.isHardwareId).toBe(false)
        // and with skipHardwareId unset again the id is kept
        config.settings.skipHardwareId = undefined
        await writeFixtureMeta({ diskId: 'AA000000000000000724', isHardwareId: true })
        expect((await readMetaUpdateId(DEV)).diskId).toBe('AA000000000000000724')
    })
})
