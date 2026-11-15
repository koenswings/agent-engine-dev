/**
 * DataBytes.ts: Instance.dataBytes / dataBytesAt, the App data size per instance (engine#430)
 *
 * The Console needs "This Pi's Apps use about X GB" for backup sizing and disk-full
 * advice. It sums dataBytes over the instances on disks docked to an Engine; there is
 * no Engine total in the store, so no second figure can disagree.
 *
 * - What: the instance folder (instances/<id>), measured as root by the existing
 *   `idea-app-data size` (instanceDataBytes, du -sk -x). The App master is not counted.
 * - Where: only on the Engine the instance's disk is docked to.
 * - When: after the dock pass (each instance on that disk), after every successful
 *   backup, and every 24 h for all instances docked here.
 * - How: one instance at a time, at low priority (nice -n 19 ionice -c3 around the same
 *   sudo call; the root helper and sudoers are unchanged). Never while the instance or
 *   its disk is locked (backup, restore, copy, move, …): that instance is retried at the
 *   next chance (every DATA_BYTES_RETRY_MS while one is waiting). Measuring takes no lock.
 * - Store growth: rounded to whole MB (1,000,000 bytes, as DiskSize.ts) and written only
 *   when it changed by more than 5% of the stored value or 100 MB, whichever is larger.
 *   A first value is always written. dataBytesAt is the time of that write.
 * - Failure (helper missing, too old, refused, timeout): the stored value stays, one log
 *   line, no trace and no Error status. An instance never measured keeps null.
 */

import { DocHandle } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { AppDataRunner, instanceDataBytes, runAppDataLowPriority } from '../utils/appDataHelper.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { Store } from './Store.js'
import { Disk, appDataRoot } from './Disk.js'
import { EngineID, InstanceID, Timestamp } from './CommonTypes.js'
import { localEngineId } from './Engine.js'

export const DATA_BYTES_ROUNDING = 1_000_000                 // whole MB
export const DATA_BYTES_MIN_CHANGE = 100_000_000             // 100 MB
export const DATA_BYTES_CHANGE_FRACTION = 0.05               // 5% of the stored value
export const DATA_BYTES_INTERVAL_MS = 24 * 60 * 60 * 1000    // 24 h
export const DATA_BYTES_RETRY_MS = 60 * 1000                 // a locked instance is retried after 1 min

export const roundDataBytes = (n: number): number => Math.round(n / DATA_BYTES_ROUNDING) * DATA_BYTES_ROUNDING

/**
 * Write rule (pure): a first value (old null/absent) is always written; otherwise only
 * a change of more than max(5% of old, 100 MB). Both values are rounded bytes.
 */
export const shouldWriteDataBytes = (old: number | null | undefined, next: number): boolean => {
    if (old == null) return true
    return Math.abs(next - old) > Math.max(old * DATA_BYTES_CHANGE_FRACTION, DATA_BYTES_MIN_CHANGE)
}

export type DataBytesResult = 'written' | 'unchanged' | 'locked' | 'not-docked' | 'failed'

export interface DataBytesOptions {
    engineId?: EngineID
    /** Runs the helper (default: nice -n 19 ionice -c3 sudo -n idea-app-data). */
    run?: AppDataRunner
    /** The helper's root token for the disk (default appDataRoot). */
    rootOf?: (disk: Disk) => Promise<string>
    now?: () => number
}

/**
 * Measure one instance and store the result when the write rule says so. Returns what
 * happened; never throws (a failure keeps the stored value and logs one line).
 */
export const measureInstanceDataBytes = async (
    storeHandle: DocHandle<Store>, instanceId: InstanceID, opts: DataBytesOptions = {},
): Promise<DataBytesResult> => {
    const engineId = opts.engineId ?? localEngineId
    const store = storeHandle.doc()
    const instance = store?.instanceDB?.[instanceId]
    const disk = instance?.storedOn ? store.diskDB?.[instance.storedOn] : undefined
    if (!instance || !disk || disk.device == null || String(disk.dockedTo) !== String(engineId)) return 'not-docked'
    if (resourceLock.isLocked(instanceKey(String(instanceId))) || resourceLock.isLocked(diskKey(String(disk.id)))) return 'locked'
    let bytes: number
    try {
        const root = await (opts.rootOf ?? appDataRoot)(disk)
        bytes = roundDataBytes(await instanceDataBytes(root, String(instanceId), opts.run ?? runAppDataLowPriority))
    } catch (e: any) {
        log(`[dataBytes] could not measure the App data of ${instanceId}; keeping ${instance.dataBytes ?? 'null'}: ${e?.message ?? e}`)
        return 'failed'
    }
    const now = (opts.now ?? Date.now)()
    let written = false
    storeHandle.change(doc => {
        const inst = doc.instanceDB?.[instanceId]
        if (!inst || !shouldWriteDataBytes(inst.dataBytes, bytes)) return
        inst.dataBytes = bytes
        inst.dataBytesAt = now as Timestamp
        written = true
    })
    return written ? 'written' : 'unchanged'
}

