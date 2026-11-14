/**
 * DemoPack.ts — local and GitHub demo content packs for setupDemo (engine#369).
 *
 * Canonical pack root (Kid, app-kolibri#25): pack.json, CREDITS.txt, and the
 * app payload (Kolibri: KOLIBRI_DATA/content/{databases,storage}). A GitHub
 * release asset is a tar of that root, pinned by sha256 in app.yaml. Local
 * sources (Steve addendum decision 3): IDEA-DEMO/idea-demo-<app>-vN.tar,
 * IDEA-DEMO/<app>/pack.json, or a single-app IDEA-DEMO/pack.json, on a USB
 * stick or at the root of a docked IDEA disk. Old FAT32 source-tree sticks
 * (no pack.json of this schema) are not a usable pack (NO_SOURCE).
 *
 * Undeclared files under the pack root are ignored, but logged (decision 4).
 * CREDITS.txt is required (decision 2). Hooks in pack.json are declarative
 * only; the Engine never runs a script from the pack (decision 1).
 */
import { createHash } from 'node:crypto'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import * as https from 'node:https'
import * as http from 'node:http'
import { createWriteStream } from 'node:fs'
import { fs, path, YAML } from 'zx'
import { log } from '../utils/utils.js'
import { compareVersions } from './Version.js'

const execFile = promisify(execFileCb)

export const PACK_SCHEMA_VERSION = 1
export const DEMO_PACK_DIR = 'demo-pack'
export const DEMO_PACK_EXTRACT = 'x'
export const CREDITS_DEFAULT = 'CREDITS.txt'

export type DemoAppName = 'kolibri' | 'nextcloud'

export interface PackFile {
    path: string
    sha256: string
    bytes: number
}

export interface PackHookDecl {
    id: string
    needs: 'stopped' | 'running'
}

export interface PackJson {
    schemaVersion: number
    packVersion: number
    app: DemoAppName
    minAppVersion: string
    maxAppVersion?: string
    bytes: number
    credits: string
    licence?: string
    hooks: PackHookDecl[]
    files: PackFile[]
}

export interface AppDemoPackPin {
    file: string
    url: string
    sha256: string
    bytes: number
    minVersion: number
}

export interface AppDemoSpec {
    name: string
    minEngine?: string
    pack: AppDemoPackPin | null
    reserveBytes: number
    steps: { id: string, run: string, needs: 'stopped' | 'running', timeoutSec: number }[]
}

export type PackSourceKind = 'local' | 'github'

export interface LocatedPack {
    source: PackSourceKind
    packVersion: number
    /** Directory already in canonical layout, or the .tar to extract */
    kind: 'dir' | 'tar'
    path: string
    /** When kind is tar and we know the official pin, the expected sha256 */
    tarSha256?: string
    pin?: AppDemoPackPin
}

export class PackVerifyError extends Error {
    constructor(public code: 'PACK_OUTDATED' | 'CHECKSUM_MISMATCH' | 'INVALID_PACK' | 'NO_SOURCE', text: string) {
        super(`${code}: ${text}`)
        this.name = 'PackVerifyError'
    }
}

const SHA_RE = /^[0-9a-f]{64}$/
const SAFE_REL = /^(?![./])(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._/\- ]*$/

const asApp = (v: unknown): DemoAppName | null =>
    v === 'kolibri' || v === 'nextcloud' ? v : null

const asPosInt = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null

const asNonEmpty = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

