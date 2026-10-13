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

// ── Undock pending + dock identity (hw180 idea04, 2026-10-13) ───────────────────────────

const undockPending = new Map<string, number>()

/** An undock (eject, erase or physical removal) of `diskId` has begun and has not finished. */
export const markUndockPending = (diskId: string): void => { undockPending.set(String(diskId), (undockPending.get(String(diskId)) ?? 0) + 1) }
export const clearUndockPending = (diskId: string): void => {
    const n = (undockPending.get(String(diskId)) ?? 0) - 1
    if (n > 0) undockPending.set(String(diskId), n); else undockPending.delete(String(diskId))
}
export const isUndockPending = (diskId: string): boolean => (undockPending.get(String(diskId)) ?? 0) > 0

/** What identifies one dock of a disk: device node, engine, dock time (generation). */
export interface DockIdentity { device: string | null; dockedTo: string | null; lastDocked: number | null }
export const dockIdentityOf = (d: { device?: unknown; dockedTo?: unknown; lastDocked?: unknown } | null | undefined): DockIdentity => ({
    device: (d?.device as string) ?? null, dockedTo: (d?.dockedTo as string) ?? null, lastDocked: (d?.lastDocked as number) ?? null,
})

/**
 * Why the dock `before` (captured when the eject began) is no longer the disk's current dock
 * `now` (store record after the in-flight wait); null when it is still the same dock.
 */
export const dockChangedReason = (before: DockIdentity, now: DockIdentity | null): string | null => {
    if (!now || !now.dockedTo || !now.device) return `disk is no longer docked (was ${before.device})`
    if (now.dockedTo !== before.dockedTo) return `disk is now docked to ${now.dockedTo} (was ${before.dockedTo})`
    if (now.device !== before.device) return `disk was re-docked on ${now.device} (was ${before.device})`
    if (now.lastDocked !== before.lastDocked) return `disk was re-docked on ${now.device} (dock generation ${before.lastDocked} → ${now.lastDocked})`
    return null
}

/**
 * Why a failed start on `diskId` is a pulled disk rather than a real start failure; null = real failure.
 * `deviceAtStart` is the device the start ran against; `deviceExists` checks the node (injected for tests).
 */
export const startDiskGoneReason = (diskId: string, deviceAtStart: string | null, now: DockIdentity | null,
    deviceExists: ((dev: string) => boolean) | null): string | null => {
    if (isUndockPending(diskId)) return 'an undock of the disk is pending'
    if (!now || !now.dockedTo || !now.device) return 'the disk is no longer docked'
    if (deviceAtStart && now.device !== deviceAtStart) return `the disk moved from ${deviceAtStart} to ${now.device}`
    if (deviceExists && deviceAtStart && !deviceExists(deviceAtStart)) return `device ${deviceAtStart} is gone`
    return null
}

/** Test hook. */
export const resetUndockPendingForTests = (): void => { undockPending.clear() }
