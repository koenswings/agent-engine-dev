/**
 * Schema checks for idea-usage-day/1, idea-usage-sample/1 and
 * idea-usage-presence/1 (idea#411 contract §5).
 */
import { APP_NAME_RE, TOP_ARTICLES_MAX, USAGE_SCHEMA_DAY, USAGE_SCHEMA_PRESENCE, USAGE_SCHEMA_SAMPLE, isValidDate } from './paths.js'
import type { DayFile, PresenceRecord, SampleRecord } from './types.js'

export type SchemaResult<T> = { ok: true; value: T } | { ok: false; error: string }

const FORBIDDEN_KEY = /^(username|userName|email|e-mail|clientAddress|clientIp|clientIP|client_ip|ipAddress|macAddress|password)$/i
const IDENTITY_FROM_ENGINE = new Set(['engine', 'instance', 'name', 'listed', 'clock', 'collectedAt', 'hookStatus', 'skipReason'])

export function hasForbiddenKeys(value: unknown, path = ''): string | null {
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const hit = hasForbiddenKeys(value[i], `${path}[${i}]`)
            if (hit) return hit
        }
        return null
    }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (FORBIDDEN_KEY.test(k)) return path ? `${path}.${k}` : k
            const hit = hasForbiddenKeys(v, path ? `${path}.${k}` : k)
            if (hit) return hit
        }
    }
    return null
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)
const isNonNegInt = (n: unknown): n is number => isInt(n) && n >= 0

