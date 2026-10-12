/**
 * InstanceInFlight.ts — in-flight instance starts/installs per disk (#179).
 *
 * ejectDisk/undockDisk must not stop and unmount a disk while a start (or an install
 * that ends in a start) is still running on it: the start would carry on against the
 * unmounted disk and leave the row in Error/Pauzed (idea#168 r82b/r83). There is no
 * cancel API, so the undock waits for those to settle (bounded), then stops them.
 */
import { log } from '../utils/utils.js'

const inFlight = new Map<string, { diskId: string; label: string; promise: Promise<unknown> }>()
let seq = 0

/** Register `promise` as in flight on `diskId` until it settles (resolve or reject). */
export const trackInFlight = <T>(diskId: string, label: string, promise: Promise<T>): Promise<T> => {
    const key = `${label}#${++seq}`
    inFlight.set(key, { diskId: String(diskId), label, promise })
    const done = () => { inFlight.delete(key) }
    promise.then(done, done)
    return promise
}

/** Labels of the operations currently in flight on `diskId`. */
export const inFlightOnDisk = (diskId: string): string[] =>
    [...inFlight.values()].filter(e => e.diskId === String(diskId)).map(e => e.label)

/** Default bound for the eject wait; IDEA_EJECT_INFLIGHT_WAIT_MS overrides. */
export const ejectInFlightWaitMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const n = Number(env.IDEA_EJECT_INFLIGHT_WAIT_MS)
    return Number.isFinite(n) && n >= 0 && env.IDEA_EJECT_INFLIGHT_WAIT_MS !== undefined && env.IDEA_EJECT_INFLIGHT_WAIT_MS !== '' ? n : 120_000
}

/**
 * Wait until nothing is in flight on `diskId`, at most `timeoutMs`. Never throws:
 * returns what settled and what was still running at the timeout (the caller then stops it).
 */
export const waitInFlightOnDisk = async (diskId: string, timeoutMs: number): Promise<{ waitedMs: number; timedOut: string[] }> => {
    const t0 = Date.now()
    for (;;) {
        const pending = [...inFlight.values()].filter(e => e.diskId === String(diskId))
        if (pending.length === 0) return { waitedMs: Date.now() - t0, timedOut: [] }
        const left = timeoutMs - (Date.now() - t0)
        if (left <= 0) return { waitedMs: Date.now() - t0, timedOut: pending.map(e => e.label) }
        log(`Waiting up to ${left}ms for ${pending.map(e => e.label).join(', ')} on disk ${diskId} to settle before undock`)
        let timer: NodeJS.Timeout | undefined
        await Promise.race([
            Promise.allSettled(pending.map(e => e.promise)),
            new Promise<void>(r => { timer = setTimeout(r, left) }),
        ])
        if (timer) clearTimeout(timer)
    }
}

/** Test hook. */
export const resetInFlightForTests = (): void => { inFlight.clear() }
