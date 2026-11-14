/**
 * backupScheduler.ts — the scheduled Backup Disk tick (idea#400, PR C)
 *
 * Design: docs/BACKUP_SCHEDULE.md. The decisions are pure functions in
 * utils/backupSchedule.ts (PR A); BACKUP.yaml edits and per-attempt results are
 * PR B. This module only wires them to the store, the disk and a 60 s timer:
 *
 *  - One `setInterval` inside the Engine (pm2, as pi), never a host cron job.
 *  - Only Backup Disks docked to this Engine in `scheduled` mode. A disk whose
 *    BACKUP.yaml schedule does not parse runs at the 02:30 default, and
 *    backupConfig.scheduleError says why (Steve, #347 call 5 and #351 call 1).
 *  - A tick that has nothing to do writes nothing to the store. A run writes
 *    BACKUP.yaml (lastRun, lastAttempt, missedRuns, the uptime counter reset) when
 *    it starts, the per-instance results as PR B does, and ONE store change when it
 *    ends (lastAttempt, missedRuns, freePct). clockTrusted / clockReason change
 *    only when their value changes; backupConfig.schedule / scheduleError only when
 *    BACKUP.yaml changed.
 *  - The instances of one disk run one after another through backupInstance (cause
 *    `scheduled-backup`), with the same locks as a manual backupApp.
 *  - A held lock gives SKIPPED_LOCKED (recorded by backupInstance) and one catch-up
 *    as soon as the lock frees, inside the same window (Steve, Q3).
 *  - A FAILED attempt is retried once, after RETRY_DELAY_MS. A stale lock is never
 *    retried: the instance is left to the idea#446 flow (Steve, Q2), and its
 *    INTERRUPTED result (recorded at dock) stands.
 *  - lastRun is written at the start of the run, so a crash or restart mid-run never
 *    starts the same window again; crash recovery does not retry a scheduled op either.
 *
 * Clock trust inputs here: NTP synchronised since this Engine started, the build's
 * git commit time (dist/build-info.json, Q12), the newest backup timestamp of the
 * disk and its linked instances, and live peer clocks from the ephemeral hb
 * (engine#352; in memory only, never a store field).
 */

import { performance } from 'node:perf_hooks'
import { statfs } from 'node:fs/promises'
import { DocHandle } from '@automerge/automerge-repo'
import { chalk, fs } from 'zx'
import { log } from '../utils/utils.js'
import { disksRoot } from '../data/Config.js'
import { Disk, diskMountRoot, joinMountRoot, syncBackupOrphanLinks } from '../data/Disk.js'
import { localEngineId } from '../data/Engine.js'
import { peerClockViews } from '../data/Liveness.js'
import { Store, getInstance } from '../data/Store.js'
import { BackupResultCode, DiskID, EngineID, InstanceID, OperationCause, Timestamp } from '../data/CommonTypes.js'
import { readBackupYamlState, writeBackupScheduleState, BackupYamlState } from '../data/BackupYamlDoc.js'
import { recordBackupResult } from '../data/BackupResults.js'
import { resourceLock } from '../utils/ResourceLock.js'
import { readBuildInfo } from '../utils/buildInfo.js'
import { defaultReadBootId, defaultReadNtpSynced, defaultReadUptimeS } from '../usage/sampler.js'
import { bindEngineClockTrusted } from '../utils/engineClockStatus.js'
import {
    BackupDue, ClockJumpState, DEFAULT_BACKUP_TIME, ClockSample, ClockTrust, SkippedRun,
    advanceClockJumpState, advanceUptimeCounter, decideBackupDue, detectClockJump, effectiveSchedule,
    evaluateClockTrust, noteClockJump, peerClockInputs, resetUptimeCounter, scheduleNowMs, shouldPersistUptimeCounter,
    skippedCatchUpDue, testClockOffsetMs, windowIdFor, TEST_CLOCK_OFFSET_ENV,
} from '../utils/backupSchedule.js'
import {
    BACKUP_IN_PROGRESS, backupInstance, backupLockKeysFor, hasBackupStaleLock, isBackupActive,
} from './backupMonitor.js'