/** Parse and type-check pack.json. Throws PackVerifyError('INVALID_PACK', ...) on a bad document. */
export const parsePackJson = (raw: string, expectedApp?: DemoAppName): PackJson => {
    let v: any
    try { v = JSON.parse(raw) } catch (e) {
        throw new PackVerifyError('INVALID_PACK', `pack.json does not parse: ${(e as Error).message}`)
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new PackVerifyError('INVALID_PACK', 'pack.json must be an object')
    }
    if (v.schemaVersion !== PACK_SCHEMA_VERSION) {
        throw new PackVerifyError('INVALID_PACK', `pack.json schemaVersion must be ${PACK_SCHEMA_VERSION} (got ${String(v.schemaVersion)})`)
    }
    const packVersion = asPosInt(v.packVersion)
    if (packVersion === null) throw new PackVerifyError('INVALID_PACK', 'pack.json packVersion must be a non-negative integer')
    const app = asApp(v.app)
    if (!app) throw new PackVerifyError('INVALID_PACK', `pack.json app must be "kolibri" or "nextcloud" (got ${JSON.stringify(v.app)})`)
    if (expectedApp && app !== expectedApp) {
        throw new PackVerifyError('INVALID_PACK', `pack.json app is '${app}', expected '${expectedApp}'`)
    }
    const minAppVersion = asNonEmpty(v.minAppVersion)
    if (!minAppVersion) throw new PackVerifyError('INVALID_PACK', 'pack.json minAppVersion is required')
    const bytes = asPosInt(v.bytes)
    if (bytes === null) throw new PackVerifyError('INVALID_PACK', 'pack.json bytes must be a non-negative integer')
    const credits = asNonEmpty(v.credits)
    if (!credits) throw new PackVerifyError('INVALID_PACK', 'pack.json credits is required')
    if (!SAFE_REL.test(credits) || credits.includes('..')) {
        throw new PackVerifyError('INVALID_PACK', `pack.json credits path is not a safe relative path: ${credits}`)
    }
    if (v.licence !== undefined && v.licence !== null) {
        const lic = asNonEmpty(v.licence)
        if (!lic || !SAFE_REL.test(lic)) throw new PackVerifyError('INVALID_PACK', 'pack.json licence must be a safe relative path when set')
    }
    if (!Array.isArray(v.hooks)) throw new PackVerifyError('INVALID_PACK', 'pack.json hooks must be an array')
    const hooks: PackHookDecl[] = v.hooks.map((h: any, i: number) => {
        if (!h || typeof h !== 'object') throw new PackVerifyError('INVALID_PACK', `pack.json hooks[${i}] is invalid`)
        const id = asNonEmpty(h.id)
        if (!id) throw new PackVerifyError('INVALID_PACK', `pack.json hooks[${i}].id is required`)
        if (h.needs !== 'stopped' && h.needs !== 'running') {
            throw new PackVerifyError('INVALID_PACK', `pack.json hooks[${i}].needs must be "stopped" or "running"`)
        }
        return { id, needs: h.needs }
    })
    if (!Array.isArray(v.files)) throw new PackVerifyError('INVALID_PACK', 'pack.json files must be an array')
    const files: PackFile[] = v.files.map((f: any, i: number) => {
        if (!f || typeof f !== 'object') throw new PackVerifyError('INVALID_PACK', `pack.json files[${i}] is invalid`)
        const p = asNonEmpty(f.path)
        const sha = typeof f.sha256 === 'string' ? f.sha256.toLowerCase() : ''
        const fb = asPosInt(f.bytes)
        if (!p || !SAFE_REL.test(p) || p.includes('..') || p.startsWith('/')) {
            throw new PackVerifyError('INVALID_PACK', `pack.json files[${i}].path is not a safe relative path`)
        }
        if (p === 'pack.json') throw new PackVerifyError('INVALID_PACK', 'pack.json must not list itself in files')
        if (!SHA_RE.test(sha)) throw new PackVerifyError('INVALID_PACK', `pack.json files[${i}].sha256 must be 64 lowercase hex`)
        if (fb === null) throw new PackVerifyError('INVALID_PACK', `pack.json files[${i}].bytes must be a non-negative integer`)
        return { path: p, sha256: sha, bytes: fb }
    })
    const out: PackJson = { schemaVersion: 1, packVersion, app, minAppVersion, bytes, credits, hooks, files }
    if (typeof v.maxAppVersion === 'string' && v.maxAppVersion.trim()) out.maxAppVersion = v.maxAppVersion.trim()
    if (typeof v.licence === 'string' && v.licence.trim()) out.licence = v.licence.trim()
    return out
}

export const sha256File = async (file: string): Promise<string> => {
    const hash = createHash('sha256')
    const stream = (await import('node:fs')).createReadStream(file)
    return await new Promise((resolve, reject) => {
        stream.on('data', (c: Buffer | string) => hash.update(c))
        stream.on('error', reject)
        stream.on('end', () => resolve(hash.digest('hex')))
    })
}

const fileSize = async (file: string): Promise<number> => (await fs.stat(file)).size

