/**
 * Operators.ts — Engine-local operator accounts (engine#582, idea#372).
 *
 * <authFolder>/operators.json, 0600, written atomically:
 *   { version: 1, importedFromStore: { at, count } | null, operators: OperatorRecord[] }
 *
 * The file is created on the first start of a build with Engine sign-in. If the
 * synced store still has `userDB` entries with a well-formed bcrypt hash, they are
 * imported then, once; later `userDB` changes are never imported. Hashes are never
 * logged. The synced `userDB` itself is left alone (older builds still use it).
 */

import fs from 'fs'
import crypto from 'crypto'
import type { Store } from './Store.js'
import { authFile, writeAuthFileAtomic } from './AuthFolder.js'
import { authFolder } from './Config.js'
import { log } from '../utils/utils.js'

export const OPERATORS_FILE = 'operators.json'

export interface OperatorRecord {
    id: string
    username: string
    passwordHash: string
    role: 'operator'
    created: number
}

export interface OperatorsFile {
    version: 1
    importedFromStore: { at: number, count: number } | null
    operators: OperatorRecord[]
}

/** A bcrypt hash with any cost 04–31 (imports keep theirs). */
export const BCRYPT_HASH_RE = /^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/
/** Hashes the Console sends for new or changed passwords: cost 10–12. */
export const NEW_HASH_RE = /^\$2[aby]\$(1[0-2])\$[./A-Za-z0-9]{53}$/

export const isBcryptHash = (h: unknown): h is string => typeof h === 'string' && BCRYPT_HASH_RE.test(h)
export const isAcceptableNewHash = (h: unknown): h is string => typeof h === 'string' && NEW_HASH_RE.test(h)
/** The 29-character salt prefix of a bcrypt hash ($2b$10$ + 22 characters). */
export const saltOf = (hash: string): string => hash.slice(0, 29)
export const costOf = (hash: string): number => Number(hash.slice(4, 6))

/** Usernames: 1–64 characters, no control characters, no leading/trailing space. */
export const validUsername = (u: unknown): u is string =>
    typeof u === 'string' && u.length >= 1 && u.length <= 64 && u === u.trim() && !/[\u0000-\u001f\u007f]/.test(u)

export const newOperatorId = (): string => `user-${Date.now()}-${crypto.randomBytes(4).toString('hex').slice(0, 6)}`

const fileOf = (dir?: string): string => authFile(OPERATORS_FILE, dir ?? authFolder())

/** The operators file, or null when it does not exist yet. Throws on a corrupt file. */
export const readOperatorsFile = (dir?: string): OperatorsFile | null => {
    let text: string
    try { text = fs.readFileSync(fileOf(dir), 'utf8') } catch (e: any) {
        if (e?.code === 'ENOENT') return null
        throw e
    }
    const j = JSON.parse(text)
    if (!j || j.version !== 1 || !Array.isArray(j.operators)) throw new Error(`${OPERATORS_FILE}: unknown format`)
    return {
        version: 1,
        importedFromStore: j.importedFromStore ?? null,
        operators: j.operators.filter((o: any) => o && validUsername(o.username) && isBcryptHash(o.passwordHash) && typeof o.id === 'string')
            .map((o: any) => ({ id: o.id, username: o.username, passwordHash: o.passwordHash, role: 'operator', created: Number(o.created) || 0 })),
    }
}

export const writeOperatorsFile = (f: OperatorsFile, dir?: string): void => {
    writeAuthFileAtomic(fileOf(dir), JSON.stringify(f, null, 2) + '\n')
}

/** The operators, [] when the file does not exist. */
export const listOperators = (dir?: string): OperatorRecord[] => readOperatorsFile(dir)?.operators ?? []

export const findOperatorByUsername = (username: string, dir?: string): OperatorRecord | null =>
    listOperators(dir).find(o => o.username === username) ?? null

/**
 * First start with Engine sign-in: create operators.json, importing the synced
 * store's userDB entries that have a well-formed bcrypt hash. Does nothing when the
 * file already exists. Returns what happened.
 */
