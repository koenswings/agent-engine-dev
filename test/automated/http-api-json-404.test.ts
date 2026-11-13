import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'

/**
 * engine#357: unknown /api/* paths return a JSON 404 before the Console SPA
 * fallback, in the same shape as the existing API error replies
 * ({ error: string }, Content-Type application/json, CORS *).
 * Non-/api paths still get the SPA fallback (or the no-console 404 text).
 */
const { enableHttpMonitor } = await import('../../src/monitors/httpMonitor.js')

const listen = async (srv: http.Server): Promise<string> => {
    await new Promise<void>((r) => (srv.listening ? r() : srv.once('listening', () => r())))
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
}

const expectJson404 = async (res: Response) => {
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toEqual({ error: 'Not found' })
}

describe('unknown /api/* paths return JSON 404 (engine#357)', () => {
    let dir: string
    let server: http.Server
    let base: string

    beforeAll(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'idea-api-404-'))
        mkdirSync(path.join(dir, 'assets'))
        writeFileSync(path.join(dir, 'index.html'), '<html>console-357</html>')
        writeFileSync(path.join(dir, 'assets', 'a.js'), 'x=1')
        server = enableHttpMonitor(0, dir)
        base = await listen(server)
    })

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()))
        rmSync(dir, { recursive: true, force: true })
    })

    it('GET /api/does-not-exist is JSON 404, not the Console', async () => {
        const res = await fetch(`${base}/api/does-not-exist`, { headers: { Origin: 'http://brave-otter.local' } })
        await expectJson404(res)
    })

    it('a typo of a known route (/api/store-urll) is JSON 404', async () => {
        await expectJson404(await fetch(`${base}/api/store-urll`))
    })

    it('trailing slash and query string on an unknown /api path are still JSON 404', async () => {
        await expectJson404(await fetch(`${base}/api/nope/`))
        await expectJson404(await fetch(`${base}/api/nope?x=1`))
    })

    it('GET /api and /api/ are JSON 404', async () => {
        await expectJson404(await fetch(`${base}/api`))
        await expectJson404(await fetch(`${base}/api/`))
    })

    it('known /api/store-url still answers JSON (not 404)', async () => {
        const res = await fetch(`${base}/api/store-url`)
        expect(res.status).not.toBe(404)
        expect(res.headers.get('content-type')).toContain('application/json')
        const body = await res.json() as { url?: string, error?: string }
        expect(body.url ?? body.error).toBeTruthy()
    })

    it('a non-/api typo (/store-url) still gets the Console SPA fallback', async () => {
        const res = await fetch(`${base}/store-url`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/html')
        expect(await res.text()).toContain('console-357')
    })

    it('other non-/api SPA routes and real static files still work', async () => {
        const spa = await fetch(`${base}/some/route`)
        expect(spa.status).toBe(200)
        expect(await spa.text()).toContain('console-357')
        const js = await fetch(`${base}/assets/a.js`)
        expect(js.status).toBe(200)
        expect(js.headers.get('content-type')).toContain('javascript')
        expect(await js.text()).toBe('x=1')
    })

    it('without a consolePath, unknown /api/* is still JSON 404 (not the text 404)', async () => {
        const srv = enableHttpMonitor(0, '')
        const b = await listen(srv)
        try {
            await expectJson404(await fetch(`${b}/api/does-not-exist`))
            const page = await fetch(`${b}/store-url`)
            expect(page.status).toBe(404)
            expect(page.headers.get('content-type')).toContain('text/plain')
            expect(await page.text()).toBe('Console UI not configured on this Engine')
        } finally {
            await new Promise<void>((r) => srv.close(() => r()))
        }
    })
})
