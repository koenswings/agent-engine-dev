/**
 * system-meta-path.test.ts
 *
 * The box `pnpm test:full` gate must not depend on the host `/META.yaml`.
 * `IDEA_SYSTEM_META` may point at a test-local file, but only when
 * `NODE_ENV=test` or `IDEA_TEST_MODE=true`. On a Pi those are unset, so a
 * stray env var cannot redirect production away from `/META.yaml`.
 *
 * Never writes or deletes the real `/META.yaml`.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'os'
import { fs, path } from 'zx'
import { SYSTEM_META_PATH, systemMetaPath, readMetaUpdateId } from '../../src/data/Meta.js'

const saved = {
    meta: process.env.IDEA_SYSTEM_META,
    testMode: process.env.IDEA_TEST_MODE,
    nodeEnv: process.env.NODE_ENV,
}

const restoreEnv = () => {
    const set = (key: 'IDEA_SYSTEM_META' | 'IDEA_TEST_MODE' | 'NODE_ENV', val: string | undefined) => {
        if (val === undefined) delete process.env[key]
        else process.env[key] = val
    }
    set('IDEA_SYSTEM_META', saved.meta)
    set('IDEA_TEST_MODE', saved.testMode)
    set('NODE_ENV', saved.nodeEnv)
}

let dir = ''
beforeEach(async () => {
    restoreEnv()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-system-meta-'))
})
afterEach(async () => {
    restoreEnv()
    if (dir) await fs.remove(dir)
})

describe('systemMetaPath (test-local system META, host /META.yaml unchanged)', () => {
    it('defaults to /META.yaml when IDEA_SYSTEM_META is unset', () => {
        delete process.env.IDEA_SYSTEM_META
        expect(SYSTEM_META_PATH).toBe('/META.yaml')
        expect(systemMetaPath()).toBe('/META.yaml')
    })

    it('uses IDEA_SYSTEM_META when NODE_ENV=test', () => {
        process.env.IDEA_SYSTEM_META = path.join(dir, 'META.yaml')
        process.env.NODE_ENV = 'test'
        delete process.env.IDEA_TEST_MODE
        expect(systemMetaPath()).toBe(path.join(dir, 'META.yaml'))
    })

    it('uses IDEA_SYSTEM_META when IDEA_TEST_MODE=true', () => {
        process.env.IDEA_SYSTEM_META = path.join(dir, 'META.yaml')
        process.env.IDEA_TEST_MODE = 'true'
        process.env.NODE_ENV = 'production'
        expect(systemMetaPath()).toBe(path.join(dir, 'META.yaml'))
    })

    it('ignores IDEA_SYSTEM_META when not in a test (production Pi behaviour)', () => {
        process.env.IDEA_SYSTEM_META = path.join(dir, 'META.yaml')
        delete process.env.IDEA_TEST_MODE
        process.env.NODE_ENV = 'production'
        expect(systemMetaPath()).toBe('/META.yaml')
    })

    it('readMetaUpdateId with no device reads the test-local file, not /META.yaml', async () => {
        const metaFile = path.join(dir, 'META.yaml')
        await fs.writeFile(metaFile, [
            'diskId: idea-test-engine',
            'isHardwareId: false',
            'diskName: idea-test-engine',
            'created: 1700000000000',
            'lastDocked: 1700000000000',
            'version: "1.0"',
            '',
        ].join('\n'))
        process.env.IDEA_SYSTEM_META = metaFile
        process.env.IDEA_TEST_MODE = 'true'
        process.env.NODE_ENV = 'test'
        const hostBefore = await fs.stat('/META.yaml').catch(() => null)
        const meta = await readMetaUpdateId()
        expect(meta.diskId).toBe('idea-test-engine')
        expect(meta.diskName).toBe('idea-test-engine')
        const hostAfter = await fs.stat('/META.yaml').catch(() => null)
        // Must not create, delete, or rewrite the host /META.yaml.
        if (hostBefore === null) expect(hostAfter).toBeNull()
        else {
            expect(hostAfter).not.toBeNull()
            expect(hostAfter!.mtimeMs).toBe(hostBefore.mtimeMs)
            expect(hostAfter!.size).toBe(hostBefore.size)
        }
    })
})
