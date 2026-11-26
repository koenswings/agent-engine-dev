/**
 * CommandKey.ts — per-Engine command key and signed queue entries (engine#582).
 *
 * <authFolder>/command-key: 32 random bytes (0600), made at first start, never
 * synced, logged, backed up or copied. Each Engine is the only signer and the only
 * verifier of its own queue (engineDB[<self>].commands).
 *
 * Entry format (still a plain string in Engine.commands):
 *   @v1.<seq>.<src>.<mac> <command text>
 *   mac = base64url(HMAC-SHA256(commandKey, "idea-cmd-v1\n" + engineId + "\n" + seq + "\n" + src + "\n" + commandText))
 *   src = op-<session8> | peer-<engineId> | cli | engine
 *
 * seq: a per-Engine counter in <authFolder>/command-seq; a new counter starts at the
 * wall-clock milliseconds when it is created (then +1), so it stays unique across a
 * reimage. Replay guard: <authFolder>/command-done keeps the seqs already run above
 * maxIssued − REPLAY_WINDOW; a seq run before, or below that window, is refused
 * (COMMAND_REPLAYED). A seq is marked done when it starts, so a command that was
 * running when the Engine stopped is not run again by the startup replay.
 */

import crypto from 'crypto'
import fs from 'fs'
import { authFile, writeAuthFileAtomic, ensureAuthFolder } from './AuthFolder.js'
import { authFolder } from './Config.js'

export const COMMAND_KEY_FILE = 'command-key'
export const COMMAND_SEQ_FILE = 'command-seq'
export const COMMAND_DONE_FILE = 'command-done'
export const REPLAY_WINDOW = 4096

export const COMMAND_UNSIGNED = 'COMMAND_UNSIGNED'
export const COMMAND_SIGNATURE_INVALID = 'COMMAND_SIGNATURE_INVALID'
export const COMMAND_REPLAYED = 'COMMAND_REPLAYED'

export const UNSIGNED_MESSAGE = "Refused: this Engine only runs commands from a signed-in operator. Open this Engine's own Console to sign in."

const keyCache = new Map<string, Buffer>()

/** The command key of auth folder `dir`, created when missing. */
export const commandKey = (dir: string = authFolder()): Buffer => {
    const hit = keyCache.get(dir)
    if (hit) return hit
    const file = authFile(COMMAND_KEY_FILE, dir)
    let key: Buffer | null = null
    try { const b = fs.readFileSync(file); if (b.length === 32) key = b } catch { /* missing */ }
    if (!key) { key = crypto.randomBytes(32); writeAuthFileAtomic(file, key) }
    keyCache.set(dir, key)
    return key
}

/** Tests only. */
export const clearCommandKeyCacheForTests = (): void => { keyCache.clear(); doneCache.clear() }

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Run `fn` holding <file>.lock (the local CLI may issue seqs too). */
const withLock = <T>(file: string, fn: () => T): T => {
    const lock = `${file}.lock`
    const until = Date.now() + 2000
    for (;;) {
        try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); break } catch (e: any) {
            if (e?.code !== 'EEXIST') throw e
            try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.renameSync(lock, `${lock}.stale`) } catch { /* raced */ }
            if (Date.now() > until) throw new Error('command-seq is locked')
            sleepSync(5)
        }
    }
    try { return fn() } finally { try { fs.unlinkSync(lock) } catch { /* gone */ } }
}

const readSeq = (file: string): number | null => {
    try {
        const n = Number(fs.readFileSync(file, 'utf8').trim())
        return Number.isSafeInteger(n) && n > 0 ? n : null
    } catch { return null }
}

/** Highest seq issued so far (creates the counter when missing). */
export const maxIssuedSeq = (dir: string = authFolder()): number => {
    const file = authFile(COMMAND_SEQ_FILE, ensureAuthFolder(dir))
    const n = readSeq(file)
    if (n !== null) return n
    return withLock(file, () => {
        const again = readSeq(file)
        if (again !== null) return again
        const start = Date.now()
        writeAuthFileAtomic(file, String(start) + '\n')
        return start
    })
}

/** Issue the next seq. */
export const nextSeq = (dir: string = authFolder()): number => {
    const file = authFile(COMMAND_SEQ_FILE, ensureAuthFolder(dir))
    return withLock(file, () => {
        const cur = readSeq(file) ?? Date.now() - 1
        const next = cur + 1
        writeAuthFileAtomic(file, String(next) + '\n')
        return next
    })
}

export type EntrySource = string   // op-<session8> | peer-<engineId> | cli | engine
const SRC_RE = /^(op-[0-9a-f]{8}|peer-[A-Za-z0-9_-]{1,80}|cli|engine)$/

