/**
 * authApi.ts — Engine sign-in HTTP routes (engine#582).
 *
 *   GET    /api/auth/info              none    → { engineId, engineName, version, authVersion: 1, setupRequired, capabilities }
 *   POST   /api/auth/setup             none    { setupCode, username, passwordHash } → 201 { token, expiresInMs, operator }
 *   POST   /api/auth/challenge         none    { username } → { challengeId, salt, nonce, expiresInMs }
 *   POST   /api/auth/login             none    { challengeId, username, proof } → { token, expiresInMs, operator }
 *   POST   /api/auth/renew             Bearer  → { expiresInMs }
 *   POST   /api/auth/logout            Bearer  → 204
 *   POST   /api/auth/password          Bearer  { challengeId, proof, newPasswordHash } → 204
 *   GET    /api/auth/operators         Bearer  → { operators: [{ id, username, created }] }
 *   POST   /api/auth/operators         Bearer  { username, passwordHash } → 201 { operator }
 *   DELETE /api/auth/operators/<id>    Bearer  → 204
 *
 * Errors are JSON { error, message, ... } with the codes of docs/COMMAND_AUTH.md.
 * Request bodies are JSON, at most 16 KB. Hashes, proofs, tokens and setup codes are
 * never logged.
 */

import type http from 'http'
import os from 'os'
import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from '../data/Store.js'
import { log } from '../utils/utils.js'
import { authFolder } from '../data/Config.js'
import { engineCapabilities } from '../data/Engine.js'
import {
    addOperator, listOperators, removeOperator, setOperatorHash, validUsername, OperatorError, isAcceptableNewHash,
} from '../data/Operators.js'
import { createChallenge, verifyProof } from '../data/LoginChallenge.js'
import { bearerToken, checkToken, createSession, endSession, endSessionsOf, sessionShortId, Session, SESSION_IDLE_MS } from '../data/Sessions.js'
import { loginWaitMs, recordLoginFailure, recordLoginSuccess } from '../data/LoginRateLimit.js'
import { setupOpen, useSetupCode } from '../data/SetupCode.js'
import { appendAudit } from '../data/CommandAudit.js'
import { cleanCommandSource } from '../data/CommandSource.js'
import { issueGrant } from '../data/PeerGrants.js'

export const AUTH_VERSION = 1
export const MAX_BODY_BYTES = 16 * 1024

export interface AuthContext {
    engineId: string
    storeHandle?: DocHandle<Store> | null
    /** Auth folder override (tests). */
    dir?: string
    /** Capabilities override (tests). */
    capabilities?: () => string[]
}

export interface AuthInfo {
    engineId: string
    engineName: string
    version: string
    authVersion: number
    setupRequired: boolean
    capabilities: string[]
}

export class HttpError extends Error {
    constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message) }
}

const dirOf = (ctx: AuthContext): string => ctx.dir ?? authFolder()

/** No operators on this Engine yet: only setup works. */
export const setupRequired = (ctx: AuthContext): boolean => listOperators(dirOf(ctx)).length === 0

export const buildAuthInfo = (ctx: AuthContext): AuthInfo => {
    const rec = (ctx.storeHandle?.doc() as Store | undefined)?.engineDB?.[ctx.engineId as any] as any
    return {
        engineId: ctx.engineId,
        engineName: String(rec?.hostname ?? os.hostname()),
        version: String(rec?.version ?? '0.0.1'),
        authVersion: AUTH_VERSION,
        setupRequired: setupRequired(ctx),
        capabilities: ctx.capabilities ? ctx.capabilities() : engineCapabilities(),
    }
}

/** The original client address: the socket peer (the relay step adds a vouched address). */
export const clientAddressOf = (req: http.IncomingMessage): string => String(req.socket?.remoteAddress ?? 'unknown')

/**
 * Read a request body, at most MAX_BODY_BYTES (413 PAYLOAD_TOO_LARGE beyond that). Routes read
 * the body before they check the token, so an oversized body always gets 413, signed in or not.
 */
