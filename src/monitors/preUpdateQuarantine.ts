/**
 * preUpdateQuarantine.ts — idea#396 24 h cleanup of a pre-update snapshot.
 *
 * After updateApp's Health gate passes, Instance.preUpdateGate records when
 * (wall `at` if the clock was trusted, else null) and the boot/uptime. A
 * scanner at start, on dock, and on an hourly in-memory tick fires
 * `idea-app-data quarantine-snapshot` when the instance's disk is docked here
 * and either (a) `at` is set, the clock is trusted (evaluateClockTrust via
 * the #400 scheduler, not raw NTPSynchronized) and now >= at + 24 h, or
 * (b) the same bootId is still running and uptime - uptimeS >= 24 h.
 *
 * Never blocks updateApp or startup. The instance lock is acquired as
 * 'preUpdateQuarantine' without waiting; a busy instance, a helper failure
 * or an undock keeps the field and retries later.
 */
import { DocHandle } from '@automerge/automerge-repo'
import type { Store } from '../data/Store.js'
import type { Disk } from '../data/Disk.js'
import type { Instance } from '../data/Instance.js'
import type { InstanceID } from '../data/CommonTypes.js'
import { resourceLock, instanceKey } from '../utils/ResourceLock.js'
import { runAppData, quarantineSnapshotArgs, parseQuarantineSnapshot, helperAtLeast } from '../utils/appDataHelper.js'
import { appDataRoot } from '../data/Disk.js'
import { refreshPreUpdateSnapshots, defaultUpdateDeps, writePreUpdateGate } from '../data/UpdateApp.js'
import { defaultReadBootId, defaultReadUptimeS } from '../usage/sampler.js'
import { engineClockTrusted } from '../utils/engineClockStatus.js'
import { quarantineAfterMs } from '../data/Config.js'
import { log } from '../utils/utils.js'
import { isStrictInstanceId } from '../utils/instanceIds.js'

export const PRE_UPDATE_QUARANTINE_HELPER_MIN = 14
export const PRE_UPDATE_QUARANTINE_TICK_MS = 60 * 60 * 1000
export const PRE_UPDATE_QUARANTINE_KIND = 'preUpdateQuarantine'

export interface PreUpdateGate {
    at: number | null
    bootId: string
    uptimeS: number
}

export interface QuarantineScannerDeps {
    wallMs: () => number
    uptimeS: () => number
    bootId: () => string
    clockTrusted: () => boolean
    afterMs: () => number
    helperProblem: () => Promise<string | null>
    quarantineSnapshot: (disk: Disk, id: InstanceID) => Promise<string>
    refreshSnapshots: (disk: Disk) => Promise<unknown>
    acquire: (id: InstanceID) => boolean
    release: (id: InstanceID) => void
    log: (msg: string) => void
}

export const defaultQuarantineScannerDeps = (storeHandle: DocHandle<Store>): QuarantineScannerDeps => ({
    wallMs: () => Date.now(),
    uptimeS: defaultReadUptimeS,
    bootId: defaultReadBootId,
    clockTrusted: engineClockTrusted,
    afterMs: quarantineAfterMs,
    helperProblem: () => helperAtLeast(PRE_UPDATE_QUARANTINE_HELPER_MIN, 'preUpdateQuarantine'),
    quarantineSnapshot: async (disk, id) =>
        parseQuarantineSnapshot(await runAppData(quarantineSnapshotArgs(await appDataRoot(disk), String(id)))),
    refreshSnapshots: (disk) => refreshPreUpdateSnapshots(storeHandle, disk, defaultUpdateDeps(storeHandle).listSnapshots),
    acquire: (id) => resourceLock.acquire(instanceKey(id), PRE_UPDATE_QUARANTINE_KIND),
    release: (id) => resourceLock.release(instanceKey(id)),
    log,
})

/**
 * (a) trusted wall clock and at + afterMs reached, or (b) same boot and
 * uptime has advanced by afterMs. A missing gate is never due.
 */
export const isPreUpdateQuarantineDue = (
    gate: PreUpdateGate | null | undefined,
    now: number,
    bootId: string,
    uptimeS: number,
    clockTrusted: boolean,
    afterMs: number,
): boolean => {
    if (!gate) return false
    if (gate.at != null && clockTrusted && now >= gate.at + afterMs) return true
    if (gate.bootId === bootId && (uptimeS - gate.uptimeS) * 1000 >= afterMs) return true
    return false
}

/**
 * When the clock becomes trusted after Health wrote at=null: same boot keeps
 * the window start at the health gate (`now - (uptime - uptimeS)`); a new
 * boot starts the 24 h at this first trusted moment.
 */
