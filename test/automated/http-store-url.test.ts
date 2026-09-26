import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import path from 'path'
import { readFileSync } from 'fs'

/**
 * Tests for GET /api/store-url (httpMonitor.ts) — idea#100.
 *
 * The response must include the Engine's effective WebSocket port (`wsPort`,
 * i.e. config.settings.port after the IDEA_ENGINE_PORT override) while keeping
 * `url` unchanged for backward compatibility.
 *
 * No hardware or Docker needed: the HTTP server is started on an ephemeral port
 * with no Console path, and reads the committed store-identity/store-url.txt.
 * Runs in its own forked process (vitest pool: 'forks'), so setting
 * IDEA_ENGINE_PORT before importing Config does not leak into other suites.
 */

const OVERRIDE_PORT = 4999

// Must be set before Config.ts is first imported (it applies the override at load time).
process.env.IDEA_ENGINE_PORT = String(OVERRIDE_PORT)

const { config } = await import('../../src/data/Config.js')
const { enableHttpMonitor, buildStoreUrlPayload } = await import('../../src/monitors/httpMonitor.js')

describe('buildStoreUrlPayload', () => {
    it('returns url unchanged plus the given wsPort', () => {
        expect(buildStoreUrlPayload('automerge:abc', 1234)).toEqual({ url: 'automerge:abc', wsPort: 1234 })
    })

    it('defaults wsPort to the effective config port (IDEA_ENGINE_PORT override applied)', () => {
        expect(config.settings.port).toBe(OVERRIDE_PORT)
        const payload = buildStoreUrlPayload('automerge:abc')
        expect(payload.wsPort).toBe(OVERRIDE_PORT)
        expect(typeof payload.wsPort).toBe('number')
    })
})

describe('GET /api/store-url', () => {
    let server: http.Server
    let baseUrl: string
    const expectedUrl = readFileSync(
        path.join(config.settings.storeIdentityFolder, 'store-url.txt'), 'utf-8'
    ).trim()

    beforeAll(async () => {
        server = enableHttpMonitor(0, '')
        await new Promise<void>((resolve) => {
            if (server.listening) resolve()
            else server.once('listening', () => resolve())
        })
        const { port } = server.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('returns { url, wsPort } with numeric wsPort equal to the effective port', async () => {
        const res = await fetch(`${baseUrl}/api/store-url`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({ url: expectedUrl, wsPort: OVERRIDE_PORT })
        expect(typeof body.wsPort).toBe('number')
    })

    it('keeps url exactly as the stored store URL (backward compatible)', async () => {
        const res = await fetch(`${baseUrl}/api/store-url/`)
        const body = await res.json()
        expect(body.url).toBe(expectedUrl)
        expect(body.url.startsWith('automerge:')).toBe(true)
    })
})
