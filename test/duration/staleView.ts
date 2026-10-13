/**
 * r65 FAIL@43: the walker's cached Automerge view of the store showed NO copyApp Operation for ≥66 s while a
 * fresh connection showed it Done (+0.85 s start, 25 s op). The stale-view guard forces a reconnect and a
 * re-read before an op wait / post-check gives up, and when a doc has not changed for N s while the Pi is up.
 *
 * Steve's condition: a frozen sync view may be a real sync bug, so EVERY forced reconnect is counted and
 * stays visible: one `stale_view_reconnect` line per event in run.log, a RECONNECTS.md in the evidence dir
 * and a `reconnects` field in the final duration_summary.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ReconnectEvent {
    engine: string
    at: number // epoch ms (box clock)
    reason: string
    /** The re-read saw data the cached view did not have (store heads changed). null = reconnect failed. */
    foundNew: boolean | null
    beforeHeads: string
    afterHeads: string
    tookMs: number
    error?: string
    /** r86r: 'reattach' = existing off-thread link re-synced in its worker; 'fresh' = new connection. */
    mode?: 'reattach' | 'fresh' | 'failed'
}

const events: ReconnectEvent[] = []

export const recordReconnect = (e: ReconnectEvent, log: (line: string) => void = l => console.log(l)): void => {
    events.push(e)
    log(JSON.stringify({
        event: 'stale_view_reconnect', n: events.length, engine: e.engine, at: new Date(e.at).toISOString(),
        reason: e.reason, found_new: e.foundNew, took_ms: e.tookMs, before_heads: e.beforeHeads, after_heads: e.afterHeads,
        ...(e.mode ? { mode: e.mode } : {}),
        ...(e.error ? { error: e.error } : {}),
    }))
}

export const reconnectEvents = (): readonly ReconnectEvent[] => events
export const resetReconnectEvents = (): void => { events.length = 0 }

/** Compact summary for duration_summary / FAIL-NOTE. */
export const reconnectSummary = (evs: readonly ReconnectEvent[] = events) => ({
    count: evs.length,
    found_new: evs.filter(e => e.foundNew === true).length,
    failed: evs.filter(e => e.foundNew === null).length,
    byEngine: evs.reduce<Record<string, number>>((m, e) => ({ ...m, [e.engine]: (m[e.engine] ?? 0) + 1 }), {}),
    times: evs.map(e => `${e.engine}@${new Date(e.at).toISOString()}`),
})

/** One line for the final summary / FAIL-NOTE. */
export const reconnectLine = (evs: readonly ReconnectEvent[] = events): string => {
    const s = reconnectSummary(evs)
    if (!s.count) return 'Stale-view reconnects: 0'
    return `Stale-view reconnects: ${s.count} (found new data: ${s.found_new}, failed: ${s.failed}) — ` +
        Object.entries(s.byEngine).map(([e, n]) => `${e}×${n}`).join(', ') +
        '. A re-read that found new data means the cached sync view was frozen — possible sync bug, see RECONNECTS.md.'
}

const cest = (ms: number) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Brussels' }).replace(' ', 'T')

export const renderReconnectsMd = (evs: readonly ReconnectEvent[] = events): string => {
    const lines = [
        '# Stale-view reconnects',
        '',
        reconnectLine(evs),
        '',
        'Every forced reconnect of the walker\'s store view (r66 guard). `found new` = the fresh connection saw store',
        'changes the cached view lacked (frozen sync view — treat as a possible sync bug, not just healed).',
        '',
        '| # | Pi | Time (CEST) | Reason | Found new | Took ms | Heads before → after |',
        '|---|---|---|---|---|---|---|',
        ...evs.map((e, i) =>
            `| ${i + 1} | ${e.engine} | ${cest(e.at)} | ${e.reason.replace(/\|/g, '/')} | ` +
            `${e.foundNew === null ? `reconnect FAILED: ${(e.error ?? '').replace(/\|/g, '/')}` : e.foundNew ? 'YES' : 'no'} | ${e.tookMs} | ` +
            `${e.beforeHeads} → ${e.afterHeads} |`),
    ]
    return lines.join('\n') + '\n'
}

export const writeReconnectsMd = (dir: string, evs: readonly ReconnectEvent[] = events): string => {
    const p = join(dir, 'RECONNECTS.md')
    writeFileSync(p, renderReconnectsMd(evs))
    return p
}

/** How long a doc may stay unchanged (while the Pi is up) before an op wait forces a reconnect. */
export const staleViewMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const v = Number(env.DURATION_STALE_VIEW_MS)
    return env.DURATION_STALE_VIEW_MS?.trim() && Number.isFinite(v) && v >= 10_000 ? v : 120_000
}

export const headsKey = (h: readonly string[] | null | undefined): string => (h && h.length ? [...h].sort().map(x => x.slice(0, 8)).join(',') : 'none')
