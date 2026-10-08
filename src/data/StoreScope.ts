/**
 * StoreScope.ts: an Engine only peers with Engines of its OWN store (store-scoped peering).
 *
 * Bug (2026-10-08, tailscale-isolation SUMMARY.md §1 row 5): when two Engines
 * connected they handed each other EVERY document they held, whatever store
 * (fleet) it belonged to. idea02 (store 4GQm) and the pool (store 3zoqd) ended up
 * holding and relaying each other's store docs. Any link did it: mDNS on a shared
 * LAN, a static peer resolving to a Tailscale address, or a stray inbound dial.
 *
 * Fix: every Engine carries a store tag in its identity and checks the other
 * side's tag before any document moves.
 *
 *   - store tag      `<first 5 chars of the store doc id>-<12 hex of sha256(id)>`,
 *                    e.g. `3zoqd-1a2b3c4d5e6f`. The prefix keeps logs readable; the
 *                    hash makes the match exact. The full store id is never
 *                    broadcast (it is a write capability: SUMMARY.md §1 row 6).
 *   - Engine peerId  `idea-engine/<storeTag>/<engineId>/<session>`, the Repo's
 *                    peerId. It travels in the automerge-repo WS handshake in both
 *                    directions (client `join`, server `peer`), so both the dialler
 *                    and the listener can check it before a sync message is
 *                    processed. PeerMetadata cannot carry it (2.3.1 only has
 *                    storageId/isEphemeral).
 *   - mDNS TXT       `store=<storeTag>` next to name/id/version: a mismatch is not
 *                    even dialled (mdnsMonitor.ts). The handshake check is the
 *                    authoritative one and also covers static peers (incl. names
 *                    that resolve to Tailscale IPs) and inbound connections.
 *
 * Verdicts (peerVerdict):
 *   same-store     Engine peerId with our tag                  -> admitted, syncs
 *   foreign-store  Engine peerId with another tag              -> refused
 *   legacy-engine  no Engine peerId and not ephemeral (an Engine
 *                  from before this change, or a tool that keeps
 *                  storage): its store cannot be verified      -> refused (fail closed)
 *   client         no Engine peerId and isEphemeral === true
 *                  (Console, CLI, walker: storage-less, they only
 *                  get what they find() by id)                 -> admitted
 *
 * This module has no Engine imports so the WS server worker thread can use it.
 */

import crypto from 'crypto'

export const ENGINE_PEER_PREFIX = 'idea-engine'

/** The error text a refusing Engine sends before closing (parsed by the other side). */
export const REFUSAL_PREFIX = 'idea-store-refused'

export type PeerKind = 'same-store' | 'foreign-store' | 'legacy-engine' | 'client'

export interface PeerVerdict {
    admit: boolean
    kind: PeerKind
    /** The peer's store tag, when it sent one. */
    theirTag?: string
    engineId?: string
}

/** Minimal shape of automerge-repo's PeerMetadata (kept local: worker-safe, no runtime import). */
export interface PeerMetaLike { isEphemeral?: boolean, storageId?: string }

const TAG_RE = /^[A-Za-z0-9]{1,5}-[0-9a-f]{12}$/
const SESSION_RE = /^[a-z0-9]{1,16}$/

