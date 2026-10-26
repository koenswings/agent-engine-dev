/**
 * deploymentRecord.ts — content manifests for Engine installs (idea#322).
 *
 * A deployment record follows the idea repo's schema `idea-deployment-record/1`
 * (koenswings/idea deployments/README.md, idea#323): a folder
 * deployments/engines/<hostname>/<label>/ in the idea repo with a key=value
 * record.txt plus sidecar lists, written by script/capture-engine-record.sh:
 *
 *   record.txt     key=value summary (schema keys + Engine keys)
 *   packages.tsv   <package>\t<version>\t<arch>      (dpkg-query -W), sorted
 *   images.tsv     <ref>\t<image id>\t<repo digests> (docker image inspect), sorted
 *   files.sha256   sha256sum lines of the Engine's tracked files, sorted by path
 *   dist.sha256    sha256sum lines of the compiled dist/, sorted by path
 *
 * Two records are "content-identical" when every non-volatile field and line is
 * equal; byte-identical images are not required (Koen, idea#322).
 */

export const RECORD_FILES = ['record.txt', 'packages.tsv', 'images.tsv', 'files.sha256', 'dist.sha256'] as const
export type RecordFile = typeof RECORD_FILES[number]

/** Keys of record.txt that change on every capture or every install and are never compared. */
export const VOLATILE_KEYS = new Set([
    'capturedUtc', 'hostname', 'stickerName', 'cardId', 'captureHost', 'uptime', 'recordLabel', 'notes',
    'batch', 'deployedAt', 'evidence', 'confidence', 'open', 'packageArchive', 'secrets',
    'buildOptions', 'buildSourceFlags',
])

/** Keys idea deployments/README.md (idea#323) marks required, as they apply to an Engine. */
export const REQUIRED_KEYS = [
    'schema', 'batch', 'deviceType', 'arch', 'model', 'osRelease',
    'imageCommit', 'imageBranch', 'imageTag', 'imageVersion',
    'packageArchive', 'secrets', 'deployedAt', 'evidence', 'confidence', 'open',
] as const
export const SCHEMA = 'idea-deployment-record/1'
/** For image-only keys (imageFile, imageSha256, …) that do not apply: an Engine is built on the device. */
export const NOT_APPLICABLE = 'n/a'

/** Missing required keys and identity check; empty = valid. */
export const validateRecord = (recordTxt: string): string[] => {
    const kv = parseKeyValues(recordTxt)
    const errs = REQUIRED_KEYS.filter(k => !kv.has(k)).map(k => `missing ${k}`)
    if (kv.has('schema') && kv.get('schema') !== SCHEMA) errs.push(`schema is ${kv.get('schema')}`)
    if (!kv.get('hostname') && !kv.get('stickerName') && !kv.get('cardId')) errs.push('missing hostname/stickerName/cardId')
    if (kv.has('deviceType') && kv.get('deviceType') !== 'engine') errs.push(`deviceType is ${kv.get('deviceType')}, expected engine`)
    return errs
}

/** Value used in retro records for a field that could not be recovered. */
export const UNKNOWN = 'UNKNOWN'

export type Record = { [K in RecordFile]?: string }

export const parseKeyValues = (text: string): Map<string, string> => {
    const m = new Map<string, string>()
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const i = line.indexOf('=')
        if (i <= 0) continue
        m.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
    }
    return m
}

/** Replace `key=` lines in place, append the ones that are new. */
export const setKeys = (recordTxt: string, lines: string[]): string => {
    const out = recordTxt.replace(/\n*$/, '').split('\n')
    for (const l of lines) {
        const k = l.slice(0, l.indexOf('='))
        const i = out.findIndex(o => o.startsWith(k + '='))
        if (i >= 0) out[i] = l; else out.push(l)
    }
    return out.join('\n') + '\n'
}

/** Non-empty, non-comment lines, trimmed of trailing whitespace, sorted. */
export const normaliseLines = (text: string): string[] =>
    text.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l && !l.startsWith('#')).sort()

/** `pkg\tver\tarch` lines from `dpkg-query -W -f '${Package}\t${Version}\t${Architecture}\n'`. */
export const parseApt = (text: string): Map<string, string> => {
    const m = new Map<string, string>()
    for (const l of normaliseLines(text)) {
        const [pkg, ver, arch] = l.split('\t')
        if (pkg && ver !== undefined) m.set(arch ? `${pkg}:${arch}` : pkg, ver)
    }
    return m
}

/** `sha256  path` lines (sha256sum output) → path → sha256. */
export const parseSha256 = (text: string): Map<string, string> => {
    const m = new Map<string, string>()
    for (const l of normaliseLines(text)) {
        const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l)
        if (match) m.set(match[2], match[1])
    }
    return m
}

export type Difference = { file: RecordFile, key: string, expected: string | undefined, actual: string | undefined }

