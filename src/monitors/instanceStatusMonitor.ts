/**
 * instanceStatusMonitor.ts — engine#428
 *
 * Re-probes instances left at Error after a port-ready timeout (statusCondition
 * starting with PORT_NOT_READY:). Every minute, while the instance's disk is
 * docked here, the record is still that Error, and its compose containers are
 * still up, the same HTTP probe and stable window are used. When the probe
 * passes, the record becomes Running and statusCondition is cleared. Any other
 * Error (compose failure, exited containers, a legacy dotted id) is never healed.
 * Healing stops after 1 h from the `at=` timestamp written when the Error was
 * diagnosed (or from the first time this Engine saw the condition, if `at=` is
 * missing).
 *
 * This also covers slow first starts that did not come from a restore.
 */

import { $ } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../data/Store.js'
import { Disk, diskMountRoot as diskMountRootImpl } from '../data/Disk.js'
import {
    Instance,
    assertInstancePortReady,
    isPortNotReadyCondition,
    parsePortNotReadyAt,
    type Status,
} from '../data/Instance.js'
import { localEngineId } from '../data/Engine.js'
import { EngineID, InstanceID, Timestamp } from '../data/CommonTypes.js'
import { isInstanceDockedOn } from '../data/UndockedApps.js'
import { composeProjectLabelFilter, isLegacyDottedInstanceId } from '../utils/instanceIds.js'
import { dockerAvailable } from '../utils/dockerAvailable.js'
import { log } from '../utils/utils.js'

$.verbose = false

export const PORT_NOT_READY_HEAL_INTERVAL_MS = 60_000
export const PORT_NOT_READY_HEAL_WINDOW_MS = 60 * 60 * 1000

export type ContainersUpCheck = (instanceId: InstanceID) => Promise<boolean>
export type ProbeReadyCheck = (instance: Instance, disk: Disk) => Promise<boolean>

export interface HealPortNotReadyOpts {
    now?: () => number
    engineId?: EngineID
    healWindowMs?: number
    containersUp?: ContainersUpCheck
    probeReady?: ProbeReadyCheck
    stableMs?: number
    probeTimeoutMs?: number
    diskMountRoot?: (disk: Disk) => Promise<string>
}

/** First time this process saw a PORT_NOT_READY condition that had no `at=`. */
const firstSeenAt = new Map<string, number>()

export const resetPortNotReadyHealStateForTests = (): void => {
    firstSeenAt.clear()
}

/** Compose containers of this instance are running (up), without requiring a healthcheck. */
export const dockerComposeContainersUp: ContainersUpCheck = async (instanceId) => {
    if (!await dockerAvailable()) return false
    try {
        const projectFilter = composeProjectLabelFilter(String(instanceId))
        if (!projectFilter) return false
        const ps = await $`docker ps -q --filter ${projectFilter}`
        return ps.stdout.trim().length > 0
    } catch {
        return false
    }
}

const healDeadlineOf = (instanceId: string, condition: string, now: number, windowMs: number): number => {
    const at = parsePortNotReadyAt(condition)
    if (at != null) {
        firstSeenAt.delete(instanceId)
        return at + windowMs
    }
    let seen = firstSeenAt.get(instanceId)
    if (seen == null) {
        seen = now
        firstSeenAt.set(instanceId, seen)
    }
    return seen + windowMs
}

const defaultProbeReady = async (
    instance: Instance,
    disk: Disk,
    opts: HealPortNotReadyOpts,
): Promise<boolean> => {
    const port = Number(instance.port) || 0
    if (!port) return false
    const mountRoot = await (opts.diskMountRoot ?? diskMountRootImpl)(disk)
    const instanceDir = `${mountRoot}/instances/${instance.id}`
    const stableMs = opts.stableMs ?? 10_000
    const probeTimeoutMs = opts.probeTimeoutMs ?? 2_000
    try {
        await assertInstancePortReady(instance.id, port, instanceDir, {
            readyTimeoutMs: stableMs + probeTimeoutMs + 1_000,
            stableMs,
            probeTimeoutMs,
            forceRecreate: false,
        })
        return true
    } catch {
        return false
    }
}