/** The tick interval (proposal §3.1). */
export const SCHEDULER_TICK_MS = 60_000
/** Wait before the one retry of a FAILED attempt (Steve, Q2: retry once on a transient failure). */
export const RETRY_DELAY_MS = 60_000
/** The cause every scheduled attempt carries (operationDB, the trace, crash recovery). */
export const SCHEDULED_BACKUP_CAUSE: OperationCause = 'scheduled-backup'

/** Everything the scheduler reads from the outside world. Tests replace these (fake clock). */
export interface SchedulerDeps {
    /** Wall time as the scheduler sees it (the test offset applies only when NODE_ENV=test, Q10). */
    wallMs: () => number
    /** Monotonic time, for jump detection. */
    monoMs: () => number
    uptimeS: () => number
    bootId: () => string
    ntpSynced: () => boolean
    /** The build's git commit time, or null when unknown (the check is skipped). */
    buildTimeMs: () => number | null
    diskUsage: (mountRoot: string) => Promise<{ totalBytes: number, freeBytes: number }>
    runBackup: (storeHandle: DocHandle<Store>, instanceId: InstanceID, backupDisk: Disk, cause: OperationCause) => Promise<void>
    sleep: (ms: number) => Promise<void>
}

const defaultDiskUsage = async (mountRoot: string) => {
    const s = await statfs(mountRoot)
    return { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) }
}

let cachedBuildTime: number | null | undefined
export const defaultSchedulerDeps = (): SchedulerDeps => ({
    wallMs: () => scheduleNowMs(Date.now()),
    monoMs: () => performance.now(),
    uptimeS: defaultReadUptimeS,
    bootId: defaultReadBootId,
    ntpSynced: defaultReadNtpSynced,
    buildTimeMs: () => {
        if (cachedBuildTime === undefined) cachedBuildTime = readBuildInfo()?.commitTimeMs ?? null
        return cachedBuildTime
    },
    diskUsage: defaultDiskUsage,
    runBackup: (h, id, disk, cause) => backupInstance(h, id, disk, undefined, cause),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
})

/** Rounded free space in percent; null when the size is unknown. */
export const freePctOf = (u: { totalBytes: number, freeBytes: number }): number | null =>
    u.totalBytes > 0 ? Math.round((u.freeBytes / u.totalBytes) * 100) : null

/** The newest backup timestamp the store holds for this disk: its lastAttempt and its linked instances' lastBackup / lastResult. */
export const newestBackupTimeFor = (store: Store, disk: Disk): number | null => {
    const times: number[] = []
    if (disk.lastAttempt != null) times.push(Number(disk.lastAttempt))
    for (const id of disk.backupConfig?.links ?? []) {
        const inst = store.instanceDB?.[id]
        if (!inst) continue
        if (inst.lastBackup != null) times.push(Number(inst.lastBackup))
        if (inst.lastResult?.time != null) times.push(Number(inst.lastResult.time))
    }
    const finite = times.filter(t => Number.isFinite(t) && t > 0)
    return finite.length ? Math.max(...finite) : null
}

/** A scheduled Backup Disk this Engine runs: docked here, a Backup Disk, mode scheduled. */
export const isScheduledHere = (disk: Disk | undefined, engineId: string): disk is Disk =>
    !!disk && !!disk.device && String(disk.dockedTo) === String(engineId) &&
    !!disk.diskTypes?.includes('backup') && disk.backupConfig?.mode === 'scheduled'

export class BackupScheduler {
    private prev: ClockSample | null = null
    private jump: ClockJumpState | null = null
    private ntpSeen = false
    private ticking = false
    private timer: ReturnType<typeof setInterval> | null = null
    /** Disks with a run (or catch-up) in progress. */
    private readonly running = new Set<string>()
    /** Per disk: instances skipped with SKIPPED_LOCKED in the current window (Q3). In memory only. */
    private readonly skipped = new Map<string, Map<string, SkippedRun>>()
    private readonly inFlight = new Set<Promise<void>>()
    private readonly loggedScheduleError = new Map<string, string>()

