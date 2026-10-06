/**
 * idea#168: peer-key preflight (exit 9) — fail loud before step 1 when a cross-Engine copy
 * the walk will run cannot work because the Engines have not exchanged their per-Pi keys.
 *
 * Engine feat/app-data-root-helper (per-Pi Engine keys, design-per-pi-engine-key.md):
 *  - every Engine publishes `peerAccess` on its own Engine entry in the store:
 *      { sshKey: 'ssh-ed25519 <b64>', hostKey: 'ssh-ed25519 <b64>', publishedAt,
 *        authorized: ['<engineId> <sshKey fp> <hostKey fp>', …] }   (fp = OpenSSH SHA256:…)
 *  - `idea-app-data` v2 `sync-peers` writes /etc/ssh/idea_authorized_keys/pi
 *    (`restrict,command="/usr/local/sbin/idea-peer-gate <id>" ssh-ed25519 <key> idea-peer:<id>`)
 *    and /etc/idea/peer_known_hosts (`<id> ssh-ed25519 <hostkey>`, HostKeyAlias=<id>);
 *  - the Engine's copy validate() (PeerAccess.peerCopyRefusal) refuses a cross-Engine copy
 *    from A to B unless B lists A's CURRENT keys in B.peerAccess.authorized AND A lists B's.
 *
 * This module is the pure part (pair derivation + verdict + probe script/parser); the live
 * reads are RealFleetOps.readPeerStore / probePeerHost and the CLI wiring is in cli.ts.
 *
 * Which steps / pairs. Of the walk actions, only `copy_app` runs an Engine-to-Engine
 * transfer (rsync over ssh with the peer keys). `move_app` is refused cross-Engine by the
 * Engine (and preflighted same-Pi by the harness); `infra_move_disk` streams through the
 * walker's own ssh (no Pi→Pi key). Which Pis a copy joins is decided at run time from the
 * store (predictCopyMovePair: the instance's disk host → the target disk's host), and the
 * walk's infra_dock_fixture (rng pool pick), infra_move_disk and co-location moves can put
 * either disk on any pool Pi — so every copy step needs every pair of the walk's pool
 * engines (pool_engines minus exclude_engines, never idea02) mutually accepted.
 */

import crypto from 'node:crypto'

/** Exit code: per-Pi peer keys not (mutually) accepted for a cross-Engine copy the walk runs. */
export const EXIT_PEER_PREFLIGHT = 9

/** Walk actions that can run a cross-Engine (peer-key) copy. */
export const CROSS_ENGINE_COPY_ACTIONS: readonly string[] = ['copy_app']

/** `idea-app-data` protocol version that has `sync-peers` (peer keys). */
export const MIN_PEER_HELPER_VERSION = 2
/** Lowest `idea-app-data` version the slot layout accepts when no peer copy is in the walk. */
export const MIN_SLOT_HELPER_VERSION = 1

export const PEER_HELPER = '/usr/local/sbin/idea-app-data'
export const PEER_AUTHORIZED_KEYS = '/etc/ssh/idea_authorized_keys/pi'
export const PEER_KNOWN_HOSTS = '/etc/idea/peer_known_hosts'
export const PEER_KEY_PUB = '/home/pi/.ssh/idea_engine_ed25519.pub'
export const HOST_KEY_PUB = '/etc/ssh/ssh_host_ed25519_key.pub'

const NEVER_ENGINES = new Set(['idea02'])

// ── Keys (same rules as Engine src/utils/peerSsh.ts) ─────────────────────────

const ED25519_B64_RE = /^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/

/** `ssh-ed25519 <b64> [comment]` → `ssh-ed25519 <b64>`, or null when not one well-formed ed25519 key. */
export const normaliseEd25519 = (line: unknown): string | null => {
    if (typeof line !== 'string') return null
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2 || parts[0] !== 'ssh-ed25519' || !ED25519_B64_RE.test(parts[1]!)) return null
    const blob = Buffer.from(parts[1]!, 'base64')
    if (blob.length !== 51 || blob.readUInt32BE(0) !== 11 || blob.toString('latin1', 4, 15) !== 'ssh-ed25519' || blob.readUInt32BE(15) !== 32) return null
    if (blob.toString('base64').replace(/=+$/, '') !== parts[1]) return null
    return `ssh-ed25519 ${parts[1]}`
}

