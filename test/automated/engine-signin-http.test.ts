/**
 * engine-signin-http.test.ts — /api/auth/* over HTTP (engine#582): info, setup with
 * the setup code, challenge sign-in, renew/logout, operators, password change,
 * rate limit, and how a Console tells an older Engine (404 on info).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import fs from 'fs'
import bcrypt from 'bcryptjs'
import { loginProof, clearChallengesForTests } from '../../src/data/LoginChallenge.js'
import { clearSessionsForTests } from '../../src/data/Sessions.js'
import { clearRateLimitsForTests } from '../../src/data/LoginRateLimit.js'
import { openSetup, closeSetup, currentSetupCodeForTests } from '../../src/data/SetupCode.js'
import { AUDIT_FILE_NAME } from '../../src/data/CommandAudit.js'

const { enableHttpMonitor } = await import('../../src/monitors/httpMonitor.js')

const ENGINE = 'engine-test-1'
const listen = async (srv: http.Server): Promise<string> => {
    await new Promise<void>((r) => (srv.listening ? r() : srv.once('listening', () => r())))
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
}
const close = (srv: http.Server) => new Promise<void>((r) => srv.close(() => r()))

describe('/api/auth/* (engine#582)', () => {
    let dir: string, server: http.Server, oldServer: http.Server, base: string, oldBase: string
    const doc: any = { engineDB: { [ENGINE]: { hostname: 'brave-otter', version: '2.4.0' } } }
    const post = (p: string, body: unknown, token?: string) => fetch(`${base}${p}`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
    const get = (p: string, token?: string) => fetch(`${base}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    const signIn = async (username: string, password: string) => {
        const ch = await (await post('/api/auth/challenge', { username })).json()
        const proof = loginProof(bcrypt.hashSync(password, ch.salt), ENGINE, ch.challengeId, ch.nonce)
        return post('/api/auth/login', { challengeId: ch.challengeId, username, proof })
    }

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-signin-http-'))
        server = enableHttpMonitor(0, '', null, undefined, {
            engineId: ENGINE, auth: { engineId: ENGINE, dir, storeHandle: { doc: () => doc } as any, capabilities: () => ['engineSignIn1'] },
        })
        oldServer = enableHttpMonitor(0, '', null, undefined, { engineId: 'old' })   // no auth context: like an older build
        base = await listen(server)
        oldBase = await listen(oldServer)
    })
    afterAll(async () => { closeSetup(); await close(server); await close(oldServer); fs.rmSync(dir, { recursive: true, force: true }) })
    beforeEach(() => { clearRateLimitsForTests(); clearChallengesForTests() })

    it('an older Engine answers 404 on /api/auth/info (the relay maps this to ENGINE_VERSION_MISMATCH)', async () => {
        const r = await fetch(`${oldBase}/api/auth/info`)
        expect(r.status).toBe(404)
        expect(await r.json()).toEqual({ error: 'NOT_FOUND', message: expect.any(String) })
    })

    let token = ''
    it('fresh Engine: info says setupRequired, sign-in says SETUP_REQUIRED, setup creates the first operator', async () => {
        clearSessionsForTests()
        openSetup({ dir, repeatLog: false })
        const info = await (await get('/api/auth/info')).json()
        expect(info).toEqual({ engineId: ENGINE, engineName: 'brave-otter', version: '2.4.0', authVersion: 1, setupRequired: true, capabilities: ['engineSignIn1'] })
        const c = await post('/api/auth/challenge', { username: 'admin' })
        expect(c.status).toBe(403)
        expect((await c.json()).error).toBe('SETUP_REQUIRED')

        const hash = bcrypt.hashSync('first-pw', 10)
        const bad = await post('/api/auth/setup', { setupCode: 'AAAA-AAAA', username: 'admin', passwordHash: hash })
        expect(bad.status).toBe(403)
        expect((await bad.json()).error).toBe('SETUP_CODE_INVALID')
        const weak = await post('/api/auth/setup', { setupCode: currentSetupCodeForTests(), username: 'admin', passwordHash: bcrypt.hashSync('x', 4) })
        expect(weak.status).toBe(400)
        const ok = await post('/api/auth/setup', { setupCode: currentSetupCodeForTests(), username: 'admin', passwordHash: hash })
        expect(ok.status).toBe(201)
        const body = await ok.json()
        expect(body).toMatchObject({ expiresInMs: 15 * 60_000, operator: { username: 'admin' } })
        token = body.token
        expect((await (await get('/api/auth/info')).json()).setupRequired).toBe(false)
        const again = await post('/api/auth/setup', { setupCode: 'AAAA-AAAA', username: 'x', passwordHash: hash })
        expect(again.status).toBe(409)
        expect((await again.json()).error).toBe('SETUP_DONE')
    })

    it('challenge sign-in, renew, logout', async () => {
        const wrong = await signIn('admin', 'nope')
        expect(wrong.status).toBe(401)
        expect((await wrong.json()).error).toBe('LOGIN_FAILED')
        const r = await signIn('admin', 'first-pw')
        expect(r.status).toBe(200)
        const { token: t2, operator } = await r.json()
        expect(operator.username).toBe('admin')
        const renew = await post('/api/auth/renew', {}, t2)
        expect(renew.status).toBe(200)
        expect((await renew.json()).expiresInMs).toBe(15 * 60_000)
        expect((await post('/api/auth/logout', {}, t2)).status).toBe(204)
        const after = await post('/api/auth/renew', {}, t2)
        expect(after.status).toBe(401)
        expect((await after.json()).error).toBe('TOKEN_INVALID')
        expect((await (await post('/api/auth/renew', {})).json()).error).toBe('AUTH_REQUIRED')
        expect((await (await post('/api/auth/renew', {}, 'bad')).json()).error).toBe('TOKEN_INVALID')
        expect((await (await get('/api/auth/operators', 'x'.repeat(43))).json()).error).toBe('TOKEN_INVALID')
        expect(r.headers.get('cache-control')).toBe('no-store')
    })

    it('unknown and known usernames look the same at the challenge step', async () => {
        const a = await (await post('/api/auth/challenge', { username: 'admin' })).json()
        const b = await (await post('/api/auth/challenge', { username: 'nobody' })).json()
        expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
        expect(b.salt).toMatch(/^\$2b\$10\$[./A-Za-z0-9]{22}$/)
        expect((await signIn('nobody', 'x')).status).toBe(401)
    })

    it('operators: list without hashes, add, OPERATOR_EXISTS, delete, LAST_OPERATOR', async () => {
        expect((await get('/api/auth/operators')).status).toBe(401)
        const list = await (await get('/api/auth/operators', token)).json()
        expect(list.operators).toHaveLength(1)
        expect(Object.keys(list.operators[0]).sort()).toEqual(['created', 'id', 'username'])
        const add = await post('/api/auth/operators', { username: 'teacher', passwordHash: bcrypt.hashSync('t-pw', 10) }, token)
        expect(add.status).toBe(201)
        const { operator } = await add.json()
        expect(operator.username).toBe('teacher')
        const dup = await post('/api/auth/operators', { username: 'teacher', passwordHash: bcrypt.hashSync('t-pw', 10) }, token)
        expect(dup.status).toBe(409)
        expect((await dup.json()).error).toBe('OPERATOR_EXISTS')
        const teacher = await (await signIn('teacher', 't-pw')).json()
        const del = await fetch(`${base}/api/auth/operators/${operator.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        expect(del.status).toBe(204)
        expect((await post('/api/auth/renew', {}, teacher.token)).status).toBe(401)   // removed operator's sessions end
        const unknown = await fetch(`${base}/api/auth/operators/nope`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        expect(unknown.status).toBe(404)
        expect((await unknown.json()).error).toBe('OPERATOR_UNKNOWN')
        const admin = list.operators[0]
        const last = await fetch(`${base}/api/auth/operators/${admin.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        expect(last.status).toBe(409)
        expect((await last.json()).error).toBe('LAST_OPERATOR')
    })

    it('password change proves the current password; other sessions end', async () => {
        const other = await (await signIn('admin', 'first-pw')).json()
        const ch = await (await post('/api/auth/challenge', { username: 'admin' })).json()
        const badProof = loginProof(bcrypt.hashSync('wrong', ch.salt), ENGINE, ch.challengeId, ch.nonce)
        const bad = await post('/api/auth/password', { challengeId: ch.challengeId, proof: badProof, newPasswordHash: bcrypt.hashSync('second-pw', 10) }, token)
        expect(bad.status).toBe(401)
        const ch2 = await (await post('/api/auth/challenge', { username: 'admin' })).json()
        const proof = loginProof(bcrypt.hashSync('first-pw', ch2.salt), ENGINE, ch2.challengeId, ch2.nonce)
        const ok = await post('/api/auth/password', { challengeId: ch2.challengeId, proof, newPasswordHash: bcrypt.hashSync('second-pw', 10) }, token)
        expect(ok.status).toBe(204)
        expect((await post('/api/auth/renew', {}, token)).status).toBe(200)
        expect((await post('/api/auth/renew', {}, other.token)).status).toBe(401)
        expect((await signIn('admin', 'first-pw')).status).toBe(401)
        expect((await signIn('admin', 'second-pw')).status).toBe(200)
    })

    it('5 failed sign-ins → 429 LOGIN_RATE_LIMITED with Retry-After and retryAfterSeconds', async () => {
        for (let i = 0; i < 5; i++) expect((await signIn('admin', 'bad')).status).toBe(401)
        const r = await signIn('admin', 'second-pw')
        expect(r.status).toBe(429)
        expect(r.headers.get('retry-after')).toBe('60')
        expect(await r.json()).toMatchObject({ error: 'LOGIN_RATE_LIMITED', retryAfterSeconds: 60 })
    })

    it('bad bodies: invalid JSON, too large, missing fields', async () => {
        const inv = await fetch(`${base}/api/auth/challenge`, { method: 'POST', body: '{nope' })
        expect(inv.status).toBe(400)
        const big = await fetch(`${base}/api/auth/challenge`, { method: 'POST', body: JSON.stringify({ username: 'x'.repeat(20_000) }) })
        expect(big.status).toBe(413)
        expect((await big.json()).error).toBe('PAYLOAD_TOO_LARGE')
        // The size is checked before the token: no token, a bad token and a good token all get 413
        const huge = JSON.stringify({ username: 'x'.repeat(20_000), passwordHash: 'y' })
        for (const t of [undefined, 'not-a-token', token]) {
            const r = await post('/api/auth/operators', JSON.parse(huge), t)
            expect(r.status, String(t)).toBe(413)
            expect((await r.json()).error).toBe('PAYLOAD_TOO_LARGE')
        }
        // Chunked (no Content-Length) and without a token: still 413, not 401
        const chunked = await fetch(`${base}/api/auth/password`, {
            method: 'POST', duplex: 'half',
            body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(huge)); c.close() } }),
        } as any)
        expect(chunked.status).toBe(413)
        // A small body without a token is still 401
        expect((await post('/api/auth/operators', { username: 'z', passwordHash: 'y' })).status).toBe(401)
        const miss = await post('/api/auth/login', { username: 'admin' })
        expect(miss.status).toBe(400)
        expect((await miss.json()).error).toBe('BAD_REQUEST')
    })

    it('sign-in events go to the local audit log without secrets', async () => {
        const text = fs.readFileSync(path.join(dir, AUDIT_FILE_NAME), 'utf8')
        expect(text).toContain('"command":"auth:login"')
        expect(text).toContain('"errorCode":"LOGIN_FAILED"')
        expect(text).not.toMatch(/\$2[aby]\$/)
        expect(text).not.toContain(token)
    })
})
