/**
 * idea#411: Engine-process wiring outside src/usage/ — capability, skip-flag
 * call sites, pm2 app, tmpfiles install.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'module'
import { ENGINE_CAPABILITIES } from '../../src/data/Engine.js'

const repo = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8')

describe('usageSummaries capability', () => {
    it('is on ENGINE_CAPABILITIES (boolean flag, advertised even when monitoring is off)', () => {
        expect(ENGINE_CAPABILITIES).toContain('usageSummaries')
        expect(ENGINE_CAPABILITIES[ENGINE_CAPABILITIES.length - 1]).toBe('usageSummaries')
    })
})

describe('Engine writes skip flags', () => {
    it('backupInstance and restoreApp begin/end backup-running', () => {
        const src = read('src/monitors/backupMonitor.ts')
        expect(src).toMatch(/beginUsageSkip\('backup'\)/)
        expect(src).toMatch(/endUsageSkip\('backup'\)/)
        expect(src.split("beginUsageSkip('backup')")).toHaveLength(3) // two call sites
    })
    it('updateApp begin/end update-running while the instance lock is held', () => {
        const src = read('src/data/UpdateApp.ts')
        expect(src).toMatch(/if \(gotLock\) beginUsageSkip\('update'\)/)
        expect(src).toMatch(/endUsageSkip\('update'\)/)
    })
    it('copyApp and moveApp begin/end move-running', () => {
        const src = read('src/data/CopyMoveApp.ts')
        expect(src).toMatch(/beginUsageSkip\('move'\)/)
        expect(src).toMatch(/endUsageSkip\('move'\)/)
        expect(src.split("beginUsageSkip('move')")).toHaveLength(3)
    })
})

describe('pm2 and install', () => {
    it('pm2.config.cjs starts idea-usage next to engine', () => {
        const cfg = createRequire(import.meta.url)(path.join(repo, 'pm2.config.cjs'))
        expect(cfg.apps.map((a: { name: string }) => a.name)).toEqual(['engine', 'idea-usage'])
        expect(cfg.apps[1].script).toBe('./dist/src/usage/main.js')
        expect(cfg.apps[1].kill_timeout).toBe(10000)
    })
    it('tmpfiles config creates /run/idea and /var/lib/idea/usage', () => {
        const conf = read('script/build_image_assets/idea-usage.tmpfiles.conf')
        expect(conf).toMatch(/^d \/run\/idea 0755 pi pi -/m)
        expect(conf).toMatch(/^d \/var\/lib\/idea\/usage 0750 pi pi -/m)
    })
    it('installRootHelpers installs the usage tmpfiles and directory', () => {
        const src = read('src/data/Engine.ts')
        expect(src).toMatch(/idea-usage\.tmpfiles\.conf/)
        expect(src).toMatch(/\/var\/lib\/idea\/usage/)
        expect(src).toMatch(/USAGE_TMPFILES_CONF/)
    })
})