export const readRawBody = (req: http.IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const fail = (e: HttpError) => { if (!done) { done = true; reject(e) } }
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        fail(new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body is larger than ${MAX_BODY_BYTES / 1024} KB.`))
        req.resume()
        return
    }
    req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY_BYTES) { fail(new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body is larger than ${MAX_BODY_BYTES / 1024} KB.`)); req.resume(); return }
        if (!done) chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
    req.on('error', () => fail(new HttpError(400, 'BAD_REQUEST', 'Request body could not be read.')))
})

/** Parse a body read by readRawBody as a JSON object (empty body = {}). */
export const parseJsonBody = (raw: Buffer): Record<string, unknown> => {
    const text = raw.toString('utf8').trim()
    if (!text) return {}
    let j: unknown
    try { j = JSON.parse(text) } catch { throw new HttpError(400, 'BAD_REQUEST', 'Body is not valid JSON.') }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new HttpError(400, 'BAD_REQUEST', 'Body must be a JSON object.')
    return j as Record<string, unknown>
}

/** Read a JSON object body, at most MAX_BODY_BYTES. */
export const readJsonBody = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => parseJsonBody(await readRawBody(req))

/** Check the Bearer token of a request (renewing the session); throws a 401 HttpError. */
export const authenticate = (req: http.IncomingMessage): Session => {
    const r = checkToken(bearerToken(req.headers.authorization))
    if (r.ok) return r.session
    const msg = r.code === 'AUTH_REQUIRED' ? 'Sign in first.' : r.code === 'TOKEN_EXPIRED' ? 'The session expired. Sign in again.' : 'Unknown session. Sign in again.'
    throw new HttpError(401, r.code, msg)
}

const str = (v: unknown, field: string, max = 512): string => {
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new HttpError(400, 'BAD_REQUEST', `'${field}' must be a non-empty string.`)
    return v
}

const rateLimited = (waitMs: number): HttpError => {
    const s = Math.max(1, Math.ceil(waitMs / 1000))
    return new HttpError(429, 'LOGIN_RATE_LIMITED', `Too many attempts. Try again in ${s} s.`, { retryAfterSeconds: s })
}

/** One audit line per sign-in event: command 'auth:<event>', the username as args. */
const auditAuth = (ctx: AuthContext, event: string, data: { client?: string, username?: string, by?: string, session?: string }): void => {
    const failed = event.endsWith('-failed')
    appendAudit({
        t: Date.now(),
        engineId: ctx.engineId,
        command: `auth:${event.replace(/-failed$/, '')}`,
        args: data.username ?? '',
        source: cleanCommandSource({ kind: 'operator', operator: data.by ?? data.username, session: data.session, remoteAddr: data.client }) ?? null,
        result: failed ? 'refused' : 'ok',
        errorCode: failed ? (event.startsWith('setup') ? 'SETUP_CODE_INVALID' : 'LOGIN_FAILED') : null,
    }, ctx.dir ? { dir: ctx.dir } : {})
}

const sessionReply = (op: { id: string, username: string }) => {
    const { token, expiresInMs } = createSession(op)
    return { token, expiresInMs, operator: { id: op.id, username: op.username } }
}

export interface AuthResult { status: number, body?: unknown, headers?: Record<string, string> }

/**
 * Handle one /api/auth/* request. Returns null when the path is not an auth route.
 * Pure of the HTTP response so tests can drive it directly.
 */
