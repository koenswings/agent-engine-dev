/**
 * engine-relay.test.ts — /api/engines/<id>/… relay and the X-Idea-Relay header
 * (engine#582 step 4): forwarding, own id answered locally, unknown Engine and path,
 * an older Engine (404 on info) → ENGINE_VERSION_MISMATCH, unreachable and slow
 * Engines → 502 ENGINE_UNREACHABLE, grant requests carry issuerEngineId, the
 * original client in a signed header (rate limit per client), body limit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { Repo } from '@automerge/automerge-repo'
import { relayKey, relayHeader, verifyRelayHeader, publishRelayPublicKey, clearRelayKeyCacheForTests, RELAY_KEY_FILE } from '../../src/data/RelayKey.js'
import { relayRoute, setRelayTimeoutsForTests } from '../../src/monitors/relayApi.js'
import { clientOf } from '../../src/monitors/authApi.js'
import { setPeerAddressOverrideForTests } from '../../src/data/PeerHttp.js'

const { enableHttpMonitor } = await import('../../src/monitors/httpMonitor.js')

const SELF = 'ENGINE_relay-a'
const PEER = 'ENGINE_relay-b'
const OLD = 'ENGINE_relay-old'
const SLOW = 'ENGINE_relay-slow'
const GONE = 'ENGINE_relay-gone'

const listen = async (srv: http.Server): Promise<number> => {
    await new Promise<void>((r) => (srv.listening ? r() : srv.once('listening', () => r())))
    return (srv.address() as AddressInfo).port
}
const close = (srv: http.Server) => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()) })

describe('relay key and X-Idea-Relay', () => {
    let dir: string
    beforeEach(() => { clearRelayKeyCacheForTests(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-relay-key-')) })

    it('key file 0600, stable across loads; public half published in engineDB', async () => {
        const k = relayKey(dir)
        expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect((fs.statSync(path.join(dir, RELAY_KEY_FILE)).mode & 0o777).toString(8)).toBe('600')
        clearRelayKeyCacheForTests()
        expect(relayKey(dir).publicKey).toBe(k.publicKey)
        const h = new Repo({ network: [], storage: undefined }).create<any>({ engineDB: { [SELF]: { id: SELF } } })
        await h.whenReady()
        publishRelayPublicKey(h, SELF, dir)
        expect(h.doc().engineDB[SELF].relayPublicKey).toBe(k.publicKey)
    })

    it('verifies with the sender\'s published key; refuses stale, unknown sender, changed client, other key', () => {
        const store: any = { engineDB: { [SELF]: { relayPublicKey: relayKey(dir).publicKey } } }
        const now = Date.now()
        const h = relayHeader(SELF, '10.42.0.17', now, dir)
        expect(verifyRelayHeader(h, store, now)).toEqual({ client: '10.42.0.17', viaEngineId: SELF })
        expect(verifyRelayHeader(h, store, now + 61_000)).toBeNull()
        expect(verifyRelayHeader(h, { engineDB: {} } as any, now)).toBeNull()
        const parts = h.split('.')
        parts[2] = Buffer.from('10.42.0.99').toString('base64url')
        expect(verifyRelayHeader(parts.join('.'), store, now)).toBeNull()
        const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-relay-key-'))
        expect(verifyRelayHeader(relayHeader(SELF, '10.42.0.17', now, otherDir), store, now)).toBeNull()
        expect(verifyRelayHeader('junk', store, now)).toBeNull()
    })

    it('clientOf: the vouched client with a valid header, else the socket address', () => {
        const store: any = { engineDB: { [SELF]: { relayPublicKey: relayKey(dir).publicKey } } }
        const req = (hdr?: string): any => ({ headers: hdr ? { 'x-idea-relay': hdr } : {}, socket: { remoteAddress: '10.42.0.5' } })
        expect(clientOf(req(relayHeader(SELF, '10.42.0.17', Date.now(), dir)), store)).toEqual({ client: '10.42.0.17', viaEngineId: SELF })
        expect(clientOf(req('v1.forged'), store)).toEqual({ client: '10.42.0.5' })
        expect(clientOf(req(), store)).toEqual({ client: '10.42.0.5' })
    })

    it('relayRoute: allowed paths only; own id is local', () => {
        expect(relayRoute('/api/auth/info', SELF)).toEqual({ kind: 'none' })
        expect(relayRoute(`/api/engines/${SELF}/auth/info`, SELF)).toEqual({ kind: 'local', path: '/api/auth/info' })
        expect(relayRoute(`/api/engines/${PEER}/command`, SELF)).toEqual({ kind: 'remote', engineId: PEER, path: 'command' })
        expect(relayRoute(`/api/engines/${PEER}/auth/operators/user-1`, SELF)).toEqual({ kind: 'remote', engineId: PEER, path: 'auth/operators/user-1' })
        for (const p of ['store-url', 'command-log-url', 'auth/grant', 'auth/login']) expect(relayRoute(`/api/engines/${PEER}/${p}`, SELF).kind).toBe('remote')
        for (const p of ['engines/x/auth/info', 'files', '../auth/info', 'auth/../../x']) expect(relayRoute(`/api/engines/${PEER}/${p}`, SELF).kind).toBe('unknown-path')
    })
})

describe('/api/engines/<id>/… over HTTP', () => {
    let a: http.Server, b: http.Server, old: http.Server, slow: http.Server
    let base = '', dir = ''
    const seen: { method: string, url: string, headers: http.IncomingHttpHeaders, body: string }[] = []
    const doc: any = { engineDB: {} }

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-relay-http-'))
        b = http.createServer((req, res) => {
            let body = ''
            req.on('data', c => { body += c })
            req.on('end', () => {
                seen.push({ method: String(req.method), url: String(req.url), headers: req.headers, body })
                if (req.url === '/api/auth/info') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ engineId: PEER, authVersion: 1 })); return }
                if (req.url === '/api/auth/login') { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' }); res.end(JSON.stringify({ error: 'LOGIN_RATE_LIMITED', retryAfterSeconds: 60 })); return }
                if (req.url === '/api/auth/grant') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'AUTH_REQUIRED', message: 'Sign in first.', issuerEngineId: PEER })); return }
                res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ engineId: PEER, seq: 9 }))
            })
        }).listen(0, '127.0.0.1')
        old = http.createServer((req, res) => {
            if (req.url === '/api/store-url') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ url: 'automerge:old' })); return }
            res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Not found"}')
        }).listen(0, '127.0.0.1')
        slow = http.createServer((req, res) => {
            if (req.url === '/api/auth/info') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ engineId: SLOW })); return }
            req.resume()   // never answers /api/command
        }).listen(0, '127.0.0.1')
        const ports = { [PEER]: await listen(b), [OLD]: await listen(old), [SLOW]: await listen(slow), [GONE]: 1 }
        setPeerAddressOverrideForTests(id => ports[id] ? [{ host: '127.0.0.1', port: ports[id] }] : [])
        doc.engineDB = {
            [SELF]: { id: SELF, hostname: 'relay-a', relayPublicKey: relayKey(dir).publicKey },
            [PEER]: { id: PEER, hostname: 'relay-b' },
            [OLD]: { id: OLD, hostname: 'relay-old', version: '2.3.0' },
            [SLOW]: { id: SLOW, hostname: 'relay-slow' },
            [GONE]: { id: GONE, hostname: 'relay-gone' },
        }
        a = enableHttpMonitor(0, '', null, undefined, { engineId: SELF, auth: { engineId: SELF, dir, storeHandle: { doc: () => doc } as any, capabilities: () => ['engineRelay1'] } })
        base = `http://127.0.0.1:${await listen(a)}`
        setRelayTimeoutsForTests({ auth: 1_000, command: 1_500 })
    })
    afterAll(async () => {
        setPeerAddressOverrideForTests(null); setRelayTimeoutsForTests(null)
        await close(a); await close(b); await close(old); await close(slow)
    })
    beforeEach(() => { seen.length = 0 })

    it('forwards to the other Engine: method, path, body, Authorization; adds a signed X-Idea-Relay; drops a client one', async () => {
        const r = await fetch(`${base}/api/engines/${PEER}/command`, {
            method: 'POST', body: JSON.stringify({ command: 'reboot' }),
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 't'.repeat(43), 'X-Idea-Relay': 'v1.spoofed' },
        })
        expect(r.status).toBe(202)
        expect(await r.json()).toEqual({ engineId: PEER, seq: 9 })
        expect(r.headers.get('cache-control')).toBe('no-store')
        const fwd = seen.find(s => s.url === '/api/command')!
        expect(fwd).toMatchObject({ method: 'POST', body: JSON.stringify({ command: 'reboot' }) })
        expect(fwd.headers.authorization).toBe('Bearer ' + 't'.repeat(43))
        expect(verifyRelayHeader(fwd.headers['x-idea-relay'], doc)).toEqual({ client: expect.stringMatching(/127\.0\.0\.1$/), viaEngineId: SELF })
    })

    it('the page\'s own Engine id is answered locally', async () => {
        const r = await fetch(`${base}/api/engines/${SELF}/auth/info`)
        expect(r.status).toBe(200)
        expect((await r.json()).engineId).toBe(SELF)
        expect(seen).toEqual([])
    })

    it('B\'s answers pass through unchanged, Retry-After included', async () => {
        const r = await fetch(`${base}/api/engines/${PEER}/auth/login`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
        expect(r.status).toBe(429)
        expect(r.headers.get('retry-after')).toBe('60')
        expect(await r.json()).toMatchObject({ error: 'LOGIN_RATE_LIMITED' })
        const g = await fetch(`${base}/api/engines/${PEER}/auth/grant`, { method: 'POST', body: JSON.stringify({ toEngineId: SELF }) })
        expect(g.status).toBe(401)
        expect(await g.json()).toMatchObject({ error: 'AUTH_REQUIRED', issuerEngineId: PEER })
    })

    it('unknown Engine → 404 ENGINE_UNKNOWN; unknown path → 404 NOT_FOUND', async () => {
        const u = await fetch(`${base}/api/engines/ENGINE_nobody/auth/info`)
        expect(u.status).toBe(404)
        expect(await u.json()).toMatchObject({ error: 'ENGINE_UNKNOWN', engineId: 'ENGINE_nobody' })
        const p = await fetch(`${base}/api/engines/${PEER}/files`)
        expect(p.status).toBe(404)
        expect((await p.json()).error).toBe('NOT_FOUND')
    })

    it('older Engine (404 on info) → 409 ENGINE_VERSION_MISMATCH with version; its public store-url still goes through', async () => {
        const r = await fetch(`${base}/api/engines/${OLD}/auth/info`)
        expect(r.status).toBe(409)
        expect(await r.json()).toMatchObject({ error: 'ENGINE_VERSION_MISMATCH', engineId: OLD, version: '2.3.0' })
        const s = await fetch(`${base}/api/engines/${OLD}/store-url`)
        expect(s.status).toBe(200)
        expect(await s.json()).toEqual({ url: 'automerge:old' })
    })

    it('unreachable → 502 ENGINE_UNREACHABLE with engineId; a grant request also carries issuerEngineId', async () => {
        const r = await fetch(`${base}/api/engines/${GONE}/auth/info`)
        expect(r.status).toBe(502)
        expect(await r.json()).toMatchObject({ error: 'ENGINE_UNREACHABLE', engineId: GONE, message: 'relay-gone cannot be reached right now.' })
        const g = await fetch(`${base}/api/engines/${GONE}/auth/grant`, { method: 'POST', body: '{}' })
        expect(await g.json()).toMatchObject({ error: 'ENGINE_UNREACHABLE', engineId: GONE, issuerEngineId: GONE })
    })

    it('whole-request timeout → 502 ENGINE_UNREACHABLE', async () => {
        const t0 = Date.now()
        const r = await fetch(`${base}/api/engines/${SLOW}/command`, { method: 'POST', body: '{}' })
        expect(r.status).toBe(502)
        expect(await r.json()).toMatchObject({ error: 'ENGINE_UNREACHABLE', engineId: SLOW })
        expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400)
    })

    it('body over 16 KB → 413 PAYLOAD_TOO_LARGE, nothing forwarded', async () => {
        const r = await fetch(`${base}/api/engines/${PEER}/command`, { method: 'POST', body: 'x'.repeat(17 * 1024) })
        expect(r.status).toBe(413)
        expect((await r.json()).error).toBe('PAYLOAD_TOO_LARGE')
        expect(seen.filter(s => s.url === '/api/command')).toEqual([])
    })
})
