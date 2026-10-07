/**
 * PeerAccess.ts — per-Pi Engine keys, exchanged through the store
 * (design-per-pi-engine-key.md; Koen's decision 2026-10-06).
 *
 * 1. At start, this Engine makes its own ed25519 key if it has none
 *    (/home/pi/.ssh/idea_engine_ed25519, pi 0600) and publishes the public key and
 *    its ssh host key in its Engine entry (Engine.peerAccess). The image and
 *    install.sh stay key-free. The heartbeat re-publishes the entry if it went
 *    missing (store reset) or a key file changed (reimage, host key rotation).
 * 2. On every Engine-entry change (debounced) and on the heartbeat, it computes the
 *    FULL peer set — every other Engine in THIS Engine's store document with a
 *    well-formed peerAccess and a heartbeat in the last 7 days — and hands it to
 *    `sudo -n idea-app-data sync-peers` (stdin). The helper validates every line,
 *    adds the restrict,command="idea-peer-gate <engineId>" prefix itself and swaps
 *    in /etc/ssh/idea_authorized_keys/pi and /etc/idea/peer_known_hosts atomically.
 *    An Engine whose entry is deleted or whose heartbeat is older than 7 days drops
 *    out of the set, so its key is removed. Then it lists what it authorized in
 *    peerAccess.authorized, so a sender can see it has been accepted.
 * 3. Every key change of a peer (added, removed, ssh key or host key changed) is
 *    logged loudly.
 *
 * Trust: anything that can write the store can already make an Engine run
 * commands (engineDB[x].commands), so taking keys from the store opens no new
 * door; the gate limits what a peer key can do (receive into a new folder,
 * ensure-dirs, version, delete only of folders that peer's receive created).
 *
 * Fail closed: when store-url.txt was missing and the Engine wrote back the fleet
 * store URL (StoreIdentity), this Engine does not know it is in the right store:
 * it publishes no key (peerAccess = null), authorizes nobody (sync-peers with the
 * empty set) and says so loudly until Ops confirms the store.
 */

import { DocHandle } from '@automerge/automerge-repo'
import { spawn } from 'child_process'
import { fs, chalk } from 'zx'
import path from 'path'
import { print } from '../utils/utils.js'
import type { Store } from './Store.js'
import type { Engine, PeerAccess } from './Engine.js'
import type { Timestamp } from './CommonTypes.js'
import { AppDataInputRunner, runAppDataWithInput } from '../utils/appDataHelper.js'
import {
    PEER_KEY_PATH, HOST_KEY_PUB, ENGINE_ID_RE,
    normaliseEd25519, keyFingerprint,
} from '../utils/peerSsh.js'

/** A peer whose last heartbeat (Engine.lastRun) is older than this is dropped. */
export const PEER_STALE_MS = 7 * 24 * 60 * 60 * 1000
/** Engine-entry changes are synced after this quiet time. */
export const PEER_SYNC_DEBOUNCE_MS = 5000
/** The helper refuses more lines than this; the Engine never sends more. */
export const PEER_SET_MAX = 256

// ── Pure parts ───────────────────────────────────────────────────────────────

export interface PeerLine { engineId: string, sshKey: string, hostKey: string }
export interface SkippedPeer { engineId: string, reason: string }

/** '<engineId> <sshKey fingerprint> <hostKey fingerprint>' (Engine.peerAccess.authorized) */
export const authorizedEntry = (engineId: string, keys: { sshKey: string, hostKey: string }): string =>
    `${engineId} ${keyFingerprint(keys.sshKey)} ${keyFingerprint(keys.hostKey)}`

const ageText = (ms: number): string => {
    const h = Math.floor(ms / 3_600_000)
    return h >= 48 ? `${Math.floor(h / 24)} days` : `${h} hours`
}

/**
 * The full peer set for this Engine: every OTHER Engine in the store with a
 * well-formed peerAccess and a heartbeat within `staleMs`. Engines that share a
 * key (a cloned SD card) are all left out. Sorted by Engine id, at most 256.
 */
