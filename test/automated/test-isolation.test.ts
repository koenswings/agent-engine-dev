/**
 * test-isolation.test.ts
 *
 * Verifies the guarantees of idea#105: Engine tests share nothing with a live Engine.
 *
 *   1. The system disk is always skipped (IDEA_SYSTEM_DISK_SKIP=true)
 *   2. Tests use a private watch folder and a private mount root
 *      (never /dev/engine or /disks) and the Engine honours the mount root
 *   3. Pretend disks use test-only names that a live Engine ignores
 *   4. Tests run from dist-test/, never dist/
 *   6. Fixture containers carry the test label; cleanup filters on it
 *
 * (Requirement 5, the pre-flight check, lives in script/test-preflight.sh and
 * runs before vitest starts.)
 */

import { describe, it, expect } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import { fs, YAML } from 'zx'
import {
    assertTestIsolation,
    labelFixtureComposeFiles,
    DISKS_ROOT,
    DEV_ROOT,
    FIXTURES_DIR,
    TEST_DEVICE,
    TEST_CONTAINER_LABEL_KEY,
    TEST_CONTAINER_LABEL_VALUE,
    diskPath,
    sentinelPath,
    uniqueTestDevice,
} from '../harness/diskSim.js'
import { config, disksRoot } from '../../src/data/Config.js'
import { isTestDeviceName } from '../../src/monitors/usbDeviceMonitor.js'
import { diskMountRoot } from '../../src/data/Disk.js'

const PRIVATE = '/tmp/idea-test-abc'

describe('Test isolation guard (diskSim.assertTestIsolation)', () => {
    const good = { IDEA_SYSTEM_DISK_SKIP: 'true', IDEA_WATCH_DIR: `${PRIVATE}/watch`, IDEA_DISKS_ROOT: `${PRIVATE}/disks` }

    it('accepts a private watch folder and mount root with the system disk skipped', () => {
        expect(assertTestIsolation(good)).toEqual({ watchDir: `${PRIVATE}/watch`, disksRoot: `${PRIVATE}/disks` })
    })

    it('rejects when IDEA_SYSTEM_DISK_SKIP is not true', () => {
        expect(() => assertTestIsolation({ ...good, IDEA_SYSTEM_DISK_SKIP: undefined })).toThrow(/IDEA_SYSTEM_DISK_SKIP/)
        expect(() => assertTestIsolation({ ...good, IDEA_SYSTEM_DISK_SKIP: 'false' })).toThrow(/IDEA_SYSTEM_DISK_SKIP/)
    })

    it('rejects a missing or live watch folder', () => {
        expect(() => assertTestIsolation({ ...good, IDEA_WATCH_DIR: undefined })).toThrow(/IDEA_WATCH_DIR/)
        expect(() => assertTestIsolation({ ...good, IDEA_WATCH_DIR: '/dev/engine' })).toThrow(/IDEA_WATCH_DIR/)
        expect(() => assertTestIsolation({ ...good, IDEA_WATCH_DIR: '/dev/engine/' })).toThrow(/IDEA_WATCH_DIR/)
        expect(() => assertTestIsolation({ ...good, IDEA_WATCH_DIR: '/dev/engine/sub' })).toThrow(/IDEA_WATCH_DIR/)
    })

    it('rejects a missing or live mount root', () => {
        expect(() => assertTestIsolation({ ...good, IDEA_DISKS_ROOT: undefined })).toThrow(/IDEA_DISKS_ROOT/)
        expect(() => assertTestIsolation({ ...good, IDEA_DISKS_ROOT: '/disks' })).toThrow(/IDEA_DISKS_ROOT/)
        expect(() => assertTestIsolation({ ...good, IDEA_DISKS_ROOT: '/disks/old' })).toThrow(/IDEA_DISKS_ROOT/)
        expect(() => assertTestIsolation({ ...good, IDEA_DISKS_ROOT: '/disks/../disks' })).toThrow(/IDEA_DISKS_ROOT/)
    })

    it('does not treat look-alike paths as live', () => {
        expect(() => assertTestIsolation({ ...good, IDEA_DISKS_ROOT: '/disks-test' })).not.toThrow()
    })
})

