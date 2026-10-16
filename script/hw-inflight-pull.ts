/**
 * hw-inflight-pull.ts — verdict for the hw-roundtrip "pull-out during an in-flight start"
 * case (#179/#180). Pure functions, unit-tested in test/automated/hw-inflight-pull.test.ts.
 *
 * Expected behaviour on a physical removal (device gone → undockAllOnDevice →
 * undockDisk(..., { waitInFlight: false })):
 *   - the pulled disk is undocked at once: no in-flight wait (the eject bound is 120 s),
 *   - the Engine never logs the eject-wait lines for that disk,
 *   - the instance whose start was in flight ends 'Undocked' and stays so (the late start
 *     must not turn it into Running / Starting / Error against the gone disk),
 *   - after re-plug every partition re-docks exactly once (checked by hw-roundtrip's checkDocked)
 *     and the instance is not left in Error or stuck in Starting.
 */

export interface Check { ok: boolean; what: string; detail: string }

/** Default upper bound for "at once": far below the 120 s eject wait, above udev + store latency. */
export const UNDOCK_AT_ONCE_MS = 20_000

/** Engine log lines that prove the eject in-flight wait ran for `diskId` (InstanceInFlight / undockDisk). */
export const inflightWaitLines = (log: string, diskId: string): string[] =>
    log.split('\n').filter(l =>
        (l.includes('Waiting up to') && l.includes(`on disk ${diskId} to settle before undock`))
        || l.includes(`Undock ${diskId}: still in flight after`)
        || l.includes(`Undock ${diskId}: in-flight start(s) settled after`))

export interface PullObservation {
    diskId: string
    instanceId: string
    /** Instance status sampled right before the unplug write. */
    statusAtUnplug: string | null
    /** startInstance trace for the instance still 'running' right before the unplug write. */
    startTraceRunningAtUnplug: boolean
    unpluggedAt: number
    /** First time the store showed dockedTo/device null for diskId; null = never within the timeout. */
    undockedAt: number | null
    /** Engine log from just before the unplug until the post-undock watch ended. */
    logSinceUnplug: string
    /** Instance statuses sampled from the undock until the watch ended (in order). */
    statusesAfterUndock: string[]
    boundMs?: number
}

export const inflightPullChecks = (o: PullObservation): Check[] => {
    const bound = o.boundMs ?? UNDOCK_AT_ONCE_MS
    const out: Check[] = []
    const c = (ok: boolean, what: string, detail = '') => out.push({ ok, what, detail })
    c(o.statusAtUnplug === 'Starting' || o.startTraceRunningAtUnplug,
        `in-flight: startInstance ${o.instanceId} was in flight at the unplug`,
        `status=${o.statusAtUnplug} startTraceRunning=${o.startTraceRunningAtUnplug}`)
    const took = o.undockedAt === null ? null : o.undockedAt - o.unpluggedAt
    c(took !== null && took <= bound,
        `in-flight: ${o.diskId} undocked at once after the pull-out (≤ ${bound / 1000} s, no 120 s in-flight wait)`,
        took === null ? 'never undocked within the timeout' : `took ${took} ms`)
    const waits = inflightWaitLines(o.logSinceUnplug, o.diskId)
    c(waits.length === 0, `in-flight: Engine did not run the eject in-flight wait for ${o.diskId}`, waits.slice(0, 3).join(' | '))
    const last = o.statusesAfterUndock[o.statusesAfterUndock.length - 1] ?? null
    c(last === 'Undocked', `in-flight: instance ${o.instanceId} ends 'Undocked' after the pull-out`, `last=${last}`)
    const bad = [...new Set(o.statusesAfterUndock.filter(s => s === 'Running' || s === 'Error'))]
    c(bad.length === 0, `in-flight: instance ${o.instanceId} never Running/Error against the pulled disk`, `seen ${JSON.stringify(o.statusesAfterUndock)}`)
    return out
}

/** After re-plug + settle: the instance is neither in Error nor stuck in Starting. */
export const inflightReplugChecks = (instanceId: string, statusAfterReplug: string | null): Check[] => [{
    ok: !!statusAfterReplug && statusAfterReplug !== 'Error' && statusAfterReplug !== 'Starting',
    what: `in-flight: instance ${instanceId} not Error / stuck Starting after re-plug`,
    detail: `status=${statusAfterReplug}`,
}]
