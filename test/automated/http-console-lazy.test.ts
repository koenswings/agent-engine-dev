import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'

/**
 * agent-engine-dev#264: the Engine must not settle the Console UI at startup.
 * Start with an empty dist/ (as during a vite rebuild) → 503; once index.html lands
 * the same server serves it (200) with no restart; emptying dist/ again → 503.
 */
const { enableHttpMonitor } = await import('../../src/monitors/httpMonitor.js')

const listen = async (srv: http.Server): Promise<string> => {
    await new Promise<void>((r) => (srv.listening ? r() : srv.once('listening', () => r())))
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
}

describe('Console UI detected lazily (#264)', () => {
    let dir: string
    let server: http.Server
    let base: string

    beforeAll(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'idea-console-264-'))
        server = enableHttpMonitor(0, dir)
        base = await listen(server)
    })

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()))
        rmSync(dir, { recursive: true, force: true })
    })

    it('answers 503 while dist/ has no index.html', async () => {
        const res = await fetch(`${base}/`)
        expect(res.status).toBe(503)
        expect(res.headers.get('retry-after')).toBe('5')
        expect(await res.text()).toBe('Console UI not built yet on this Engine')
    })

    it('serves a Console build that lands after startup, without a restart', async () => {
        mkdirSync(path.join(dir, 'assets'), { recursive: true })
        writeFileSync(path.join(dir, 'index.html'), '<html>console-264</html>')
        writeFileSync(path.join(dir, 'assets', 'a.js'), 'x=1')
        const res = await fetch(`${base}/`)
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('console-264')
        const js = await fetch(`${base}/assets/a.js`)
        expect(js.status).toBe(200)
        expect(js.headers.get('content-type')).toContain('javascript')
        const spa = await fetch(`${base}/some/route`)
        expect(await spa.text()).toContain('console-264')
    })

    it('goes back to 503 when dist/ is emptied again (next rebuild)', async () => {
        rmSync(path.join(dir, 'index.html'))
        expect((await fetch(`${base}/`)).status).toBe(503)
    })

    it('keeps 404 "not configured" when no consolePath is set, API still works', async () => {
        const srv = enableHttpMonitor(0, '')
        const b = await listen(srv)
        try {
            const res = await fetch(`${b}/`)
            expect(res.status).toBe(404)
            expect(await res.text()).toBe('Console UI not configured on this Engine')
        } finally {
            await new Promise<void>((r) => srv.close(() => r()))
        }
    })
})
