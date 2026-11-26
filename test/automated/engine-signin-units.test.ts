/**
 * engine-signin-units.test.ts — Engine-local accounts, challenge sign-in, sessions,
 * rate limits and the setup code (engine#582).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import {
    importOperatorsOnce, readOperatorsFile, listOperators, addOperator, removeOperator, setOperatorHash, upsertOperatorHash,
    isBcryptHash, isAcceptableNewHash, saltOf, OperatorError, OPERATORS_FILE,
} from '../../src/data/Operators.js'
import {
    loginProof, fakeSalt, bcryptBase64, createChallenge, verifyProof, clearChallengesForTests, CHALLENGE_TTL_MS,
} from '../../src/data/LoginChallenge.js'
import {
    createSession, checkToken, bearerToken, endSession, endSessionsOf, clearSessionsForTests, sessionCountForTests,
    SESSION_IDLE_MS, SESSION_MAX_MS, MAX_SESSIONS,
} from '../../src/data/Sessions.js'
import {
    loginWaitMs, recordLoginFailure, recordLoginSuccess, clearRateLimitsForTests,
    CLIENT_LOCK_BASE_MS, CLIENT_LOCK_MAX_MS, ACCOUNT_LOCK_MS, GLOBAL_WINDOW_MS,
} from '../../src/data/LoginRateLimit.js'
import {
    openSetup, closeSetup, useSetupCode, setupOpen, normaliseSetupCode, newSetupCode, currentSetupCodeForTests,
    SETUP_CODE_TTL_MS, SETUP_LOCK_MS, SETUP_CODE_FILE,
} from '../../src/data/SetupCode.js'
import { syncEngineAuth, watchStoreAccounts, storeImportPending } from '../../src/data/EngineAuth.js'
import { clearAuthSecretCacheForTests } from '../../src/data/AuthSecret.js'

// Pixel's reference vector (agent-console-dev, engine#582 review point 16)
const VEC = {
    password: 'idea-test',
    salt: '$2b$10$abcdefghijklmnopqrstuu',
    hash: '$2b$10$abcdefghijklmnopqrstuuTz0XgmRlzyslBgX7qxsZ1WQYR9WyyzG',
    engineId: 'eng-test', challengeId: 'ch1', nonce: 'n1',
    proof: 'cd1abc0204f9362e41dfe9733db7e9206385588aece117f80ab3e6ea2e94d538',
}

let dir: string
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-signin-'))
    clearChallengesForTests(); clearSessionsForTests(); clearRateLimitsForTests(); clearAuthSecretCacheForTests(); closeSetup()
})
afterEach(() => { closeSetup(); fs.rmSync(dir, { recursive: true, force: true }) })

const H10 = (pw = 'pw-' + crypto.randomBytes(3).toString('hex')) => bcrypt.hashSync(pw, 10)

describe('reference vector (Console ⇄ Engine)', () => {
    it('bcrypt(password, salt) gives the vector hash and the proof matches', () => {
        expect(bcrypt.hashSync(VEC.password, VEC.salt)).toBe(VEC.hash)
        expect(saltOf(VEC.hash)).toBe(VEC.salt)
        expect(loginProof(VEC.hash, VEC.engineId, VEC.challengeId, VEC.nonce)).toBe(VEC.proof)
    })
    it('the Engine accepts the vector proof against the stored hash', () => {
        upsertOperatorHash('admin', VEC.hash, dir)
        const ch = createChallenge('admin', dir)
        expect(ch.salt).toBe(VEC.salt)
        const proof = loginProof(bcrypt.hashSync(VEC.password, ch.salt), VEC.engineId, ch.challengeId, ch.nonce)
        expect(verifyProof(ch.challengeId, 'admin', proof, VEC.engineId, dir)?.username).toBe('admin')
    })
})

describe('operators.json and the one-time import', () => {
    it('imports well-formed bcrypt users once, keeps their cost, never again', () => {
        const h12 = '$2a$12$' + 'a'.repeat(53)
        const store: any = { userDB: {
            u1: { id: 'u1', username: 'admin', passwordHash: VEC.hash, created: 5 },
            u2: { id: 'u2', username: 'teacher', passwordHash: h12 },
            u3: { id: 'u3', username: 'plain', passwordHash: 'not-a-hash' },
            u4: { id: 'u4', username: 'admin', passwordHash: VEC.hash },
        } }
        const r = importOperatorsOnce(store, dir, 100)
        expect(r).toEqual({ created: true, imported: ['admin', 'teacher'], skipped: [] })
        const f = readOperatorsFile(dir)!
        expect(f.importedFromStore).toEqual({ at: 100, count: 2 })
        expect(f.operators.find(o => o.username === 'teacher')!.passwordHash).toBe(h12)
        expect((fs.statSync(path.join(dir, OPERATORS_FILE)).mode & 0o777).toString(8)).toBe('600')
        store.userDB.u5 = { id: 'u5', username: 'late', passwordHash: VEC.hash }
        expect(importOperatorsOnce(store, dir)).toEqual({ created: false, imported: [], skipped: [] })
        expect(listOperators(dir).map(o => o.username)).toEqual(['admin', 'teacher'])
    })
    it('an empty userDB still writes the file, so a later userDB is not imported', () => {
        expect(importOperatorsOnce({ userDB: {} } as any, dir).created).toBe(true)
        expect(importOperatorsOnce({ userDB: { a: { username: 'x', passwordHash: VEC.hash } } } as any, dir).created).toBe(false)
        expect(listOperators(dir)).toEqual([])
    })
    it('hash rules: imports any cost, new hashes cost 10–12 only', () => {
        expect(isBcryptHash('$2y$04$' + 'a'.repeat(53))).toBe(true)
        expect(isAcceptableNewHash('$2b$09$' + 'a'.repeat(53))).toBe(false)
        expect(isAcceptableNewHash('$2b$10$' + 'a'.repeat(53))).toBe(true)
        expect(isAcceptableNewHash('$2b$12$' + 'a'.repeat(53))).toBe(true)
        expect(isAcceptableNewHash('$2b$13$' + 'a'.repeat(53))).toBe(false)
        expect(() => addOperator('x', '$2b$04$' + 'a'.repeat(53), dir)).toThrow(OperatorError)
    })
    it('OPERATOR_EXISTS, OPERATOR_UNKNOWN, LAST_OPERATOR', () => {
        const a = addOperator('anna', H10(), dir)
        expect(() => addOperator('anna', H10(), dir)).toThrow(expect.objectContaining({ code: 'OPERATOR_EXISTS' }))
        expect(() => removeOperator('nope', dir)).toThrow(expect.objectContaining({ code: 'OPERATOR_UNKNOWN' }))
        expect(() => removeOperator(a.id, dir)).toThrow(expect.objectContaining({ code: 'LAST_OPERATOR' }))
        const b = addOperator('bert', H10(), dir)
        removeOperator(a.id, dir)
        expect(listOperators(dir).map(o => o.id)).toEqual([b.id])
        expect(() => setOperatorHash('anna', H10(), dir)).toThrow(expect.objectContaining({ code: 'OPERATOR_UNKNOWN' }))
    })
})

describe('challenge sign-in', () => {
    const op = () => { const pw = 'secret-pw'; const hash = bcrypt.hashSync(pw, 10); upsertOperatorHash('admin', hash, dir); return { pw, hash } }

    it('a right proof signs in once; the challenge is single-use', () => {
        const { pw } = op()
        const ch = createChallenge('admin', dir, 0)
        expect(ch.expiresInMs).toBe(CHALLENGE_TTL_MS)
        const proof = loginProof(bcrypt.hashSync(pw, ch.salt), 'E1', ch.challengeId, ch.nonce)
        expect(verifyProof(ch.challengeId, 'admin', proof, 'E1', dir, 10)).not.toBeNull()
        expect(verifyProof(ch.challengeId, 'admin', proof, 'E1', dir, 11)).toBeNull()
    })
    it('refuses a wrong password, another Engine id, another username, an expired challenge', () => {
        const { pw } = op()
        const mk = () => createChallenge('admin', dir, 0)
        let ch = mk()
        expect(verifyProof(ch.challengeId, 'admin', loginProof(bcrypt.hashSync('wrong', ch.salt), 'E1', ch.challengeId, ch.nonce), 'E1', dir, 1)).toBeNull()
        ch = mk()
        expect(verifyProof(ch.challengeId, 'admin', loginProof(bcrypt.hashSync(pw, ch.salt), 'E2', ch.challengeId, ch.nonce), 'E1', dir, 1)).toBeNull()
        ch = mk()
        expect(verifyProof(ch.challengeId, 'other', loginProof(bcrypt.hashSync(pw, ch.salt), 'E1', ch.challengeId, ch.nonce), 'E1', dir, 1)).toBeNull()
        ch = mk()
        expect(verifyProof(ch.challengeId, 'admin', loginProof(bcrypt.hashSync(pw, ch.salt), 'E1', ch.challengeId, ch.nonce), 'E1', dir, CHALLENGE_TTL_MS)).toBeNull()
        ch = mk()
        expect(verifyProof(ch.challengeId, 'admin', 'zz', 'E1', dir, 1)).toBeNull()
    })
    it('unknown usernames get a stable fake salt in the same format and cost', () => {
        upsertOperatorHash('admin', '$2b$12$' + 'a'.repeat(53), dir, 1)
        const s1 = createChallenge('ghost', dir).salt
        const s2 = createChallenge('ghost', dir).salt
        expect(s1).toBe(s2)
        expect(s1).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{21}[.Oeu]$/)
        expect(createChallenge('ghost2', dir).salt).not.toBe(s1)
        expect(bcrypt.hashSync('x', fakeSalt('ghost', dir).replace('$12$', '$04$'))).toMatch(/^\$2b\$04\$/)
    })
    it('bcryptBase64 matches bcryptjs salts', () => {
        expect(bcryptBase64(Buffer.alloc(16))).toBe('......................')
        expect(bcryptBase64(Buffer.alloc(16, 0xff))).toBe('9999999999999999999999'.slice(0, 21) + 'u')
    })
})

describe('sessions', () => {
    const OP = { id: 'u1', username: 'admin' }
    it('idle expiry after 15 min, renewal by use, TOKEN_EXPIRED then TOKEN_INVALID', () => {
        const { token, expiresInMs } = createSession(OP, 0)
        expect(expiresInMs).toBe(SESSION_IDLE_MS)
        expect(checkToken(token, SESSION_IDLE_MS - 1).ok).toBe(true)          // renews to 2*idle-1
        expect(checkToken(token, 2 * SESSION_IDLE_MS - 2).ok).toBe(true)
        expect(checkToken(token, 4 * SESSION_IDLE_MS)).toEqual({ ok: false, code: 'TOKEN_EXPIRED' })
        expect(checkToken(token, 4 * SESSION_IDLE_MS)).toEqual({ ok: false, code: 'TOKEN_INVALID' })
        expect(checkToken(null)).toEqual({ ok: false, code: 'AUTH_REQUIRED' })
    })
    it('hard cap of 8 h however often it is renewed', () => {
        const { token } = createSession(OP, 0)
        for (let t = 60_000; t < SESSION_MAX_MS; t += 10 * 60_000) expect(checkToken(token, t).ok).toBe(true)
        expect(checkToken(token, SESSION_MAX_MS).ok).toBe(false)
    })
    it('at most 32 sessions; the least recently used goes', () => {
        const first = createSession(OP, 0).token
        for (let i = 1; i < MAX_SESSIONS; i++) createSession(OP, i)
        expect(sessionCountForTests()).toBe(MAX_SESSIONS)
        createSession(OP, 100)
        expect(sessionCountForTests()).toBe(MAX_SESSIONS)
        expect(checkToken(first, 101).ok).toBe(false)
    })
    it('logout and endSessionsOf', () => {
        const a = createSession(OP, 0), b = createSession(OP, 0)
        expect(endSession(a.token)).toBe(true)
        expect(checkToken(a.token, 1).ok).toBe(false)
        endSessionsOf('u1')
        expect(checkToken(b.token, 1).ok).toBe(false)
    })
    it('bearerToken parses only "Bearer <token>"', () => {
        expect(bearerToken('Bearer ' + 'a'.repeat(43))).toBe('a'.repeat(43))
        // only a missing header is AUTH_REQUIRED; anything else that is not a valid token is TOKEN_INVALID
        expect(bearerToken('Basic abc')).toBe('')
        expect(bearerToken(undefined)).toBeNull()
        expect(bearerToken('')).toBeNull()
        expect(bearerToken('Bearer short')).toBe('short')
        expect(checkToken(bearerToken('Bearer short'))).toEqual({ ok: false, code: 'TOKEN_INVALID' })
        expect(checkToken(bearerToken('Basic abc'))).toEqual({ ok: false, code: 'TOKEN_INVALID' })
        expect(checkToken(bearerToken('Bearer ' + 'b'.repeat(43)))).toEqual({ ok: false, code: 'TOKEN_INVALID' })
        expect(checkToken(bearerToken(undefined))).toEqual({ ok: false, code: 'AUTH_REQUIRED' })
    })
})

describe('sign-in rate limits', () => {
    it('5 failures per client lock it for 60 s, doubling to 15 min; success clears', () => {
        for (let i = 0; i < 4; i++) recordLoginFailure('10.0.0.1', `u${i}`, 0)
        expect(loginWaitMs('10.0.0.1', 'x', 0)).toBe(0)
        recordLoginFailure('10.0.0.1', 'u4', 0)
        expect(loginWaitMs('10.0.0.1', 'x', 0)).toBe(CLIENT_LOCK_BASE_MS)
        expect(loginWaitMs('10.0.0.2', 'x', 0)).toBe(0)
        let t = CLIENT_LOCK_BASE_MS
        for (let i = 0; i < 5; i++) recordLoginFailure('10.0.0.1', `v${i}`, t)
        expect(loginWaitMs('10.0.0.1', 'x', t)).toBe(2 * CLIENT_LOCK_BASE_MS)
        for (let n = 0; n < 6; n++) { t += 3_600_000; for (let i = 0; i < 5; i++) recordLoginFailure('10.0.0.1', `w${n}${i}`, t) }
        expect(loginWaitMs('10.0.0.1', 'x', t)).toBe(CLIENT_LOCK_MAX_MS)
        recordLoginSuccess('10.0.0.1')
        expect(loginWaitMs('10.0.0.1', 'x', t)).toBe(0)
    })
    it('20 failures for one username from many clients lock that username', () => {
        for (let i = 0; i < 20; i++) recordLoginFailure(`10.1.0.${i}`, 'admin', i * 4_000)
        const now = 19 * 4_000
        expect(loginWaitMs('10.9.9.9', 'admin', now)).toBe(ACCOUNT_LOCK_MS)
        expect(loginWaitMs('10.9.9.9', 'teacher', now)).toBe(0)
    })
    it('30 failures in a minute lock every sign-in until the minute passes', () => {
        for (let i = 0; i < 30; i++) recordLoginFailure(`10.2.${i}.1`, `n${i}`, 1000)
        expect(loginWaitMs('10.3.0.1', 'fresh', 1000)).toBe(GLOBAL_WINDOW_MS)
        expect(loginWaitMs('10.3.0.1', 'fresh', 1000 + GLOBAL_WINDOW_MS)).toBe(0)
    })
})

describe('setup code', () => {
    it('format XXXX-XXXX Crockford, file 0600, single use', () => {
        expect(newSetupCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
        const code = openSetup({ dir, now: 0, repeatLog: false })
        const f = path.join(dir, SETUP_CODE_FILE)
        expect(fs.readFileSync(f, 'utf8').trim()).toBe(code)
        expect((fs.statSync(f).mode & 0o777).toString(8)).toBe('600')
        expect(useSetupCode(code.toLowerCase().replace('-', ' '), 1)).toEqual({ ok: true })
        expect(setupOpen()).toBe(false)
        expect(fs.existsSync(f)).toBe(false)
        expect(useSetupCode(code, 2).ok).toBe(false)
    })
    it('expires after 24 h of uptime', () => {
        const code = openSetup({ dir, now: 0, repeatLog: false })
        expect(useSetupCode(code, SETUP_CODE_TTL_MS)).toEqual({ ok: false, code: 'SETUP_CODE_INVALID' })
    })
    it('5 wrong codes lock setup for 15 minutes, even for the right code', () => {
        const code = openSetup({ dir, now: 0, repeatLog: false })
        for (let i = 0; i < 5; i++) expect(useSetupCode('AAAA-AAAA', 1).ok).toBe(false)
        expect(useSetupCode(code, 2)).toEqual({ ok: false, code: 'SETUP_LOCKED', retryAfterMs: SETUP_LOCK_MS - 1 })
        expect(useSetupCode(code, 1 + SETUP_LOCK_MS)).toEqual({ ok: true })
    })
    it('a new start makes a new code', () => {
        const a = openSetup({ dir, repeatLog: false })
        const b = openSetup({ dir, repeatLog: false })
        expect(currentSetupCodeForTests()).toBe(b)
        expect(useSetupCode(a).ok).toBe(a === b)
        expect(normaliseSetupCode('o1il-0L1I')).toBe('0111' + '0111')
    })
})

describe('startup (syncEngineAuth)', () => {
    const handle = (doc: any) => ({ doc: () => doc }) as any
    it('imports userDB accounts and opens no setup', () => {
        const r = syncEngineAuth(handle({ userDB: { u: { id: 'u', username: 'admin', passwordHash: VEC.hash } } }), { dir, tty: false })
        expect(r).toMatchObject({ operators: 1, imported: ['admin'], setupOpen: false })
        expect(fs.existsSync(path.join(dir, 'auth-secret'))).toBe(true)
    })
    it('nothing to import: setup opens with a code', () => {
        const r = syncEngineAuth(handle({ userDB: {} }), { dir, tty: false })
        expect(r).toMatchObject({ operators: 0, setupOpen: true, waitingForStore: false })
        expect(currentSetupCodeForTests()).toMatch(/-/)
    })
    it('store maps not there yet: setup opens, the import runs when they arrive and closes setup', () => {
        const doc: any = {}
        expect(syncEngineAuth(handle(doc), { dir, tty: false })).toMatchObject({ setupOpen: true, waitingForStore: true })
        expect(readOperatorsFile(dir)).toBeNull()
        doc.userDB = { u: { id: 'u', username: 'admin', passwordHash: VEC.hash } }
        expect(syncEngineAuth(handle(doc), { dir, tty: false })).toMatchObject({ operators: 1, imported: ['admin'], setupOpen: false })
    })
    it('setup wrote operators.json before the store synced: the import still runs once, this Engine\'s accounts win', () => {
        const doc: any = {}
        expect(syncEngineAuth(handle(doc), { dir, tty: false })).toMatchObject({ setupOpen: true, waitingForStore: true })
        addOperator('pixel', VEC.hash, dir)   // what POST /api/auth/setup does
        expect(readOperatorsFile(dir)!.importedFromStore).toBeNull()
        const other = '$2b$10$' + 'c'.repeat(53)
        doc.engineDB = {}
        doc.userDB = { a: { id: 'a', username: 'admin', passwordHash: VEC.hash }, p: { id: 'p', username: 'pixel', passwordHash: other } }
        expect(syncEngineAuth(handle(doc), { dir, tty: false })).toMatchObject({ operators: 2, imported: ['admin'] })
        expect(listOperators(dir).find(o => o.username === 'pixel')!.passwordHash).toBe(VEC.hash)   // local wins
        expect(readOperatorsFile(dir)!.importedFromStore).toMatchObject({ count: 1 })
        doc.userDB.late = { id: 'l', username: 'late', passwordHash: VEC.hash }
        expect(syncEngineAuth(handle(doc), { dir, tty: false }).imported).toEqual([])   // once only
    })
    it('a loaded store without userDB (store-template.json): nothing to import, no waiting; a userDB synced later is still imported once', () => {
        const doc: any = { engineDB: {}, diskDB: {} }
        expect(syncEngineAuth(handle(doc), { dir, tty: false })).toMatchObject({ waitingForStore: false, imported: [], setupOpen: true })
        expect(readOperatorsFile(dir)!.importedFromStore).toMatchObject({ count: 0, none: true })
        expect(syncEngineAuth(handle(doc), { dir, tty: false })).toMatchObject({ waitingForStore: false })
        doc.userDB = { a: { id: 'a', username: 'admin', passwordHash: VEC.hash } }
        expect(syncEngineAuth(handle(doc), { dir, tty: false })).toMatchObject({ operators: 1, imported: ['admin'], setupOpen: false })
        expect(readOperatorsFile(dir)!.importedFromStore).toEqual({ at: expect.any(Number), count: 1 })
    })
    it('watchStoreAccounts: a userDB arriving by sync triggers the import, then stops watching', async () => {
        const { Repo } = await import('@automerge/automerge-repo')
        const h = new Repo({ network: [], storage: undefined }).create<any>({ engineDB: {}, diskDB: {} })
        await h.whenReady()
        syncEngineAuth(h, { dir, tty: false })
        const stop = watchStoreAccounts(h, { dir })
        h.change((d: any) => { d.userDB = { a: { id: 'a', username: 'admin', passwordHash: VEC.hash } } })
        await new Promise(r => setTimeout(r, 50))
        expect(listOperators(dir).map(o => o.username)).toEqual(['admin'])
        expect(storeImportPending(dir)).toBe(false)
        stop()
    })
})

describe('idea-engine-auth CLI (Ops provisioning)', () => {
    it('set-password creates the operator with a cost-10 hash; the Engine accepts a proof for it', async () => {
        const { execFileSync } = await import('child_process')
        const { fileURLToPath } = await import('url')
        const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../script/idea-engine-auth.js')
        const env = { ...process.env, IDEA_AUTH_DIR: dir }
        const out = execFileSync(process.execPath, [cli, 'set-password', 'ops'], { input: 'cli-password-1\n', env }).toString()
        expect(out).toContain("Operator 'ops' created")
        const op = listOperators(dir).find(o => o.username === 'ops')!
        expect(op.passwordHash).toMatch(/^\$2[ab]\$10\$/)
        expect(readOperatorsFile(dir)!.importedFromStore).toBeNull()
        const ch = createChallenge('ops', dir)
        expect(verifyProof(ch.challengeId, 'ops', loginProof(bcrypt.hashSync('cli-password-1', ch.salt), 'E', ch.challengeId, ch.nonce), 'E', dir)).not.toBeNull()
        expect(() => execFileSync(process.execPath, [cli, 'set-password', 'ops'], { input: 'short\n', env, stdio: 'pipe' })).toThrow()
        expect(execFileSync(process.execPath, [cli, 'list'], { env }).toString()).toContain('ops')
    })
})
