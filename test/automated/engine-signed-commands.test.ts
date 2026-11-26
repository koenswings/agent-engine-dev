/**
 * engine-signed-commands.test.ts — signed queue entries, peer grants and
 * POST /api/command (engine#582), including the mixed-version cases:
 *   - an old (unsigned) queue entry is refused with COMMAND_UNSIGNED and never runs
 *   - a peer without signedCommands1 → ENGINE_VERSION_MISMATCH (no grant asked)
 *   - a peer whose /api/auth/info answers 404 → ENGINE_VERSION_MISMATCH
 *   - replay refusal, grant scope and expiry, confirmation expiry
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { DocHandle, Repo } from '@automerge/automerge-repo'

vi.mock('../../src/data/Engine.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, rebootEngine: vi.fn(async () => {}) }
})
vi.mock('../../src/data/ConfirmGate.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, prepareConfirm: vi.fn(async () => ({ summary: { label: 'Backup 3', contents: [] }, confirmField: 'label', expected: 'Backup 3' })) }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, rebootEngine } from '../../src/data/Engine.js'
import { CommandLogStore, CommandTrace, commandLogText, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { enableStoreMonitor } from '../../src/monitors/storeMonitor.js'
import {
    signEntry, verifyEntry, markSeqDone, parseEntry, nextSeq, maxIssuedSeq, entryCommandText, entryLogText,
    COMMAND_UNSIGNED, COMMAND_SIGNATURE_INVALID, COMMAND_REPLAYED,
} from '../../src/data/CommandKey.js'
import { enqueueSigned, clearPendingSourcesForTests } from '../../src/data/SignedQueue.js'
import { issueGrant, checkGrant, GrantError, GRANT_TTL_MS, isPeerFollowUp, rememberGrant, grantFrom, clearGrantsForTests, parseGrant, GRANT_CHECK_COMMAND } from '../../src/data/PeerGrants.js'
import { dispatchToPeer, hasSignedCommands, preflightPeerGrant, grantRefusal, PeerGrantRefusal } from '../../src/data/PeerCommands.js'
import { setPeerAddressOverrideForTests, verifiedTarget, PeerError } from '../../src/data/PeerHttp.js'
import { createSession, clearSessionsForTests } from '../../src/data/Sessions.js'
import { clearConfirmsForTests, CONFIRM_TTL_MS } from '../../src/data/ConfirmGate.js'
import { sendCommand } from '../../src/utils/commandUtils.js'
import { monoNow } from '../../src/utils/monoClock.js'

const { enableHttpMonitor } = await import('../../src/monitors/httpMonitor.js')

const SELF = String(localEngineId)
const PEER = 'ENGINE_peer-b'
const OLD = 'ENGINE_old-c'

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(d => {
        ;(d.engineDB as any)[PEER] = { id: PEER, hostname: 'peer-b', commands: [], lastBooted: 5, capabilitiesBootedAt: 5, capabilities: ['signedCommands1'], version: '2.5.0' }
        ;(d.engineDB as any)[OLD] = { id: OLD, hostname: 'old-c', commands: [], lastBooted: 5, capabilitiesBootedAt: 5, capabilities: ['engineSignIn1'], version: '2.3.0' }
        ;(d.diskDB as any)['disk-peer'] = { id: 'disk-peer', name: 'peer-disk', dockedTo: PEER }
        ;(d.diskDB as any)['disk-old'] = { id: 'disk-old', name: 'old-disk', dockedTo: OLD }
    })
    return h
}
const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] => h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])
const queue = (h: DocHandle<Store>, id: string = SELF): string[] => [...(((h.doc()!.engineDB as any)[id].commands as any[]) ?? [])].map(String)

describe('signed queue entries (CommandKey)', () => {
    it('sign → verify ok; seq increases; the command text is readable', () => {
        const a = signEntry('reboot', 'cli', SELF)
        const b = signEntry('ejectDisk d1', 'op-0123abcd', SELF)
        expect(b.seq).toBe(a.seq + 1)
        expect(a.entry).toMatch(/^@v1\.\d+\.cli\.[A-Za-z0-9_-]{43} reboot$/)
        expect(verifyEntry(b.entry, SELF)).toEqual({ ok: true, seq: b.seq, src: 'op-0123abcd', command: 'ejectDisk d1' })
        expect(entryCommandText(b.entry)).toBe('ejectDisk d1')
        expect(entryCommandText('reboot')).toBe('reboot')
    })

    it('the log form of an entry shows seq and source, never the mac', () => {
        const b = signEntry('ejectDisk d1', 'op-0123abcd', SELF)
        const mac = parseEntry(b.entry)!.mac
        expect(entryLogText(b.entry)).toBe(`[seq ${b.seq}, src op-0123abcd] ejectDisk d1`)
        expect(entryLogText(b.entry)).not.toContain(mac)
        expect(entryLogText('reboot')).toBe('reboot')
        expect(entryLogText('@v1.12.cli.short reboot')).toBe('[unreadable signature] reboot')
    })

    it('unsigned (an older Console writing the store) → COMMAND_UNSIGNED', () => {
        const v = verifyEntry('ejectDisk d1', SELF)
        expect(v).toMatchObject({ ok: false, code: COMMAND_UNSIGNED, seq: null, command: 'ejectDisk d1' })
    })

    it('changed command, other Engine id, or changed source → COMMAND_SIGNATURE_INVALID', () => {
        const { entry, seq } = signEntry('ejectDisk d1', 'cli', SELF)
        expect(verifyEntry(entry.replace('ejectDisk d1', 'eraseDisk d1'), SELF)).toMatchObject({ ok: false, code: COMMAND_SIGNATURE_INVALID, seq })
        expect(verifyEntry(entry, 'ENGINE_other')).toMatchObject({ ok: false, code: COMMAND_SIGNATURE_INVALID })
        expect(verifyEntry(entry.replace('.cli.', '.engine.'), SELF)).toMatchObject({ ok: false, code: COMMAND_SIGNATURE_INVALID })
    })

    it('replay: a seq that ran, a seq never issued, or one out of the window → COMMAND_REPLAYED', () => {
        const { entry, seq } = signEntry('reboot', 'cli', SELF)
        markSeqDone(seq)
        expect(verifyEntry(entry, SELF)).toMatchObject({ ok: false, code: COMMAND_REPLAYED, seq })
        const p = parseEntry(entry)!
        expect(p.seq).toBe(seq)
        expect(maxIssuedSeq()).toBeGreaterThanOrEqual(seq)
        expect(nextSeq()).toBe(seq + 1)
    })
})

describe('the queue runs only signed entries', () => {
    let h: DocHandle<Store>, log: DocHandle<CommandLogStore>
    beforeEach(async () => { vi.mocked(rebootEngine).mockClear(); h = await newStore(); log = newLog() })

    it('an unsigned entry: error trace COMMAND_UNSIGNED, not run, removed; the next signed entry runs', async () => {
        enableStoreMonitor(h, log)
        h.change(d => { (d.engineDB[localEngineId].commands as any[]).push('reboot', signEntry('reboot', 'cli', SELF).entry) })
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        expect(vi.mocked(rebootEngine)).toHaveBeenCalledOnce()
        const t = traces(log).filter(x => x.command === 'reboot')
        expect(t.map(x => x.status).sort()).toEqual(['error', 'ok'])
        const refused = t.find(x => x.status === 'error')!
        expect(refused.errorCode).toBe(COMMAND_UNSIGNED)
        expect(commandLogText(refused.errorMessage)).toMatch(/signed-in operator/)
    })

    it('the same signed entry twice: the second is refused COMMAND_REPLAYED with its seq', async () => {
        enableStoreMonitor(h, log)
        const { entry, seq } = signEntry('reboot', 'cli', SELF)
        h.change(d => { (d.engineDB[localEngineId].commands as any[]).push(entry) })
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        h.change(d => { (d.engineDB[localEngineId].commands as any[]).push(entry) })
        await vi.waitFor(() => expect(traces(log).filter(x => x.command === 'reboot')).toHaveLength(2))
        expect(vi.mocked(rebootEngine)).toHaveBeenCalledOnce()
        const t = traces(log).filter(x => x.command === 'reboot')
        expect(t.find(x => x.status === 'error')).toMatchObject({ errorCode: COMMAND_REPLAYED, seq })
        expect(t.find(x => x.status === 'ok')).toMatchObject({ seq })
    })

    it('enqueueSigned keeps the operator details for the trace; sendCommand refuses another Engine', async () => {
        enableStoreMonitor(h, log)
        setCommandLogHandle(log)
        const seq = enqueueSigned(h, 'reboot', 'op-0123abcd', { kind: 'operator', operator: 'admin', session: '0123abcd', remoteAddr: '10.42.0.9' })
        await vi.waitFor(() => expect(traces(log).find(x => x.command === 'reboot')?.status).toBe('ok'))
        expect(traces(log).find(x => x.command === 'reboot')).toMatchObject({ seq, source: { kind: 'operator', operator: 'admin', session: '0123abcd', remoteAddr: '10.42.0.9' } })
        expect(sendCommand(h, PEER as any, 'startInstance i1 d1' as any)).toBeNull()
        expect(queue(h, PEER)).toEqual([])
        clearPendingSourcesForTests()
    })
})

describe('peer grants (PeerGrants)', () => {
    beforeEach(() => clearGrantsForTests())

    it('issued by B for A: valid for A only; every failure names B as issuerEngineId', () => {
        const { grant, expiresInMs } = issueGrant(PEER, SELF)
        expect(expiresInMs).toBe(GRANT_TTL_MS)
        expect(checkGrant(grant, PEER, SELF)).toMatchObject({ issuer: PEER, to: SELF })
        const fail = (fn: () => unknown): GrantError => { try { fn() } catch (e) { return e as GrantError } throw new Error('no error') }
        const wrongFrom = fail(() => checkGrant(grant, PEER, 'ENGINE_x'))
        expect(wrongFrom).toMatchObject({ code: 'GRANT_INVALID', issuerEngineId: PEER })
        const notMine = fail(() => checkGrant(grant, 'ENGINE_x', SELF))
        expect(notMine).toMatchObject({ code: 'GRANT_INVALID', issuerEngineId: 'ENGINE_x' })
        const forged = grant.slice(0, -2) + (grant.endsWith('AA') ? 'BB' : 'AA')
        expect(fail(() => checkGrant(forged, PEER, SELF))).toMatchObject({ code: 'GRANT_INVALID', issuerEngineId: PEER })
        expect(fail(() => checkGrant('junk', PEER, SELF))).toMatchObject({ code: 'GRANT_INVALID', issuerEngineId: PEER })
    })

    it('expiry after 6 h, and after a restart (in memory only) → GRANT_EXPIRED', () => {
        const now = monoNow()
        const { grant } = issueGrant(PEER, SELF, 'admin', now)
        expect(() => checkGrant(grant, PEER, SELF, now + GRANT_TTL_MS - 1)).not.toThrow()
        expect(() => checkGrant(grant, PEER, SELF, now + GRANT_TTL_MS)).toThrow(expect.objectContaining({ code: 'GRANT_EXPIRED', issuerEngineId: PEER }))
        const g2 = issueGrant(PEER, SELF).grant
        clearGrantsForTests()   // like a restart
        expect(() => checkGrant(g2, PEER, SELF)).toThrow(expect.objectContaining({ code: 'GRANT_EXPIRED', issuerEngineId: PEER }))
    })

    it('scope: only the peer follow-ups', () => {
        for (const c of ['startInstance i d', 'verifyMoveTarget o i d', 'cleanupMoveTarget o i d', 'pushAppBundle x', 'appFetchResult x']) expect(isPeerFollowUp(c)).toBe(true)
        for (const c of ['eraseDisk d t', 'copyApp i a b', 'reboot', 'flashCard c v s', 'createInstance x']) expect(isPeerFollowUp(c)).toBe(false)
    })

    it('received grants: kept per issuer, refused when for another Engine, gone after 6 h', () => {
        const now = monoNow()
        const { grant } = issueGrant(PEER, SELF)
        rememberGrant(grant, SELF, now)
        expect(grantFrom(PEER, now + 1)).toBe(grant)
        expect(grantFrom(PEER, now + GRANT_TTL_MS)).toBeNull()
        expect(() => rememberGrant(issueGrant(PEER, 'ENGINE_x').grant, SELF)).toThrow(expect.objectContaining({ code: 'GRANT_INVALID', issuerEngineId: PEER }))
    })
})

describe('peer follow-ups (PeerCommands / PeerHttp), mixed versions', () => {
    let h: DocHandle<Store>, log: DocHandle<CommandLogStore>, fake: http.Server, port = 0
    const seen: { url: string, auth: string, body: any }[] = []
    let answer: { status: number, body: unknown } = { status: 202, body: { engineId: PEER, seq: 77 } }
    beforeAll(async () => {
        fake = http.createServer((req, res) => {
            let raw = ''
            req.on('data', c => { raw += c })
            req.on('end', () => {
                if (req.url === '/api/auth/info') {
                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ engineId: PEER })); return
                }
                seen.push({ url: String(req.url), auth: String(req.headers.authorization ?? ''), body: raw ? JSON.parse(raw) : null })
                res.writeHead(answer.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answer.body))
            })
        }).listen(0, '127.0.0.1')
        await new Promise<void>(r => fake.once('listening', () => r()))
        port = (fake.address() as AddressInfo).port
    })
    afterAll(async () => { setPeerAddressOverrideForTests(null); await new Promise<void>(r => fake.close(() => r())) })
    beforeEach(async () => {
        clearGrantsForTests(); seen.length = 0
        answer = { status: 202, body: { engineId: PEER, seq: 77 } }
        h = await newStore(); log = newLog(); setCommandLogHandle(log)
        setPeerAddressOverrideForTests(id => id === PEER ? [{ host: '127.0.0.1', port }] : id === 'ENGINE_unreachable' ? [{ host: '127.0.0.1', port: 1 }] : [])
    })

    it('capability check follows the idea#128 stamp', () => {
        const s = h.doc()!
        expect(hasSignedCommands(s, PEER)).toBe(true)
        expect(hasSignedCommands(s, OLD)).toBe(false)
        h.change(d => { (d.engineDB as any)[PEER].lastBooted = 6 })
        expect(hasSignedCommands(h.doc()!, PEER)).toBe(false)
    })

    it('old peer (no signedCommands1): ENGINE_VERSION_MISMATCH, nothing sent, traced with issuerEngineId', async () => {
        const r = await dispatchToPeer(h, OLD, 'startInstance i1 disk-old')
        expect(r).toMatchObject({ ok: false, code: 'ENGINE_VERSION_MISMATCH', issuerEngineId: OLD })
        expect(r.message).toMatch(/2\.3\.0/)
        expect(seen).toEqual([])
        const t = traces(log).find(x => x.command === 'startInstance')!
        expect(t).toMatchObject({ status: 'error', errorCode: 'ENGINE_VERSION_MISMATCH' })
        expect(commandLogText(t.result)).toContain(`"issuerEngineId":"${OLD}"`)
    })

    it('no grant from the peer: GRANT_EXPIRED with issuerEngineId, nothing sent', async () => {
        expect(await dispatchToPeer(h, PEER, 'startInstance i1 disk-peer')).toMatchObject({ ok: false, code: 'GRANT_EXPIRED', issuerEngineId: PEER })
        expect(seen).toEqual([])
    })

    it('with a grant: POST /api/command with Authorization: Grant and a reply grant; ok with the peer seq', async () => {
        const g = issueGrant(PEER, SELF).grant
        rememberGrant(g, SELF)
        const r = await dispatchToPeer(h, PEER, 'startInstance i1 disk-peer')
        expect(r).toEqual({ ok: true, seq: 77, issuerEngineId: PEER })
        expect(seen).toHaveLength(1)
        expect(seen[0].url).toBe('/api/command')
        expect(seen[0].auth).toBe(`Grant ${g}`)
        expect(seen[0].body).toMatchObject({ command: 'startInstance i1 disk-peer', fromEngineId: SELF })
        expect(parseGrant(seen[0].body.replyGrant)).toMatchObject({ issuer: SELF, to: PEER })
    })

    it('the peer refuses the grant: its code and issuerEngineId, and the grant is dropped', async () => {
        rememberGrant(issueGrant(PEER, SELF).grant, SELF)
        answer = { status: 403, body: { error: 'GRANT_EXPIRED', message: 'expired', issuerEngineId: PEER } }
        const before = traces(log).filter(x => x.command === 'startInstance' && x.errorCode === 'GRANT_EXPIRED').length
        expect(await dispatchToPeer(h, PEER, 'startInstance i1 disk-peer')).toMatchObject({ ok: false, code: 'GRANT_EXPIRED', issuerEngineId: PEER })
        expect(grantFrom(PEER)).toBeNull()
        // A stale grant is accepted when the operation starts (202 on this Engine); the peer
        // refuses it only at the follow-up, and that follow-up's trace says so.
        const after = traces(log).filter(x => x.command === 'startInstance' && x.errorCode === 'GRANT_EXPIRED')
        expect(after.length).toBe(before + 1)
        const t = after[after.length - 1]
        expect(t.status).toBe('error')
        expect(commandLogText(t.result)).toContain(`"issuerEngineId":"${PEER}"`)
        expect(commandLogText(t.result)).toContain(`"dispatchedTo":"${PEER}"`)
    })

    it('a peer that answers 404 on /api/auth/info is an older Engine: ENGINE_VERSION_MISMATCH', async () => {
        const old = http.createServer((_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Not found"}') }).listen(0, '127.0.0.1')
        await new Promise<void>(r => old.once('listening', () => r()))
        setPeerAddressOverrideForTests(() => [{ host: '127.0.0.1', port: (old.address() as AddressInfo).port }])
        try {
            await expect(verifiedTarget(h.doc(), OLD)).rejects.toMatchObject({ code: 'ENGINE_VERSION_MISMATCH', engineId: OLD, version: '2.3.0' })
        } finally { await new Promise<void>(r => old.close(() => r())) }
    })

    it('unreachable peer: ENGINE_UNREACHABLE with engineId', async () => {
        await expect(verifiedTarget(h.doc(), 'ENGINE_unreachable')).rejects.toBeInstanceOf(PeerError)
        await expect(verifiedTarget(h.doc(), 'ENGINE_unreachable')).rejects.toMatchObject({ code: 'ENGINE_UNREACHABLE', engineId: 'ENGINE_unreachable' })
    })

    // engine#582: the read-only grant check before a copy or move does anything for the peer
    it('preflight: POST /api/command grantCheck with Authorization: Grant and no reply grant; 200 ok → accepted', async () => {
        const g = issueGrant(PEER, SELF).grant
        rememberGrant(g, SELF)
        answer = { status: 200, body: { engineId: PEER, issuerEngineId: PEER, ok: true } }
        expect(await preflightPeerGrant(h, PEER)).toEqual({ ok: true, issuerEngineId: PEER })
        expect(seen).toHaveLength(1)
        expect(seen[0]).toMatchObject({ url: '/api/command', auth: `Grant ${g}`, body: { command: GRANT_CHECK_COMMAND, fromEngineId: SELF } })
        expect(seen[0].body.replyGrant).toBeUndefined()
        expect(grantFrom(PEER)).toBe(g)
        expect(traces(log).filter(t => t.command === GRANT_CHECK_COMMAND)).toEqual([])   // no trace on success
    })

    it('preflight: an earlier engine#582 peer (no grantCheck) answers 422 not-a-follow-up after a good grant check → accepted', async () => {
        rememberGrant(issueGrant(PEER, SELF).grant, SELF)
        answer = { status: 422, body: { error: 'COMMAND_REFUSED', reason: 'not-a-follow-up', issuerEngineId: PEER } }
        expect(await preflightPeerGrant(h, PEER)).toEqual({ ok: true, issuerEngineId: PEER })
        answer = { status: 422, body: { error: 'COMMAND_REFUSED', reason: 'unknown', issuerEngineId: PEER } }
        expect(await preflightPeerGrant(h, PEER)).toMatchObject({ ok: false, code: 'COMMAND_REFUSED' })
    })

    it('preflight: the peer refuses the grant (it restarted) → GRANT_EXPIRED with issuerEngineId, grant dropped, traced; grantRefusal carries both', async () => {
        rememberGrant(issueGrant(PEER, SELF).grant, SELF)
        answer = { status: 403, body: { error: 'GRANT_EXPIRED', message: 'This permission expired (or this Engine restarted). Start again.', issuerEngineId: PEER } }
        const r = await preflightPeerGrant(h, PEER)
        expect(r).toMatchObject({ ok: false, code: 'GRANT_EXPIRED', issuerEngineId: PEER })
        expect(grantFrom(PEER)).toBeNull()
        const t = traces(log).filter(x => x.command === GRANT_CHECK_COMMAND).at(-1)!
        expect(t).toMatchObject({ status: 'error', errorCode: 'GRANT_EXPIRED' })
        expect(commandLogText(t.result)).toContain(`"issuerEngineId":"${PEER}"`)
        const e = grantRefusal(r, 'start')!
        expect(e).toBeInstanceOf(PeerGrantRefusal)
        expect(e).toMatchObject({ code: 'GRANT_EXPIRED', issuerEngineId: PEER, traceResult: { code: 'GRANT_EXPIRED', issuerEngineId: PEER, dispatchedTo: PEER, step: 'start' } })
        expect(grantRefusal({ ok: true, issuerEngineId: PEER }, 'start')).toBeNull()
    })

    it('preflight: GRANT_INVALID also drops the grant', async () => {
        rememberGrant(issueGrant(PEER, SELF).grant, SELF)
        answer = { status: 403, body: { error: 'GRANT_INVALID', message: 'not valid', issuerEngineId: PEER } }
        expect(await preflightPeerGrant(h, PEER)).toMatchObject({ ok: false, code: 'GRANT_INVALID', issuerEngineId: PEER })
        expect(grantFrom(PEER)).toBeNull()
    })

    it('preflight: no grant kept (6 h passed, or this Engine restarted) → GRANT_EXPIRED, nothing sent', async () => {
        expect(await preflightPeerGrant(h, PEER)).toMatchObject({ ok: false, code: 'GRANT_EXPIRED', issuerEngineId: PEER })
        expect(seen).toEqual([])
    })

    it('preflight: an older peer (no signedCommands1) → ENGINE_VERSION_MISMATCH, nothing sent; unreachable → ENGINE_UNREACHABLE', async () => {
        expect(await preflightPeerGrant(h, OLD)).toMatchObject({ ok: false, code: 'ENGINE_VERSION_MISMATCH', issuerEngineId: OLD })
        expect(seen).toEqual([])
        h.change(d => { (d.engineDB as any)['ENGINE_unreachable'] = { id: 'ENGINE_unreachable', commands: [], lastBooted: 5, capabilitiesBootedAt: 5, capabilities: ['signedCommands1'] } })
        rememberGrant(issueGrant('ENGINE_unreachable', SELF).grant, SELF)
        expect(await preflightPeerGrant(h, 'ENGINE_unreachable')).toMatchObject({ ok: false, code: 'ENGINE_UNREACHABLE', issuerEngineId: 'ENGINE_unreachable' })
    })

    it('preflight to this Engine itself: accepted without a request', async () => {
        expect(await preflightPeerGrant(h, SELF)).toEqual({ ok: true, issuerEngineId: SELF })
        expect(seen).toEqual([])
    })

    it('to this Engine itself: a signed entry on the own queue', async () => {
        const r = await dispatchToPeer(h, SELF, 'startInstance i1 d1')
        expect(r.ok).toBe(true)
        const q = queue(h)
        expect(q).toHaveLength(1)
        expect(verifyEntry(q[0], SELF)).toMatchObject({ ok: true, src: 'engine', command: 'startInstance i1 d1', seq: r.seq })
    })
})

describe('POST /api/command and POST /api/auth/grant', () => {
    let h: DocHandle<Store>, server: http.Server, base = ''
    let token = ''
    const post = (p: string, body: unknown, auth?: string) => fetch(`${base}${p}`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    })
    beforeAll(async () => {
        h = await newStore()
        server = enableHttpMonitor(0, '', null, undefined, { engineId: SELF, auth: { engineId: SELF, storeHandle: h, capabilities: () => ['engineSignIn1', 'signedCommands1'] } })
        await new Promise<void>(r => (server.listening ? r() : server.once('listening', () => r())))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterAll(async () => { await new Promise<void>(r => server.close(() => r())) })
    beforeEach(() => {
        clearSessionsForTests(); clearGrantsForTests(); clearConfirmsForTests()
        token = createSession({ id: 'op1', username: 'admin' }).token
        h.change(d => { (d.engineDB[localEngineId].commands as any[]).splice(0) })
    })

    it('no token → 401 AUTH_REQUIRED; nothing queued', async () => {
        const r = await post('/api/command', { command: 'reboot' })
        expect(r.status).toBe(401)
        expect((await r.json()).error).toBe('AUTH_REQUIRED')
        expect(queue(h)).toEqual([])
    })

    it('an oversized body → 413 PAYLOAD_TOO_LARGE, with or without a token; nothing queued', async () => {
        for (const auth of [undefined, `Bearer ${token}`, 'Grant junk']) {
            const r = await post('/api/command', { command: 'ejectDisk d1', pad: 'x'.repeat(20_000) }, auth)
            expect(r.status, String(auth)).toBe(413)
            expect((await r.json()).error).toBe('PAYLOAD_TOO_LARGE')
        }
        expect(queue(h)).toEqual([])
    })

    it('store not ready → 503 STORE_NOT_READY', async () => {
        const empty = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await empty.whenReady()
        const s2 = enableHttpMonitor(0, '', null, undefined, { engineId: SELF, auth: { engineId: SELF, storeHandle: empty, capabilities: () => ['engineSignIn1', 'signedCommands1'] } })
        await new Promise<void>(r => (s2.listening ? r() : s2.once('listening', () => r())))
        try {
            const r = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/command`, {
                method: 'POST', body: JSON.stringify({ command: 'ejectDisk d1' }), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            })
            expect(r.status).toBe(503)
            expect(await r.json()).toMatchObject({ error: 'STORE_NOT_READY' })
        } finally { await new Promise<void>(r => s2.close(() => r())) }
    })

    it('operator → 202 {engineId, seq}; the entry is signed with src op-<session8>', async () => {
        const r = await post('/api/command', { command: 'ejectDisk d1' }, `Bearer ${token}`)
        expect(r.status).toBe(202)
        const body = await r.json()
        expect(body).toEqual({ engineId: SELF, seq: expect.any(Number) })
        const q = queue(h)
        expect(verifyEntry(q[0], SELF)).toMatchObject({ ok: true, seq: body.seq, command: 'ejectDisk d1', src: expect.stringMatching(/^op-[0-9a-f]{8}$/) })
    })

    it('validation: unknown, local-only, multi-line → refused before anything is queued', async () => {
        const u = await post('/api/command', { command: 'bogus x' }, `Bearer ${token}`)
        expect(u.status).toBe(422)
        expect(await u.json()).toMatchObject({ error: 'COMMAND_REFUSED', reason: 'unknown' })
        const l = await post('/api/command', { command: 'createInstance x y' }, `Bearer ${token}`)
        expect(l.status).toBe(422)
        expect(await l.json()).toMatchObject({ error: 'COMMAND_REFUSED', reason: 'local-only' })
        expect((await post('/api/command', { command: 'reboot\nreboot' }, `Bearer ${token}`)).status).toBe(400)
        expect(queue(h)).toEqual([])
    })

    it('copyApp to a disk on another Engine: GRANT_REQUIRED with engineIds; with the grant → 202 and the grant is kept', async () => {
        const r = await post('/api/command', { command: 'copyApp i1 d1 peer-disk' }, `Bearer ${token}`)
        expect(r.status).toBe(409)
        expect(await r.json()).toMatchObject({ error: 'GRANT_REQUIRED', engineIds: [PEER] })
        const g = issueGrant(PEER, SELF).grant
        const bad = await post('/api/command', { command: 'copyApp i1 d1 peer-disk', grants: { [PEER]: issueGrant(PEER, 'ENGINE_x').grant } }, `Bearer ${token}`)
        expect(bad.status).toBe(403)
        expect(await bad.json()).toMatchObject({ error: 'GRANT_INVALID', issuerEngineId: PEER })
        const ok = await post('/api/command', { command: 'copyApp i1 d1 peer-disk', grants: { [PEER]: g } }, `Bearer ${token}`)
        expect(ok.status).toBe(202)
        expect(grantFrom(PEER)).toBe(g)
    })

    it('updateApp --source on an older Engine: ENGINE_VERSION_MISMATCH with engineId and version', async () => {
        const r = await post('/api/command', { command: 'updateApp i1 --source old-disk' }, `Bearer ${token}`)
        expect(r.status).toBe(409)
        expect(await r.json()).toMatchObject({ error: 'ENGINE_VERSION_MISMATCH', engineId: OLD, version: '2.3.0' })
    })

    it('eraseDisk: 428 CONFIRM_REQUIRED with the summary; wrong text → 409 CONFIRM_INVALID; right text → 202', async () => {
        const c = await post('/api/command', { command: 'eraseDisk d1 t1' }, `Bearer ${token}`)
        expect(c.status).toBe(428)
        const ch = await c.json()
        expect(ch).toMatchObject({ error: 'CONFIRM_REQUIRED', confirmField: 'label', summary: { label: 'Backup 3', contents: [] }, expiresInMs: CONFIRM_TTL_MS })
        const wrong = await post('/api/command', { command: 'eraseDisk d1 t1', confirmId: ch.confirmId, confirmText: 'nope' }, `Bearer ${token}`)
        expect(wrong.status).toBe(409)
        expect(await wrong.json()).toMatchObject({ error: 'CONFIRM_INVALID', reason: 'text' })
        const ch2 = await (await post('/api/command', { command: 'eraseDisk d1 t1' }, `Bearer ${token}`)).json()
        const ok = await post('/api/command', { command: 'eraseDisk d1 t1', confirmId: ch2.confirmId, confirmText: 'Backup 3' }, `Bearer ${token}`)
        expect(ok.status).toBe(202)
        expect(queue(h)).toHaveLength(1)
    })

    it('peer with a grant: follow-up → 202 (src peer-<id>); other commands and bad grants refused, all with issuerEngineId', async () => {
        const g = issueGrant(SELF, PEER).grant
        const ok = await post('/api/command', { command: 'startInstance i1 d1', fromEngineId: PEER, replyGrant: issueGrant(PEER, SELF).grant }, `Grant ${g}`)
        expect(ok.status).toBe(202)
        const { seq } = await ok.json()
        expect(verifyEntry(queue(h)[0], SELF)).toMatchObject({ ok: true, seq, src: `peer-${PEER}` })
        expect(grantFrom(PEER)).not.toBeNull()   // reply grant kept
        const notFollowUp = await post('/api/command', { command: 'eraseDisk d1 t1', fromEngineId: PEER }, `Grant ${g}`)
        expect(notFollowUp.status).toBe(422)
        expect(await notFollowUp.json()).toMatchObject({ error: 'COMMAND_REFUSED', reason: 'not-a-follow-up', issuerEngineId: SELF })
        const otherFrom = await post('/api/command', { command: 'startInstance i1 d1', fromEngineId: 'ENGINE_x' }, `Grant ${g}`)
        expect(otherFrom.status).toBe(403)
        expect(await otherFrom.json()).toMatchObject({ error: 'GRANT_INVALID', issuerEngineId: SELF })
        clearGrantsForTests()
        const expired = await post('/api/command', { command: 'startInstance i1 d1', fromEngineId: PEER }, `Grant ${g}`)
        expect(expired.status).toBe(403)
        expect(await expired.json()).toMatchObject({ error: 'GRANT_EXPIRED', issuerEngineId: SELF })
        const badBody = await post('/api/command', { fromEngineId: PEER }, `Grant ${g}`)
        expect(badBody.status).toBe(400)
        expect(await badBody.json()).toMatchObject({ error: 'BAD_REQUEST', issuerEngineId: SELF })
    })

    it('grantCheck from a peer: 200 with a good grant, nothing queued; stale or wrong grants refused with issuerEngineId; never from an operator', async () => {
        const g = issueGrant(SELF, PEER).grant
        const ok = await post('/api/command', { command: GRANT_CHECK_COMMAND, fromEngineId: PEER }, `Grant ${g}`)
        expect(ok.status).toBe(200)
        expect(await ok.json()).toEqual({ engineId: SELF, issuerEngineId: SELF, ok: true })
        expect(queue(h)).toEqual([])
        expect(isPeerFollowUp(GRANT_CHECK_COMMAND)).toBe(false)
        const otherFrom = await post('/api/command', { command: GRANT_CHECK_COMMAND, fromEngineId: 'ENGINE_x' }, `Grant ${g}`)
        expect(otherFrom.status).toBe(403)
        expect(await otherFrom.json()).toMatchObject({ error: 'GRANT_INVALID', issuerEngineId: SELF })
        clearGrantsForTests()   // = this Engine restarted
        const stale = await post('/api/command', { command: GRANT_CHECK_COMMAND, fromEngineId: PEER }, `Grant ${g}`)
        expect(stale.status).toBe(403)
        expect(await stale.json()).toMatchObject({ error: 'GRANT_EXPIRED', issuerEngineId: SELF })
        const op = await post('/api/command', { command: GRANT_CHECK_COMMAND }, `Bearer ${token}`)
        expect(op.status).toBe(422)
        expect(await op.json()).toMatchObject({ error: 'COMMAND_REFUSED', reason: 'unknown' })
        expect(queue(h)).toEqual([])
    })

    it('POST /api/auth/grant: a grant for a known Engine; every error carries issuerEngineId', async () => {
        const r = await post('/api/auth/grant', { toEngineId: PEER }, `Bearer ${token}`)
        expect(r.status).toBe(200)
        const b = await r.json()
        expect(b).toMatchObject({ issuerEngineId: SELF, expiresInMs: GRANT_TTL_MS })
        expect(checkGrant(b.grant, SELF, PEER)).toMatchObject({ issuer: SELF, to: PEER })
        const noTok = await post('/api/auth/grant', { toEngineId: PEER })
        expect(noTok.status).toBe(401)
        expect(await noTok.json()).toMatchObject({ error: 'AUTH_REQUIRED', issuerEngineId: SELF })
        const unknown = await post('/api/auth/grant', { toEngineId: 'ENGINE_nobody' }, `Bearer ${token}`)
        expect(unknown.status).toBe(404)
        expect(await unknown.json()).toMatchObject({ error: 'ENGINE_UNKNOWN', issuerEngineId: SELF })
        const self = await post('/api/auth/grant', { toEngineId: SELF }, `Bearer ${token}`)
        expect(self.status).toBe(400)
        expect(await self.json()).toMatchObject({ error: 'BAD_REQUEST', issuerEngineId: SELF })
        const big = await post('/api/auth/grant', { toEngineId: PEER, pad: 'x'.repeat(20_000) })
        expect(big.status).toBe(413)
        expect(await big.json()).toMatchObject({ error: 'PAYLOAD_TOO_LARGE', issuerEngineId: SELF })
    })
})
