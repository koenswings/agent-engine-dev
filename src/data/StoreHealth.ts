/**
 * engine#567: startup guard for the Automerge documents in store-data.
 *
 * Before a document is opened, every chunk file under <doc>/snapshot and
 * <doc>/incremental is checked:
 *   - 0 bytes                          -> bad ('empty')
 *   - not a sequence of whole Automerge chunks (magic bytes, length, SHA-256 checksum
 *     of document and change chunks) AND it does not decode -> bad ('corrupt')
 * Bad chunk files are moved to the quarantine folder next to the store (never deleted).
 * The caller then opens the document from the good chunks, or, when none are left,
 * from store-template.json (read only) under the same document ID.
 *
 * After loading, validateStoreShape checks the top-level maps of the template.
 * Nothing here ever writes a map into the document: a missing map is restored only
 * by merging the template (the shared genesis), never by assigning `{}`.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { next as A } from '@automerge/automerge'
import { log } from '../utils/utils.js'
import { quarantineFile, QuarantinedFile } from './StoreQuarantine.js'

/** The top-level maps store-template.json creates; every valid store doc has them. */
export const REQUIRED_STORE_MAPS = ['engineDB', 'diskDB', 'appDB', 'instanceDB'] as const

const MAGIC = [0x85, 0x6f, 0x4a, 0x83]

const readUleb = (b: Uint8Array, o: number): [number, number] | null => {
    let result = 0, shift = 0, i = o
    while (i < b.length && shift < 49) {
        const x = b[i++]
        result += (x & 0x7f) * 2 ** shift
        shift += 7
        if (!(x & 0x80)) return [result, i]
    }
    return null
}

/**
 * Structural check of a chunk file: whole chunks only, checksums of document (0)
 * and change (1) chunks verified. Compressed (2) and unknown types are length-checked only.
 * Returns null when it looks fine, else the reason.
 */
export const chunkStructureProblem = (b: Uint8Array): string | null => {
    if (b.length === 0) return 'empty'
    let o = 0
    while (o < b.length) {
        if (o + 9 > b.length) return 'truncated header'
        for (let i = 0; i < 4; i++) if (b[o + i] !== MAGIC[i]) return 'bad magic bytes'
        const type = b[o + 8]
        const len = readUleb(b, o + 9)
        if (!len) return 'truncated length'
        const [size, dataStart] = len
        const end = dataStart + size
        if (end > b.length) return 'truncated chunk'
        if (type === 0 || type === 1) {
            const sum = crypto.createHash('sha256').update(b.subarray(o + 8, end)).digest()
            for (let i = 0; i < 4; i++) if (sum[i] !== b[o + 4 + i]) return 'checksum mismatch'
        }
        o = end
    }
    return null
}

/** Decodes on its own? (the final word when the structural check objects) */
const decodes = (b: Uint8Array): boolean => {
    try { A.loadIncremental(A.init(), b); return true } catch { return false }
}

/** Why the chunk file is unusable, or null when it is usable. */
export const chunkProblem = (b: Uint8Array): string | null => {
    if (b.length === 0) return 'empty (0-byte) chunk'
    const structural = chunkStructureProblem(b)
    if (!structural) return null
    return decodes(b) ? null : `corrupt chunk (${structural}, does not decode)`
}

/** <store-data>/<first 2 id chars>/<rest> (NodeFS layout). */
export const docDirFor = (dataDir: string, docId: string): string =>
    path.join(dataDir, docId.slice(0, 2), docId.slice(2))

export interface DocChunkReport {
    docId: string
    /** Usable chunk files left after the check */
    good: string[]
    quarantined: QuarantinedFile[]
}

const chunkFiles = (docDir: string): string[] => {
    const out: string[] = []
    for (const kind of ['snapshot', 'incremental']) {
        const d = path.join(docDir, kind)
        let names: string[] = []
        try { names = fs.readdirSync(d) } catch { continue }
        for (const n of names) {
            if (n.startsWith('.')) continue
            const p = path.join(d, n)
            try { if (fs.statSync(p).isFile()) out.push(p) } catch { /* vanished */ }
        }
    }
    return out.sort()
}

/** Check every chunk file of a document; move the unusable ones to quarantine. */
export const quarantineBadChunks = async (dataDir: string, docId: string): Promise<DocChunkReport> => {
    const report: DocChunkReport = { docId, good: [], quarantined: [] }
    for (const file of chunkFiles(docDirFor(dataDir, docId))) {
        let bytes: Uint8Array
        try { bytes = fs.readFileSync(file) } catch { continue }
        const problem = chunkProblem(bytes)
        if (!problem) { report.good.push(file); continue }
        const q = await quarantineFile(dataDir, file, problem)
        if (q) report.quarantined.push(q)
    }
    if (report.quarantined.length > 0) {
        log(`[store-health] ${docId}: ${report.quarantined.length} bad chunk file(s) quarantined, ${report.good.length} usable left (engine#567)`)
    }
    return report
}

/** Move every chunk file of a document to quarantine (when the good chunks still do not make a valid doc). */
export const quarantineAllChunks = async (dataDir: string, docId: string, reason: string): Promise<QuarantinedFile[]> => {
    const out: QuarantinedFile[] = []
    for (const file of chunkFiles(docDirFor(dataDir, docId))) {
        const q = await quarantineFile(dataDir, file, reason)
        if (q) out.push(q)
    }
    return out
}

/** The required top-level maps that are missing or not plain objects (empty list: valid). */
export const missingStoreMaps = (doc: unknown): string[] => {
    const d = doc as Record<string, unknown> | null | undefined
    return REQUIRED_STORE_MAPS.filter(k => {
        const v = d?.[k]
        return !v || typeof v !== 'object' || Array.isArray(v)
    })
}

/** What the startup guard did to the store document (published on this Engine's entry). */
export interface StoreSelfHeal {
    at: number
    /** 'chunks': loaded from the usable chunks; 'template': rebuilt from store-template.json; 'template-merge': template merged into the loaded doc */
    source: 'chunks' | 'template' | 'template-merge'
    reason: string
    quarantined: number
    quarantineDir: string | null
}

/** Write the self-heal on this Engine's own entry (never creates engineDB or the entry). */
export const publishStoreSelfHeal = (storeHandle: { change: (fn: (doc: any) => void) => void }, engineId: string, heal: StoreSelfHeal): boolean => {
    let done = false
    storeHandle.change((doc: any) => {
        const eng = doc?.engineDB?.[engineId]
        if (!eng) return
        eng.lastStoreSelfHeal = { ...heal }
        done = true
    })
    return done
}