export const computePeerSet = (store: Store, localEngineId: string, now: number, staleMs: number = PEER_STALE_MS): { peers: PeerLine[], skipped: SkippedPeer[] } => {
    const skipped: SkippedPeer[] = []
    let peers: PeerLine[] = []
    const ownKey = normaliseEd25519((store.engineDB as any)?.[localEngineId]?.peerAccess?.sshKey)
    for (const [engineId, eng] of Object.entries(store.engineDB ?? {}) as [string, Engine][]) {
        if (engineId === String(localEngineId)) continue
        const pa = eng?.peerAccess
        if (!pa) continue   // older Engine, or peer access off there: nothing to authorize
        if (!ENGINE_ID_RE.test(engineId)) { skipped.push({ engineId, reason: `its Engine id is not one the peer files accept (${ENGINE_ID_RE})` }); continue }
        if (eng.id && String(eng.id) !== engineId) { skipped.push({ engineId, reason: `its id field '${eng.id}' differs from its key` }); continue }
        const sshKey = normaliseEd25519(pa.sshKey)
        const hostKey = normaliseEd25519(pa.hostKey)
        if (!sshKey) { skipped.push({ engineId, reason: 'its published sshKey is not one ed25519 public key' }); continue }
        if (!hostKey) { skipped.push({ engineId, reason: 'its published hostKey is not one ed25519 public key' }); continue }
        const lastRun = Number(eng.lastRun)
        if (!Number.isFinite(lastRun) || now - lastRun > staleMs) {
            skipped.push({ engineId, reason: Number.isFinite(lastRun) ? `stale: no heartbeat for ${ageText(now - lastRun)}` : 'stale: no heartbeat recorded' })
            continue
        }
        if (ownKey && sshKey === ownKey) { skipped.push({ engineId, reason: 'it publishes THIS Engine\'s own key (cloned key file?)' }); continue }
        peers.push({ engineId, sshKey, hostKey })
    }
    // A key published by two Engines: neither is trusted (cloned key file)
    const byKey = new Map<string, string[]>()
    for (const p of peers) byKey.set(p.sshKey, [...(byKey.get(p.sshKey) ?? []), p.engineId])
    peers = peers.filter(p => {
        const ids = byKey.get(p.sshKey)!
        if (ids.length === 1) return true
        skipped.push({ engineId: p.engineId, reason: `it shares its key with ${ids.filter(i => i !== p.engineId).join(', ')} (cloned key file?)` })
        return false
    })
    peers.sort((a, b) => (a.engineId < b.engineId ? -1 : a.engineId > b.engineId ? 1 : 0))
    if (peers.length > PEER_SET_MAX) {
        for (const p of peers.slice(PEER_SET_MAX)) skipped.push({ engineId: p.engineId, reason: `more than ${PEER_SET_MAX} peers` })
        peers = peers.slice(0, PEER_SET_MAX)
    }
    return { peers, skipped }
}

/** stdin for `idea-app-data sync-peers`: one '<engineId> <sshKey> <hostKey>' line per peer. */
export const peerSetInput = (peers: PeerLine[]): string =>
    peers.map(p => `${p.engineId} ${p.sshKey} ${p.hostKey}\n`).join('')

/** The key changes between two peer sets, as log lines. */
export const describePeerChanges = (before: PeerLine[], after: PeerLine[], skipped: SkippedPeer[] = []): string[] => {
    const lines: string[] = []
    const prev = new Map(before.map(p => [p.engineId, p]))
    const next = new Map(after.map(p => [p.engineId, p]))
    const why = new Map(skipped.map(s => [s.engineId, s.reason]))
    for (const p of after) {
        const o = prev.get(p.engineId)
        if (!o) { lines.push(`peer key added: Engine ${p.engineId} (key ${keyFingerprint(p.sshKey)}, host key ${keyFingerprint(p.hostKey)})`); continue }
        if (o.sshKey !== p.sshKey) lines.push(`PEER KEY CHANGED: Engine ${p.engineId} ssh key ${keyFingerprint(o.sshKey)} -> ${keyFingerprint(p.sshKey)}`)
        if (o.hostKey !== p.hostKey) lines.push(`PEER HOST KEY CHANGED: Engine ${p.engineId} host key ${keyFingerprint(o.hostKey)} -> ${keyFingerprint(p.hostKey)}`)
    }
    for (const o of before) {
        if (!next.has(o.engineId)) lines.push(`peer key removed: Engine ${o.engineId} (key ${keyFingerprint(o.sshKey)}): ${why.get(o.engineId) ?? 'its Engine entry or peer key is gone'}`)
    }
    return lines
}