const diffMaps = (file: RecordFile, a: Map<string, string>, b: Map<string, string>, skip: (k: string) => boolean): Difference[] => {
    const out: Difference[] = []
    const keys = [...new Set([...a.keys(), ...b.keys()])].sort()
    for (const k of keys) {
        if (skip(k)) continue
        const x = a.get(k), y = b.get(k)
        if (x === UNKNOWN || y === UNKNOWN) continue
        if (x !== y) out.push({ file, key: k, expected: x, actual: y })
    }
    return out
}

export type CompareOptions = {
    /** Extra record.txt keys to ignore (on top of VOLATILE_KEYS). */
    ignoreKeys?: string[]
    /** Paths in files.sha256 / dist.sha256 to ignore (exact match or prefix ending in '/'). */
    ignorePaths?: string[]
}

/**
 * Compare a committed record (expected) with a fresh one (actual).
 * A file missing on one side is only compared when it exists on both;
 * the expected side decides which files matter. UNKNOWN values (retro records)
 * never count as a difference.
 */
export const compareRecords = (expected: Record, actual: Record, opts: CompareOptions = {}): Difference[] => {
    const ignoreKeys = new Set([...VOLATILE_KEYS, ...(opts.ignoreKeys ?? [])])
    const ignorePaths = opts.ignorePaths ?? []
    const pathIgnored = (p: string) => ignorePaths.some(ip => ip.endsWith('/') ? p.startsWith(ip) : p === ip)
    const out: Difference[] = []
    for (const f of RECORD_FILES) {
        const e = expected[f], a = actual[f]
        if (e === undefined) continue
        if (a === undefined) { out.push({ file: f, key: '<file>', expected: 'present', actual: undefined }); continue }
        if (f === 'record.txt') out.push(...diffMaps(f, parseKeyValues(e), parseKeyValues(a), k => ignoreKeys.has(k)))
        else if (f === 'packages.tsv') out.push(...diffMaps(f, parseApt(e), parseApt(a), () => false))
        else if (f === 'images.tsv') {
            const toMap = (t: string) => new Map(normaliseLines(t).map(l => { const [ref, ...rest] = l.split('\t'); return [ref, rest.join('\t')] as [string, string] }))
            out.push(...diffMaps(f, toMap(e), toMap(a), () => false))
        } else out.push(...diffMaps(f, parseSha256(e), parseSha256(a), pathIgnored))
    }
    return out
}

export const formatDifferences = (d: Difference[]): string =>
    d.length === 0 ? 'IDENTICAL (content)\n'
        : d.map(x => `DIFF ${x.file} ${x.key}: expected=${x.expected ?? '<missing>'} actual=${x.actual ?? '<missing>'}`).join('\n') + `\n${d.length} difference(s)\n`

/** Patterns that must never appear in a committed record (no secrets, idea#322). */
export const SECRET_PATTERNS: RegExp[] = [
    /tskey-[A-Za-z0-9-]+/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /^\s*(password|passwd|psk|wifi_psk|authkey|auth_key|token|secret)\s*=/im,
    /ghp_[A-Za-z0-9]{20,}/,
]

/** Returns `file: pattern` for every secret-looking match; empty means clean. */
export const findSecrets = (rec: Record): string[] => {
    const hits: string[] = []
    for (const f of RECORD_FILES) {
        const t = rec[f]
        if (!t) continue
        for (const p of SECRET_PATTERNS) if (p.test(t)) hits.push(`${f}: ${p}`)
    }
    return hits
}

/** Engine release tags (idea#322, Steve 2026-10-26): engine-vYYYY.MM.DD[-N], created on main after Koen merges. */
export const ENGINE_TAG_RE = /^engine-v\d{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(-[1-9]\d*)?$/
export const isEngineTag = (t: string) => ENGINE_TAG_RE.test(t)

export type SourceState = { commit: string, tags: string[], dirty: boolean, onMain: boolean }
export type SourceVerdict = { ok: boolean, tag: string | null, reasons: string[] }

/**
 * build-engine gate (idea#322 plan item 1): build only from a clean, tagged
 * commit that is on main. With allowUntagged the build continues, but the
 * reasons are printed and recorded in the deployment record (sourceVerdict).
 */
export const judgeSource = (s: SourceState, allowUntagged = false): SourceVerdict => {
    const reasons: string[] = []
    if (!/^[0-9a-f]{40}$/.test(s.commit)) reasons.push(`not a full commit id: ${s.commit}`)
    const tags = s.tags.filter(isEngineTag)
    if (tags.length === 0) reasons.push(s.tags.length ? `HEAD has no engine-vYYYY.MM.DD[-N] tag (has: ${s.tags.join(', ')})` : 'HEAD has no tag')
    if (s.dirty) reasons.push('working tree has uncommitted changes')
    if (!s.onMain) reasons.push('HEAD is not on origin/main')
    const tag = tags.length ? [...tags].sort().reverse()[0] : null
    return { ok: reasons.length === 0 || allowUntagged, tag, reasons }
}
