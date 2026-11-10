/**
 * idea#411: schema accept/reject for day, sample and presence payloads.
 */
import { describe, it, expect } from 'vitest'
import { validateDayHook, validatePresence, validateSampleHook, hasForbiddenKeys } from '../../src/usage/schema.js'

const kolibri = (over: Record<string, unknown> = {}) => ({
    schema: 'idea-usage-day/1',
    day: '2026-11-12',
    app: 'kolibri',
    setup: {
        classes: 1, classesDelta: 0,
        learner: { total: 2, beyondSeed: 2 }, learnerDelta: -1, learnerEnrolled: 2,
        teacher: { total: 1, beyondSeed: 1 }, teachersDelta: 0,
        admin: { total: 1, beyondSeed: 1 },
    },
    signins: {
        learner: { total: 1, beyondSeed: 1, sessions: 2, minutes: 3 },
        coach: { total: 0, beyondSeed: 0, sessions: 0, minutes: 0 },
        admin: { total: 1, beyondSeed: 1, sessions: 1, minutes: 4 },
    },
    content: [{ channel: 'Maths', title: 'Intro', kind: 'video', role: 'learner', visits: 1, seconds: 10, completions: 0, assigned: true }],
    teaching: { lessonsCreated: 0, lessonsVisible: 0, quizzesCreated: 0, quizzesStarted: 0, quizzesEnded: 0 },
    guest: { visits: 0, seconds: 0 },
    ...over,
})

const nextcloud = (over: Record<string, unknown> = {}) => ({
    schema: 'idea-usage-day/1',
    day: '2026-11-12',
    app: 'nextcloud',
    setup: {
        admin: { total: 1, beyondSeed: 1 },
        teacher: { total: 2, beyondSeed: 2 },
        learner: { total: 10, beyondSeed: 8 },
        otherGroups: { 'Grade 5': { total: 4, beyondSeed: 4 } },
    },
    logins: {
        admin: { total: 1, beyondSeed: 1 },
        teacher: { total: 2, beyondSeed: 2 },
        learner: { total: 5, beyondSeed: 5 },
    },
    office: { opens: 1, distinctDocuments: 2, read: 1, edit: 1, estimatedMinutes: 15, byGroup: { admin: { total: 0, beyondSeed: 0 }, teacher: { total: 1, beyondSeed: 1 }, learner: { total: 0, beyondSeed: 0 } }, mime: { text: 1 } },
    ...over,
})

const kiwix = (over: Record<string, unknown> = {}) => ({
    schema: 'idea-usage-day/1',
    day: '2026-11-12',
    app: 'kiwix',
    pageViews: 3,
    distinctArticles: 2,
    sessions: 1,
    topArticles: [{ title: 'Earth', views: 2 }],
    byHour: Array.from({ length: 24 }, () => 0),
    ...over,
})

describe('validateDayHook', () => {
    it('accepts valid Kolibri, Nextcloud and Kiwix payloads', () => {
        expect(validateDayHook(kolibri(), '2026-11-12').ok).toBe(true)
        expect(validateDayHook(nextcloud(), '2026-11-12').ok).toBe(true)
        expect(validateDayHook(kiwix(), '2026-11-12').ok).toBe(true)
    })
    it('accepts an unknown app with only the envelope', () => {
        expect(validateDayHook({ schema: 'idea-usage-day/1', day: '2026-11-12', app: 'otherapp' }, '2026-11-12').ok).toBe(true)
    })
    it('rejects an unknown schema id', () => {
        const r = validateDayHook(kolibri({ schema: 'idea-usage-day/2' }), '2026-11-12')
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toMatch(/unknown schema/)
    })
    it('rejects a day that does not match the request', () => {
        const r = validateDayHook(kolibri(), '2026-11-13')
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toMatch(/does not match/)
    })
    it('rejects an invalid calendar date', () => {
        expect(validateDayHook(kolibri({ day: '2026-02-30' }), '2026-02-30').ok).toBe(false)
    })
    it('rejects a missing required Kolibri key', () => {
        const body = kolibri()
        delete (body as any).teaching
        expect(validateDayHook(body, '2026-11-12').ok).toBe(false)
    })
    it('accepts a negative Kolibri delta', () => {
        expect(validateDayHook(kolibri({ setup: { ...kolibri().setup, learnerDelta: -3, teachersDelta: 0 } }), '2026-11-12').ok).toBe(true)
    })
    it('rejects a Kiwix byHour that is not 24 long', () => {
        expect(validateDayHook(kiwix({ byHour: [1, 2, 3] }), '2026-11-12').ok).toBe(false)
    })
    it('rejects more than 50 topArticles', () => {
        const top = Array.from({ length: 51 }, (_, i) => ({ title: `a${i}`, views: 1 }))
        expect(validateDayHook(kiwix({ topArticles: top }), '2026-11-12').ok).toBe(false)
    })
    it('rejects a forbidden username key', () => {
        expect(validateDayHook(kolibri({ username: 'alice' }), '2026-11-12').ok).toBe(false)
        expect(hasForbiddenKeys({ nested: { email: 'a@b.c' } })).toBe('nested.email')
    })
    it('allows Nextcloud without office or appsOpened', () => {
        const body = nextcloud()
        delete (body as any).office
        expect(validateDayHook(body, '2026-11-12').ok).toBe(true)
    })
    it('rejects plural role keys and bare-number role counts', () => {
        expect(validateDayHook(nextcloud({ setup: { admin: 1, teacher: 2, learner: 3 } }), '2026-11-12').ok).toBe(false)
        const body = nextcloud()
        delete (body.setup as any).teacher
        ;(body.setup as any).teachers = { total: 2, beyondSeed: 2 }
        expect(validateDayHook(body, '2026-11-12').ok).toBe(false)
    })
    it('rejects a role count whose beyondSeed exceeds total', () => {
        expect(validateDayHook(nextcloud({
            setup: {
                admin: { total: 1, beyondSeed: 1 },
                teacher: { total: 1, beyondSeed: 2 },
                learner: { total: 1, beyondSeed: 1 },
            },
        }), '2026-11-12').ok).toBe(false)
    })
})