const listFilesRec = async (root: string, rel = ''): Promise<string[]> => {
    const dir = rel ? path.join(root, rel) : root
    const out: string[] = []
    let ents: string[]
    try { ents = await fs.readdir(dir) } catch { return out }
    for (const name of ents) {
        if (name === '.' || name === '..') continue
        const next = rel ? `${rel}/${name}` : name
        const st = await fs.lstat(path.join(root, next))
        if (st.isDirectory()) out.push(...await listFilesRec(root, next))
        else if (st.isFile()) out.push(next)
    }
    return out
}

/**
 * Verify an extracted canonical pack root. pack.json is the root of trust for a
 * folder; a tar is also checked against tarSha256 when provided (the app.yaml pin).
 */
export const verifyExtractedPack = async (
    root: string,
    expectedApp: DemoAppName,
    opts: { minVersion?: number, appVersion?: string } = {},
): Promise<PackJson> => {
    const packPath = path.join(root, 'pack.json')
    if (!await fs.pathExists(packPath)) throw new PackVerifyError('INVALID_PACK', `no pack.json in ${root}`)
    const pack = parsePackJson(await fs.readFile(packPath, 'utf8'), expectedApp)
    if (opts.minVersion !== undefined && pack.packVersion < opts.minVersion) {
        throw new PackVerifyError('PACK_OUTDATED', `packVersion ${pack.packVersion} is below minVersion ${opts.minVersion}`)
    }
    if (opts.appVersion) {
        const cMin = compareVersions(opts.appVersion, pack.minAppVersion)
        if (cMin !== null && cMin < 0) {
            throw new PackVerifyError('PACK_OUTDATED', `app version ${opts.appVersion} is below the pack's minAppVersion ${pack.minAppVersion}`)
        }
        if (pack.maxAppVersion) {
            const cMax = compareVersions(opts.appVersion, pack.maxAppVersion)
            if (cMax !== null && cMax > 0) {
                throw new PackVerifyError('PACK_OUTDATED', `app version ${opts.appVersion} is above the pack's maxAppVersion ${pack.maxAppVersion}`)
            }
        }
    }
    const listed = new Set(pack.files.map(f => f.path))
    if (!listed.has(pack.credits)) {
        throw new PackVerifyError('INVALID_PACK', `credits file '${pack.credits}' is not in pack.json files`)
    }
    if (pack.licence && !listed.has(pack.licence)) {
        throw new PackVerifyError('INVALID_PACK', `licence file '${pack.licence}' is not in pack.json files`)
    }
    for (const f of pack.files) {
        const full = path.join(root, f.path)
        if (!await fs.pathExists(full)) throw new PackVerifyError('INVALID_PACK', `missing pack file ${f.path}`)
        const st = await fs.stat(full)
        if (!st.isFile()) throw new PackVerifyError('INVALID_PACK', `pack path ${f.path} is not a file`)
        if (st.size !== f.bytes) throw new PackVerifyError('INVALID_PACK', `${f.path} is ${st.size} bytes, pack.json says ${f.bytes}`)
        const sha = await sha256File(full)
        if (sha !== f.sha256) throw new PackVerifyError('CHECKSUM_MISMATCH', `${f.path} sha256 is ${sha}, pack.json says ${f.sha256}`)
    }
    const creditsPath = path.join(root, pack.credits)
    const creditsText = await fs.readFile(creditsPath, 'utf8')
    if (!creditsText.trim()) throw new PackVerifyError('INVALID_PACK', `credits file '${pack.credits}' is empty`)
    const present = await listFilesRec(root)
    for (const rel of present) {
        if (rel === 'pack.json') continue
        if (!listed.has(rel)) log(`demo pack: ignoring undeclared file ${rel} under ${root}`)
    }
    return pack
}

export const verifyTarSha256 = async (tarPath: string, expected: string): Promise<void> => {
    const sha = await sha256File(tarPath)
    const want = expected.toLowerCase()
    if (sha !== want) throw new PackVerifyError('CHECKSUM_MISMATCH', `tar sha256 is ${sha}, pin says ${want}`)
}