/** OpenSSH fingerprint `SHA256:<b64 no padding>` of an ed25519 public key line. */
export const keyFingerprint = (keyLine: string): string => {
    const k = normaliseEd25519(keyLine)
    if (!k) throw new Error('not an ed25519 public key')
    return `SHA256:${crypto.createHash('sha256').update(Buffer.from(k.split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/, '')}`
}

const fpOrBad = (k: string | null | undefined): string => {
    const n = normaliseEd25519(k)
    return n ? keyFingerprint(n) : '(malformed)'
}

/** The entry B appears as in A's peerAccess.authorized: '<engineId> <sshKey fp> <hostKey fp>'. */
export const authorizedEntry = (engineId: string, keys: { sshKey: string; hostKey: string }): string =>
    `${engineId} ${keyFingerprint(keys.sshKey)} ${keyFingerprint(keys.hostKey)}`

// ── Pair derivation (pure, from the walk) ────────────────────────────────────

export interface CopyStep { step: number; action: string }
export interface EnginePair {
    /** Logical pool ids, in pool order. */
    a: string
    b: string
    /** 1-based walk steps that need this pair. */
    steps: number[]
}
export interface CopyPairPlan {
    copySteps: CopyStep[]
    /** Pool engines a copy can join (pool minus excluded, never idea02). */
    engines: string[]
    pairs: EnginePair[]
    /** The first step considered (1-based; --start-from). */
    fromStep: number
}

/**
 * Copy steps at or after `startIndex` (0-based; --start-from N → N-1) and before `endIndex`
 * (exclusive; --iterations), and the unordered engine pairs they need.
 */
export const deriveCopyPairs = (input: {
    steps: readonly { action: string }[]
    startIndex?: number
    endIndex?: number
    poolEngines: readonly string[]
    excludeEngines?: readonly string[]
}): CopyPairPlan => {
    const start = Math.max(0, input.startIndex ?? 0)
    const end = Math.min(input.steps.length, input.endIndex ?? input.steps.length)
    const copySteps: CopyStep[] = []
    for (let i = start; i < end; i++) {
        const a = input.steps[i]!.action
        if (CROSS_ENGINE_COPY_ACTIONS.includes(a)) copySteps.push({ step: i + 1, action: a })
    }
    const excl = new Set(input.excludeEngines ?? [])
    const engines = [...new Set(input.poolEngines)].filter(e => !excl.has(e) && !NEVER_ENGINES.has(e))
    const pairs: EnginePair[] = []
    if (copySteps.length) {
        for (let i = 0; i < engines.length; i++) {
            for (let j = i + 1; j < engines.length; j++) {
                pairs.push({ a: engines[i]!, b: engines[j]!, steps: copySteps.map(s => s.step) })
            }
        }
    }
    return { copySteps, engines, pairs, fromStep: start + 1 }
}

/** Slot-layout helper floor: v1 in general, v2 when the run has a cross-Engine copy pair. */
export const requiredHelperVersion = (plan: Pick<CopyPairPlan, 'pairs'>): number =>
    plan.pairs.length ? MIN_PEER_HELPER_VERSION : MIN_SLOT_HELPER_VERSION

export const describeCopySteps = (plan: Pick<CopyPairPlan, 'copySteps'>): string =>
    plan.copySteps.map(s => `${s.action}@${s.step}`).join(', ')

// ── Store view + host probe ──────────────────────────────────────────────────

export interface PeerAccessRow {
    sshKey?: unknown
    hostKey?: unknown
    publishedAt?: unknown
    authorized?: unknown
}
export interface PeerStoreEngine {
    liveId: string
    hostname?: string | null
    peerAccess?: PeerAccessRow | null
    lastRun?: number | null
}
export interface PeerStoreView {
    /** Pool engine whose WS store copy was read. */
    via: string
    /** Every Engine entry in the (shared) store doc, by live engineDB key. */
    engines: Record<string, PeerStoreEngine>
    /** logical pool id → live engineDB key (null: no entry found). */
    liveIdOf: Record<string, string | null>
}

