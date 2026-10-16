/**
 * ClientImages.ts — IDEA client images stored on this Engine (idea#201 §10, idea#202 naming)
 *
 * Layout: <root>/<version>/idea-client-<version>.img.xz (+ .img.xz.sha256 in sha256sum format,
 * optional MANIFEST.txt). <root> = /var/lib/idea/client-images (IDEA_CLIENT_IMAGES_DIR for tests).
 * <version> = 26.04-<YYYYMMDD>-<gitsha>. Verify = recompute SHA-256; it must equal the .sha256
 * line AND the line must name the file. Verified results are cached by (size, mtime) so a
 * 4.5 GB image is hashed once, not at every scan. A bad image is marked 'bad-sha' and never
 * offered; it is NOT deleted (quarantine-never-delete; an operator removes it).
 * Sync from docked disks / peer Engines is a follow-up (only 'local' sources today).
 */
import crypto from 'crypto'
import path from 'path'
import { $, fs } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { EngineID, Timestamp } from './CommonTypes.js'
import { localEngineId } from './Engine.js'
import { ENGINE_STATE_DIR } from './FilesMount.js'
import { log } from '../utils/utils.js'
import { ClientImageVersion } from './ClientCards.js'

export interface ClientImage {
    version: ClientImageVersion
    fileName: string
    sizeBytes: number
    imageSizeBytes: number | null
    sha256: string
    state: 'arriving' | 'verified' | 'bad-sha'
    source: { type: 'disk'; diskId: string } | { type: 'engine'; engineId: string } | { type: 'local' }
    addedAt: Timestamp
}

export interface ClientImageStore {
    current: ClientImageVersion | null
    previous: ClientImageVersion | null
    images: ClientImage[]
}

export const clientImagesRoot = (): string => process.env.IDEA_CLIENT_IMAGES_DIR || '/var/lib/idea/client-images'
export const VERSION_PATTERN = /^\d{2}\.\d{2}-(\d{8})-[0-9a-f]{7,40}$/
export const imageFileName = (v: string): string => `idea-client-${v}.img.xz`
export const imagePathOf = (v: string): string => path.join(clientImagesRoot(), v, imageFileName(v))

export interface ClientImageOps {
    sha256File: (file: string) => Promise<string>
    uncompressedSize: (file: string) => Promise<number | null>
    cacheFile: () => string
}

const defaultOps: ClientImageOps = {
    sha256File: (file) => new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256')
        fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')))
    }),
    uncompressedSize: async (file) => {
        const out = await $`xz --robot --list ${file}`.nothrow()
        if (out.exitCode !== 0) return null
        const line = out.stdout.split('\n').find(l => l.startsWith('totals'))
        const n = parseInt(line?.split('\t')[4] ?? '', 10)
        return Number.isFinite(n) ? n : null
    },
    cacheFile: () => path.join(ENGINE_STATE_DIR, 'client-images-verified.json'),
}
let ops: ClientImageOps = defaultOps
export const setClientImageOpsForTests = (o: Partial<ClientImageOps> | null): void => { ops = o ? { ...defaultOps, ...o } : defaultOps }

type CacheEntry = { size: number; mtimeMs: number; sha256: string; imageSizeBytes: number | null; ok: boolean }
const readCache = async (): Promise<Record<string, CacheEntry>> => {
    try { return JSON.parse(await fs.readFile(ops.cacheFile(), 'utf8')) } catch { return {} }
}
const writeCache = async (c: Record<string, CacheEntry>): Promise<void> => {
    try { await fs.ensureDir(path.dirname(ops.cacheFile())); await fs.writeFile(ops.cacheFile(), JSON.stringify(c)) } catch (e) { log(`client image cache: ${e}`) }
}

/** Parse a sha256sum line "<64 hex>  <name>" (also "*name"). */
export const parseShaLine = (text: string): { sha256: string; name: string } | null => {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(text.trim().split('\n')[0] ?? '')
    return m ? { sha256: m[1].toLowerCase(), name: m[2] } : null
}

