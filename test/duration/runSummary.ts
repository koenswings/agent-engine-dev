/**
 * idea#168 run summary helpers for `pnpm test:duration`:
 *
 *  - keep_editing recoveries: the Console keep_editing Intent (in-process, Playwright)
 *    logs one `{"event":"keep_editing_recovery","kind":...,"ok":...}` line per
 *    Reconnect / Reload / reopen it performed. The harness counts exactly those lines
 *    as they go to stdout (= the walk run.log) and reports total + by kind.
 *  - shake-out labelling: a walk with a `shake_out:` block (cover-all-skip-copy) is
 *    reported as shakeOut:true with the parent (cover-all) steps it does NOT cover and
 *    both step numberings. Never presented as the parent walk.
 */

import type { StructuredLogEntry, WalkDefinition, WalkerResult } from './types.js'
import { parentStepFor } from './scenario.js'

export const KEEP_EDITING_RECOVERY_EVENT = 'keep_editing_recovery'

export interface KeepEditingRecoveryCount {
    /** All keep_editing_recovery events seen (ok + failed attempts). */
    total: number
    /** Attempts that did not succeed (event ok:false). */
    failed: number
    /** kind → count (reconnect | reload | reopen_files | reopen_page_reload | …). */
    byKind: Record<string, number>
}

/** Parse one stdout line; returns the recovery kind/ok or null when it is not that event. */
export const parseKeepEditingRecovery = (line: string): { kind: string; ok: boolean } | null => {
    const s = line.trim()
    if (!s.startsWith('{') || !s.includes(KEEP_EDITING_RECOVERY_EVENT)) return null
    let ev: unknown
    try {
        ev = JSON.parse(s)
    } catch {
        return null
    }
    if (!ev || typeof ev !== 'object') return null
    const e = ev as Record<string, unknown>
    if (e.event !== KEEP_EDITING_RECOVERY_EVENT) return null
    const kind = typeof e.kind === 'string' && e.kind ? e.kind : 'unknown'
    return { kind, ok: e.ok !== false }
}

export class KeepEditingRecoveryCounter {
    private total = 0
    private failed = 0
    private byKind: Record<string, number> = {}

    /** Feed one or more stdout lines (a chunk may hold several). */
    addLines(text: string): void {
        for (const line of text.split('\n')) {
            const r = parseKeepEditingRecovery(line)
            if (!r) continue
            this.total += 1
            if (!r.ok) this.failed += 1
            this.byKind[r.kind] = (this.byKind[r.kind] ?? 0) + 1
        }
    }

    snapshot(): KeepEditingRecoveryCount {
        return { total: this.total, failed: this.failed, byKind: { ...this.byKind } }
    }
}

/**
 * Tap process stdout line-by-line (Console Intents log with console.log in this process).
 * Output is passed through unchanged. Returns an uninstall function.
 */
export const tapStdoutLines = (
    onLine: (line: string) => void,
    stream: NodeJS.WriteStream = process.stdout,
): (() => void) => {
    const original = stream.write
    let partial = ''
    const tapped = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
        try {
            const text = typeof chunk === 'string'
                ? chunk
                : chunk instanceof Uint8Array
                    ? Buffer.from(chunk).toString('utf8')
                    : ''
            if (text) {
                const parts = (partial + text).split('\n')
                partial = parts.pop() ?? ''
                for (const p of parts) onLine(p)
            }
        } catch {
            // never break stdout for a counter
        }
        return (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest)
    }
    stream.write = tapped as typeof stream.write
    return () => {
        if (partial) {
            onLine(partial)
            partial = ''
        }
        stream.write = original
    }
}

export interface ShakeOutSummary {
    shakeOut: true
    variantOf: string
    reason: string | null
    /** Parent-walk steps this variant does not execute (parent = cover-all numbering). */
    notCovered: { step: number; action: string }[]
    stepNumbering: {
        variantSteps: number
        parentSteps: number
        /** variant range ↔ parent range, e.g. 44-114 ↔ 45-115. */
        map: { variant: string; parent: string }[]
        substitutes: { variant: number; action: string; replacesParent: number[] }[]
    }
}

const range = ([a, b]: [number, number]): string => (a === b ? `${a}` : `${a}-${b}`)

