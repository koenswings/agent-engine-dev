import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

/**
 * The 503 replies of GET /api/store-url and /api/command-log-url carry
 * Access-Control-Allow-Origin: * like the 200s, so a Console opened from
 * another Pi's page can read the "not available yet" answer instead of a CORS
 * error. The store identity folder points at an empty temp dir, so both URL
 * files are missing. Must be set before httpMonitor is imported (paths are
 * computed at load time).
 */
const emptyDir = mkdtempSync(path.join(tmpdir(), 'idea-503-cors-'))
const { config } = await import('../../src/data/Config.js')
config.settings.storeIdentityFolder = emptyDir
const { enableHttpMonitor } = await import('../../src/monitors/httpMonitor.js')

describe('503 replies send CORS header', () => {
    let server: http.Server
    let baseUrl: string

    beforeAll(async () => {
        server = enableHttpMonitor(0, '')
        await new Promise<void>((resolve) => {
            if (server.listening) resolve()
            else server.once('listening', () => resolve())
        })
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        rmSync(emptyDir, { recursive: true, force: true })
    })

    for (const route of ['/api/store-url', '/api/store-url/', '/api/command-log-url', '/api/command-log-url/']) {
        it(`${route} -> 503 with Access-Control-Allow-Origin: *`, async () => {
            const res = await fetch(`${baseUrl}${route}`, { headers: { Origin: 'http://brave-otter.local' } })
            expect(res.status).toBe(503)
            expect(res.headers.get('access-control-allow-origin')).toBe('*')
            expect((await res.json()).error).toMatch(/not available yet/)
        })
    }
})
