/**
 * console-origins-cors.test.ts — CORS limited to the Engine's own Console origins (engine#582).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const emptyDir = mkdtempSync(path.join(tmpdir(), 'idea-cors-own-'))
const { config } = await import('../../src/data/Config.js')
config.settings.storeIdentityFolder = emptyDir
const { enableHttpMonitor } = await import('../../src/monitors/httpMonitor.js')
const { isOwnConsoleOrigin, ownConsoleHosts } = await import('../../src/monitors/consoleOrigins.js')
const { isWsOriginAllowed } = await import('../../src/utils/originCheck.js')

const IFACES = {
    eth0: [{ address: '10.42.0.17', family: 'IPv4', internal: false } as any],
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as any],
    tailscale0: [{ address: '100.126.117.80', family: 'IPv4', internal: false } as any],
}

describe('own Console origins (unit)', () => {
    const hosts = ownConsoleHosts('Idea03', IFACES)

    it('hosts: hostname, hostname.local, idea.local, localhost, LAN and Tailscale IPv4', () => {
        for (const h of ['idea03', 'idea03.local', 'idea.local', 'localhost', '127.0.0.1', '10.42.0.17', '100.126.117.80']) {
            expect(hosts.has(h), h).toBe(true)
        }
    })

    it('accepts own origins on the Console ports; port 80 without a port', () => {
        expect(isOwnConsoleOrigin('http://idea03.local', [80], hosts, [])).toBe(true)
        expect(isOwnConsoleOrigin('http://IDEA03.local', [80], hosts, [])).toBe(true)
        expect(isOwnConsoleOrigin('http://10.42.0.17:8080', [80, 8080], hosts, [])).toBe(true)
        expect(isOwnConsoleOrigin('http://idea.local', [8080, 80], hosts, [])).toBe(true)
    })

    it('refuses other hosts, other ports, https, paths, null and missing origins', () => {
        expect(isOwnConsoleOrigin('http://idea04.local', [80], hosts, [])).toBe(false)
        expect(isOwnConsoleOrigin('http://10.42.0.18', [80], hosts, [])).toBe(false)
        expect(isOwnConsoleOrigin('http://idea03.local:5173', [80, 8080], hosts, [])).toBe(false)
        expect(isOwnConsoleOrigin('https://idea03.local', [80, 443], hosts, [])).toBe(false)
        expect(isOwnConsoleOrigin('http://idea03.local/x', [80], hosts, [])).toBe(false)
        expect(isOwnConsoleOrigin('null', [80], hosts, [])).toBe(false)
        expect(isOwnConsoleOrigin(undefined, [80], hosts, [])).toBe(false)
        expect(isOwnConsoleOrigin('http://evil.example', [80], hosts, [])).toBe(false)
    })

    it('settings.devConsoleOrigins adds exact origins only', () => {
        expect(isOwnConsoleOrigin('http://localhost:5173', [80], hosts, ['http://localhost:5173'])).toBe(true)
        expect(isOwnConsoleOrigin('http://localhost:5174', [80], hosts, ['http://localhost:5173'])).toBe(false)
    })
})

describe('store WebSocket origin rule (unit)', () => {
    const hosts = ownConsoleHosts('idea03', IFACES)
    it('no Origin (Engines, CLI) and extensions pass; own Console origins pass; others refused', () => {
        expect(isWsOriginAllowed(undefined, [80], [], hosts)).toBe(true)
        expect(isWsOriginAllowed('', [80], [], hosts)).toBe(true)
        expect(isWsOriginAllowed('chrome-extension://abcdefghijklmnopabcdefghijklmnop', [80], [], hosts)).toBe(true)
        expect(isWsOriginAllowed('chrome-extension://short', [80], [], hosts)).toBe(false)
        expect(isWsOriginAllowed('http://idea03.local', [80, 8080], [], hosts)).toBe(true)
        expect(isWsOriginAllowed('http://10.42.0.17:8080', [80, 8080], [], hosts)).toBe(true)
        expect(isWsOriginAllowed('http://idea04.local', [80], [], hosts)).toBe(false)
        expect(isWsOriginAllowed('http://evil.example', [80], [], hosts)).toBe(false)
        expect(isWsOriginAllowed('http://localhost:5173', [80], ['http://localhost:5173'], hosts)).toBe(true)
    })
})

describe('HTTP API answers (engine#582)', () => {
    let server: http.Server
    let base: string
    let port: number

    beforeAll(async () => {
        server = enableHttpMonitor(0, '')
        await new Promise<void>((resolve) => server.listening ? resolve() : server.once('listening', () => resolve()))
        port = (server.address() as AddressInfo).port
        base = `http://127.0.0.1:${port}`
    })
    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        rmSync(emptyDir, { recursive: true, force: true })
        config.settings.devConsoleOrigins = undefined
    })

    it('no Origin: no CORS header', async () => {
        const r = await fetch(`${base}/api/store-url`)
        expect(r.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('own origin: echoed with Vary: Origin; a foreign origin: none', async () => {
        const own = await fetch(`${base}/api/nope`, { headers: { Origin: `http://localhost:${port}` } })
        expect(own.status).toBe(404)
        expect(own.headers.get('access-control-allow-origin')).toBe(`http://localhost:${port}`)
        expect(own.headers.get('vary')).toBe('Origin')
        const foreign = await fetch(`${base}/api/nope`, { headers: { Origin: 'http://brave-otter.local' } })
        expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
        expect(foreign.headers.get('vary')).toBe('Origin')
    })

    it('OPTIONS preflight: allowed for own origins with methods and headers, bare for others', async () => {
        const ok = await fetch(`${base}/api/command`, { method: 'OPTIONS', headers: { Origin: base, 'Access-Control-Request-Method': 'POST' } })
        expect(ok.status).toBe(204)
        expect(ok.headers.get('access-control-allow-origin')).toBe(base)
        expect(ok.headers.get('access-control-allow-headers')).toContain('Authorization')
        expect(ok.headers.get('access-control-allow-methods')).toContain('POST')
        const no = await fetch(`${base}/api/command`, { method: 'OPTIONS', headers: { Origin: 'http://brave-otter.local', 'Access-Control-Request-Method': 'POST' } })
        expect(no.status).toBe(204)
        expect(no.headers.get('access-control-allow-origin')).toBeNull()
        expect(no.headers.get('access-control-allow-methods')).toBeNull()
    })

    it('a configured development origin is answered', async () => {
        config.settings.devConsoleOrigins = ['http://localhost:5173']
        const r = await fetch(`${base}/api/store-url`, { headers: { Origin: 'http://localhost:5173' } })
        expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
        config.settings.devConsoleOrigins = undefined
    })
})