const engineName = (store: Store, engineId: string): string => {
    const h = (store.engineDB as any)?.[engineId]?.hostname
    return h ? `'${h}' (${engineId})` : `'${engineId}'`
}

/**
 * Why a cross-Engine copy from this Engine to `targetEngineId` cannot run yet, or
 * null when both sides have exchanged keys: the target lists this Engine's CURRENT
 * keys in peerAccess.authorized (it accepts this Engine's key) and this Engine lists
 * the target's (it has pinned the target's host key).
 */
export const peerCopyRefusal = (store: Store, localEngineId: string, targetEngineId: string, localProblem: string | null = null): string | null => {
    const local = (store.engineDB as any)?.[localEngineId] as Engine | undefined
    const target = (store.engineDB as any)?.[targetEngineId] as Engine | undefined
    const tname = engineName(store, targetEngineId)
    if (localProblem) return `Cross-Engine copy is off on this Engine: ${localProblem}`
    if (!local?.peerAccess || !normaliseEd25519(local.peerAccess.sshKey) || !normaliseEd25519(local.peerAccess.hostKey)) {
        return `This Engine has not published its Engine key yet, so no other Engine accepts its copies. It is published at start; check the Engine log for 'peer access'.`
    }
    if (!target?.peerAccess || !normaliseEd25519(target.peerAccess.sshKey) || !normaliseEd25519(target.peerAccess.hostKey)) {
        return `Engine ${tname} has not published an Engine key (it runs an older Engine, or peer access is off there). Cross-Engine copy to it is not possible until it does.`
    }
    const mine = authorizedEntry(localEngineId, local.peerAccess)
    if (!(target.peerAccess.authorized ?? []).includes(mine)) {
        return `Engine ${tname} has not accepted this Engine's key yet (Engines add each other's keys within a minute of seeing them in the store). Try again in a minute.`
    }
    const theirs = authorizedEntry(targetEngineId, target.peerAccess)
    if (!(local.peerAccess.authorized ?? []).includes(theirs)) {
        return `This Engine has not pinned the host key of Engine ${tname} yet (it adds peer keys within a minute of seeing them in the store). Try again in a minute.`
    }
    return null
}

// ── This Engine's key files ──────────────────────────────────────────────────