/** The store tag of a store doc id (`automerge:` prefix and whitespace ignored). */
export const storeTag = (storeDocId: string): string => {
    const id = String(storeDocId).trim().replace(/^automerge:/, '')
    if (!id) throw new Error('storeTag: empty store doc id')
    return `${id.slice(0, 5)}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

/** The Repo peerId of an Engine of `storeDocId`. A random session suffix keeps two runs apart. */
export const enginePeerId = (storeDocId: string, engineId: string, session: string = crypto.randomBytes(4).toString('hex')): string => {
    const eid = String(engineId).replace(/[^A-Za-z0-9_.:-]/g, '_')
    return `${ENGINE_PEER_PREFIX}/${storeTag(storeDocId)}/${eid}/${session}`
}

/** `idea-engine/<tag>/<engineId>/<session>` -> its parts; anything else -> undefined. */
export const parseEnginePeerId = (peerId: string | undefined | null): { storeTag: string, engineId: string } | undefined => {
    if (typeof peerId !== 'string') return undefined
    const parts = peerId.split('/')
    if (parts.length !== 4 || parts[0] !== ENGINE_PEER_PREFIX) return undefined
    const [, tag, engineId, session] = parts
    if (!TAG_RE.test(tag) || !engineId || !SESSION_RE.test(session)) return undefined
    return { storeTag: tag, engineId }
}

/** Should `ownTag`'s Engine sync with the peer `peerId` (see the table above)? */
export const peerVerdict = (ownTag: string, peerId: string | undefined, meta: PeerMetaLike | undefined): PeerVerdict => {
    const parsed = parseEnginePeerId(peerId)
    if (parsed) {
        const same = parsed.storeTag === ownTag
        return { admit: same, kind: same ? 'same-store' : 'foreign-store', theirTag: parsed.storeTag, engineId: parsed.engineId }
    }
    if (meta?.isEphemeral === true) return { admit: true, kind: 'client' }
    return { admit: false, kind: 'legacy-engine' }
}

/** One readable line for a refused peer (peer address, its store, ours). */
export const describeRefusal = (v: PeerVerdict, ownTag: string, peerId: string | undefined, where: string): string => {
    const reason = v.kind === 'foreign-store'
        ? `different store: theirs ${v.theirTag}, ours ${ownTag}`
        : `no store id in its identity (an Engine older than store-scoped peering, or a tool with storage; peerId '${peerId ?? '?'}'); ours ${ownTag}`
    return `[store-scope] REFUSED peer ${where}${v.engineId ? ` (${v.engineId})` : ''}: ${reason}. No documents exchanged.`
}

/** The error message text sent to a refused peer: `idea-store-refused ours=<tag> kind=<kind>`. */
export const refusalMessage = (ownTag: string, kind: PeerKind): string => `${REFUSAL_PREFIX} ours=${ownTag} kind=${kind}`

/** Parse a refusal error message from the other side; undefined if it is not one. */
export const parseRefusalMessage = (message: unknown): { theirTag: string, kind: string } | undefined => {
    if (typeof message !== 'string' || !message.startsWith(REFUSAL_PREFIX)) return undefined
    const tag = /ours=(\S+)/.exec(message)?.[1] ?? '?'
    const kind = /kind=(\S+)/.exec(message)?.[1] ?? '?'
    return { theirTag: tag, kind }
}

/**
 * Is `doc` another fleet's store document? A store doc is recognised by its
 * engineDB map (Store.ts); `docId` equal to our own store is never foreign.
 * Used to keep foreign store copies that are already on disk (relayed before this
 * fix) from being announced or served to anyone. They are left in place:
 * clean-up is the separate quarantine proposal.
 */
export const isForeignStoreDocContent = (ownStoreDocId: string, docId: string, doc: unknown): boolean => {
    if (String(docId) === String(ownStoreDocId).replace(/^automerge:/, '')) return false
    return !!doc && typeof doc === 'object' && 'engineDB' in (doc as object)
        && typeof (doc as any).engineDB === 'object' && (doc as any).engineDB !== null
}

/**
 * Is `documentId` another fleet's store doc that is loaded in `repo`? A doc that is
 * not loaded cannot be judged, and cannot be sent either (a sync reply needs the
 * loaded doc), so the send-side guard catches it once it is loaded.
 */
export const isForeignStoreDoc = (repo: { handles: Record<string, any> }, ownStoreDocId: string, documentId: string): boolean => {
    const handle = repo.handles[documentId]
    if (!handle || !handle.isReady?.()) return false
    try { return isForeignStoreDocContent(ownStoreDocId, documentId, handle.doc()) } catch { return false }
}

/**
 * Rate-limited logging of refusals: the same peer (key) is logged at once, then at
 * most every `intervalMs` with the number of refusals in between. A refused old
 * Engine redials every 5 s, so unthrottled this would flood the log.
 */
export class RefusalLog {
    #last = new Map<string, { at: number, suppressed: number }>()
    constructor(private readonly sink: (line: string) => void, private readonly intervalMs = 5 * 60_000, private readonly now: () => number = Date.now) {}
    report(key: string, line: string): boolean {
        const t = this.now()
        const prev = this.#last.get(key)
        if (prev && t - prev.at < this.intervalMs) { prev.suppressed++; return false }
        const extra = prev && prev.suppressed > 0 ? ` (${prev.suppressed} more refusal(s) of this peer since the last log line)` : ''
        this.#last.set(key, { at: t, suppressed: 0 })
        this.sink(line + extra)
        return true
    }
}
