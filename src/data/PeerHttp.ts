/**
 * PeerHttp.ts — server-to-server HTTP to another Engine's API (engine#582).
 *
 * Used for peer follow-ups (PeerCommands.ts) and the relay. The address comes from the
 * store: engineDB[<id>].lanAddresses (lanAddress first), then <hostname>.local. Only
 * private ranges (10/8, 172.16/12, 192.168/16, Tailscale 100.64/10) and .local names
 * are used. Before the first request the peer's GET /api/auth/info must report the
 * expected engineId; an older Engine answers 404 there (ENGINE_VERSION_MISMATCH).
 * Connect timeout 3 s (ENGINE_UNREACHABLE); a whole-request timeout per call.
 */

import http from 'http'
import type { Store } from './Store.js'
import { config } from './Config.js'
import { monoNow } from '../utils/monoClock.js'

export const PEER_CONNECT_TIMEOUT_MS = 3_000
const VERIFIED_TTL_MS = 60_000

export class PeerError extends Error {
    constructor(public code: 'ENGINE_UNKNOWN' | 'ENGINE_UNREACHABLE' | 'ENGINE_VERSION_MISMATCH', message: string, public engineId: string, public version?: string) { super(message) }
}

export interface PeerTarget { host: string, port: number }

const PRIVATE_V4 = (a: string): boolean => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
    if (!m) return false
    const [o1, o2] = [Number(m[1]), Number(m[2])]
    return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 100 && o2 >= 64 && o2 <= 127)
}

let addressOverride: ((engineId: string) => PeerTarget[]) | null = null
/** Tests only: map an engine id to targets (e.g. 127.0.0.1:<port>). */
export const setPeerAddressOverrideForTests = (fn: ((engineId: string) => PeerTarget[]) | null): void => { addressOverride = fn; verified.clear() }

/** Addresses to try for Engine `engineId`, in order. */
export const peerTargets = (store: Store | undefined, engineId: string): PeerTarget[] => {
    if (addressOverride) return addressOverride(engineId)
    const e = (store?.engineDB as any)?.[engineId]
    if (!e) return []
    const port = Number(config.settings.httpPort) || 80
    const out: string[] = []
    for (const a of [e.lanAddress, ...(Array.isArray(e.lanAddresses) ? e.lanAddresses : [])]) {
        if (typeof a === 'string' && PRIVATE_V4(a) && !out.includes(a)) out.push(a)
    }
    const hn = typeof e.hostname === 'string' ? e.hostname.trim() : ''
    if (/^[A-Za-z0-9-]{1,63}$/.test(hn)) out.push(`${hn}.local`)
    return out.map(host => ({ host, port }))
}

export interface PeerResponse { status: number, headers: http.IncomingHttpHeaders, body: Buffer }

/** One HTTP request to a target. Rejects with code 'CONNECT' or 'TIMEOUT' on transport failure. */
export const httpRequest = (
    t: PeerTarget, method: string, path: string, headers: Record<string, string>, body: Buffer | null, timeoutMs: number,
): Promise<PeerResponse> => new Promise((resolve, reject) => {
    let connected = false
    const req = http.request({ host: t.host, port: t.port, method, path, headers: { ...headers, ...(body ? { 'Content-Length': String(body.length) } : {}) } }, res => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => { size += c.length; if (size <= 4 * 1024 * 1024) chunks.push(c) })
        res.on('end', () => { clearTimeout(all); resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }) })
        res.on('error', e => { clearTimeout(all); reject(Object.assign(e, { peer: 'TIMEOUT' })) })
    })
    const conn = setTimeout(() => { if (!connected) req.destroy(Object.assign(new Error('connect timeout'), { peer: 'CONNECT' })) }, PEER_CONNECT_TIMEOUT_MS)
    const all = setTimeout(() => req.destroy(Object.assign(new Error('request timeout'), { peer: 'TIMEOUT' })), timeoutMs)
    req.on('socket', s => {
        const done = () => { connected = true; clearTimeout(conn) }
        if ((s as any).connecting === false) done(); else s.once('connect', done)
    })
    req.on('error', (e: any) => { clearTimeout(conn); clearTimeout(all); reject(Object.assign(e, { peer: e?.peer ?? (connected ? 'TIMEOUT' : 'CONNECT') })) })
    if (body) req.write(body)
    req.end()
})

const verified = new Map<string, { target: PeerTarget, until: number }>()

/** A target of `engineId` whose /api/auth/info reports that engine id. */
export const verifiedTarget = async (store: Store | undefined, engineId: string): Promise<PeerTarget> => {
    const hit = verified.get(engineId)
    if (hit && hit.until > monoNow()) return hit.target
    const targets = peerTargets(store, engineId)
    if (!targets.length) {
        if (!(store?.engineDB as any)?.[engineId] && !addressOverride) throw new PeerError('ENGINE_UNKNOWN', `Engine ${engineId} is not in the store.`, engineId)
        throw new PeerError('ENGINE_UNREACHABLE', `Engine ${engineId} has no usable address.`, engineId)
    }
    let mismatch: PeerError | null = null
    for (const t of targets) {
        try {
            const r = await httpRequest(t, 'GET', '/api/auth/info', { Accept: 'application/json' }, null, 10_000)
            if (r.status === 404) {
                const version = String((store?.engineDB as any)?.[engineId]?.version ?? 'unknown')
                mismatch = new PeerError('ENGINE_VERSION_MISMATCH', `Engine ${engineId} runs an older version (${version}).`, engineId, version)
                continue
            }
            if (r.status !== 200) continue
            const info = JSON.parse(r.body.toString('utf8'))
            if (info?.engineId !== engineId) continue
            verified.set(engineId, { target: t, until: monoNow() + VERIFIED_TTL_MS })
            return t
        } catch { /* next address */ }
    }
    if (mismatch) throw mismatch
    throw new PeerError('ENGINE_UNREACHABLE', `Engine ${engineId} cannot be reached right now.`, engineId)
}

/** Forget the verified address (after a transport failure). */
export const forgetVerifiedTarget = (engineId: string): void => { verified.delete(engineId) }

/** JSON request to a peer's API. */
export const peerJson = async (
    store: Store | undefined, engineId: string, method: string, path: string, body: unknown, headers: Record<string, string>, timeoutMs: number,
): Promise<{ status: number, json: any }> => {
    const t = await verifiedTarget(store, engineId)
    try {
        const r = await httpRequest(t, method, path, { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
            body === undefined ? null : Buffer.from(JSON.stringify(body)), timeoutMs)
        let json: any = null
        try { json = r.body.length ? JSON.parse(r.body.toString('utf8')) : null } catch { json = null }
        return { status: r.status, json }
    } catch (e: any) {
        forgetVerifiedTarget(engineId)
        throw new PeerError('ENGINE_UNREACHABLE', `Engine ${engineId} cannot be reached right now (${e?.message ?? e}).`, engineId)
    }
}