    constructor(
        private readonly storeHandle: DocHandle<Store>,
        private readonly deps: SchedulerDeps = defaultSchedulerDeps(),
        private readonly engineId: EngineID | string = localEngineId,
    ) {}

    start(intervalMs = SCHEDULER_TICK_MS): void {
        if (this.timer) return
        const offset = testClockOffsetMs()
        if (offset !== 0) log(chalk.bgRed(`Backup scheduler: TEST CLOCK OFFSET ${offset} ms (NODE_ENV=test, ${TEST_CLOCK_OFFSET_ENV}); the system clock is not changed`))
        this.timer = setInterval(() => { this.tick().catch(e => log(chalk.red(`Backup scheduler tick failed: ${e?.message ?? e}`))) }, intervalMs)
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    /** Resolves when every run started so far has finished (tests). */
    async idle(): Promise<void> {
        while (this.inFlight.size) await Promise.all([...this.inFlight])
    }

    /** Skipped-run state for a disk (tests and logs). */
    skippedFor(diskId: string): Map<string, SkippedRun> {
        return this.skipped.get(diskId) ?? new Map()
    }

    /** One tick. Never overlaps itself; a run started here continues in the background. */
    async tick(): Promise<void> {
        if (this.ticking) return
        this.ticking = true
        try {
            const now = this.deps.wallMs()
            const bootId = this.deps.bootId()
            const uptime = this.deps.uptimeS()
            this.observeClock(now, bootId, uptime)
            const store = this.storeHandle.doc()
            if (!store?.diskDB) return
            for (const disk of Object.values(store.diskDB)) {
                if (!isScheduledHere(disk, String(this.engineId))) continue
                try {
                    await this.tickDisk(disk, now, bootId, uptime)
                } catch (e: any) {
                    log(chalk.red(`Backup scheduler: disk ${disk.id}: ${e?.message ?? e}`))
                }
            }
        } finally {
            this.ticking = false
        }
    }

    private peersFor(now: number) {
        return peerClockInputs(now, peerClockViews(now, String(this.engineId)))
    }

    /** Jump detection, the NTP latch and the jump recovery window (in memory). */
    private observeClock(now: number, bootId: string, uptime: number): void {
        const sample: ClockSample = { wallMs: now, monoMs: this.deps.monoMs() }
        const jumped = this.prev ? detectClockJump(this.prev, sample) : null
        this.prev = sample
        if (!this.ntpSeen && this.deps.ntpSynced()) this.ntpSeen = true
        const peerAgreed = this.peersFor(now).peerSynced
        if (jumped) {
            this.jump = noteClockJump(bootId, uptime)
            log(chalk.yellow(`Backup scheduler: clock jumped ${jumped}; schedule clock untrusted until the next sync or 24 h of uptime (idea#400)`))
        } else if (this.jump) {
            this.jump = advanceClockJumpState(this.jump, bootId, uptime, this.deps.ntpSynced() || peerAgreed)
            if (!this.jump) log('Backup scheduler: clock trusted again after the jump')
        }
    }

    private trustFor(store: Store, disk: Disk, now: number): ClockTrust {
        const peers = this.peersFor(now)
        return evaluateClockTrust({
            nowMs: now,
            ntpSynced: this.ntpSeen,
            peerSynced: peers.peerSynced,
            peerNtpAgreed: peers.peerNtpAgreed,
            buildTimeMs: this.deps.buildTimeMs(),
            newestStoreTimeMs: newestBackupTimeFor(store, disk),
            syncedPeerNowMs: peers.syncedPeerNowMs,
            jumpSinceSync: this.jump != null,
        })
    }

    /**
     * Engine-level clock flags for the ephemeral hb (engine#352). BEFORE_STORE is
     * per-disk and is not included: this answers "do I have a confirmed clock
     * (NTP or an NTP-backed peer chain) and is it not obviously wrong?"
     */
    clockStatus(): { ntpSynced: boolean, clockTrusted: boolean } {
        if (!this.ntpSeen && this.deps.ntpSynced()) this.ntpSeen = true
        const now = this.deps.wallMs()
        const peers = this.peersFor(now)
        const t = evaluateClockTrust({
            nowMs: now,
            ntpSynced: this.ntpSeen,
            peerSynced: peers.peerSynced,
            peerNtpAgreed: peers.peerNtpAgreed,
            buildTimeMs: this.deps.buildTimeMs(),
            newestStoreTimeMs: null,
            syncedPeerNowMs: peers.syncedPeerNowMs,
            jumpSinceSync: this.jump != null,
        })
        return { ntpSynced: this.ntpSeen, clockTrusted: t.clockTrusted }
    }

    private async tickDisk(disk: Disk, now: number, bootId: string, uptime: number): Promise<void> {
        const trust = this.trustFor(this.storeHandle.doc(), disk, now)
        this.writeTrustIfChanged(disk.id, trust)
        if (this.running.has(disk.id)) return
        const yaml = await readBackupYamlState(disk.device!)
        if (!yaml) return
        this.mirrorScheduleIfChanged(disk.id, yaml)
        if (yaml.mode !== 'scheduled') return
        // Steve, #351 call 1: an invalid schedule runs at the 02:30 default (a missed nightly backup is
        // worse than the default time) and stays visible as backupConfig.scheduleError.
        if (yaml.scheduleError) {
            if (this.loggedScheduleError.get(disk.id) !== yaml.scheduleError) {
                log(chalk.yellow(`Backup scheduler: disk ${disk.id}: BACKUP.yaml schedule is invalid (${yaml.scheduleError}); running at the default ${DEFAULT_BACKUP_TIME}, shown as backupConfig.scheduleError`))
                this.loggedScheduleError.set(disk.id, yaml.scheduleError)
            }
        } else {
            this.loggedScheduleError.delete(disk.id)
        }
        const counter = yaml.uptimeCounter ? advanceUptimeCounter(yaml.uptimeCounter, bootId, uptime) : resetUptimeCounter(bootId, uptime)
        // Worked out from the stored lastRun / counter on every tick, so after an Engine restart a window
        // missed while it was down is caught up once, and a window already run is not run again (#351 call 8).
        const due = decideBackupDue({
            nowMs: now, clockTrusted: trust.clockTrusted, schedule: effectiveSchedule(yaml.schedule),
            lastRun: yaml.lastRun, uptimeCounter: counter,
        })
        if (due.due) {
            this.launch(disk.id, () => this.runDisk(disk.id, yaml, due, now, bootId, uptime))
            return
        }
        // Not due: keep the uptime counter on the disk (hourly and on a new boot), never in the store (Q9)
        if (shouldPersistUptimeCounter(yaml.uptimeCounter, counter)) {
            await writeBackupScheduleState(disk.device!, { uptimeCounter: counter })
        }
        // Q3: an instance skipped with SKIPPED_LOCKED catches up once when the lock frees, same window
        const windowId = due.slotMs ?? yaml.lastRun?.time ?? null
        const sk = this.skipped.get(disk.id)
        if (!sk || windowId == null) return
        for (const [id, s] of sk) if (s.windowId !== windowId) sk.delete(id)
        const ready = [...sk].filter(([id, s]) => skippedCatchUpDue(s, windowId, this.lockFree(id, disk.id))).map(([id]) => id)
        if (!ready.length) return
        for (const id of ready) sk.get(id)!.catchUpUsed = true
        this.launch(disk.id, () => this.catchUp(disk.id, ready))
    }

    private launch(diskId: string, fn: () => Promise<void>): void {
        this.running.add(diskId)
        const p: Promise<void> = fn()
            .catch(e => log(chalk.red(`Backup scheduler: run on disk ${diskId} failed: ${e?.message ?? e}`)))
            .finally(() => { this.running.delete(diskId); this.inFlight.delete(p) })
        this.inFlight.add(p)
    }

    private lockFree(instanceId: string, diskId: string): boolean {
        return !isBackupActive(instanceId) && !backupLockKeysFor(instanceId, diskId).some(k => resourceLock.isLocked(k))
    }

    /** A scheduled run: claim the window on the disk, back up each link in turn, retry FAILED once, one summary change. */
    private async runDisk(diskId: string, yaml: BackupYamlState, due: BackupDue, now: number, bootId: string, uptime: number): Promise<void> {
        const device = this.storeHandle.doc().diskDB[diskId]?.device
        if (!device) return
        // lastAttempt and lastRun.time hold the same value (the run start) on purpose (PR B contract,
        // Steve #351 call 7): lastAttempt is the plain timestamp the store mirrors for the Console;
        // lastRun stays on the disk only, with the uptime and boot id the untrusted-clock path needs.
        const claimed = await writeBackupScheduleState(device, {
            lastRun: { time: now, uptimeS: uptime, bootId },
            lastAttempt: now,
            missedRuns: due.missedRuns,
            uptimeCounter: resetUptimeCounter(bootId, uptime),
        })
        if (!claimed) throw new Error(`BACKUP.yaml missing on ${device}; run not started`)
        const ids = yaml.links.map(l => l.instanceId)
        log(chalk.blue(`Backup scheduler: scheduled run on disk ${diskId} (${due.basis}${due.missedRuns ? `, ${due.missedRuns} missed` : ''}): ${ids.length} linked instance(s)`))
        const windowId = windowIdFor(due, now)
        const skipped = new Map<string, SkippedRun>()
        this.skipped.set(diskId, skipped)
        const retry: string[] = []
        for (const id of ids) {
            const code = await this.runOne(diskId, id)
            if (code === 'SKIPPED_LOCKED') skipped.set(id, { windowId, catchUpUsed: false })
            else if (code === 'FAILED') retry.push(id)
        }
        if (retry.length) {
            log(`Backup scheduler: retrying ${retry.join(', ')} once in ${Math.round(RETRY_DELAY_MS / 1000)} s (Q2)`)
            await this.deps.sleep(RETRY_DELAY_MS)
            for (const id of retry) {
                const code = await this.runOne(diskId, id)
                if (code === 'SKIPPED_LOCKED') skipped.set(id, { windowId, catchUpUsed: false })
            }
        }
        await this.writeRunSummary(diskId, { lastAttempt: now, missedRuns: due.missedRuns })
    }

    private async catchUp(diskId: string, ids: string[]): Promise<void> {
        log(`Backup scheduler: catching up ${ids.join(', ')} on disk ${diskId} (lock freed, same window, Q3)`)
        for (const id of ids) await this.runOne(diskId, id)
        await this.writeRunSummary(diskId, {})
    }

    /** One instance. Returns the result code this attempt recorded, or null when nothing ran. */
    private async runOne(diskId: string, instanceId: string): Promise<BackupResultCode | null> {
        const store = this.storeHandle.doc()
        const disk = store.diskDB[diskId as DiskID]
        if (!isScheduledHere(disk, String(this.engineId))) {
            log(`Backup scheduler: disk ${diskId} is no longer docked here in scheduled mode; ${instanceId} not run`)
            return null
        }
        if (!getInstance(store, instanceId as InstanceID)) {
            log(`Backup scheduler: linked instance ${instanceId} is not in the store; skipped (orphanLinks)`)
            syncBackupOrphanLinks(this.storeHandle, diskId as DiskID)
            return null
        }
        const lockFile = `${disksRoot()}/${disk.device}/backups/${instanceId}/${BACKUP_IN_PROGRESS}`
        if (hasBackupStaleLock(disk, instanceId) || await fs.pathExists(lockFile)) {
            log(`Backup scheduler: ${instanceId} has a stale lock — not run; use clearBackupLock, then backupApp (idea#446, Q2)`)
            return null
        }
        if (isBackupActive(instanceId)) {
            recordBackupResult(this.storeHandle, instanceId, 'stop', 'SKIPPED_LOCKED')
            return 'SKIPPED_LOCKED'
        }
        const before = JSON.stringify(this.storeHandle.doc().instanceDB?.[instanceId as InstanceID]?.lastResult ?? null)
        try {
            await this.deps.runBackup(this.storeHandle, instanceId as InstanceID, disk, SCHEDULED_BACKUP_CAUSE)
        } catch (e: any) {
            log(chalk.red(`Backup scheduler: ${instanceId}: ${e?.message ?? e}`))
        }
        // The attempt's own result (backupInstance records one per attempt; a quiet duplicate skip records none)
        const r = this.storeHandle.doc().instanceDB?.[instanceId as InstanceID]?.lastResult
        return r && JSON.stringify(r) !== before ? r.result : null
    }

    /** The one store change at the end of a run: lastAttempt / missedRuns (BACKUP.yaml mirror) and freePct. */
    private async writeRunSummary(diskId: string, s: { lastAttempt?: number, missedRuns?: number }): Promise<void> {
        const disk = this.storeHandle.doc().diskDB[diskId as DiskID]
        let freePct: number | null | undefined
        if (disk?.device) {
            try {
                freePct = freePctOf(await this.deps.diskUsage(joinMountRoot(await diskMountRoot(disk))))
            } catch (e: any) {
                log(`Backup scheduler: free space of ${diskId} unread: ${e?.message ?? e}`)
            }
        }
        const cur = this.storeHandle.doc().diskDB[diskId as DiskID]
        if (!cur) return
        const changes: Partial<Record<'lastAttempt' | 'missedRuns' | 'freePct', number>> = {}
        if (s.lastAttempt !== undefined && cur.lastAttempt !== s.lastAttempt) changes.lastAttempt = s.lastAttempt
        if (s.missedRuns !== undefined && cur.missedRuns !== s.missedRuns) changes.missedRuns = s.missedRuns
        if (freePct != null && cur.freePct !== freePct) changes.freePct = freePct
        if (!Object.keys(changes).length) return
        this.storeHandle.change(doc => {
            const d = doc.diskDB[diskId as DiskID]
            if (!d) return
            if (changes.lastAttempt !== undefined) d.lastAttempt = changes.lastAttempt as Timestamp
            if (changes.missedRuns !== undefined) d.missedRuns = changes.missedRuns
            if (changes.freePct !== undefined) d.freePct = changes.freePct
        })
    }

    private writeTrustIfChanged(diskId: string, t: ClockTrust): void {
        const d = this.storeHandle.doc().diskDB[diskId as DiskID]
        if (!d) return
        if (d.clockTrusted === t.clockTrusted && (d.clockReason ?? null) === t.clockReason) return
        this.storeHandle.change(doc => {
            const x = doc.diskDB[diskId as DiskID]
            if (!x) return
            x.clockTrusted = t.clockTrusted
            x.clockReason = t.clockReason
        })
    }

    /** BACKUP.yaml edited while docked: mirror schedule / scheduleError (not mode or links; those are mirrored at dock). */
    private mirrorScheduleIfChanged(diskId: string, yaml: BackupYamlState): void {
        const cfg = this.storeHandle.doc().diskDB[diskId as DiskID]?.backupConfig
        if (!cfg) return
        const daily = yaml.schedule?.daily ?? null
        if ((cfg.schedule?.daily ?? null) === daily && (cfg.scheduleError ?? null) === yaml.scheduleError) return
        this.storeHandle.change(doc => {
            const c = doc.diskDB[diskId as DiskID]?.backupConfig
            if (!c) return
            c.schedule = daily ? { daily } : null
            c.scheduleError = yaml.scheduleError
        })
    }
}

let engineScheduler: BackupScheduler | null = null

/** Start the Engine's scheduler (start.ts). One per process. */
export const startBackupScheduler = (storeHandle: DocHandle<Store>): BackupScheduler => {
    if (!engineScheduler) {
        engineScheduler = new BackupScheduler(storeHandle)
        engineScheduler.start()
        bindEngineClockTrusted(() => engineScheduler!.clockStatus().clockTrusted)
        log(`Backup scheduler started (${SCHEDULER_TICK_MS / 1000} s tick, in the Engine; idea#400)`)
    }
    return engineScheduler
}

/** The running scheduler, if startBackupScheduler has run (idea#396 clock trust). */
export const getBackupScheduler = (): BackupScheduler | null => engineScheduler

/** Test seam: drop the process-wide scheduler. */
export const resetBackupSchedulerForTests = (): void => { engineScheduler = null }