describe('This test run is isolated from the live Engine', () => {
    it('skips the system disk', () => {
        expect(process.env.IDEA_SYSTEM_DISK_SKIP).toBe('true')
        expect(config.settings.systemDiskSkip).toBe(true)
    })

    it('uses a private watch folder and mount root', () => {
        expect(DEV_ROOT).not.toBe('/dev/engine')
        expect(DISKS_ROOT).not.toBe('/disks')
        expect(DISKS_ROOT.startsWith('/disks/')).toBe(false)
        expect(DEV_ROOT.startsWith('/dev/engine/')).toBe(false)
        expect(sentinelPath()).toBe(`${DEV_ROOT}/${TEST_DEVICE}`)
        expect(diskPath()).toBe(`${DISKS_ROOT}/${TEST_DEVICE}`)
    })

    it('the Engine resolves App Disk paths under the private mount root', async () => {
        expect(disksRoot()).toBe(DISKS_ROOT)
        const root = await diskMountRoot({ device: TEST_DEVICE } as any)
        expect(root).toBe(`${DISKS_ROOT}/${TEST_DEVICE}`)
    })

    it('runs from dist-test/, not dist/', () => {
        const here = fileURLToPath(import.meta.url)
        expect(here.split(path.sep)).toContain('dist-test')
        expect(here.split(path.sep)).not.toContain('dist')
    })
})

describe('Test-only device names', () => {
    it('TEST_DEVICE and generated names are test-only names', () => {
        expect(isTestDeviceName(TEST_DEVICE)).toBe(true)
        expect(isTestDeviceName(uniqueTestDevice())).toBe(true)
    })

    it('real hardware names are not test-only names', () => {
        for (const d of ['sda', 'sda1', 'sda2', 'sdz1', 'nvme0n1p1', 'mmcblk0p2', '', 'idea-test-', 'idea-test-1a', 'xidea-test-1']) {
            expect(isTestDeviceName(d), d).toBe(false)
        }
        expect(isTestDeviceName(undefined)).toBe(false)
        expect(isTestDeviceName(null)).toBe(false)
    })
})

describe('Test container labelling', () => {
    it('every fixture service carries the test label', async () => {
        const composeFiles: string[] = []
        for (const fixture of await fs.readdir(FIXTURES_DIR)) {
            for (const sub of ['instances', 'apps']) {
                const dir = path.join(FIXTURES_DIR, fixture, sub)
                if (!(await fs.pathExists(dir))) continue
                for (const entry of await fs.readdir(dir)) composeFiles.push(path.join(dir, entry, 'compose.yaml'))
            }
        }
        expect(composeFiles.length).toBeGreaterThan(0)
        for (const f of composeFiles) {
            const compose = YAML.parse(await fs.readFile(f, 'utf-8'))
            for (const [name, service] of Object.entries<any>(compose.services)) {
                expect(service.labels?.[TEST_CONTAINER_LABEL_KEY], `${f}: ${name}`).toBe(TEST_CONTAINER_LABEL_VALUE)
            }
        }
    })

    it('labelFixtureComposeFiles adds the label to unlabelled services (map and list form)', async () => {
        const root = path.join(DISKS_ROOT, uniqueTestDevice())
        const composePath = path.join(root, 'instances', 'x', 'compose.yaml')
        await fs.ensureDir(path.dirname(composePath))
        await fs.writeFile(composePath, YAML.stringify({
            services: { a: { image: 'img' }, b: { image: 'img', labels: ['other=1'] } },
        }))
        try {
            await labelFixtureComposeFiles(root)
            const compose = YAML.parse(await fs.readFile(composePath, 'utf-8'))
            expect(compose.services.a.labels[TEST_CONTAINER_LABEL_KEY]).toBe(TEST_CONTAINER_LABEL_VALUE)
            expect(compose.services.b.labels).toEqual(['other=1', `${TEST_CONTAINER_LABEL_KEY}=${TEST_CONTAINER_LABEL_VALUE}`])
        } finally {
            await fs.remove(root)
        }
    })
})