/** null for a normal walk / Markov run. */
export const shakeOutSummary = (walk: WalkDefinition | null): ShakeOutSummary | null => {
    const so = walk?.shakeOut
    if (!walk || !so) return null
    return {
        shakeOut: true,
        variantOf: so.variantOf,
        reason: so.reason ?? null,
        notCovered: so.notCovered.map(n => ({ step: n.step, action: n.action })),
        stepNumbering: {
            variantSteps: walk.steps.length,
            parentSteps: so.parentSteps,
            map: so.stepMap.map(m => ({ variant: range(m.variant), parent: range(m.parent) })),
            substitutes: so.substitutes.map(s => ({ ...s, replacesParent: [...s.replacesParent] })),
        },
    }
}

/** One step's numbering in a shake-out run: variant step + parent (cover-all) step (null = substitute). */
export const stepNumbers = (
    walk: WalkDefinition | null,
    step: number,
): { step: number; parentStep?: number | null } =>
    walk?.shakeOut ? { step, parentStep: parentStepFor(walk, step) } : { step }

export interface RunSummary {
    event: 'duration_summary'
    mode: 'walk' | 'markov'
    walk: string | null
    shakeOut: boolean
    variantOf?: string
    notCovered?: { step: number; action: string }[]
    stepNumbering?: ShakeOutSummary['stepNumbering']
    steps: number
    failures: number
    aborted: boolean
    abortReason: string | null
    /** Last executed step (variant numbering) + its parent step in a shake-out run. */
    lastStep: { step: number; action: string; parentStep?: number | null } | null
    failedSteps: { step: number; action: string; parentStep?: number | null }[]
    keepEditingRecoveries: KeepEditingRecoveryCount
}

export const buildRunSummary = (input: {
    walk: WalkDefinition | null
    result: Pick<WalkerResult, 'steps' | 'failures' | 'aborted' | 'abortReason' | 'logs'>
    recoveries: KeepEditingRecoveryCount
}): RunSummary => {
    const { walk, result, recoveries } = input
    const so = shakeOutSummary(walk)
    const last: StructuredLogEntry | undefined = result.logs.at(-1)
    return {
        event: 'duration_summary',
        mode: walk ? 'walk' : 'markov',
        walk: walk?.name ?? null,
        shakeOut: !!so,
        ...(so
            ? { variantOf: so.variantOf, notCovered: so.notCovered, stepNumbering: so.stepNumbering }
            : {}),
        steps: result.steps,
        failures: result.failures,
        aborted: result.aborted,
        abortReason: result.abortReason ?? null,
        lastStep: last ? { ...stepNumbers(walk, last.step), action: last.action } : null,
        failedSteps: result.logs
            .filter(l => !l.ok)
            .map(l => ({ ...stepNumbers(walk, l.step), action: l.action })),
        keepEditingRecoveries: recoveries,
    }
}

/** One human line for the end of run.log. */
export const formatRunSummaryLine = (s: RunSummary): string => {
    const kinds = Object.entries(s.keepEditingRecoveries.byKind)
        .map(([k, n]) => `${k}=${n}`)
        .join(', ')
    const rec = `keep_editing recoveries: ${s.keepEditingRecoveries.total}` +
        (s.keepEditingRecoveries.total ? ` (${kinds}; failed=${s.keepEditingRecoveries.failed})` : '')
    const so = s.shakeOut && s.stepNumbering
        ? ` | SHAKE-OUT variant of ${s.variantOf} (NOT a ${s.variantOf} attempt): not covered ` +
            `${(s.notCovered ?? []).map(n => `${s.variantOf}@${n.step} ${n.action}`).join(', ')}; ` +
            `steps ${s.stepNumbering.map.map(m => `${m.variant}↔${s.variantOf}@${m.parent}`).join(', ')}` +
            (s.stepNumbering.substitutes.length
                ? `; ${s.stepNumbering.substitutes.map(x => `@${x.variant} ${x.action} replaces ${s.variantOf}@${x.replacesParent.join('+')}`).join(', ')}`
                : '')
        : ''
    const last = s.lastStep
        ? ` | last step @${s.lastStep.step}${s.lastStep.parentStep !== undefined ? ` (${s.variantOf}@${s.lastStep.parentStep ?? 'substitute'})` : ''} ${s.lastStep.action}`
        : ''
    return `[duration] summary: ${s.walk ?? s.mode} steps=${s.steps} failures=${s.failures}${s.aborted ? ' ABORTED' : ''}${last} | ${rec}${so}`
}
