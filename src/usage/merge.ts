/**
 * Stored-file merge rules (idea#411 contract §5.5): demo OR, Nextcloud office
 * reduction from that day's samples.
 */
import { readSamples } from './store.js'
import { usageRoot } from './paths.js'
import type { DayFile, SampleRecord } from './types.js'

export function isDemoName(name: string): boolean {
    if (/\bDemo\b/.test(name)) return true
    if (/Wikipedia \(Demo\)/i.test(name)) return true
    return false
}

export function resolveDemo(hookDemo: unknown, displayName: string): boolean {
    return hookDemo === true || isDemoName(displayName)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function maxMap(maps: unknown[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const m of maps) {
        if (!m || typeof m !== 'object') continue
        for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
            const n = num(v)
            out[k] = Math.max(out[k] ?? 0, n)
        }
    }
    return out
}

/**
 * Reduce Nextcloud Office samples: max tokens / distinctDocuments / read / edit
 * (snapshot counts, not additive), max per byGroup and mime key, estimatedMinutes
 * from consecutive samples that still have tokens × 15, opens = samples with tokens > 0.
 */
export function reduceOffice(samples: SampleRecord[]): Record<string, unknown> | undefined {
    const withOffice = samples.filter(s => s.office && typeof s.office === 'object')
    if (withOffice.length === 0) return undefined
    const offices = withOffice.map(s => s.office as Record<string, unknown>)
    const maxOf = (key: string) => Math.max(0, ...offices.map(o => num(o[key])))
    let estimatedMinutes = 0
    for (let i = 1; i < withOffice.length; i++) {
        const prev = num((withOffice[i - 1].office as Record<string, unknown>).tokens)
        const cur = num((withOffice[i].office as Record<string, unknown>).tokens)
        if (prev > 0 && cur > 0) estimatedMinutes += 15
    }
    const opens = withOffice.filter(s => num((s.office as Record<string, unknown>).tokens) > 0).length
    return {
        opens,
        tokens: maxOf('tokens'),
        distinctDocuments: maxOf('distinctDocuments'),
        read: maxOf('read'),
        edit: maxOf('edit'),
        estimatedMinutes,
        byGroup: maxMap(offices.map(o => o.byGroup)),
        mime: maxMap(offices.map(o => o.mime)),
    }
}

export function applyOfficeMerge(record: DayFile, root = usageRoot()): DayFile {
    if (record.app !== 'nextcloud' || record.hookStatus !== 'ok') return record
    const samples = readSamples(record.day, record.instance, root)
    const reduced = reduceOffice(samples)
    if (reduced) return { ...record, office: reduced }
    return record
}