describe('validateSampleHook', () => {
    it('accepts a Nextcloud office snapshot', () => {
        const r = validateSampleHook({
            schema: 'idea-usage-sample/1',
            app: 'nextcloud',
            office: { tokens: 2, documentIds: ['aaaaaaaaaaaaaaaa'], read: 1, edit: 1, byGroup: { admin: { total: 0, beyondSeed: 0 }, teacher: { total: 2, beyondSeed: 2 }, learner: { total: 0, beyondSeed: 0 } }, mime: { text: 2 } },
        })
        expect(r.ok).toBe(true)
    })
    it('accepts supported: false without office', () => {
        expect(validateSampleHook({ schema: 'idea-usage-sample/1', app: 'kolibri', supported: false }).ok).toBe(true)
    })
    it('rejects an unknown sample schema', () => {
        expect(validateSampleHook({ schema: 'idea-usage-sample/2', app: 'nextcloud' }).ok).toBe(false)
    })
    it('rejects a sample office without documentIds', () => {
        expect(validateSampleHook({
            schema: 'idea-usage-sample/1',
            app: 'nextcloud',
            office: { tokens: 1, read: 1, edit: 0 },
        }).ok).toBe(false)
        expect(validateSampleHook({
            schema: 'idea-usage-sample/1',
            app: 'nextcloud',
            office: { tokens: 1, documents: ['aaaaaaaaaaaaaaaa'], read: 1, edit: 0 },
        }).ok).toBe(false)
    })
    it('rejects documentIds that are not 16-char lowercase hex', () => {
        const office = { tokens: 1, documentIds: ['aaaaaaaaaaaaaaaa'], read: 0, edit: 0 }
        expect(validateSampleHook({ schema: 'idea-usage-sample/1', app: 'nextcloud', office }).ok).toBe(true)
        expect(validateSampleHook({ schema: 'idea-usage-sample/1', app: 'nextcloud', office: { ...office, documentIds: ['DOC-1'] } }).ok).toBe(false)
        expect(validateSampleHook({ schema: 'idea-usage-sample/1', app: 'nextcloud', office: { ...office, documentIds: ['AAAAAAAAAAAAAAAA'] } }).ok).toBe(false)
        expect(validateSampleHook({ schema: 'idea-usage-sample/1', app: 'nextcloud', office: { ...office, documentIds: ['aaaaaaaaaaaaaaa'] } }).ok).toBe(false)
        expect(validateSampleHook({ schema: 'idea-usage-sample/1', app: 'nextcloud', office: { ...office, documentIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] } }).ok).toBe(false)
    })
    it('rejects integer office.byGroup values', () => {
        expect(validateSampleHook({
            schema: 'idea-usage-sample/1',
            app: 'nextcloud',
            office: { tokens: 1, documentIds: [], read: 0, edit: 0, byGroup: { admin: 0, teacher: 1, learner: 0 } },
        }).ok).toBe(false)
    })
})

describe('validatePresence', () => {
    it('accepts a complete presence record', () => {
        const r = validatePresence({
            schema: 'idea-usage-presence/1',
            engine: 'happy-zebra',
            ts: '2026-11-12T10:05:00+01:00',
            bootId: 'abc',
            uptimeS: 12,
            ntpSynced: true,
            engineUp: true,
            instancesUp: ['kolibri-1'],
            tempC: 52.1,
            throttled: '0x0',
        })
        expect(r.ok).toBe(true)
    })
    it('accepts tempC null', () => {
        const r = validatePresence({
            schema: 'idea-usage-presence/1',
            engine: 'happy-zebra',
            ts: '2026-11-12T10:05:00+01:00',
            bootId: 'abc',
            uptimeS: 12,
            ntpSynced: false,
            engineUp: false,
            instancesUp: [],
            tempC: null,
            throttled: 'unknown',
        })
        expect(r.ok).toBe(true)
    })
    it('rejects a missing engine field', () => {
        expect(validatePresence({ schema: 'idea-usage-presence/1', ts: 'x', bootId: 'a', uptimeS: 0, ntpSynced: true, engineUp: true, instancesUp: [], tempC: null, throttled: '0x0' }).ok).toBe(false)
    })
})