const execFile = (cmd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', (c: Buffer) => { out += c })
    proc.stderr.on('data', (c: Buffer) => { err += c })
    proc.on('error', e => reject(new Error(`${cmd}: ${e.message}`)))
    proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}: ${err.trim()}`)))
})

/**
 * This Engine's public Engine key; makes the key pair first if there is none
 * (`ssh-keygen -t ed25519`, no passphrase, mode 0600 in a 0700 folder).
 */
export const ensurePeerKey = async (engineId: string, keyPath: string = PEER_KEY_PATH, keygen = 'ssh-keygen'): Promise<{ sshKey: string, created: boolean }> => {
    let created = false
    const dir = path.dirname(keyPath)
    if (!await fs.pathExists(dir)) {
        await fs.ensureDir(dir)
        await fs.chmod(dir, 0o700)
    }
    if (!await fs.pathExists(keyPath)) {
        await fs.remove(`${keyPath}.pub`)
        print(chalk.yellow(`peer access: no Engine key at ${keyPath}; making a new ed25519 key`))
        await execFile(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', `idea-engine-${engineId}`, '-f', keyPath])
        created = true
    }
    const st = await fs.stat(keyPath)
    if ((st.mode & 0o077) !== 0) {
        print(chalk.yellow(`peer access: ${keyPath} had mode 0${(st.mode & 0o777).toString(8)}; setting 0600`))
        await fs.chmod(keyPath, 0o600)
    }
    let pub = (await fs.pathExists(`${keyPath}.pub`)) ? await fs.readFile(`${keyPath}.pub`, 'utf8') : ''
    if (!normaliseEd25519(pub)) {
        pub = await execFile(keygen, ['-y', '-f', keyPath])
        await fs.writeFile(`${keyPath}.pub`, pub.trim() + ` idea-engine-${engineId}\n`, { mode: 0o644 })
    }
    const sshKey = normaliseEd25519(pub)
    if (!sshKey) throw new Error(`${keyPath} is not an ed25519 key; remove ${keyPath} and ${keyPath}.pub so the Engine makes a new one`)
    if (created) print(chalk.green(`peer access: made the Engine key ${keyPath} (${keyFingerprint(sshKey)})`))
    return { sshKey, created }
}

/** This Pi's ed25519 host key (public), or null when it is missing or malformed. */
export const readHostKey = async (p: string = HOST_KEY_PUB): Promise<string | null> => {
    try {
        return normaliseEd25519(await fs.readFile(p, 'utf8'))
    } catch {
        return null
    }
}

/**
 * Write (or clear, with null) this Engine's peerAccess. `authorized` is kept while
 * the keys stay the same. Logs a change of this Engine's own keys. Returns true if
 * the store changed.
 */
export const publishPeerAccess = (handle: DocHandle<Store>, localEngineId: string, keys: { sshKey: string, hostKey: string } | null, now: number = Date.now(), say: (line: string) => void = l => print(l)): boolean => {
    const cur = (handle.doc()?.engineDB as any)?.[localEngineId] as Engine | undefined
    if (!cur) return false
    const pa = cur.peerAccess
    if (keys === null) {
        if (pa === null) return false
        handle.change(doc => { (doc.engineDB as any)[localEngineId].peerAccess = null })
        return true
    }
    if (pa && pa.sshKey === keys.sshKey && pa.hostKey === keys.hostKey) return false
    if (pa?.sshKey && normaliseEd25519(pa.sshKey) && pa.sshKey !== keys.sshKey) {
        say(chalk.red(`peer access: THIS Engine's key changed: ${keyFingerprint(pa.sshKey)} -> ${keyFingerprint(keys.sshKey)} (new key file, e.g. after a reimage); peers re-authorize it from the store`))
    }
    if (pa?.hostKey && normaliseEd25519(pa.hostKey) && pa.hostKey !== keys.hostKey) {
        say(chalk.red(`peer access: THIS Engine's ssh host key changed: ${keyFingerprint(pa.hostKey)} -> ${keyFingerprint(keys.hostKey)}; peers re-pin it from the store`))
    }
    handle.change(doc => {
        const e = (doc.engineDB as any)[localEngineId]
        const authorized: string[] = pa?.authorized ? [...pa.authorized] : []
        e.peerAccess = { sshKey: keys.sshKey, hostKey: keys.hostKey, publishedAt: now as Timestamp, authorized } as PeerAccess
    })
    return true
}

// ── The controller (start, store changes, heartbeat) ─────────────────────────

export type PeerAccessMode = 'on' | 'fail-closed' | 'off'

export interface PeerAccessOptions {
    mode: PeerAccessMode
    /** why peer access is not 'on' (shown in copy refusals) */
    reason?: string
    run?: AppDataInputRunner
    now?: () => number
    staleMs?: number
    debounceMs?: number
    keyPath?: string
    hostKeyPath?: string
    keygen?: string
    logger?: (line: string) => void
}

/** The reason cross-Engine copy is off on this Engine (validate() shows it), or null. */
let localProblem: string | null = null
export const peerAccessProblem = (): string | null => localProblem
/** Tests only. */
export const setPeerAccessProblem = (p: string | null): void => { localProblem = p }

