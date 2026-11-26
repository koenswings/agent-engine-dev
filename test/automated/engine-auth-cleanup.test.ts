/**
 * engine-auth-cleanup.test.ts — engine#582 step 5 cleanup: config.yaml carries no
 * defaults.password, and the Tailscale key comes only from TAILSCALE_AUTHKEY.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import { resolveTailscaleAuthKey } from '../../src/data/Engine.js'

describe('engine#582 cleanup', () => {
    const saved = process.env.TAILSCALE_AUTHKEY
    afterEach(() => { if (saved === undefined) delete process.env.TAILSCALE_AUTHKEY; else process.env.TAILSCALE_AUTHKEY = saved })

    it('config.yaml has no defaults.password', () => {
        const cfg = YAML.parse(fs.readFileSync(path.resolve('config.yaml'), 'utf8'))
        expect(cfg.defaults).toBeTruthy()
        expect('password' in cfg.defaults).toBe(false)
    })

    it('the Tailscale key comes only from TAILSCALE_AUTHKEY', () => {
        process.env.TAILSCALE_AUTHKEY = '  tskey-test-value  '
        expect(resolveTailscaleAuthKey()).toBe('tskey-test-value')
        delete process.env.TAILSCALE_AUTHKEY
        expect(resolveTailscaleAuthKey()).toBeNull()
        process.env.TAILSCALE_AUTHKEY = '   '
        expect(resolveTailscaleAuthKey()).toBeNull()
    })

    it('no other key file is read', () => {
        const src = fs.readFileSync(path.resolve('src/data/Engine.ts'), 'utf8')
        expect(src).not.toMatch(/openclaw|tailscale_authkey\.txt/)
    })
})
