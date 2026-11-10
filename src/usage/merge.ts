/**
 * Stored-file merge rules (idea#411 contract §5.5): demo OR, Nextcloud office
 * reduction from that day's samples.
 */
import { readSamples } from './store.js'
import { usageRoot } from './paths.js'
import type { DayFile, SampleRecord } from './types.js'

/** True when any token of the display name, split on space / _ / -, equals "demo". */
export function isDemoName(name: string): boolean {
    return name.split(/[\s_-]+/).some(tok => {
        const norm = tok.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase()
        return norm === 'demo'
    })
}

export function resolveDemo(hookDemo: unknown, displayName: string): boolean {
    return hookDemo === true || isDemoName(displayName)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const GROUP_KEYS = ['admin', 'teacher', 'learner'] as const
const MIME_KEYS = ['text', 'sheet', 'slides'] as const

function mapMax(offices: Record<string, unknown>[], field: string, keys: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const key of keys) {
        out[key] = Math.max(0, ...offices.map(o => {
            const m = o[field]
            if (!m || typeof m !== 'object') return 0
            return num((m as Record<string, unknown>)[key])
        }))
    }
    return out
}

/**
 * Reduce Nextcloud Office samples into the stored office object:
 *   opens              = max(tokens)
 *   distinctDocuments  = |union(documents)|
 *   read, edit         = max across samples (snapshot counts)
 *   estimatedMinutes   = consecutive tokens>0 samples × 15
 *   byGroup / mime     = max per key, always the canonical keys
 */
export function reduceOffice(samples: SampleRecord[]): Record<string, unknown> | undefined {
    const withOffice = samples.filter(s => s.office && typeof s.office === 'object')
    if (withOffice.length === 0) return undefined
    const offices = withOffice.map(s => s.office as Record<string, unknown>)
    const maxOf = (key: string) => Math.max(0, ...offices.map(o => num(o[key])))

    const ids = new Set<string>()
    for (const o of offices) {
        if (!Array.isArray(o.documents)) continue
        for (const id of o.documents) {
            if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) ids.add(id)
        }
    }

    let estimatedMinutes = 0
    let run = 0
    const flush = () => {
        if (run > 0) estimatedMinutes += run * 15
        run = 0
    }
    for (const sample of samples) {
        const tokens = sample.office && typeof sample.office === 'object'
            ? num((sample.office as Record<string, unknown>).tokens)
            : 0
        if (tokens > 0) run += 1
        else flush()
    }
    flush()

    return {
        opens: maxOf('tokens'),
        distinctDocuments: ids.size,
        read: maxOf('read'),
        edit: maxOf('edit'),
        estimatedMinutes,
        byGroup: mapMax(offices, 'byGroup', GROUP_KEYS),
        mime: mapMax(offices, 'mime', MIME_KEYS),
    }
}

export function applyOfficeMerge(record: DayFile, root = usageRoot()): DayFile {
    if (record.app !== 'nextcloud' || record.hookStatus !== 'ok') return record
    const samples = readSamples(record.day, record.instance, root)
    const reduced = reduceOffice(samples)
    if (reduced) return { ...record, office: reduced }
    return record
}