export class PeerAccessController {
    private lastInput: string | null = null
    private lastPeers: PeerLine[] = []
    private keys: { sshKey: string, hostKey: string } | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private chain: Promise<void> = Promise.resolve()
    private unsubscribe: (() => void) | null = null
    private readonly run: AppDataInputRunner
    private readonly now: () => number
    private readonly say: (line: string) => void

    constructor(private readonly handle: DocHandle<Store>, private readonly localEngineId: string, private readonly opts: PeerAccessOptions) {
        this.run = opts.run ?? runAppDataWithInput
        this.now = opts.now ?? Date.now
        this.say = opts.logger ?? ((l: string) => print(l))
    }

    get mode(): PeerAccessMode { return this.opts.mode }

    /** Make/read the key, publish it, sync once and follow Engine-entry changes. */
    async start(): Promise<void> {
        if (this.opts.mode === 'off') {
            localProblem = this.opts.reason ?? 'peer access is off on this Engine'
            this.say(`peer access: off (${localProblem}); no Engine key is made or published and peer keys are not synced`)
            return
        }
        if (this.opts.mode === 'fail-closed') {
            localProblem = this.opts.reason ?? 'this Engine is not sure it is in the right store'
            this.say(chalk.bgRed.white(`PEER ACCESS FAIL-CLOSED: ${localProblem}. This Engine publishes no Engine key and authorizes no peer.`))
            publishPeerAccess(this.handle, this.localEngineId, null, this.now(), this.say)
            await this.syncNow()
            return
        }
        localProblem = null
        await this.refreshKeys()
        await this.syncNow()
        const onChange = (ev: any) => {
            const relevant = (ev?.patches ?? []).some((p: any) => p.path?.[0] === 'engineDB' && !(
                p.path[1] === this.localEngineId && p.path[2] === 'peerAccess' && p.path[3] === 'authorized'))
            if (relevant) this.schedule()
        }
        this.handle.on('change', onChange)
        this.unsubscribe = () => this.handle.off('change', onChange)
    }

    /** Heartbeat: re-publish a missing or outdated entry (repair), then sync (stale expiry). */
    async onHeartbeat(): Promise<void> {
        if (this.opts.mode === 'off') return
        if (this.opts.mode === 'fail-closed') {
            if (publishPeerAccess(this.handle, this.localEngineId, null, this.now(), this.say)) this.say(chalk.red('peer access: removed this Engine\'s peerAccess again (fail-closed)'))
            return
        }
        await this.refreshKeys(true)
        await this.syncNow()
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        this.unsubscribe?.()
        this.unsubscribe = null
    }

