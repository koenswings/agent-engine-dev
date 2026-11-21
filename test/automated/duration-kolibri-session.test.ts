/**
 * Markov random-mixed-fd72ee8-7cbaf60 FAIL@403: open_kolibri_as_teacher found the shared context still signed in as
 * learner01 (Pixel attemptAppLogin returns 'already_in' for any user), so /en/coach/#/classes said "You must be signed
 * in as an admin or coach". Fake pages / contexts model the Playwright calls.
 */
import { describe, expect, it } from 'vitest'
import {
    assertKolibriSession,
    expectedKolibriUser,
    isKolibriUrl,
    kolibriOriginOf,
    kolibriRoleFor,
    kolibriSessionHint,
    readKolibriSession,
    resetKolibriSession,
    type SessionContext,
    type SessionPage,
    type SessionRequest,
} from '../duration/ui/kolibriSession.js'

class FakePage implements SessionPage {
    closed = false
    constructor(public u: string) {}
    url() { return this.u }
    isClosed() { return this.closed }
    async close() { this.closed = true }
}

const session = (body: unknown, status = 200): SessionRequest => ({
    get: async (url: string) => {
        session.urls.push(url)
        return { ok: () => status >= 200 && status < 300, status: () => status, json: async () => body }
    },
})
session.urls = [] as string[]

class FakeContext implements SessionContext {
    cleared: (string | RegExp | undefined)[] = []
    cookies = ['kolibri', 'kolibri_csrftoken', 'nc_session_id', 'oc_sessionPassphrase']
    constructor(public request?: SessionRequest) {}
    async clearCookies(o?: { name?: string | RegExp }) {
        this.cleared.push(o?.name)
        const n = o?.name
        this.cookies = this.cookies.filter(c => !(n instanceof RegExp ? n.test(c) : n === undefined || n === c))
    }
}

const CONSOLE = 'http://idea01:8080/#/'
const KOLIBRI_LEARN = 'http://idea01:18080/en/learn/#/topics'
const KOLIBRI_COACH = 'http://idea01:18080/en/coach/#/classes'
const NC = 'http://idea03.local:61820/apps/files/'

describe('Kolibri role Intents and URLs', () => {
    it('maps only the role-entry Intents', () => {
        expect(kolibriRoleFor('open_kolibri_as_teacher')).toBe('teacher')
        expect(kolibriRoleFor('open_kolibri_as_learner')).toBe('learner')
        expect(kolibriRoleFor('open_video')).toBeNull()
        expect(kolibriRoleFor('open_nextcloud_as_teacher')).toBeNull()
    })
    it('uses the Kid fixture users, overridable by env', () => {
        expect(expectedKolibriUser('teacher', {})).toBe('teacher')
        expect(expectedKolibriUser('learner', {})).toBe('learner01')
        expect(expectedKolibriUser('teacher', { DURATION_KOLIBRI_TEACHER_USER: 'coach7' })).toBe('coach7')
    })
    it('recognises Kolibri tabs but not the Console or Nextcloud', () => {
        expect(isKolibriUrl(KOLIBRI_LEARN, {})).toBe(true)
        expect(isKolibriUrl('http://idea03:18081/en/coach/#/classes', {})).toBe(true)
        expect(isKolibriUrl('http://idea03:9999/en/learn/#/home', {})).toBe(true)
        expect(isKolibriUrl('http://idea03:9999/', { DURATION_KOLIBRI_PORT: '9999' })).toBe(true)
        expect(isKolibriUrl(CONSOLE, {})).toBe(false)
        expect(isKolibriUrl(NC, {})).toBe(false)
        expect(isKolibriUrl('about:blank', {})).toBe(false)
    })
})