export const importOperatorsOnce = (store: Store | null | undefined, dir?: string, now: number = Date.now()):
    { created: boolean, imported: string[] } => {
    if (readOperatorsFile(dir)) return { created: false, imported: [] }
    const seen = new Set<string>()
    const operators: OperatorRecord[] = []
    for (const u of Object.values((store as any)?.userDB ?? {}) as any[]) {
        const username = u?.username != null ? String(u.username) : ''
        const hash = u?.passwordHash != null ? String(u.passwordHash) : ''
        if (!validUsername(username) || !isBcryptHash(hash) || seen.has(username)) continue
        seen.add(username)
        operators.push({
            id: typeof u.id === 'string' && u.id ? String(u.id) : newOperatorId(),
            username, passwordHash: hash, role: 'operator', created: Number(u.created) || now,
        })
    }
    writeOperatorsFile({ version: 1, importedFromStore: { at: now, count: operators.length }, operators }, dir)
    const names = operators.map(o => o.username)
    log(`[auth] operator accounts are now kept on this Engine: imported ${names.length} from the store${names.length ? ` (${names.join(', ')})` : ''}`)
    return { created: true, imported: names }
}

export class OperatorError extends Error {
    constructor(public code: 'OPERATOR_EXISTS' | 'OPERATOR_UNKNOWN' | 'LAST_OPERATOR' | 'BAD_REQUEST', message: string) { super(message) }
}

const mutate = (dir: string | undefined, fn: (f: OperatorsFile) => void): void => {
    const f = readOperatorsFile(dir) ?? { version: 1 as const, importedFromStore: null, operators: [] }
    fn(f)
    writeOperatorsFile(f, dir)
}

export const addOperator = (username: string, passwordHash: string, dir?: string, now: number = Date.now()): OperatorRecord => {
    if (!validUsername(username)) throw new OperatorError('BAD_REQUEST', 'Username must be 1–64 characters without control characters.')
    if (!isAcceptableNewHash(passwordHash)) throw new OperatorError('BAD_REQUEST', 'passwordHash must be a bcrypt hash with cost 10 to 12.')
    let rec!: OperatorRecord
    mutate(dir, f => {
        if (f.operators.some(o => o.username === username)) throw new OperatorError('OPERATOR_EXISTS', `Operator '${username}' already exists on this Engine.`)
        rec = { id: newOperatorId(), username, passwordHash, role: 'operator', created: now }
        f.operators.push(rec)
    })
    return rec
}

export const removeOperator = (id: string, dir?: string): void => {
    mutate(dir, f => {
        const i = f.operators.findIndex(o => o.id === id)
        if (i === -1) throw new OperatorError('OPERATOR_UNKNOWN', `No operator '${id}' on this Engine.`)
        if (f.operators.length === 1) throw new OperatorError('LAST_OPERATOR', 'The last operator cannot be removed.')
        f.operators.splice(i, 1)
    })
}

export const setOperatorHash = (username: string, passwordHash: string, dir?: string): void => {
    if (!isAcceptableNewHash(passwordHash)) throw new OperatorError('BAD_REQUEST', 'passwordHash must be a bcrypt hash with cost 10 to 12.')
    mutate(dir, f => {
        const o = f.operators.find(x => x.username === username)
        if (!o) throw new OperatorError('OPERATOR_UNKNOWN', `No operator '${username}' on this Engine.`)
        o.passwordHash = passwordHash
    })
}

/** Set (or create) an operator's hash from the local CLI: any well-formed bcrypt hash. */
export const upsertOperatorHash = (username: string, passwordHash: string, dir?: string, now: number = Date.now()): 'created' | 'updated' => {
    if (!validUsername(username)) throw new OperatorError('BAD_REQUEST', 'Bad username.')
    if (!isBcryptHash(passwordHash)) throw new OperatorError('BAD_REQUEST', 'Bad hash.')
    let what: 'created' | 'updated' = 'updated'
    mutate(dir, f => {
        const o = f.operators.find(x => x.username === username)
        if (o) o.passwordHash = passwordHash
        else { f.operators.push({ id: newOperatorId(), username, passwordHash, role: 'operator', created: now }); what = 'created' }
    })
    return what
}