export const entryMac = (key: Buffer, engineId: string, seq: number, src: string, command: string): string =>
    crypto.createHmac('sha256', key).update(`idea-cmd-v1\n${engineId}\n${seq}\n${src}\n${command}`).digest('base64url')

/** Sign `command` for this Engine's own queue. */
export const signEntry = (command: string, src: EntrySource, engineId: string, dir: string = authFolder()): { entry: string, seq: number } => {
    if (!SRC_RE.test(src)) throw new Error(`bad entry source '${src}'`)
    const seq = nextSeq(dir)
    return { entry: `@v1.${seq}.${src}.${entryMac(commandKey(dir), engineId, seq, src, command)} ${command}`, seq }
}

export interface ParsedEntry { seq: number, src: string, mac: string, command: string }
const ENTRY_RE = /^@v1\.([0-9]{1,16})\.([A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)?)\.([A-Za-z0-9_-]{43}) ([\s\S]*)$/

/** Parse a signed entry; null when it has no readable @v1 prefix. */
export const parseEntry = (raw: string): ParsedEntry | null => {
    const m = ENTRY_RE.exec(raw)
    if (!m) return null
    const seq = Number(m[1])
    if (!Number.isSafeInteger(seq)) return null
    return { seq, src: m[2], mac: m[3], command: m[4] }
}

// ── replay guard ────────────────────────────────────────────────────────────
const doneCache = new Map<string, Set<number>>()
const doneSet = (dir: string): Set<number> => {
    let s = doneCache.get(dir)
    if (s) return s
    s = new Set()
    try {
        const j = JSON.parse(fs.readFileSync(authFile(COMMAND_DONE_FILE, dir), 'utf8'))
        if (Array.isArray(j)) for (const n of j) if (Number.isSafeInteger(n)) s.add(n)
    } catch { /* none yet */ }
    doneCache.set(dir, s)
    return s
}

/** Record `seq` as run (persisted, pruned to the window). */
export const markSeqDone = (seq: number, dir: string = authFolder()): void => {
    const s = doneSet(dir)
    s.add(seq)
    const floor = maxIssuedSeq(dir) - REPLAY_WINDOW
    for (const n of s) if (n <= floor) s.delete(n)
    writeAuthFileAtomic(authFile(COMMAND_DONE_FILE, dir), JSON.stringify([...s].sort((a, b) => a - b)))
}

export type EntryCheck =
    | { ok: true, seq: number, src: string, command: string }
    | { ok: false, code: typeof COMMAND_UNSIGNED | typeof COMMAND_SIGNATURE_INVALID | typeof COMMAND_REPLAYED, seq: number | null, src: string | null, command: string, message: string }

/** Check a raw queue entry of this Engine's own queue. Does not mark it done. */
export const verifyEntry = (raw: string, engineId: string, dir: string = authFolder()): EntryCheck => {
    const p = parseEntry(raw)
    if (!p) return { ok: false, code: COMMAND_UNSIGNED, seq: null, src: null, command: raw, message: UNSIGNED_MESSAGE }
    const want = Buffer.from(entryMac(commandKey(dir), engineId, p.seq, p.src, p.command))
    const got = Buffer.from(p.mac)
    if (!SRC_RE.test(p.src) || want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
        return { ok: false, code: COMMAND_SIGNATURE_INVALID, seq: p.seq, src: p.src, command: p.command,
            message: 'Refused: this command was not signed by this Engine (copied from another Engine, or changed). Send it again from a signed-in Console.' }
    }
    const max = maxIssuedSeq(dir)
    if (doneSet(dir).has(p.seq) || p.seq <= max - REPLAY_WINDOW || p.seq > max) {
        return { ok: false, code: COMMAND_REPLAYED, seq: p.seq, src: p.src, command: p.command,
            message: 'Refused: this command already ran (or is too old). Send it again from a signed-in Console.' }
    }
    return { ok: true, seq: p.seq, src: p.src, command: p.command }
}

/** The command text of a queue entry, signed or not (for display and read-only checks). */
export const entryCommandText = (raw: string): string => parseEntry(raw)?.command ?? raw

/**
 * A queue entry for the Engine log: the seq and source of a signed entry and its command text,
 * never the mac. An entry with an unreadable @v1 prefix is shown without that prefix.
 */
export const entryLogText = (raw: string): string => {
    const p = parseEntry(raw)
    if (p) return `[seq ${p.seq}, src ${p.src}] ${p.command}`
    if (raw.startsWith('@v1.')) return `[unreadable signature] ${raw.replace(/^@v1\.\S*\s?/, '')}`
    return raw
}