const markRunning = (storeHandle: DocHandle<Store>, instanceId: InstanceID, engineId: EngineID, now: number): boolean => {
    let wrote = false
    storeHandle.change(doc => {
        const inst = doc.instanceDB[instanceId]
        if (!inst || inst.status !== 'Error' || !isPortNotReadyCondition(inst.statusCondition)) return
        if (!isInstanceDockedOn(doc, inst, engineId)) return
        inst.status = 'Running' as Status
        inst.statusCondition = null
        inst.lastStarted = now as Timestamp
        wrote = true
    })
    return wrote
}

/**
 * One heal pass. Exported for tests. Never throws; a failed probe or check
 * leaves the Error in place.
 */
export const healPortNotReadyErrors = async (
    storeHandle: DocHandle<Store>,
    opts: HealPortNotReadyOpts = {},
): Promise<void> => {
    const now = (opts.now ?? Date.now)()
    const engineId = opts.engineId ?? localEngineId
    const windowMs = opts.healWindowMs ?? PORT_NOT_READY_HEAL_WINDOW_MS
    const containersUp = opts.containersUp ?? dockerComposeContainersUp
    const store = storeHandle.doc()
    if (!store) return

    const candidates = Object.values(store.instanceDB ?? {}).filter((inst): inst is Instance => {
        if (!inst || inst.status !== 'Error') return false
        if (isLegacyDottedInstanceId(String(inst.id))) return false
        if (!isPortNotReadyCondition(inst.statusCondition)) return false
        if (!isInstanceDockedOn(store, inst, engineId)) return false
        return true
    })

    const seenIds = new Set(candidates.map(i => String(i.id)))
    for (const id of [...firstSeenAt.keys()]) {
        if (!seenIds.has(id)) firstSeenAt.delete(id)
    }

    await Promise.all(candidates.map(async (instance) => {
        const instanceId = instance.id
        const condition = String(instance.statusCondition ?? '')
        if (now > healDeadlineOf(String(instanceId), condition, now, windowMs)) return
        const disk = instance.storedOn ? store.diskDB[instance.storedOn] : undefined
        if (!disk) return
        let up = false
        try {
            up = await containersUp(instanceId)
        } catch (e) {
            log(`instanceStatusMonitor: cannot read containers of ${instanceId} (${e}); leaving Error`)
            return
        }
        if (!up) return
        let ready = false
        try {
            ready = opts.probeReady
                ? await opts.probeReady(instance, disk as Disk)
                : await defaultProbeReady(instance, disk as Disk, opts)
        } catch (e) {
            log(`instanceStatusMonitor: probe of ${instanceId} failed (${e}); leaving Error`)
            return
        }
        if (!ready) return
        if (markRunning(storeHandle, instanceId, engineId, now)) {
            firstSeenAt.delete(String(instanceId))
            log(`Instance ${instanceId}: PORT_NOT_READY heal — app answered HTTP; status set to Running`)
        }
    }))
}

/**
 * Start the every-minute PORT_NOT_READY re-probe. Ticks once immediately so a
 * late-ready app already at Error at boot is not left waiting a full minute.
 */
export const enableInstanceStatusMonitor = (
    storeHandle: DocHandle<Store>,
    opts: HealPortNotReadyOpts & { intervalMs?: number } = {},
): { stop: () => void } => {
    const intervalMs = opts.intervalMs ?? PORT_NOT_READY_HEAL_INTERVAL_MS
    const tick = () => {
        void healPortNotReadyErrors(storeHandle, opts).catch(e =>
            log(`instanceStatusMonitor: ${e}`),
        )
    }
    tick()
    const timer = setInterval(tick, intervalMs)
    return { stop: () => clearInterval(timer) }
}
