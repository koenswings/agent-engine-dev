/**
 * RelayKey.ts — the Engine's relay key and the X-Idea-Relay header (engine#582 step 4).
 *
 * When Engine A relays a Console request to Engine B (/api/engines/<B>/...), B only sees
 * A's socket address. So that B's sign-in rate limit and audit log key on the original
 * client, A adds
 *
 *   X-Idea-Relay: v1.<fromEngineId>.<clientAddr base64url>.<t>.<sig>
 *   sig = base64url(Ed25519(relay key of A, "idea-relay-v1\n" + fromEngineId + "\n" + clientAddr + "\n" + t))
 *
 * The private key is <authFolder>/relay-key.pem (PKCS#8, 0600, never synced); the public
 * half (raw 32 bytes, base64url) is published in A's engineDB entry as relayPublicKey.
 * B accepts the header when the signature verifies against the sender's published key
 * and t is within 60 s of its clock; otherwise it uses the socket address. The header
 * only feeds rate limiting and the audit remoteAddr, never authorisation.
 */

import crypto from 'crypto'
import fs from 'fs'
import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from './Store.js'
import { authFolder } from './Config.js'
import { authFile, ensureAuthFolder, writeAuthFileAtomic } from './AuthFolder.js'

export const RELAY_KEY_FILE = 'relay-key.pem'
export const RELAY_HEADER = 'x-idea-relay'
export const RELAY_CLOCK_SKEW_MS = 60_000

const keyCache = new Map<string, { privateKey: crypto.KeyObject, publicKey: string }>()

const rawPublic = (pub: crypto.KeyObject): string =>
    Buffer.from((pub.export({ format: 'jwk' }) as any).x, 'base64url').toString('base64url')

/** This Engine's relay key pair (created on first use). */
export const relayKey = (dir: string = authFolder()): { privateKey: crypto.KeyObject, publicKey: string } => {
    const hit = keyCache.get(dir)
    if (hit) return hit
    const file = authFile(RELAY_KEY_FILE, ensureAuthFolder(dir))
    let privateKey: crypto.KeyObject | null = null
    try { privateKey = crypto.createPrivateKey(fs.readFileSync(file)) } catch { /* missing or unreadable */ }
    if (!privateKey || privateKey.asymmetricKeyType !== 'ed25519') {
        const pair = crypto.generateKeyPairSync('ed25519')
        privateKey = pair.privateKey
        writeAuthFileAtomic(file, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string)
    }
    const k = { privateKey, publicKey: rawPublic(crypto.createPublicKey(privateKey)) }
    keyCache.set(dir, k)
    return k
}

/** Tests only. */
export const clearRelayKeyCacheForTests = (): void => keyCache.clear()

/** Publish the public half in this Engine's engineDB entry (only when it changed). */
export const publishRelayPublicKey = (storeHandle: DocHandle<Store>, engineId: string, dir: string = authFolder()): void => {
    const { publicKey } = relayKey(dir)
    const e = (storeHandle.doc()?.engineDB as any)?.[engineId]
    if (!e || e.relayPublicKey === publicKey) return
    storeHandle.change(d => { const r = (d.engineDB as any)[engineId]; if (r) r.relayPublicKey = publicKey })
}

const message = (from: string, client: string, t: number): string => `idea-relay-v1\n${from}\n${client}\n${t}`

/** The header value Engine `fromEngineId` sends for a request from `clientAddr`. */
export const relayHeader = (fromEngineId: string, clientAddr: string, now: number = Date.now(), dir: string = authFolder()): string => {
    const sig = crypto.sign(null, Buffer.from(message(fromEngineId, clientAddr, now)), relayKey(dir).privateKey).toString('base64url')
    return `v1.${fromEngineId}.${Buffer.from(clientAddr).toString('base64url')}.${now}.${sig}`
}

const HEADER_RE = /^v1\.([A-Za-z0-9_-]{1,80})\.([A-Za-z0-9_-]{1,120})\.([0-9]{1,16})\.([A-Za-z0-9_-]{86})$/

/** The vouched client of a relayed request, or null (bad, stale, or unknown sender). */
export const verifyRelayHeader = (header: unknown, store: Store | undefined, now: number = Date.now()): { client: string, viaEngineId: string } | null => {
    const h = Array.isArray(header) ? header[0] : header
    const m = typeof h === 'string' ? HEADER_RE.exec(h.trim()) : null
    if (!m) return null
    const [, from, addrB64, tStr, sig] = m
    const t = Number(tStr)
    if (!Number.isSafeInteger(t) || Math.abs(now - t) > RELAY_CLOCK_SKEW_MS) return null
    const pubRaw = (store?.engineDB as any)?.[from]?.relayPublicKey
    if (typeof pubRaw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pubRaw)) return null
    const client = Buffer.from(addrB64, 'base64url').toString('utf8')
    if (!/^[0-9A-Fa-f:.]{2,64}$/.test(client)) return null
    try {
        const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubRaw }, format: 'jwk' })
        return crypto.verify(null, Buffer.from(message(from, client, t)), pub, Buffer.from(sig, 'base64url')) ? { client, viaEngineId: from } : null
    } catch { return null }
}