export type PeerFile = { state: 'file'; lines: string[] } | { state: 'missing' | 'unreadable' }
export interface PeerHostProbe {
    helper: 'present' | 'absent'
    versionRc: number | null
    versionOut: string
    authorizedKeys: PeerFile
    knownHosts: PeerFile
    ownKeyPub: PeerFile
    hostKeyPub: PeerFile
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const fileProbe = (tag: string, file: string): string => {
    const F = shq(file)
    const D = shq(file.slice(0, file.lastIndexOf('/')) || '/')
    return `if [ -f ${F} ] && [ -r ${F} ]; then echo "FILE ${tag} file"; ` +
        `awk '{ sub(/\\r$/, ""); if ($0 !~ /^[ \\t]*(#|$)/) print "${tag}_LINE " $0 }' ${F} 2>/dev/null || echo "FILE ${tag} unreadable"; ` +
        `elif [ -e ${F} ] || [ -L ${F} ] || { [ -e ${D} ] && [ ! -x ${D} ]; }; then echo "FILE ${tag} unreadable"; ` +
        `else echo "FILE ${tag} missing"; fi`
}

/**
 * READ-ONLY probe of one Pi: `sudo -n idea-app-data version` (only when the helper file
 * exists — same call as the slot preflight) and the contents of the peer files the helper
 * writes plus this Pi's own published key files. Only test / awk / sudo -n … version.
 */
export const buildPeerProbeRemote = (): string => {
    const H = shq(PEER_HELPER)
    return [
        `if [ -e ${H} ] || [ -L ${H} ]; then echo "HELPER present"; ` +
            `if [ -x ${H} ]; then _v=$(sudo -n ${H} version 2>&1 </dev/null); _rc=$?; else _v="not executable"; _rc=126; fi; ` +
            `echo "HELPER_VERSION $_rc $(printf '%s' "$_v" | head -n 1 | tr -d '\\r')"; ` +
            `else echo "HELPER absent"; fi`,
        fileProbe('AUTH', PEER_AUTHORIZED_KEYS),
        fileProbe('KNOWN', PEER_KNOWN_HOSTS),
        fileProbe('OWNKEY', PEER_KEY_PUB),
        fileProbe('HOSTKEY', HOST_KEY_PUB),
        'true',
    ].join('; ')
}

export const parsePeerProbe = (out: string): PeerHostProbe => {
    const p: PeerHostProbe = {
        helper: 'absent', versionRc: null, versionOut: '',
        authorizedKeys: { state: 'missing' }, knownHosts: { state: 'missing' }, ownKeyPub: { state: 'missing' }, hostKeyPub: { state: 'missing' },
    }
    const key: Record<string, keyof Pick<PeerHostProbe, 'authorizedKeys' | 'knownHosts' | 'ownKeyPub' | 'hostKeyPub'>> = {
        AUTH: 'authorizedKeys', KNOWN: 'knownHosts', OWNKEY: 'ownKeyPub', HOSTKEY: 'hostKeyPub',
    }
    const lines: Record<string, string[]> = { AUTH: [], KNOWN: [], OWNKEY: [], HOSTKEY: [] }
    let sawHelper = false
    for (const raw of out.split('\n')) {
        const line = raw.replace(/\r$/, '')
        let m: RegExpMatchArray | null
        if ((m = line.match(/^HELPER (present|absent)$/))) { p.helper = m[1] as 'present'; sawHelper = true }
        else if ((m = line.match(/^HELPER_VERSION (\d+) ?(.*)$/))) { p.versionRc = Number(m[1]); p.versionOut = m[2]!.trim() }
        else if ((m = line.match(/^FILE (AUTH|KNOWN|OWNKEY|HOSTKEY) (file|missing|unreadable)$/))) {
            p[key[m[1]!]!] = m[2] === 'file' ? { state: 'file', lines: lines[m[1]!]! } : { state: m[2] as 'missing' }
        } else if ((m = line.match(/^(AUTH|KNOWN|OWNKEY|HOSTKEY)_LINE (.*)$/))) lines[m[1]!]!.push(m[2]!)
    }
    if (!sawHelper) throw new Error(`peer probe: unparseable output (no HELPER line): ${out.slice(0, 300)}`)
    return p
}

/** `idea-app-data <N>` → N, else null. */
export const helperVersionNumber = (versionRc: number | null, versionOut: string): number | null => {
    const m = versionRc === 0 ? versionOut.match(/^idea-app-data ([0-9]+)$/) : null
    return m ? Number(m[1]) : null
}

/** authorized_keys line written by sync-peers → { id, key } (null: not a gate line). */
export const parseAuthorizedKeysLine = (line: string): { id: string; key: string | null } | null => {
    const m = line.match(/command="[^"]*idea-peer-gate\s+([^"\s]+)"\s+(ssh-ed25519\s+\S+)/)
    return m ? { id: m[1]!, key: normaliseEd25519(m[2]!) } : null
}

/** peer_known_hosts line `<id> ssh-ed25519 <hostkey>` → { id, key }. */
export const parseKnownHostsLine = (line: string): { id: string; key: string | null } | null => {
    const m = line.trim().match(/^(\S+)\s+(ssh-ed25519\s+\S+)/)
    return m ? { id: m[1]!, key: normaliseEd25519(m[2]!) } : null
}

// ── Verdict (pure) ───────────────────────────────────────────────────────────

export type PeerProblemKind =
    | 'unpublished'
    | 'one-sided'
    | 'not-exchanged'
    | 'fingerprint-mismatch'
    | 'foreign-id'
    | 'helper-too-old'
    | 'probe-failed'

export interface PeerProblem {
    kind: PeerProblemKind
    /** 'idea01↔idea03' or the single engine. */
    subject: string
    message: string
}

export interface PeerPairResult {
    a: string
    b: string
    hostA: string | null
    hostB: string | null
    steps: number[]
    /** A lists B (store) / B lists A (store). */
    aAcceptsB: boolean
    bAcceptsA: boolean
    ok: boolean
}

export interface PeerPreflightResult {
    ok: boolean
    skipped: boolean
    pairs: PeerPairResult[]
    problems: PeerProblem[]
    /** Non-fatal observations (e.g. peer files not readable → store check only). */
    notes: string[]
    message: string
}

export const PEER_SKIP_NO_COPY = 'peer preflight skipped: no cross-engine copy steps'

const rowKeys = (row: PeerStoreEngine | undefined): { sshKey: string; hostKey: string } | null => {
    const pa = row?.peerAccess
    if (!pa) return null
    const sshKey = normaliseEd25519(pa.sshKey)
    const hostKey = normaliseEd25519(pa.hostKey)
    return sshKey && hostKey ? { sshKey, hostKey } : null
}

const authorizedList = (row: PeerStoreEngine | undefined): string[] => {
    const a = row?.peerAccess?.authorized
    return Array.isArray(a) ? a.map(String) : []
}

const isIdea02 = (liveId: string, row: PeerStoreEngine | undefined): boolean => {
    if (NEVER_ENGINES.has(liveId)) return true
    const h = String(row?.hostname ?? '').toLowerCase().replace(/\.local$/, '')
    return h === 'idea02' || h.startsWith('idea02.')
}

/**
 * Pure verdict. For every pair A,B (both directions): both entries publish well-formed
 * keys; A.authorized lists B with B's CURRENT key + host key fingerprints and vice versa;
 * no pool Engine authorizes idea02 or an Engine outside the pool. Per host (when probed):
 * helper version >= 2; its peer files (when readable) hold the peer's gate line / pinned
 * host key with the published key; its own key files match what it published.
 */
export const peerPreflightVerdict = (input: {
    plan: CopyPairPlan
    store: PeerStoreView
    hosts?: Record<string, string>
    /** Per logical engine: the read-only host probe, or the ssh error. Absent: not probed. */
    probes?: Record<string, PeerHostProbe | Error>
    minHelperVersion?: number
}): PeerPreflightResult => {
    const { plan, store } = input
    const hosts = input.hosts ?? {}
    const minV = input.minHelperVersion ?? MIN_PEER_HELPER_VERSION
    if (!plan.pairs.length) {
        const why = plan.copySteps.length
            ? `peer preflight skipped: ${describeCopySteps(plan)} but fewer than two pool engines (${plan.engines.join(', ') || 'none'}) — every copy is same-Pi`
            : PEER_SKIP_NO_COPY
        return { ok: true, skipped: true, pairs: [], problems: [], notes: [], message: why }
    }
    const problems: PeerProblem[] = []
    const notes: string[] = []
    const name = (e: string) => `${e}${hosts[e] ? ` (${hosts[e]})` : ''}`
    const at = (steps: number[]) => steps.map(n => `@${n}`).join(',')
    const engines = [...new Set(plan.pairs.flatMap(p => [p.a, p.b]))]
    const poolLive = new Map<string, string>() // live id → logical
    for (const e of plan.engines) {
        const l = store.liveIdOf[e]
        if (l) poolLive.set(l, e)
    }

    // 1. Published keys
    const keys = new Map<string, { sshKey: string; hostKey: string } | null>()
    for (const e of engines) {
        const live = store.liveIdOf[e] ?? null
        const row = live ? store.engines[live] : undefined
        const k = rowKeys(row)
        keys.set(e, k)
        if (!live || !row) {
            problems.push({ kind: 'unpublished', subject: e, message: `${name(e)} has no Engine entry in the store read through ${store.via} — nothing published` })
        } else if (!row.peerAccess) {
            problems.push({
                kind: 'unpublished', subject: e,
                message: `${name(e)} (Engine ${live}) has not published peerAccess (older Engine, peer access off, or fail-closed store) — cross-Engine copies to/from it are refused`,
            })
        } else if (!k) {
            problems.push({
                kind: 'unpublished', subject: e,
                message: `${name(e)} (Engine ${live}) publishes a malformed peerAccess (sshKey ${normaliseEd25519(row.peerAccess.sshKey) ? 'ok' : 'not one ed25519 key'}, ` +
                    `hostKey ${normaliseEd25519(row.peerAccess.hostKey) ? 'ok' : 'not one ed25519 key'})`,
            })
        }
    }

    // 2. Mutual acceptance per pair (store)
    /** Does `from` list `peer` with peer's CURRENT keys? 'mismatch': listed with other fingerprints. */
    const accepts = (from: string, peer: string, steps: number[]): 'yes' | 'no' | 'mismatch' | 'n/a' => {
        const fromLive = store.liveIdOf[from]
        const peerLive = store.liveIdOf[peer]
        const peerKeys = keys.get(peer)
        if (!fromLive || !peerLive || !peerKeys || !keys.get(from)) return 'n/a'
        const list = authorizedList(store.engines[fromLive])
        const want = authorizedEntry(peerLive, peerKeys)
        if (list.includes(want)) return 'yes'
        const theirs = list.filter(x => x.trim().split(/\s+/)[0] === peerLive)
        if (!theirs.length) return 'no'
        problems.push({
            kind: 'fingerprint-mismatch', subject: `${from}↔${peer}`,
            message: `${from}↔${peer} (${at(steps)}): ${name(from)} lists ${peer} as '${theirs.join("', '")}' but ${peer} publishes '${want}' ` +
                `(stale key or host key — reimage / key rotation not yet re-synced) — the Engine refuses copies between them`,
        })
        return 'mismatch'
    }
    const pairs: PeerPairResult[] = []
    for (const p of plan.pairs) {
        const aB = accepts(p.a, p.b, p.steps)
        const bA = accepts(p.b, p.a, p.steps)
        if (aB === 'no' && bA === 'no') {
            problems.push({
                kind: 'not-exchanged', subject: `${p.a}↔${p.b}`,
                message: `${p.a}↔${p.b} (${at(p.steps)}): neither side lists the other in peerAccess.authorized — keys not exchanged yet (sync-peers not run / failed on both)`,
            })
        } else {
            for (const [x, y, r] of [[p.a, p.b, aB], [p.b, p.a, bA]] as const) {
                if (r !== 'no') continue
                problems.push({
                    kind: 'one-sided', subject: `${p.a}↔${p.b}`,
                    message: `${p.a}↔${p.b} (${at(p.steps)}): one-sided — ${name(y)} lists ${x} but ${name(x)} does not list ${y} in peerAccess.authorized ` +
                        `(${x} neither accepts ${y}'s key nor pins its host key — the Engine refuses copies between them both ways)`,
                })
            }
        }
        pairs.push({ a: p.a, b: p.b, hostA: hosts[p.a] ?? null, hostB: hosts[p.b] ?? null, steps: p.steps, aAcceptsB: aB === 'yes', bAcceptsA: bA === 'yes', ok: false })
    }

    // 3. No idea02 / foreign / unknown id in a pool Engine's authorized list
    for (const e of engines) {
        const live = store.liveIdOf[e]
        if (!live) continue
        for (const entry of authorizedList(store.engines[live])) {
            const parts = entry.trim().split(/\s+/)
            const id = parts[0] ?? ''
            if (parts.length !== 3 || !/^SHA256:/.test(parts[1] ?? '') || !/^SHA256:/.test(parts[2] ?? '')) {
                problems.push({ kind: 'foreign-id', subject: e, message: `${name(e)} peerAccess.authorized has a malformed entry '${entry}' (want '<engineId> <SHA256:key fp> <SHA256:hostkey fp>')` })
            } else if (isIdea02(id, store.engines[id])) {
                problems.push({ kind: 'foreign-id', subject: e, message: `${name(e)} authorizes idea02 (Engine ${id}) — never idea02: production must not be able to copy into the pool` })
            } else if (!poolLive.has(id)) {
                const row = store.engines[id]
                problems.push({
                    kind: 'foreign-id', subject: e,
                    message: `${name(e)} authorizes Engine ${id}${row?.hostname ? ` ('${row.hostname}')` : ' (not in the store)'}, which is not a pool engine ` +
                        `(${plan.engines.map(x => `${x}=${store.liveIdOf[x] ?? '?'}`).join(', ')}) — a foreign Engine in the shared store can copy into the pool`,
                })
            }
        }
    }

    // 4. Host probes (helper version, peer files, own key files)
    for (const e of engines) {
        const pr = input.probes?.[e]
        if (pr === undefined) continue
        const peersOf = plan.pairs.filter(p => p.a === e || p.b === e).map(p => (p.a === e ? p.b : p.a))
        const pairText = peersOf.map(o => `${e}↔${o}`).join(', ')
        if (pr instanceof Error) {
            problems.push({ kind: 'probe-failed', subject: e, message: `${name(e)}: read-only peer probe failed over ssh (${pr.message}) — pairs ${pairText} unverified` })
            continue
        }
        const v = helperVersionNumber(pr.versionRc, pr.versionOut)
        const helperOk = pr.helper === 'present' && v !== null && v >= minV
        if (pr.helper === 'absent') {
            problems.push({ kind: 'helper-too-old', subject: e, message: `${name(e)}: helper too old — no ${PEER_HELPER} (need idea-app-data >= ${minV} with sync-peers) for ${pairText}` })
        } else if (v === null) {
            problems.push({
                kind: 'helper-too-old', subject: e,
                message: `${name(e)}: helper too old / not answering — \`sudo -n ${PEER_HELPER} version\` gave exit ${pr.versionRc ?? '?'}: ${pr.versionOut || '(no output)'} (need idea-app-data >= ${minV}) for ${pairText}`,
            })
        } else if (v < minV) {
            problems.push({ kind: 'helper-too-old', subject: e, message: `${name(e)}: helper too old — idea-app-data ${v} < ${minV} (no sync-peers / peer gate) for ${pairText}` })
        }
        const live = store.liveIdOf[e]
        const mine = keys.get(e)
        // Own key files vs what this Engine published
        for (const [file, f, pub, what] of [
            [PEER_KEY_PUB, pr.ownKeyPub, mine?.sshKey, 'Engine key'],
            [HOST_KEY_PUB, pr.hostKeyPub, mine?.hostKey, 'ssh host key'],
        ] as const) {
            if (!mine) continue
            if (f.state !== 'file') { notes.push(`${name(e)}: ${file} ${f.state} — published ${what} not cross-checked on the Pi`); continue }
            const onPi = normaliseEd25519(f.lines.join(' ').split(/\s+/).slice(0, 2).join(' '))
            if (onPi && onPi !== pub) {
                problems.push({
                    kind: 'fingerprint-mismatch', subject: e,
                    message: `${name(e)}: its ${what} on the Pi (${file}, ${keyFingerprint(onPi)}) differs from the one it publishes (${fpOrBad(pub)}) — peers pin the published one`,
                })
            }
        }
        // Peer files: each peer's gate line / pinned host key, with the published keys
        for (const [file, f, parse, field, what] of [
            [PEER_AUTHORIZED_KEYS, pr.authorizedKeys, parseAuthorizedKeysLine, 'sshKey', 'gate line'],
            [PEER_KNOWN_HOSTS, pr.knownHosts, parseKnownHostsLine, 'hostKey', 'pinned host key'],
        ] as const) {
            if (f.state === 'unreadable') { notes.push(`${name(e)}: ${file} not readable as pi — relying on the store check (peerAccess.authorized) for ${pairText}`); continue }
            if (f.state !== 'file' && !helperOk) {
                notes.push(`${name(e)}: ${file} does not exist (expected: no idea-app-data v${minV} sync-peers on this Pi yet — reported as helper-too-old)`)
                continue
            }
            if (f.state !== 'file') {
                problems.push({ kind: 'one-sided', subject: e, message: `${name(e)}: ${file} does not exist — sync-peers has not written it, so ${pairText} cannot ${field === 'sshKey' ? `log in to ${e}` : `verify the peer host key on ${e}`}` })
                continue
            }
            const parsed = f.lines.map(l => ({ l, p: parse(l) }))
            for (const { l, p } of parsed) {
                if (!p) { problems.push({ kind: 'foreign-id', subject: e, message: `${name(e)}: ${file} has a line that is not a sync-peers ${what}: '${l.slice(0, 120)}'` }); continue }
                if (isIdea02(p.id, store.engines[p.id])) problems.push({ kind: 'foreign-id', subject: e, message: `${name(e)}: ${file} holds a ${what} for idea02 (Engine ${p.id}) — never idea02` })
                else if (!poolLive.has(p.id)) problems.push({ kind: 'foreign-id', subject: e, message: `${name(e)}: ${file} holds a ${what} for Engine ${p.id}, which is not a pool engine` })
            }
            for (const o of peersOf) {
                const oLive = store.liveIdOf[o]
                const oKeys = keys.get(o)
                if (!oLive || !oKeys) continue
                const hits = parsed.filter(x => x.p?.id === oLive)
                if (!hits.length) {
                    problems.push({ kind: 'one-sided', subject: `${e}↔${o}`, message: `${e}↔${o}: ${name(e)} ${file} has no ${what} for ${o} (Engine ${oLive}) — ${field === 'sshKey' ? `${o} → ${e} copies cannot log in` : `${e} → ${o} copies cannot verify ${o}'s host key`}` })
                } else if (!hits.some(x => x.p?.key === oKeys[field])) {
                    problems.push({
                        kind: 'fingerprint-mismatch', subject: `${e}↔${o}`,
                        message: `${e}↔${o}: ${name(e)} ${file} has ${o}'s ${what} as ${hits.map(x => fpOrBad(x.p?.key)).join(', ')} but ${o} publishes ${keyFingerprint(oKeys[field])}`,
                    })
                }
            }
        }
        if (live === undefined) notes.push(`${name(e)}: no live engine id mapping`)
    }

    for (const r of pairs) {
        r.ok = !problems.some(x => x.subject === `${r.a}↔${r.b}` || x.subject === `${r.b}↔${r.a}` || x.subject === r.a || x.subject === r.b)
    }
    const ok = problems.length === 0
    const summary = pairs.map(r => `${r.a}${r.hostA ? `(${r.hostA})` : ''}↔${r.b}${r.hostB ? `(${r.hostB})` : ''} ${at(r.steps)}`).join('; ')
    const message = ok
        ? `peer preflight OK (${describeCopySteps(plan)}; from step ${plan.fromStep}): keys published and mutually accepted for ${summary}`
        : `peer preflight FAILED (${describeCopySteps(plan)}; from step ${plan.fromStep}): ${problems.map(p => `[${p.kind}] ${p.message}`).join(' | ')}`
    return { ok, skipped: false, pairs, problems, notes, message }
}