    private schedule(): void {
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => { this.timer = null; this.syncNow().catch(() => undefined) }, this.opts.debounceMs ?? PEER_SYNC_DEBOUNCE_MS)
    }

    /** Re-read the key files and (re)publish when the entry is missing or differs. */
    private async refreshKeys(isHeartbeat = false): Promise<void> {
        try {
            const { sshKey } = await ensurePeerKey(this.localEngineId, this.opts.keyPath, this.opts.keygen)
            const hostKey = await readHostKey(this.opts.hostKeyPath)
            if (!hostKey) {
                localProblem = `this Pi has no readable ed25519 ssh host key (${this.opts.hostKeyPath ?? HOST_KEY_PUB})`
                this.say(chalk.red(`peer access: ${localProblem}; not publishing an Engine key`))
                publishPeerAccess(this.handle, this.localEngineId, null, this.now(), this.say)
                this.keys = null
                return
            }
            this.keys = { sshKey, hostKey }
            const before = (this.handle.doc()?.engineDB as any)?.[this.localEngineId]?.peerAccess
            if (publishPeerAccess(this.handle, this.localEngineId, this.keys, this.now(), this.say)) {
                this.say(isHeartbeat && !before
                    ? chalk.yellow(`peer access: this Engine's peerAccess was missing from the store; re-published (key ${keyFingerprint(sshKey)})`)
                    : `peer access: published this Engine's key ${keyFingerprint(sshKey)} and host key ${keyFingerprint(hostKey)}`)
            }
            localProblem = null
        } catch (e: any) {
            localProblem = `this Engine's key could not be made or read: ${e?.message ?? e}`
            this.say(chalk.red(`peer access: ${localProblem}`))
        }
    }

    /** Compute the peer set and hand it to the helper when it changed. Serialised. */
    syncNow(): Promise<void> {
        this.chain = this.chain.then(() => this.sync()).catch(e => this.say(chalk.red(`peer access: sync failed: ${e?.message ?? e}`)))
        return this.chain
    }

    private async sync(): Promise<void> {
        const store = this.handle.doc()
        if (!store) return
        const { peers, skipped } = this.opts.mode === 'on'
            ? computePeerSet(store, this.localEngineId, this.now(), this.opts.staleMs ?? PEER_STALE_MS)
            : { peers: [] as PeerLine[], skipped: [] as SkippedPeer[] }
        const input = peerSetInput(peers)
        if (input !== this.lastInput) {
            for (const s of skipped) this.say(chalk.yellow(`peer access: not authorizing Engine ${s.engineId}: ${s.reason}`))
            try {
                const out = await this.run(['sync-peers'], input)
                if (out.trim()) this.say(`peer access: ${out.trim()}`)
            } catch (e: any) {
                this.say(chalk.red(`peer access: idea-app-data sync-peers failed (${peers.length} peer(s)); retrying on the next change or heartbeat: ${e?.message ?? e}`))
                return
            }
            for (const l of describePeerChanges(this.lastInput === null ? [] : this.lastPeers, peers, skipped)) {
                this.say(/CHANGED/.test(l) ? chalk.bgRed.white(`peer access: ${l}`) : `peer access: ${l}`)
            }
            if (this.lastInput !== null && this.lastPeers.length > 0 && peers.length === 0) {
                this.say(chalk.yellow(`peer access: the peer set went from ${this.lastPeers.length} to 0 (store reset, or every peer stale/removed); keys come back as peers re-publish`))
            }
            this.lastInput = input
            this.lastPeers = peers
        }
        this.writeAuthorized(peers)
    }

    /** List what this Engine has authorized (only the helper's success changes it). */
    private writeAuthorized(peers: PeerLine[]): void {
        if (this.opts.mode !== 'on') return
        const want = peers.map(p => authorizedEntry(p.engineId, p))
        const cur = (this.handle.doc()?.engineDB as any)?.[this.localEngineId]?.peerAccess as PeerAccess | null | undefined
        if (!cur) return
        const have = [...(cur.authorized ?? [])]
        if (have.length === want.length && have.every((v, i) => v === want[i])) return
        this.handle.change(doc => {
            const pa = (doc.engineDB as any)[this.localEngineId]?.peerAccess
            if (pa) pa.authorized = want
        })
    }
}

/**
 * Start peer access for this Engine (start.ts). `fallbackStore`: store-url.txt was
 * missing and the fleet store URL was written back (fail closed).
 */
export const startPeerAccess = async (handle: DocHandle<Store>, localEngineId: string, o: { enabled: boolean, fallbackStore: boolean, storeUrlPath?: string, staleMs?: number }): Promise<PeerAccessController> => {
    const mode: PeerAccessMode = !o.enabled ? 'off' : o.fallbackStore ? 'fail-closed' : 'on'
    const reason = mode === 'off'
        ? 'peer access is off on this machine (dev container or test mode, or settings.peerAccess=false)'
        : mode === 'fail-closed'
            ? `store-url.txt was missing, so the Engine wrote back the fleet store URL and cannot tell it is in its own store. ` +
              `Check ${o.storeUrlPath ?? 'store-identity/store-url.txt'}, then delete store-identity/store-url.restored and restart the Engine`
            : undefined
    const c = new PeerAccessController(handle, localEngineId, { mode, reason, staleMs: o.staleMs })
    await c.start()
    return c
}