export const routeAuth = async (req: http.IncomingMessage, pathname: string, ctx: AuthContext): Promise<AuthResult | null> => {
    if (!pathname.startsWith('/api/auth/') && pathname !== '/api/auth') return null
    const route = pathname.replace(/\/+$/, '')
    const method = req.method ?? 'GET'
    const dir = dirOf(ctx)
    const client = clientAddressOf(req)
    // The body is read (size-checked) before any token check: an oversized body is 413 for everyone.
    let raw: Buffer
    try { raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readRawBody(req) } catch (e) {
        // engine#582: every error of the grant route names this Engine as issuerEngineId
        if (route === '/api/auth/grant' && e instanceof HttpError) e.extra = { issuerEngineId: ctx.engineId, ...e.extra }
        throw e
    }
    const body = (): Record<string, unknown> => parseJsonBody(raw)

    if (route === '/api/auth/info' && method === 'GET') return { status: 200, body: buildAuthInfo(ctx) }

    if (route === '/api/auth/setup' && method === 'POST') {
        const b = body()
        if (!setupRequired(ctx)) throw new HttpError(409, 'SETUP_DONE', 'This Engine already has an operator. Sign in instead.')
        const username = str(b.username, 'username', 64)
        if (!validUsername(username)) throw new HttpError(400, 'BAD_REQUEST', 'Username must be 1–64 characters without control characters.')
        if (!isAcceptableNewHash(b.passwordHash)) throw new HttpError(400, 'BAD_REQUEST', "'passwordHash' must be a bcrypt hash with cost 10 to 12.")
        if (!setupOpen()) throw new HttpError(403, 'SETUP_CODE_INVALID', 'That setup code is not right or has expired.')
        const r = useSetupCode(b.setupCode)
        if (!r.ok) {
            if (r.code === 'SETUP_LOCKED') throw rateLimited(r.retryAfterMs ?? 60_000)
            auditAuth(ctx, 'setup-failed', { client })
            throw new HttpError(403, 'SETUP_CODE_INVALID', 'That setup code is not right or has expired.')
        }
        const op = addOperator(username, b.passwordHash, dir)
        log(`[auth] first operator '${username}' created with the setup code`)
        auditAuth(ctx, 'setup', { client, username })
        return { status: 201, body: sessionReply(op) }
    }

    if (route === '/api/auth/challenge' && method === 'POST') {
        const b = body()
        const username = str(b.username, 'username', 64)
        if (setupRequired(ctx)) throw new HttpError(403, 'SETUP_REQUIRED', 'This Engine has no operator yet. Enter the setup code shown on this Engine.')
        return { status: 200, body: createChallenge(username, dir) }
    }

    if (route === '/api/auth/login' && method === 'POST') {
        const b = body()
        const username = str(b.username, 'username', 64)
        const challengeId = str(b.challengeId, 'challengeId', 64)
        const proof = str(b.proof, 'proof', 128)
        if (setupRequired(ctx)) throw new HttpError(403, 'SETUP_REQUIRED', 'This Engine has no operator yet. Enter the setup code shown on this Engine.')
        const wait = loginWaitMs(client, username)
        if (wait > 0) throw rateLimited(wait)
        const op = verifyProof(challengeId, username, proof, ctx.engineId, dir)
        if (!op) {
            recordLoginFailure(client, username)
            auditAuth(ctx, 'login-failed', { client, username })
            throw new HttpError(401, 'LOGIN_FAILED', 'Wrong username or password.')
        }
        recordLoginSuccess(client)
        const reply = sessionReply(op)
        auditAuth(ctx, 'login', { client, username })
        return { status: 200, body: reply }
    }

    if (route === '/api/auth/renew' && method === 'POST') {
        const s = authenticate(req)
        return { status: 200, body: { expiresInMs: Math.max(0, Math.min(SESSION_IDLE_MS, s.expiresAt - s.lastUsed)) } }
    }

    if (route === '/api/auth/grant' && method === 'POST') {
        // engine#582: permission for another Engine to send follow-ups here. Every
        // error names this Engine as issuerEngineId.
        const self = ctx.engineId
        try {
            const s = authenticate(req)
            const b = body()
            const to = str(b.toEngineId, 'toEngineId', 80)
            if (!/^[A-Za-z0-9_-]{1,80}$/.test(to) || to === self) throw new HttpError(400, 'BAD_REQUEST', "'toEngineId' must be another Engine's id.")
            const store = ctx.storeHandle?.doc() as Store | undefined
            if (!store?.engineDB?.[to as any]) throw new HttpError(404, 'ENGINE_UNKNOWN', `Engine ${to} is not known to this Engine.`)
            const g = issueGrant(self, to, s.username, undefined, dirOf(ctx))
            auditAuth(ctx, 'grant', { username: to, by: s.username, session: sessionShortId(s) })
            return { status: 200, body: { grant: g.grant, expiresInMs: g.expiresInMs, issuerEngineId: self } }
        } catch (e) {
            if (e instanceof HttpError) e.extra = { issuerEngineId: self, ...e.extra }
            throw e
        }
    }

    if (route === '/api/auth/logout' && method === 'POST') {
        const s = authenticate(req)
        endSession(bearerToken(req.headers.authorization))
        auditAuth(ctx, 'logout', { username: s.username, session: sessionShortId(s) })
        return { status: 204 }
    }

    if (route === '/api/auth/password' && method === 'POST') {
        const s = authenticate(req)
        const b = body()
        const challengeId = str(b.challengeId, 'challengeId', 64)
        const proof = str(b.proof, 'proof', 128)
        if (!isAcceptableNewHash(b.newPasswordHash)) throw new HttpError(400, 'BAD_REQUEST', "'newPasswordHash' must be a bcrypt hash with cost 10 to 12.")
        const wait = loginWaitMs(client, s.username)
        if (wait > 0) throw rateLimited(wait)
        const op = verifyProof(challengeId, s.username, proof, ctx.engineId, dir)
        if (!op) {
            recordLoginFailure(client, s.username)
            auditAuth(ctx, 'password-failed', { client, username: s.username })
            throw new HttpError(401, 'LOGIN_FAILED', 'Wrong username or password.')
        }
        setOperatorHash(s.username, b.newPasswordHash as string, dir)
        endSessionsOf(op.id, s.key)
        auditAuth(ctx, 'password', { client, username: s.username })
        return { status: 204 }
    }

    if (route === '/api/auth/operators' && method === 'GET') {
        authenticate(req)
        return { status: 200, body: { operators: listOperators(dir).map(o => ({ id: o.id, username: o.username, created: o.created })) } }
    }

    if (route === '/api/auth/operators' && method === 'POST') {
        const s = authenticate(req)
        const b = body()
        const username = str(b.username, 'username', 64)
        const op = addOperator(username, b.passwordHash as string, dir)
        auditAuth(ctx, 'operator-added', { by: s.username, username })
        return { status: 201, body: { operator: { id: op.id, username: op.username, created: op.created } } }
    }

    const del = /^\/api\/auth\/operators\/([^/]+)$/.exec(route)
    if (del && method === 'DELETE') {
        const s = authenticate(req)
        let id: string
        try { id = decodeURIComponent(del[1]) } catch { throw new HttpError(400, 'BAD_REQUEST', 'Bad operator id.') }
        const target = listOperators(dir).find(o => o.id === id)
        removeOperator(id, dir)
        if (target) endSessionsOf(target.id)
        auditAuth(ctx, 'operator-removed', { by: s.username, username: target?.username })
        return { status: 204 }
    }

    return { status: 404, body: { error: 'NOT_FOUND', message: `No API route ${route} on this Engine.` } }
}