export const trustedAtPatch = (
    gate: PreUpdateGate | null | undefined,
    now: number,
    bootId: string,
    uptimeS: number,
    clockTrusted: boolean,
): PreUpdateGate | null => {
    if (!gate || gate.at != null || !clockTrusted) return null
    if (gate.bootId === bootId) {
        return { at: now - Math.max(0, uptimeS - gate.uptimeS) * 1000, bootId: gate.bootId, uptimeS: gate.uptimeS }
    }
    return { at: now, bootId, uptimeS }
}

/** Reasons logged at most once per boot per instance. */
const logged = new Set<string>()
let helperWarned = false
let helperOk: boolean | null = null
let tick: ReturnType<typeof setInterval> | null = null

export const resetPreUpdateQuarantineForTests = (): void => {
    logged.clear()
    helperWarned = false
    helperOk = null
    if (tick) { clearInterval(tick); tick = null }
}

const once = (d: QuarantineScannerDeps, key: string, msg: string): void => {
    if (logged.has(key)) return
    logged.add(key)
    d.log(msg)
}

export const scanPreUpdateQuarantine = async (
    storeHandle: DocHandle<Store>,
    deps: Partial<QuarantineScannerDeps> = {},
    onlyDiskId?: string,
): Promise<number> => {
    const d: QuarantineScannerDeps = { ...defaultQuarantineScannerDeps(storeHandle), ...deps }
    const store = storeHandle.doc()
    // This process only sees a disk as `device` when it is docked here.
    const now = d.wallMs()
    const bootId = d.bootId()
    const uptimeS = d.uptimeS()
    const trusted = d.clockTrusted()
    const afterMs = d.afterMs()

    if (helperOk === null) {
        const problem = await d.helperProblem()
        helperOk = !problem
        if (problem && !helperWarned) {
            helperWarned = true
            d.log(`preUpdateQuarantine: ${problem}; keeping Instance.preUpdateGate until the helper is updated`)
        }
    }
    if (!helperOk) return 0

    let fired = 0
    for (const inst of Object.values(store.instanceDB ?? {}) as Instance[]) {
        if (!inst?.preUpdateGate) continue
        if (!isStrictInstanceId(String(inst.id))) continue
        const disk = inst.storedOn ? store.diskDB[inst.storedOn] as Disk | undefined : undefined
        if (!disk || !disk.device || !disk.dockedTo) continue
        if (onlyDiskId && String(disk.id) !== String(onlyDiskId)) continue

        const patch = trustedAtPatch(inst.preUpdateGate, now, bootId, uptimeS, trusted)
        if (patch) {
            writePreUpdateGate(storeHandle, inst.id, patch)
        }
        const gate = patch ?? inst.preUpdateGate
        if (!isPreUpdateQuarantineDue(gate, now, bootId, uptimeS, trusted, afterMs)) continue

        if (!d.acquire(inst.id)) {
            once(d, `${inst.id}:busy`, `preUpdateQuarantine: ${inst.id} is busy; will retry`)
            continue
        }
        try {
            const dest = await d.quarantineSnapshot(disk, inst.id)
            writePreUpdateGate(storeHandle, inst.id, null)
            try { await d.refreshSnapshots(disk) } catch (e) {
                d.log(`preUpdateQuarantine: ${inst.id}: refresh of pre-update snapshots failed: ${(e as Error).message}`)
            }
            d.log(dest
                ? `preUpdateQuarantine: ${inst.id}: snapshot moved to ${dest}`
                : `preUpdateQuarantine: ${inst.id}: nothing to quarantine`)
            fired++
        } catch (e) {
            const why = (e as Error).message ?? String(e)
            once(d, `${inst.id}:fail:${why}`, `preUpdateQuarantine: ${inst.id} failed: ${why}; keeping the gate and retrying later`)
        } finally {
            d.release(inst.id)
        }
    }
    return fired
}

/** Start the hourly tick and run one scan now (start.ts). */
export const startPreUpdateQuarantine = (storeHandle: DocHandle<Store>, deps: Partial<QuarantineScannerDeps> = {}): void => {
    if (tick) return
    const run = () => { scanPreUpdateQuarantine(storeHandle, deps).catch(e => log(`preUpdateQuarantine: ${(e as Error).message}`)) }
    run()
    tick = setInterval(run, PRE_UPDATE_QUARANTINE_TICK_MS)
    // Do not keep the process alive for this timer alone.
    if (tick && typeof tick === 'object' && 'unref' in tick) (tick as NodeJS.Timeout).unref()
    log(`preUpdateQuarantine: hourly scanner started (idea#396)`)
}
