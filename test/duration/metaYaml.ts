/**
 * idea#168 r38: the pool runs skipMetaUpdate:false — every dock rewrites a fixture's META.yaml
 * (lastDocked changes, diskName loses its quotes) and each Engine start rewrites /META.yaml.
 * So NO harness check compares META.yaml by bytes or sha. Identity = diskId + created only,
 * read by parsing the YAML; anything else (lastDocked, diskName, key order, quoting, comments)
 * may differ. A diskId / created mismatch fails loud.
 */

import { parse as parseYaml } from 'yaml'

export interface MetaIdentity {
    diskId: string | null
    /** created as text ("1780000000000"): number vs quoted string compare equal. */
    created: string | null
}

/** Parse META.yaml text → { diskId, created }. Throws on invalid YAML / non-mapping. */
export const parseMetaIdentity = (text: string, where = 'META.yaml'): MetaIdentity => {
    let y: unknown
    try {
        y = parseYaml(String(text ?? ''))
    } catch (e) {
        throw new Error(`${where}: not valid YAML (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`)
    }
    if (!y || typeof y !== 'object' || Array.isArray(y)) throw new Error(`${where}: not a YAML mapping`)
    const o = y as Record<string, unknown>
    const scalar = (v: unknown): string | null =>
        v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v).trim()
    return { diskId: scalar(o.diskId), created: scalar(o.created) }
}

/** Compare identity (diskId + created). Returns the mismatch text, or null when they agree. */
export const metaIdentityMismatch = (expected: MetaIdentity, actual: MetaIdentity): string | null => {
    const diffs: string[] = []
    if (expected.diskId !== actual.diskId) diffs.push(`diskId expected ${expected.diskId ?? 'missing'}, actual ${actual.diskId ?? 'missing'}`)
    if (expected.created !== actual.created) diffs.push(`created expected ${expected.created ?? 'missing'}, actual ${actual.created ?? 'missing'}`)
    return diffs.length ? diffs.join('; ') : null
}

/** Throw loud when two META.yaml texts are not the same disk (diskId + created). */
export const assertSameMetaIdentity = (expectedText: string, actualText: string, where: string): MetaIdentity => {
    const e = parseMetaIdentity(expectedText, `${where} (expected)`)
    const a = parseMetaIdentity(actualText, `${where} (actual)`)
    if (!e.diskId) throw new Error(`${where}: expected META.yaml has no diskId`)
    const mm = metaIdentityMismatch(e, a)
    if (mm) throw new Error(`${where}: META.yaml identity mismatch — ${mm} (only diskId + created are compared; lastDocked/diskName may differ)`)
    return a
}

/**
 * Remote bash: print the top-level `diskId:` scalar of a META.yaml (YAML plain, 'single' or
 * "double" quoted; trailing comment, CR and whitespace stripped) — for on-Pi identity checks
 * inside one remote script, compared with `=` (exact, never a substring/grep -F match).
 */
export const metaDiskIdShell = (file: string): string =>
    `sed -n 's/^diskId:[[:space:]]*//p' ${file} 2>/dev/null | head -1 | tr -d '\\r' | ` +
    `sed -e 's/^"\\(.*\\)"[[:space:]]*\\(#.*\\)\\{0,1\\}$/\\1/' -e "s/^'\\(.*\\)'[[:space:]]*\\(#.*\\)\\{0,1\\}$/\\1/" ` +
    `-e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//'`

/** Remote bash condition: META.yaml exists and its parsed diskId equals `diskId` exactly. */
export const metaDiskIdIsShell = (file: string, diskId: string): string =>
    `[ -f ${file} ] && [ "$(${metaDiskIdShell(file)})" = ${shq(diskId)} ]`

const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`
