/**
 * relayApi.ts — /api/engines/<engineId>/<path> (engine#582 step 4).
 *
 * A Console page talks only to its own origin. To reach another Engine B of the store
 * (sign in, send a command, read its store or command-log URL) it calls its own Engine
 * A at /api/engines/<B>/<path>; A forwards the request server-to-server to B's
 * /api/<path> and returns B's answer unchanged.
 *
 * - Paths: auth/* (info, setup, challenge, login, renew, logout, password, operators,
 *   operators/<id>, grant), command, store-url, command-log-url. Anything else: 404.
 * - <engineId> = this Engine: answered locally (the caller rewrites the path).
 * - B's address: PeerHttp (engineDB lanAddress/lanAddresses, <hostname>.local; private
 *   ranges only) after B's /api/auth/info reported engine id B.
 * - Timeouts: connect 3 s; whole request 10 s for auth/* and info, 15 s for command.
 *   Both → 502 ENGINE_UNREACHABLE { engineId }.
 * - B answers 404 on /api/auth/info (older Engine) → 409 ENGINE_VERSION_MISMATCH
 *   { engineId, version }. The public store-url and command-log-url still go through.
 * - Not in the store → 404 ENGINE_UNKNOWN { engineId }.
 * - Requests to auth/grant: every error the relay makes carries issuerEngineId = B.
 * - A adds X-Idea-Relay (RelayKey.ts) with the original client, so B's rate limit is
 *   per client; a client's own X-Idea-Relay header is never passed on.
 */

import type http from 'http'
import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from '../data/Store.js'
import { authFolder } from '../data/Config.js'
import { clientAddressOf, MAX_BODY_BYTES } from './authApi.js'
import { relayHeader } from '../data/RelayKey.js'
import { httpRequest, peerTargets, verifiedTarget, forgetVerifiedTarget, PeerError, type PeerTarget } from '../data/PeerHttp.js'
import { log } from '../utils/utils.js'

export const RELAY_AUTH_TIMEOUT_MS = 10_000
export const RELAY_COMMAND_TIMEOUT_MS = 15_000
let timeouts = { auth: RELAY_AUTH_TIMEOUT_MS, command: RELAY_COMMAND_TIMEOUT_MS }
/** Tests only. */
export const setRelayTimeoutsForTests = (t: { auth: number, command: number } | null): void => {
    timeouts = t ?? { auth: RELAY_AUTH_TIMEOUT_MS, command: RELAY_COMMAND_TIMEOUT_MS }
}

export interface RelayContext {
    engineId: string
    storeHandle?: DocHandle<Store> | null
    dir?: string
}

const RELAY_RE = /^\/api\/engines\/([A-Za-z0-9_-]{1,80})\/(.+?)\/?$/
const ALLOWED_RE = /^(auth\/(info|setup|challenge|login|renew|logout|password|grant|operators|operators\/[A-Za-z0-9_-]{1,80})|command|store-url|command-log-url)$/
const PUBLIC_READ = new Set(['store-url', 'command-log-url'])

export type RelayRoute = { kind: 'none' } | { kind: 'local', path: string } | { kind: 'remote', engineId: string, path: string } | { kind: 'unknown-path' }

/** Classify a request path. */
export const relayRoute = (pathname: string, self: string): RelayRoute => {
    if (!pathname.startsWith('/api/engines/')) return { kind: 'none' }
    const m = RELAY_RE.exec(pathname)
    if (!m || !ALLOWED_RE.test(m[2])) return { kind: 'unknown-path' }
    return m[1] === self ? { kind: 'local', path: `/api/${m[2]}` } : { kind: 'remote', engineId: m[1], path: m[2] }
}

const readRaw = (req: http.IncomingMessage): Promise<Buffer | 'too-large'> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY_BYTES) { over = true; return } chunks.push(c) })
    req.on('end', () => resolve(over ? 'too-large' : Buffer.concat(chunks)))
    req.on('error', reject)
})

const send = (res: http.ServerResponse, status: number, body: unknown, cors: Record<string, string>, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra })
    res.end(JSON.stringify(body))
}

/** Forward a request to Engine `engineId`. Writes the answer. */
export const handleRelay = async (
    req: http.IncomingMessage, res: http.ServerResponse, engineId: string, path: string, query: string,
    cors: Record<string, string>, ctx: RelayContext,
): Promise<void> => {
    const store = ctx.storeHandle?.doc() as Store | undefined
    const isGrant = path === 'auth/grant'
    const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): void =>
        send(res, status, { error, message, ...extra, ...(isGrant ? { issuerEngineId: engineId } : {}) }, cors)
    const rec = (store?.engineDB as any)?.[engineId]
    if (!rec) { fail(404, 'ENGINE_UNKNOWN', `Engine ${engineId} is not in the store.`, { engineId }); return }
    const name = typeof rec.hostname === 'string' && rec.hostname ? rec.hostname : engineId

    const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readRaw(req)
    if (body === 'too-large') { fail(413, 'PAYLOAD_TOO_LARGE', `Request body is larger than ${MAX_BODY_BYTES / 1024} KB.`); return }

    let target: PeerTarget
    try {
        target = await verifiedTarget(store, engineId)
    } catch (e) {
        if (e instanceof PeerError && e.code === 'ENGINE_VERSION_MISMATCH') {
            const first = peerTargets(store, engineId)[0]
            if (PUBLIC_READ.has(path) && first) target = first
            else { fail(409, 'ENGINE_VERSION_MISMATCH', `${name} runs an older Engine version (${e.version ?? 'unknown'}).`, { engineId, version: e.version ?? 'unknown' }); return }
        } else {
            fail(502, 'ENGINE_UNREACHABLE', `${name} cannot be reached right now.`, { engineId }); return
        }
    }

    const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Idea-Relay': relayHeader(ctx.engineId, clientAddressOf(req, store), Date.now(), ctx.dir ?? authFolder()),
    }
    if (typeof req.headers['content-type'] === 'string') headers['Content-Type'] = req.headers['content-type']
    if (typeof req.headers.authorization === 'string') headers.Authorization = req.headers.authorization
    const timeout = path === 'command' ? timeouts.command : timeouts.auth
    try {
        const r = await httpRequest(target, req.method ?? 'GET', `/api/${path}${query}`, headers, body.length ? body : null, timeout)
        const out: Record<string, string> = { 'Cache-Control': 'no-store', ...cors }
        const ct = r.headers['content-type']
        out['Content-Type'] = typeof ct === 'string' ? ct : 'application/json'
        const ra = r.headers['retry-after']
        if (typeof ra === 'string') out['Retry-After'] = ra
        res.writeHead(r.status, out)
        res.end(r.body)
    } catch (e: any) {
        forgetVerifiedTarget(engineId)
        log(`[relay] ${req.method} ${path} to ${engineId} failed: ${e?.message ?? e}`)
        fail(502, 'ENGINE_UNREACHABLE', `${name} cannot be reached right now.`, { engineId })
    }
}
