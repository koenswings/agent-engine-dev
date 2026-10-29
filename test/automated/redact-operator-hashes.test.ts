/**
 * idea#113 (b): operator password hashes never reach a dump or log path.
 * One test per output path; each asserts no bcrypt prefix and "<redacted>" present.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { redactSecrets, redactString, redactedJson, REDACTED } from '../../src/utils/redact.js'
import { deepPrint, log, error, print, setVerbosity } from '../../src/utils/utils.js'
vi.mock('../../src/data/CommandLogStore.js', async (orig) => ({ ...(await orig() as object), flushLogs: vi.fn() }))
import { initCommandLogger, runWithTrace, appendToTrace, flushTrace } from '../../src/utils/CommandLogger.js'

const HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'
const HASH_A = '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'
const HASH_Y = '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'
const BCRYPT = /\$2[aby]\$/

const fakeStore = () => ({
    engineDB: { e1: { id: 'e1', hostname: 'idea04' } },
    userDB: {
        u1: { id: 'u1', username: 'koen', passwordHash: HASH, role: 'operator', created: 1 },
        u2: { id: 'u2', username: 'ops', passwordHash: HASH_A, role: 'operator', created: 2 },
    },
})

const captured = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map(c => c.map(String).join(' ')).join('\n')

afterEach(() => vi.restoreAllMocks())

describe('redact helper', () => {
    it('replaces passwordHash, keeps every other field, does not mutate the store', () => {
        const doc = fakeStore()
        const r = redactSecrets(doc)
        expect(r.userDB.u1).toEqual({ id: 'u1', username: 'koen', passwordHash: REDACTED, role: 'operator', created: 1 })
        expect(r.engineDB).toEqual(doc.engineDB)
        expect(doc.userDB.u1.passwordHash).toBe(HASH) // storage untouched
        expect(JSON.stringify(r)).not.toMatch(BCRYPT)
    })
    it('redacts $2a$/$2b$/$2y$ hashes embedded in strings', () => {
        const s = redactString(`a ${HASH} b ${HASH_A} c ${HASH_Y}`)
        expect(s).not.toMatch(BCRYPT)
        expect(s.split(REDACTED).length - 1).toBe(3)
    })
    it('handles cycles and errors carrying operator objects', () => {
        const o: any = { user: fakeStore().userDB.u1 }; o.self = o
        const r = redactSecrets(o)
        expect(r.self).toBe(r)
        const e: any = new Error(`bad user ${HASH}`); e.user = fakeStore().userDB.u1
        const re: any = redactSecrets(e)
        expect(re.message).toContain(REDACTED); expect(re.user.passwordHash).toBe(REDACTED)
        expect(String(re.stack)).not.toMatch(BCRYPT)
    })
    it('redactedJson (JSON dumps)', () => {
        const j = redactedJson(fakeStore(), 2)
        expect(j).not.toMatch(BCRYPT); expect(j).toContain(REDACTED); expect(j).toContain('koen')
    })
})

describe('output paths', () => {
    it('ls / startup store dump (deepPrint)', () => {
        const out = deepPrint(fakeStore(), 3)
        expect(out).not.toMatch(BCRYPT); expect(out).toContain(REDACTED); expect(out).toContain('koen')
    })
    it('print(deepPrint(storeHandle.doc())) as used by the ls command', () => {
        const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
        print('NetworkData on this engine:'); print(deepPrint(fakeStore()), 3)
        const out = captured(spy)
        expect(out).not.toMatch(BCRYPT); expect(out).toContain(REDACTED)
    })
    it('print() of a raw operator object (debug dump)', () => {
        const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
        print(fakeStore().userDB.u1)
        const arg: any = spy.mock.calls[0][0]
        expect(arg.passwordHash).toBe(REDACTED)
        expect(JSON.stringify(spy.mock.calls)).not.toMatch(BCRYPT)
    })
    it('log() line carrying a hash', () => {
        setVerbosity(2)
        const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
        log(`Doc contains: ${JSON.stringify(fakeStore())}`)
        const out = captured(spy)
        expect(out).not.toMatch(BCRYPT); expect(out).toContain(REDACTED)
    })
    it('error() log carrying an operator object', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        error(`login failed for ${JSON.stringify(fakeStore().userDB.u2)}`)
        const out = captured(spy)
        expect(out).not.toMatch(BCRYPT); expect(out).toContain(REDACTED)
    })
    it('command trace capture (console args → CommandLog trace) and pm2 stdout', async () => {
        const flushed: any[] = []
        const stdout: string[] = []
        vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => { stdout.push(JSON.stringify(a)) })
        initCommandLogger({} as any)  // patches console over the spy; flushLogs is mocked
        const { flushLogs } = await import('../../src/data/CommandLogStore.js')
        ;(flushLogs as any).mockImplementation((_h: unknown, _t: string, batch: unknown[]) => flushed.push(...batch))
        await runWithTrace({ traceId: 't113', command: 'ls', args: '{}' }, async () => {
            console.info('dump', fakeStore(), `str ${HASH_Y}`)
        })
        await flushTrace('t113')
        const trace = JSON.stringify(flushed)
        expect(flushed.length).toBe(1)
        expect(trace).not.toMatch(BCRYPT); expect(trace).toContain(REDACTED); expect(trace).toContain('koen')
        const out = stdout.join('\n')
        expect(out).not.toMatch(BCRYPT); expect(out).toContain(REDACTED)
    })
    it('appendToTrace error entry (error logs into the command log)', async () => {
        const flushed: any[] = []
        const { flushLogs } = await import('../../src/data/CommandLogStore.js')
        ;(flushLogs as any).mockImplementation((_h: unknown, _t: string, batch: unknown[]) => flushed.push(...batch))
        appendToTrace('t113b', { level: 'error', message: `failed ${HASH}`, timestamp: 1 } as any)
        await flushTrace('t113b')
        expect(JSON.stringify(flushed)).not.toMatch(BCRYPT)
        expect(JSON.stringify(flushed)).toContain(REDACTED)
    })
})