const OPERATOR_STATUS: Record<OperatorError['code'], number> = { OPERATOR_EXISTS: 409, OPERATOR_UNKNOWN: 404, LAST_OPERATOR: 409, BAD_REQUEST: 400 }

/** Write an auth route's answer (or error) to `res`. Returns false when not an auth route. */
export const handleAuthApi = async (
    req: http.IncomingMessage, res: http.ServerResponse, pathname: string, cors: Record<string, string>, ctx: AuthContext,
): Promise<boolean> => {
    let result: AuthResult | null
    try {
        result = await routeAuth(req, pathname, ctx)
        if (!result) return false
    } catch (e: any) {
        if (e instanceof HttpError) result = { status: e.status, body: { error: e.code, message: e.message, ...e.extra } }
        else if (e instanceof OperatorError) result = { status: OPERATOR_STATUS[e.code], body: { error: e.code, message: e.message } }
        else {
            log(`[auth] ${req.method} ${pathname} failed: ${e?.message ?? e}`)
            result = { status: 500, body: { error: 'INTERNAL', message: 'The Engine could not handle this request.' } }
        }
        if (result.status === 429) {
            const s = String((result.body as any).retryAfterSeconds ?? 60)
            result.headers = { 'Retry-After': s }
        }
    }
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...cors, ...(result.headers ?? {}) }
    if (result.status === 204) { res.writeHead(204, headers); res.end(); return true }
    res.writeHead(result.status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(result.body ?? {}))
    return true
}