/** Newest first: by YYYYMMDD in the version, then by arrival. */
export const sortImages = (images: ClientImage[]): ClientImage[] =>
    [...images].sort((a, b) => {
        const da = VERSION_PATTERN.exec(a.version)?.[1] ?? '', db = VERSION_PATTERN.exec(b.version)?.[1] ?? ''
        return db.localeCompare(da) || b.addedAt - a.addedAt
    })

export const scanClientImages = async (): Promise<ClientImageStore> => {
    const root = clientImagesRoot()
    let dirs: string[] = []
    try { dirs = await fs.readdir(root) } catch { return { current: null, previous: null, images: [] } }
    const cache = await readCache()
    let cacheChanged = false
    const images: ClientImage[] = []
    for (const v of dirs) {
        if (!VERSION_PATTERN.test(v)) continue
        const file = imagePathOf(v)
        let st: import("fs").Stats
        try { st = await fs.lstat(file) } catch { continue }
        if (!st.isFile()) continue
        let shaText = ''
        try { shaText = await fs.readFile(`${file}.sha256`, 'utf8') } catch { /* arriving */ }
        const line = parseShaLine(shaText)
        const base: Omit<ClientImage, 'state' | 'sha256' | 'imageSizeBytes'> = {
            version: v, fileName: imageFileName(v), sizeBytes: st.size, source: { type: 'local' }, addedAt: Math.round(st.mtimeMs) as Timestamp,
        }
        if (!line) { images.push({ ...base, sha256: '', imageSizeBytes: null, state: 'arriving' }); continue }
        if (line.name !== imageFileName(v)) { images.push({ ...base, sha256: line.sha256, imageSizeBytes: null, state: 'bad-sha' }); continue }
        let c = cache[file]
        if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs || c.sha256 !== line.sha256) {
            const calc = await ops.sha256File(file)
            const ok = calc === line.sha256
            c = { size: st.size, mtimeMs: st.mtimeMs, sha256: line.sha256, ok, imageSizeBytes: ok ? await ops.uncompressedSize(file) : null }
            cache[file] = c
            cacheChanged = true
            log(`Client image ${v}: sha256 ${ok ? 'verified' : `MISMATCH (got ${calc})`}`)
        }
        images.push({ ...base, sha256: line.sha256, imageSizeBytes: c.imageSizeBytes, state: c.ok ? 'verified' : 'bad-sha' })
    }
    if (cacheChanged) await writeCache(cache)
    const sorted = sortImages(images)
    const verified = sorted.filter(i => i.state === 'verified')
    return { current: verified[0]?.version ?? null, previous: verified[1]?.version ?? null, images: sorted }
}

let lastImages: ClientImageStore = { current: null, previous: null, images: [] }
export const lastClientImages = (): ClientImageStore => lastImages

export const refreshClientImages = async (
    storeHandle: DocHandle<Store>,
    engineId: EngineID = localEngineId as EngineID,
): Promise<ClientImageStore> => {
    const st = await scanClientImages()
    lastImages = st
    const prev = JSON.stringify(storeHandle.doc()?.engineDB?.[engineId]?.clientImages ?? null)
    if (prev !== JSON.stringify(st)) {
        storeHandle.change(doc => {
            const e = doc.engineDB[engineId]
            if (e) e.clientImages = JSON.parse(JSON.stringify(st))
        })
    }
    return st
}

/** Resolve a flashCard version arg ('current' or a version) to a verified image. */
export const resolveImage = (st: ClientImageStore, arg: string): { ok: true; image: ClientImage } | { ok: false; code: 'IMAGE_NOT_FOUND' | 'IMAGE_BAD_SHA'; text: string } => {
    const v = arg === 'current' ? st.current : arg
    if (!v) return { ok: false, code: 'IMAGE_NOT_FOUND', text: 'no verified client image on this Engine' }
    const img = st.images.find(i => i.version === v)
    if (!img) return { ok: false, code: 'IMAGE_NOT_FOUND', text: `client image ${v} is not stored on this Engine` }
    if (img.state === 'bad-sha') return { ok: false, code: 'IMAGE_BAD_SHA', text: `client image ${v} failed its SHA-256 check` }
    if (img.state !== 'verified') return { ok: false, code: 'IMAGE_NOT_FOUND', text: `client image ${v} is still arriving` }
    return { ok: true, image: img }
}