describe('fresh Kolibri session before a role-entry Intent', () => {
    it('closes Kolibri tabs and clears only the Kolibri cookies (the FAIL@403 learner01 cookie)', async () => {
        const consolePage = new FakePage(CONSOLE)
        const kol = new FakePage(KOLIBRI_LEARN)
        const nc = new FakePage(NC)
        const ctx = new FakeContext()
        const note = await resetKolibriSession('open_kolibri_as_teacher', ctx, consolePage, [consolePage, kol, nc])
        expect(note).toMatch(/fresh Kolibri session \(cookies cleared, closed http:\/\/idea01:18080\/en\/learn/)
        expect(kol.closed).toBe(true)
        expect(consolePage.closed).toBe(false)
        expect(nc.closed).toBe(false)
        expect(ctx.cookies).toEqual(['nc_session_id', 'oc_sessionPassphrase'])
    })
    it('does nothing for other Intents', async () => {
        const consolePage = new FakePage(CONSOLE)
        const kol = new FakePage(KOLIBRI_LEARN)
        const ctx = new FakeContext()
        expect(await resetKolibriSession('open_video', ctx, consolePage, [consolePage, kol])).toBe('')
        expect(kol.closed).toBe(false)
        expect(ctx.cleared).toEqual([])
    })
    it('fails loud when the cookies cannot be cleared', async () => {
        const ctx: SessionContext = { clearCookies: async () => { throw new Error('boom') } }
        await expect(resetKolibriSession('open_kolibri_as_learner', ctx, null, []))
            .rejects.toThrow(/could not clear the Kolibri session cookies before the role switch: boom/)
    })
})

describe('signed-in user check after a role-entry Intent', () => {
    it('reads the session API on the Kolibri tab origin', async () => {
        session.urls = []
        const r = await readKolibriSession(session({ username: 'teacher', kind: ['coach'] }), 'http://idea01:18080')
        expect(r).toEqual({ state: 'read', username: 'teacher', kind: ['coach'] })
        expect(session.urls).toEqual(['http://idea01:18080/api/auth/session/current/'])
    })
    it('passes when the teacher is signed in', async () => {
        const kol = new FakePage(KOLIBRI_COACH)
        await expect(assertKolibriSession('open_kolibri_as_teacher', session({ username: 'teacher', kind: ['coach'] }), kol, [kol], {}))
            .resolves.toBe('Kolibri session teacher verified')
    })
    it('fails "wrong Kolibri session" when learner01 is still signed in (the FAIL@403 third state)', async () => {
        const kol = new FakePage(KOLIBRI_COACH)
        await expect(assertKolibriSession('open_kolibri_as_teacher', session({ username: 'learner01', kind: ['learner'] }), kol, [kol], {}))
            .rejects.toThrow(/wrong Kolibri session at http:\/\/idea01:18080: expected teacher 'teacher', signed in as learner01 \(kind=learner\)/)
    })
    it('fails when anonymous (the login silently did not take)', async () => {
        const kol = new FakePage(KOLIBRI_COACH)
        await expect(assertKolibriSession('open_kolibri_as_learner', session({ username: '', kind: ['anonymous'] }), kol, [kol], {}))
            .rejects.toThrow(/expected learner 'learner01', signed in as \(anonymous\) \(kind=anonymous\)/)
    })
    it('notes (does not pass silently) when the session cannot be read', async () => {
        const kol = new FakePage(KOLIBRI_COACH)
        expect(await assertKolibriSession('open_kolibri_as_teacher', session({}, 404), kol, [kol], {}))
            .toBe('Kolibri session unverified at http://idea01:18080: HTTP 404')
        expect(await assertKolibriSession('open_kolibri_as_teacher', session({}), null, [new FakePage(CONSOLE)], {}))
            .toMatch(/no open Kolibri tab/)
    })
    it('prefers the active Kolibri tab, else the newest open one', () => {
        const a = new FakePage('http://idea01:18080/en/learn/#/')
        const b = new FakePage('http://idea03:18081/en/coach/#/')
        expect(kolibriOriginOf(a, [a, b])).toBe('http://idea01:18080')
        expect(kolibriOriginOf(new FakePage(CONSOLE), [a, b])).toBe('http://idea03:18081')
        b.closed = true
        expect(kolibriOriginOf(null, [a, b])).toBe('http://idea01:18080')
    })
    it('names the wrong session on an Intent failure', async () => {
        const kol = new FakePage(KOLIBRI_COACH)
        expect(await kolibriSessionHint('open_kolibri_as_teacher', session({ username: 'learner01', kind: ['learner'] }), kol, [kol], {}))
            .toBe(" [wrong Kolibri session: expected teacher 'teacher', signed in as learner01 (kind=learner)]")
        expect(await kolibriSessionHint('open_kolibri_as_teacher', session({ username: 'teacher', kind: ['coach'] }), kol, [kol], {}))
            .toBe(' [Kolibri session: teacher (kind=coach)]')
        expect(await kolibriSessionHint('open_video', session({}), kol, [kol], {})).toBe('')
    })
})