function expectObj(value: unknown, label: string): Record<string, unknown> | string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${label} must be an object`
    return value as Record<string, unknown>
}

function expectNonNegFields(obj: Record<string, unknown>, fields: string[], label: string): string | null {
    for (const f of fields) {
        if (!isNonNegInt(obj[f])) return `${label}.${f} must be a non-negative integer`
    }
    return null
}

function expectIntFields(obj: Record<string, unknown>, fields: string[], label: string): string | null {
    for (const f of fields) {
        if (!isInt(obj[f])) return `${label}.${f} must be an integer`
    }
    return null
}

function expectRoleCount(value: unknown, label: string): string | null {
    const obj = expectObj(value, label)
    if (typeof obj === 'string') return obj
    if (!isNonNegInt(obj.total)) return `${label}.total must be a non-negative integer`
    if (!isNonNegInt(obj.beyondSeed)) return `${label}.beyondSeed must be a non-negative integer`
    if ((obj.beyondSeed as number) > (obj.total as number)) return `${label}.beyondSeed cannot exceed total`
    return null
}

function expectRoleCountMap(value: unknown, label: string, keys: string[]): string | null {
    const obj = expectObj(value, label)
    if (typeof obj === 'string') return obj
    const plural = rejectPluralRoleKeys(obj, label)
    if (plural) return plural
    for (const k of keys) {
        const err = expectRoleCount(obj[k], `${label}.${k}`)
        if (err) return err
    }
    return null
}

const PLURAL_ROLE_KEYS = ['admins', 'teachers', 'learners'] as const

function rejectPluralRoleKeys(obj: Record<string, unknown>, label: string): string | null {
    for (const k of PLURAL_ROLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) return `${label} must not use plural role key '${k}'`
    }
    return null
}

function validateKolibri(body: Record<string, unknown>): string | null {
    const setup = expectObj(body.setup, 'setup')
    if (typeof setup === 'string') return setup
    const err = rejectPluralRoleKeys(setup, 'setup')
        || expectNonNegFields(setup, ['classes', 'learnerEnrolled'], 'setup')
        || expectIntFields(setup, ['classesDelta', 'learnerDelta', 'teachersDelta'], 'setup')
        || expectRoleCount(setup.learner, 'setup.learner')
        || expectRoleCount(setup.teacher, 'setup.teacher')
        || expectRoleCount(setup.admin, 'setup.admin')
    if (err) return err

    const signins = expectObj(body.signins, 'signins')
    if (typeof signins === 'string') return signins
    for (const role of ['learner', 'coach', 'admin']) {
        const rowErr = expectRoleCount(signins[role], `signins.${role}`)
        if (rowErr) return rowErr
        const row = signins[role] as Record<string, unknown>
        const sErr = expectNonNegFields(row, ['sessions', 'minutes'], `signins.${role}`)
        if (sErr) return sErr
    }

    if (!Array.isArray(body.content)) return 'content must be an array'
    for (let i = 0; i < body.content.length; i++) {
        const item = expectObj(body.content[i], `content[${i}]`)
        if (typeof item === 'string') return item
        for (const f of ['channel', 'title', 'kind', 'role']) {
            if (typeof item[f] !== 'string') return `content[${i}].${f} must be a string`
        }
        const cErr = expectNonNegFields(item, ['visits', 'seconds', 'completions'], `content[${i}]`)
        if (cErr) return cErr
        if (item.assigned !== undefined && typeof item.assigned !== 'boolean') return `content[${i}].assigned must be a boolean`
    }

    const teaching = expectObj(body.teaching, 'teaching')
    if (typeof teaching === 'string') return teaching
    const tErr = expectNonNegFields(teaching, ['lessonsCreated', 'lessonsVisible', 'quizzesCreated', 'quizzesStarted', 'quizzesEnded'], 'teaching')
    if (tErr) return tErr

    const guest = expectObj(body.guest, 'guest')
    if (typeof guest === 'string') return guest
    const gErr = expectNonNegFields(guest, ['visits', 'seconds'], 'guest')
    if (gErr) return gErr

    if (body.flags !== undefined) {
        if (!Array.isArray(body.flags) || !body.flags.every(x => typeof x === 'string')) return 'flags must be an array of strings'
    }
    return null
}

function validateNextcloud(body: Record<string, unknown>): string | null {
    const setup = expectObj(body.setup, 'setup')
    if (typeof setup === 'string') return setup
    const err = expectRoleCountMap(setup, 'setup', ['admin', 'teacher', 'learner'])
    if (err) return err
    if (setup.otherGroups !== undefined) {
        const og = expectObj(setup.otherGroups, 'setup.otherGroups')
        if (typeof og === 'string') return og
        for (const [k, v] of Object.entries(og)) {
            const gErr = expectRoleCount(v, `setup.otherGroups.${k}`)
            if (gErr) return gErr
        }
    }
    const loginErr = expectRoleCountMap(body.logins, 'logins', ['admin', 'teacher', 'learner'])
    if (loginErr) return loginErr
    if (body.office !== undefined) {
        const oErr = validateOfficeLike(body.office, 'office', false)
        if (oErr) return oErr
    }
    if (body.appsOpened !== undefined) {
        const apps = expectObj(body.appsOpened, 'appsOpened')
        if (typeof apps === 'string') return apps
        for (const [k, v] of Object.entries(apps)) {
            if (!isNonNegInt(v)) return `appsOpened.${k} must be a non-negative integer`
        }
    }
    return null
}

function validateOfficeLike(value: unknown, label: string, requireTokens: boolean): string | null {
    const obj = expectObj(value, label)
    if (typeof obj === 'string') return obj
    const keys = ['opens', 'distinctDocuments', 'read', 'edit', 'estimatedMinutes', 'tokens']
    for (const k of keys) {
        if (obj[k] !== undefined && !isNonNegInt(obj[k])) return `${label}.${k} must be a non-negative integer`
    }
    if (requireTokens && obj.tokens === undefined) return `${label}.tokens is required`
    if (requireTokens) {
        const HEX16 = /^[0-9a-f]{16}$/
        if (!Array.isArray(obj.documentIds) || !obj.documentIds.every(x => typeof x === 'string' && HEX16.test(x))) {
            return `${label}.documentIds must be an array of 16-char lowercase hex strings`
        }
    }
    if (obj.byGroup !== undefined) {
        const map = expectObj(obj.byGroup, `${label}.byGroup`)
        if (typeof map === 'string') return map
        const plural = rejectPluralRoleKeys(map, `${label}.byGroup`)
        if (plural) return plural
        for (const [k, v] of Object.entries(map)) {
            if (!isNonNegInt(v)) return `${label}.byGroup.${k} must be a non-negative integer`
        }
    }
    if (obj.mime !== undefined) {
        const map = expectObj(obj.mime, `${label}.mime`)
        if (typeof map === 'string') return map
        for (const [k, v] of Object.entries(map)) {
            if (!isNonNegInt(v)) return `${label}.mime.${k} must be a non-negative integer`
        }
    }
    return null
}

function validateKiwix(body: Record<string, unknown>): string | null {
    const err = expectNonNegFields(body, ['pageViews', 'distinctArticles', 'sessions'], 'kiwix')
    if (err) return err
    if (!Array.isArray(body.topArticles)) return 'topArticles must be an array'
    if (body.topArticles.length > TOP_ARTICLES_MAX) return `topArticles must have at most ${TOP_ARTICLES_MAX} entries`
    for (let i = 0; i < body.topArticles.length; i++) {
        const item = expectObj(body.topArticles[i], `topArticles[${i}]`)
        if (typeof item === 'string') return item
        if (typeof item.title !== 'string') return `topArticles[${i}].title must be a string`
        if (!isNonNegInt(item.views)) return `topArticles[${i}].views must be a non-negative integer`
    }
    if (!Array.isArray(body.byHour) || body.byHour.length !== 24) return 'byHour must be an array of 24 integers'
    for (let i = 0; i < 24; i++) {
        if (!isNonNegInt(body.byHour[i])) return `byHour[${i}] must be a non-negative integer`
    }
    return null
}

function validateAppPayload(body: Record<string, unknown>): string | null {
    const app = body.app
    if (app === 'kolibri') return validateKolibri(body)
    if (app === 'nextcloud') return validateNextcloud(body)
    if (app === 'kiwix') return validateKiwix(body)
    return null
}

export function validateDayHook(value: unknown, expectedDay: string): SchemaResult<Record<string, unknown>> {
    const obj = expectObj(value, 'day hook')
    if (typeof obj === 'string') return { ok: false, error: obj }
    if (obj.schema !== USAGE_SCHEMA_DAY) return { ok: false, error: `unknown schema '${String(obj.schema)}'` }
    if (typeof obj.day !== 'string' || !isValidDate(obj.day)) return { ok: false, error: 'day must be a real YYYY-MM-DD date' }
    if (obj.day !== expectedDay) return { ok: false, error: `day ${obj.day} does not match requested ${expectedDay}` }
    if (typeof obj.app !== 'string' || !APP_NAME_RE.test(obj.app)) return { ok: false, error: 'app must be a lowercase app name' }
    if (obj.demo !== undefined && typeof obj.demo !== 'boolean') return { ok: false, error: 'demo must be a boolean' }
    const forbidden = hasForbiddenKeys(obj)
    if (forbidden) return { ok: false, error: `forbidden key ${forbidden}` }
    const payloadErr = validateAppPayload(obj)
    if (payloadErr) return { ok: false, error: payloadErr }
    return { ok: true, value: obj }
}

export function validateSampleHook(value: unknown): SchemaResult<SampleRecord> {
    const obj = expectObj(value, 'sample hook')
    if (typeof obj === 'string') return { ok: false, error: obj }
    if (obj.schema !== USAGE_SCHEMA_SAMPLE) return { ok: false, error: `unknown schema '${String(obj.schema)}'` }
    if (typeof obj.app !== 'string' || !APP_NAME_RE.test(obj.app)) return { ok: false, error: 'app must be a lowercase app name' }
    if (obj.supported === false) return { ok: true, value: obj as SampleRecord }
    const forbidden = hasForbiddenKeys(obj)
    if (forbidden) return { ok: false, error: `forbidden key ${forbidden}` }
    if (obj.office !== undefined) {
        const oErr = validateOfficeLike(obj.office, 'office', true)
        if (oErr) return { ok: false, error: oErr }
    }
    return { ok: true, value: obj as SampleRecord }
}

export function validatePresence(value: unknown): SchemaResult<PresenceRecord> {
    const obj = expectObj(value, 'presence')
    if (typeof obj === 'string') return { ok: false, error: obj }
    if (obj.schema !== USAGE_SCHEMA_PRESENCE) return { ok: false, error: `unknown schema '${String(obj.schema)}'` }
    if (typeof obj.engine !== 'string' || !obj.engine) return { ok: false, error: 'engine is required' }
    if (typeof obj.ts !== 'string' || !obj.ts) return { ok: false, error: 'ts is required' }
    if (typeof obj.bootId !== 'string' || !obj.bootId) return { ok: false, error: 'bootId is required' }
    if (typeof obj.uptimeS !== 'number' || !(obj.uptimeS >= 0)) return { ok: false, error: 'uptimeS must be a non-negative number' }
    if (typeof obj.ntpSynced !== 'boolean') return { ok: false, error: 'ntpSynced must be a boolean' }
    if (typeof obj.engineUp !== 'boolean') return { ok: false, error: 'engineUp must be a boolean' }
    if (!Array.isArray(obj.instancesUp) || !obj.instancesUp.every(x => typeof x === 'string')) {
        return { ok: false, error: 'instancesUp must be an array of strings' }
    }
    if (obj.tempC !== null && typeof obj.tempC !== 'number') return { ok: false, error: 'tempC must be a number or null' }
    if (typeof obj.throttled !== 'string') return { ok: false, error: 'throttled must be a string' }
    return { ok: true, value: obj as unknown as PresenceRecord }
}

export function validateStoredDay(value: unknown): SchemaResult<DayFile> {
    const hook = expectObj(value, 'stored day')
    if (typeof hook === 'string') return { ok: false, error: hook }
    if (typeof hook.day !== 'string') return { ok: false, error: 'day is required' }
    const base = validateDayHook(value, hook.day)
    if (!base.ok) return base
    if (typeof hook.engine !== 'string' || !hook.engine) return { ok: false, error: 'engine is required' }
    if (typeof hook.instance !== 'string' || !hook.instance) return { ok: false, error: 'instance is required' }
    if (typeof hook.name !== 'string') return { ok: false, error: 'name is required' }
    if (typeof hook.listed !== 'boolean') return { ok: false, error: 'listed must be a boolean' }
    if (typeof hook.collectedAt !== 'string' || !hook.collectedAt) return { ok: false, error: 'collectedAt is required' }
    const statuses = ['ok', 'timeout', 'failed', 'invalid', 'skipped', 'unlisted-no-hook', 'no-hook']
    if (!statuses.includes(String(hook.hookStatus))) return { ok: false, error: 'hookStatus is invalid' }
    const clock = expectObj(hook.clock, 'clock')
    if (typeof clock === 'string') return { ok: false, error: clock }
    if (typeof clock.synced !== 'boolean') return { ok: false, error: 'clock.synced must be a boolean' }
    if (!isInt(clock.correctedBoots) || clock.correctedBoots < 0) return { ok: false, error: 'clock.correctedBoots must be a non-negative integer' }
    return { ok: true, value: hook as DayFile }
}

/** Hook-owned fields to copy onto the stored file (identity is overwritten by the Engine). */
export function hookPayloadFields(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
        if (k === 'schema' || k === 'day' || k === 'app' || k === 'demo') continue
        if (IDENTITY_FROM_ENGINE.has(k)) continue
        out[k] = v
    }
    return out
}