/**
 * The measurement queue: one instance at a time, in request order. An instance found
 * locked waits and is requested again after retryMs (the "next chance").
 */
export class DataBytesQueue {
    private queue: InstanceID[] = []
    private waiting = new Set<InstanceID>()
    private running: Promise<void> | null = null
    private retryTimer: NodeJS.Timeout | null = null
    private storeHandle: DocHandle<Store> | null = null
    constructor(private opts: DataBytesOptions & { retryMs?: number } = {}) {}

    request(storeHandle: DocHandle<Store>, ids: InstanceID[]): void {
        this.storeHandle = storeHandle
        for (const id of ids) if (!this.queue.includes(id)) this.queue.push(id)
        if (!this.running && this.queue.length) {
            this.running = this.drain().finally(() => {
                this.running = null
                if (this.queue.length && this.storeHandle) this.request(this.storeHandle, [])
            })
        }
    }

    /** Resolves when nothing is being measured (retries still waiting do not count). */
    async idle(): Promise<void> {
        while (this.running) await this.running
    }

    /** Instances that were locked and wait for their retry. */
    waitingIds(): InstanceID[] { return [...this.waiting] }

    stop(): void {
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryTimer = null
        this.queue = []
        this.waiting.clear()
    }

    private async drain(): Promise<void> {
        while (this.queue.length && this.storeHandle) {
            const id = this.queue.shift() as InstanceID
            this.waiting.delete(id)
            const result = await measureInstanceDataBytes(this.storeHandle, id, this.opts)
            if (result === 'locked') this.waiting.add(id)
        }
        if (this.waiting.size && !this.retryTimer) {
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null
                const ids = [...this.waiting]
                this.waiting.clear()
                if (this.storeHandle) this.request(this.storeHandle, ids)
            }, this.opts.retryMs ?? DATA_BYTES_RETRY_MS)
            this.retryTimer.unref?.()
        }
    }
}

/** The Engine's queue (one measurement at a time for the whole Engine). */
export const dataBytesQueue = new DataBytesQueue()

/** Instances on `diskId` whose disk is docked to `engineId`. */
export const instancesOnDockedDisk = (store: Store, diskId: string, engineId: EngineID): InstanceID[] => {
    const disk = store.diskDB?.[diskId as any]
    if (!disk || String(disk.dockedTo) !== String(engineId)) return []
    return Object.values(store.instanceDB ?? {})
        .filter(inst => !!inst && String(inst.storedOn) === String(diskId))
        .map(inst => inst.id)
}

/** Instances on every disk docked to `engineId` (the 24 h pass). */
export const instancesDockedOn = (store: Store, engineId: EngineID): InstanceID[] =>
    Object.values(store.diskDB ?? {})
        .filter(d => !!d && d.device != null && String(d.dockedTo) === String(engineId))
        .flatMap(d => instancesOnDockedDisk(store, String(d.id), engineId))

/** After the dock pass of `diskId`: queue each instance on it. Returns the queued ids. */
export const requestDataBytesForDisk = (
    storeHandle: DocHandle<Store>, diskId: string, engineId: EngineID = localEngineId, queue: DataBytesQueue = dataBytesQueue,
): InstanceID[] => {
    const ids = instancesOnDockedDisk(storeHandle.doc(), diskId, engineId)
    if (ids.length) queue.request(storeHandle, ids)
    return ids
}

/** After a successful backup (or any single-instance trigger). */
export const requestDataBytes = (storeHandle: DocHandle<Store>, ids: InstanceID[], queue: DataBytesQueue = dataBytesQueue): void => {
    queue.request(storeHandle, ids)
}

let dailyTimer: NodeJS.Timeout | null = null

/** The 24 h pass over every instance docked to this Engine. */
export const startDataBytesMonitor = (
    storeHandle: DocHandle<Store>, engineId: EngineID = localEngineId, intervalMs = DATA_BYTES_INTERVAL_MS, queue: DataBytesQueue = dataBytesQueue,
): void => {
    if (dailyTimer) clearInterval(dailyTimer)
    dailyTimer = setInterval(() => {
        try { queue.request(storeHandle, instancesDockedOn(storeHandle.doc(), engineId)) } catch (e: any) {
            log(`[dataBytes] daily pass: ${e?.message ?? e}`)
        }
    }, intervalMs)
    dailyTimer.unref()
}

export const stopDataBytesMonitor = (): void => {
    if (dailyTimer) clearInterval(dailyTimer)
    dailyTimer = null
}