/** Extract a pack tar into destDir (created). Members with `..` or an absolute path are refused. */
export const extractPackTar = async (tarPath: string, destDir: string): Promise<void> => {
    await fs.ensureDir(destDir)
    const { stdout } = await execFile('tar', ['-tf', tarPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    for (const line of stdout.split('\n')) {
        const m = line.replace(/\/$/, '')
        if (!m) continue
        if (m.startsWith('/') || m.split('/').includes('..')) {
            throw new PackVerifyError('INVALID_PACK', `tar member has an unsafe path: ${m}`)
        }
    }
    await execFile('tar', ['-xf', tarPath, '-C', destDir])
}

export const instancePackRoot = (instanceDir: string): string =>
    path.join(instanceDir, DEMO_PACK_DIR, DEMO_PACK_EXTRACT)

export const instancePackDir = (instanceDir: string): string =>
    path.join(instanceDir, DEMO_PACK_DIR)

/** True when demo-pack/x/ already verifies for this app and minVersion. */
export const existingPackIsValid = async (
    instanceDir: string,
    app: DemoAppName,
    opts: { minVersion?: number, appVersion?: string } = {},
): Promise<PackJson | null> => {
    const root = instancePackRoot(instanceDir)
    if (!await fs.pathExists(path.join(root, 'pack.json'))) return null
    try { return await verifyExtractedPack(root, app, opts) } catch { return null }
}

export const readAppDemoSpec = async (bundleDir: string): Promise<AppDemoSpec | null> => {
    const p = path.join(bundleDir, 'app.yaml')
    if (!await fs.pathExists(p)) return null
    let doc: any
    try { doc = YAML.parse(await fs.readFile(p, 'utf8')) } catch { return null }
    const d = doc?.demo
    if (!d || typeof d !== 'object') return null
    const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : null
    if (!name) return null
    const reserveBytes = typeof d.reserveBytes === 'number' && d.reserveBytes >= 0 ? d.reserveBytes : 0
    let pack: AppDemoPackPin | null = null
    if (d.pack && typeof d.pack === 'object') {
        const file = asNonEmpty(d.pack.file)
        const url = asNonEmpty(d.pack.url)
        const sha256 = typeof d.pack.sha256 === 'string' ? d.pack.sha256.toLowerCase() : ''
        const bytes = asPosInt(d.pack.bytes)
        const minVersion = asPosInt(d.pack.minVersion)
        if (file && url && SHA_RE.test(sha256) && bytes !== null && minVersion !== null) {
            pack = { file, url, sha256, bytes, minVersion }
        }
    }
    const steps: AppDemoSpec['steps'] = []
    if (Array.isArray(d.steps)) {
        for (const s of d.steps) {
            if (!s || typeof s !== 'object') continue
            const id = asNonEmpty(s.id)
            const run = asNonEmpty(s.run)
            const needs = s.needs === 'stopped' || s.needs === 'running' ? s.needs : null
            const timeoutSec = typeof s.timeoutSec === 'number' && s.timeoutSec > 0 ? s.timeoutSec : 600
            if (id && run && needs) steps.push({ id, run, needs, timeoutSec })
        }
    }
    return { name, minEngine: asNonEmpty(d.minEngine) ?? undefined, pack, reserveBytes, steps }
}

const packJsonAt = async (dir: string, expectedApp: DemoAppName): Promise<PackJson | null> => {
    const p = path.join(dir, 'pack.json')
    if (!await fs.pathExists(p)) return null
    try { return parsePackJson(await fs.readFile(p, 'utf8'), expectedApp) } catch { return null }
}

const considerDir = async (dir: string, app: DemoAppName, minVersion: number, out: LocatedPack[]): Promise<void> => {
    const packPath = path.join(dir, 'pack.json')
    if (!await fs.pathExists(packPath)) return
    const pack = await packJsonAt(dir, app)
    if (!pack) {
        log(`setupDemo: skipping ${packPath} (not a usable ${app} pack)`)
        return
    }
    if (pack.packVersion < minVersion) return
    out.push({ source: 'local', packVersion: pack.packVersion, kind: 'dir', path: dir })
}

/** Release tar for one demo app: idea-demo-<app>-vN.tar (N is a non-negative integer). */
export const ideaDemoTarName = (app: DemoAppName, name: string): number | null => {
    const m = String(name).match(new RegExp(`^idea-demo-${app}-v(\\d+)\\.tar$`))
    return m ? Number(m[1]) : null
}

const considerTar = async (tar: string, app: DemoAppName, minVersion: number, pin: AppDemoPackPin | null, out: LocatedPack[]): Promise<void> => {
    if (!await fs.pathExists(tar) || !(await fs.stat(tar)).isFile()) return
    const base = path.basename(tar)
    // Only this app's release-named tar. A nextcloud tar on a kolibri setup must
    // not be offered (that used to extract as INVALID_PACK instead of GitHub / NO_SOURCE).
    const namedVersion = ideaDemoTarName(app, base)
    if (namedVersion === null) {
        log(`setupDemo: skipping ${tar} (not idea-demo-${app}-vN.tar)`)
        return
    }
    if (namedVersion < minVersion) return
    const tarSha256 = pin && base === pin.file ? pin.sha256 : undefined
    out.push({
        source: 'local',
        packVersion: namedVersion,
        kind: 'tar',
        path: tar,
        tarSha256,
        pin: pin && base === pin.file ? pin : undefined,
    })
}

/** Scan one IDEA-DEMO directory (stick or disk root). */
export const scanIdeaDemoDir = async (ideaDemoDir: string, app: DemoAppName, minVersion: number, pin: AppDemoPackPin | null): Promise<LocatedPack[]> => {
    const out: LocatedPack[] = []
    if (!await fs.pathExists(ideaDemoDir)) return out
    // Preferred: release-named tars and IDEA-DEMO/<app>/
    try {
        for (const name of await fs.readdir(ideaDemoDir)) {
            const full = path.join(ideaDemoDir, name)
            if (name.endsWith('.tar')) await considerTar(full, app, minVersion, pin, out)
        }
    } catch { /* unreadable */ }
    await considerDir(path.join(ideaDemoDir, app), app, minVersion, out)
    // Root pack.json as a single-app pack (decision 3)
    await considerDir(ideaDemoDir, app, minVersion, out)
    return out
}

/**
 * Pick the usable local pack: highest packVersion; on a tie, prefer a tar
 * whose sha256 matches the app.yaml pin.
 */
export const pickBestLocalPack = (found: LocatedPack[], pin: AppDemoPackPin | null): LocatedPack | null => {
    if (!found.length) return null
    const pinned = pin?.sha256
    found.sort((a, b) => {
        if (b.packVersion !== a.packVersion) return b.packVersion - a.packVersion
        const aPin = pinned && a.tarSha256 === pinned ? 1 : 0
        const bPin = pinned && b.tarSha256 === pinned ? 1 : 0
        return bPin - aPin
    })
    return found[0]
}

export type DownloadFn = (
    url: string,
    dest: string,
    onProgress?: (bytesDone: number, bytesTotal: number) => void,
) => Promise<void>

/** Write url to dest (a .part file). Used only when a mock is not injected; tests must mock this. */
export const downloadUrlToFile: DownloadFn = async (url, dest, onProgress) => {
    await fs.ensureDir(path.dirname(dest))
    const tmp = dest.endsWith('.part') ? dest : `${dest}.part`
    await new Promise<void>((resolve, reject) => {
        const go = (u: string, redirects: number) => {
            if (redirects > 5) { reject(new Error('too many redirects')); return }
            let parsed: URL
            try { parsed = new URL(u) } catch (e) { reject(e); return }
            const lib = parsed.protocol === 'http:' ? http : https
            const req = lib.get(parsed, { timeout: 30_000 }, (res) => {
                const code = res.statusCode ?? 0
                if (code >= 300 && code < 400 && res.headers.location) {
                    res.resume()
                    go(new URL(res.headers.location, parsed).toString(), redirects + 1)
                    return
                }
                if (code !== 200) {
                    res.resume()
                    reject(new Error(`HTTP ${code}`))
                    return
                }
                const total = Number(res.headers['content-length'] ?? 0)
                let done = 0
                const out = createWriteStream(tmp)
                res.on('data', (c: Buffer) => {
                    done += c.length
                    onProgress?.(done, total || done)
                })
                res.pipe(out)
                out.on('finish', () => resolve())
                out.on('error', reject)
                res.on('error', reject)
            })
            req.on('error', reject)
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
        }
        go(url, 0)
    })
    if (dest !== tmp) await fs.move(tmp, dest, { overwrite: true })
}

export const GB = 1024 * 1024 * 1024

export const spaceNeededBytes = (apps: { packBytes: number, reserveBytes: number }[]): number =>
    apps.reduce((s, a) => s + 2 * a.packBytes + a.reserveBytes, 0) + GB
