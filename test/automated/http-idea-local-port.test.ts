import { describe, it, expect, afterEach } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import net from 'net'
import os from 'os'
import path from 'path'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'

/**
 * idea#203: http://idea.local (port 80) must reach this Engine's Console even when
 * the Engine's own httpPort is not 80. enableHttpMonitor(port, consolePath, _, alsoPort)
 * serves the same handler (Console + API) on alsoPort; closing the main server closes it.
 * Uses free high ports in place of 80 (no root needed).
 */
const { enableHttpMonitor } = await import('../../src/monitors/httpMonitor.js')
const { config } = await import('../../src/data/Config.js')

const freePort = () => new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)) })
})
const listening = (s: http.Server) => new Promise<void>((r) => s.listening ? r() : s.once('listening', () => r()))

const consoleDir = mkdtempSync(path.join(os.tmpdir(), 'idea203-console-'))
writeFileSync(path.join(consoleDir, 'index.html'), '<html>IDEA Console</html>')
mkdirSync(path.join(consoleDir, 'assets'))
writeFileSync(path.join(consoleDir, 'assets', 'app.js'), 'console.log(1)')

let server: http.Server | undefined
afterEach(async () => { if (server?.listening) await new Promise<void>((r) => server!.close(() => r())); server = undefined })

describe('Console on the idea.local port (idea#203)', () => {
    it('serves the same Console and API on the extra port', async () => {
        const [main, extra] = [await freePort(), await freePort()]
        server = enableHttpMonitor(main, consoleDir, null, extra)
        const x: http.Server = (server as any).ideaLocalServer
        await listening(server); await listening(x)
        for (const p of [main, extra]) {
            const r = await fetch(`http://127.0.0.1:${p}/`, { headers: { Host: 'idea.local' } })
            expect(r.status).toBe(200)
            expect(await r.text()).toContain('IDEA Console')
            const a = await fetch(`http://127.0.0.1:${p}/assets/app.js`)
            expect(a.headers.get('content-type')).toContain('javascript')
            const s = await fetch(`http://127.0.0.1:${p}/api/store-url`)
            expect([200, 503]).toContain(s.status)
        }
    })

    it('SPA routes on the extra port fall back to index.html', async () => {
        const [main, extra] = [await freePort(), await freePort()]
        server = enableHttpMonitor(main, consoleDir, null, extra)
        await listening((server as any).ideaLocalServer)
        const r = await fetch(`http://127.0.0.1:${extra}/apps/some-route`)
        expect(await r.text()).toContain('IDEA Console')
    })

    it('no extra listener when the extra port equals httpPort, or is not given', async () => {
        const main = await freePort()
        server = enableHttpMonitor(main, consoleDir, null, main)
        await listening(server)
        expect((server as any).ideaLocalServer).toBeUndefined()
        await new Promise<void>((r) => server!.close(() => r()))
        server = enableHttpMonitor(main, consoleDir, null)
        await listening(server)
        expect((server as any).ideaLocalServer).toBeUndefined()
    })

    it('closing the main server closes the idea.local listener', async () => {
        const [main, extra] = [await freePort(), await freePort()]
        server = enableHttpMonitor(main, consoleDir, null, extra)
        const x: http.Server = (server as any).ideaLocalServer
        await listening(server); await listening(x)
        await new Promise<void>((r) => server!.close(() => r()))
        await new Promise((r) => setTimeout(r, 50))
        expect(x.listening).toBe(false)
    })

    it('a busy extra port does not stop the main Console', async () => {
        const [main, extra] = [await freePort(), await freePort()]
        const blocker = net.createServer().listen(extra)
        await new Promise((r) => blocker.once('listening', r))
        server = enableHttpMonitor(main, consoleDir, null, extra)
        await listening(server)
        expect((await fetch(`http://127.0.0.1:${main}/`)).status).toBe(200)
        blocker.close()
    })

    it('ideaLocalHttpPort config defaults to 80 at the call site (unset in config.yaml)', () => {
        expect(config.settings.ideaLocalHttpPort ?? 80).toBe(80)
    })
})
