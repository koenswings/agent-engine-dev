/**
 * backupCleanup.ts — fullness-driven Backup Disk cleanup (idea#401, helper v9)
 *
 * The Engine chooses which archives to remove; idea-app-data enforces the
 * retention floor (refuses the newest N and the last archive). Cleanup uses
 * fullness and backup count only, never age.
 *
 * After a successful backup, and before a backup if space looks tight: if
 * free space is below 15 %, delete oldest eligible archives until free space
 * is above 25 % (estimated from deleted compressed sizes, then confirmed
 * after compact). Always keep the newest 3 good backups per instance.
 * Several instances: round-robin, oldest first, never touching any instance's
 * newest 3. Before a backup, estimate the next archive from the last
 * archive's compressed size; if it still does not fit after cleanup, refuse
 * with BACKUP_DISK_FULL.
 *
 * helperAtLeast(10) runs before any list/delete/compact (v9's borg-list was broken on real borg, idea#450). An older helper
 * skips cleanup and the backup still runs (HELPER_OUTDATED recorded).
 */

import { statfs } from 'node:fs/promises'
import { fs } from 'zx'
import { log } from './utils.js'
import { config, disksRoot, skipBorg } from '../data/Config.js'
import {
    AppDataRunner, runAppData, helperAtLeast,
    borgListArgs, borgDeleteArgs, borgCompactArgs, BACKUP_CLEANUP_HELPER_MIN,
} from './appDataHelper.js'

export { BACKUP_CLEANUP_HELPER_MIN }

export const BACKUP_KEEP_MIN = 3
export const BACKUP_FULL_LOW_PCT = 15
export const BACKUP_FULL_HIGH_PCT = 25

export interface BackupArchiveInfo {
    name: string
    time: string
    originalSize: number
    compressedSize: number
}

export interface DiskUsage {
    totalBytes: number
    freeBytes: number
}

export const freePercent = (usage: DiskUsage): number =>
    usage.totalBytes > 0 ? (usage.freeBytes / usage.totalBytes) * 100 : 0

export const backupDiskFullError = (): Error =>
    new Error('BACKUP_DISK_FULL: Backup Disk full: add a bigger disk')

/**
 * Parse `borg-list` stdout. Accepts borg `info --json` (`name`/`start`/`stats`)
 * and the flatter `{ name, time, original_size, compressed_size }` shape.
 * Returns archives oldest first (by time, then name). ISO archive names sort
 * in time order when time is missing.
 */
export const parseBorgListJson = (raw: string): BackupArchiveInfo[] => {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error('borg-list did not return JSON')
    }
    const list = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed as { archives?: unknown }).archives
        : undefined
    if (!Array.isArray(list)) throw new Error('borg-list did not return an archives list')
    const out: BackupArchiveInfo[] = []
    for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const a = item as Record<string, unknown>
        const name = (typeof a.name === 'string' && a.name) ? a.name
            : (typeof a.archive === 'string' && a.archive) ? a.archive
            : ''
        if (!name) continue
        const time = (typeof a.time === 'string' && a.time) ? a.time
            : (typeof a.start === 'string' && a.start) ? a.start
            : name
        const stats = (a.stats && typeof a.stats === 'object' && !Array.isArray(a.stats))
            ? a.stats as Record<string, unknown>
            : undefined
        const originalSize = Number(stats?.original_size ?? a.original_size ?? 0)
        const compressedSize = Number(stats?.compressed_size ?? a.compressed_size ?? 0)
        out.push({
            name,
            time,
            originalSize: Number.isFinite(originalSize) ? originalSize : 0,
            compressedSize: Number.isFinite(compressedSize) ? compressedSize : 0,
        })
    }
    out.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : a.name.localeCompare(b.name))
    return out
}

/** Archives that are not among the newest `keepMin` (already oldest-first). */
export const eligibleArchives = (archives: BackupArchiveInfo[], keepMin = BACKUP_KEEP_MIN): BackupArchiveInfo[] => {
    if (archives.length <= keepMin) return []
    return archives.slice(0, archives.length - keepMin)
}

export const estimateNextBackupBytes = (archives: BackupArchiveInfo[]): number => {
    if (!archives.length) return 0
    const last = archives[archives.length - 1]
    return last.compressedSize || last.originalSize || 0
}

/**
 * Next archive to delete: round-robin across instances (fewest deletions in
 * this pass, then instance id), each instance contributing its oldest eligible
 * archive. Never a newest-N archive.
 */
export const pickRoundRobinDeletion = (
    byInstance: Map<string, BackupArchiveInfo[]>,
    deletedCount: Map<string, number>,
    keepMin = BACKUP_KEEP_MIN,
): { instanceId: string, archive: BackupArchiveInfo } | null => {
    const candidates: { instanceId: string, archive: BackupArchiveInfo, deleted: number }[] = []
    for (const [instanceId, archives] of byInstance) {
        const eligible = eligibleArchives(archives, keepMin)
        if (!eligible.length) continue
        candidates.push({
            instanceId,
            archive: eligible[0],
            deleted: deletedCount.get(instanceId) ?? 0,
        })
    }
    if (!candidates.length) return null
    candidates.sort((a, b) => a.deleted - b.deleted || a.instanceId.localeCompare(b.instanceId))
    return { instanceId: candidates[0].instanceId, archive: candidates[0].archive }
}

const ID_TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/

export const defaultReadBackupDiskUsage = async (mountRoot: string): Promise<DiskUsage> => {
    const s = await statfs(mountRoot)
    return {
        totalBytes: Number(s.blocks) * Number(s.bsize),
        freeBytes: Number(s.bavail) * Number(s.bsize),
    }
}

export const defaultListBackupRepoIds = async (backupDevice: string): Promise<string[]> => {
    const base = `${disksRoot()}/${backupDevice}/backups`
    if (!await fs.pathExists(base)) return []
    const entries = await fs.readdir(base)
    const ids: string[] = []
    for (const e of entries) {
        if (!ID_TOKEN.test(e)) continue
        if (await fs.pathExists(`${base}/${e}/config`)) ids.push(e)
    }
    return ids.sort()
}

/**
 * Tests set `enableInTests` so existing backup tests (testMode, no cleanup
 * fixture) do not call helper v9 or depend on the box disk's free space.
 */
export const backupCleanupIO: {
    enableInTests: boolean
    readUsage: (mountRoot: string) => Promise<DiskUsage>
    listInstanceIds: (backupDevice: string) => Promise<string[]>
    run: AppDataRunner
} = {
    enableInTests: false,
    readUsage: defaultReadBackupDiskUsage,
    listInstanceIds: defaultListBackupRepoIds,
    run: (...args) => runAppData(...args),
}

export const cleanupIsEnabled = (): boolean => {
    if (skipBorg()) return false
    if (config.settings.testMode && !backupCleanupIO.enableInTests) return false
    return true
}

export interface CleanupResult {
    status: 'skipped' | 'ok' | 'HELPER_OUTDATED' | 'full'
    warning?: string
    deleted: { instanceId: string, archive: string }[]
    compacted: boolean
}

const listArchives = async (backupDevice: string, instanceId: string): Promise<BackupArchiveInfo[]> => {
    const out = await backupCleanupIO.run(borgListArgs(backupDevice, instanceId))
    return parseBorgListJson(out)
}

const loadArchives = async (backupDevice: string, instanceIds: string[]): Promise<Map<string, BackupArchiveInfo[]>> => {
    const byInstance = new Map<string, BackupArchiveInfo[]>()
    for (const id of instanceIds) {
        try {
            byInstance.set(id, await listArchives(backupDevice, id))
        } catch (e: any) {
            log(`backup cleanup: could not list archives for ${id}: ${e?.message ?? e}`)
        }
    }
    return byInstance
}

/**
 * Delete oldest eligible archives round-robin until estimated free space is
 * above 25 % (and, before a backup, until the next archive's estimate fits).
 * Compact each affected repo after at least one successful delete.
 */
export const defaultRunBackupCleanup = async (opts: {
    backupDevice: string
    mountRoot: string
    currentInstanceId: string
    phase: 'before' | 'after'
    /** Called once, just before the first archive is deleted (Disk.cleaning, idea#400 PR C). */
    onDeleteStart?: () => void
}): Promise<CleanupResult> => {
    const empty: CleanupResult = { status: 'ok', deleted: [], compacted: false }
    if (!cleanupIsEnabled()) return { ...empty, status: 'skipped' }

    const outdated = await helperAtLeast(BACKUP_CLEANUP_HELPER_MIN, 'backup cleanup', backupCleanupIO.run)
    if (outdated) {
        log(`backup cleanup skipped: HELPER_OUTDATED (${outdated})`)
        return { status: 'HELPER_OUTDATED', warning: `HELPER_OUTDATED: ${outdated}`, deleted: [], compacted: false }
    }

    let usage: DiskUsage
    try {
        usage = await backupCleanupIO.readUsage(opts.mountRoot)
    } catch (e: any) {
        log(`backup cleanup: could not read disk usage: ${e?.message ?? e}`)
        return { ...empty, status: 'skipped', warning: `cleanup usage unread: ${e?.message ?? e}` }
    }
    if (!(usage.totalBytes > 0)) return empty

    const ids = await backupCleanupIO.listInstanceIds(opts.backupDevice)
    const pct = freePercent(usage)
    const belowLow = pct < BACKUP_FULL_LOW_PCT

    let currentArchives: BackupArchiveInfo[] = []
    if (opts.phase === 'before' && ids.includes(opts.currentInstanceId)) {
        try {
            currentArchives = await listArchives(opts.backupDevice, opts.currentInstanceId)
        } catch (e: any) {
            log(`backup cleanup: could not list archives for ${opts.currentInstanceId}: ${e?.message ?? e}`)
        }
    }
    const estimate = opts.phase === 'before' ? estimateNextBackupBytes(currentArchives) : 0
    const estimateTight = opts.phase === 'before' && estimate > 0 && usage.freeBytes < estimate
    if (!belowLow && !estimateTight) return empty

    const toLoad = currentArchives.length ? ids.filter(id => id !== opts.currentInstanceId) : ids
    const byInstance = await loadArchives(opts.backupDevice, toLoad)
    if (currentArchives.length) byInstance.set(opts.currentInstanceId, currentArchives)

    const deleted: { instanceId: string, archive: string }[] = []
    const deletedCount = new Map<string, number>()
    let reclaimed = 0
    const enough = (free: number): boolean => {
        const p = usage.totalBytes > 0 ? (free / usage.totalBytes) * 100 : 0
        if (p <= BACKUP_FULL_HIGH_PCT) return false
        if (opts.phase === 'before' && estimate > 0 && free < estimate) return false
        return true
    }

    if (!enough(usage.freeBytes + reclaimed)) opts.onDeleteStart?.()
    while (!enough(usage.freeBytes + reclaimed)) {
        const next = pickRoundRobinDeletion(byInstance, deletedCount)
        if (!next) break
        try {
            await backupCleanupIO.run(borgDeleteArgs(opts.backupDevice, next.instanceId, next.archive.name))
        } catch (e: any) {
            log(`backup cleanup: borg-delete ${next.instanceId} ${next.archive.name} failed: ${e?.message ?? e}`)
            break
        }
        deleted.push({ instanceId: next.instanceId, archive: next.archive.name })
        deletedCount.set(next.instanceId, (deletedCount.get(next.instanceId) ?? 0) + 1)
        reclaimed += next.archive.compressedSize || next.archive.originalSize || 0
        const remaining = (byInstance.get(next.instanceId) ?? []).filter(a => a.name !== next.archive.name)
        byInstance.set(next.instanceId, remaining)
        log(`backup cleanup: deleted ${next.archive.name} from ${next.instanceId}`)
    }

    let compacted = false
    const affected = [...new Set(deleted.map(d => d.instanceId))].sort()
    for (const id of affected) {
        try {
            await backupCleanupIO.run(borgCompactArgs(opts.backupDevice, id))
            compacted = true
        } catch (e: any) {
            log(`backup cleanup: borg-compact ${id} failed: ${e?.message ?? e}`)
        }
    }

    try {
        usage = await backupCleanupIO.readUsage(opts.mountRoot)
    } catch {
        // keep the last reading
    }
    const freeAfter = Math.max(usage.freeBytes, usage.freeBytes + (compacted ? 0 : reclaimed))
    if (opts.phase === 'before' && estimate > 0 && usage.freeBytes < estimate && freeAfter < estimate) {
        return { status: 'full', deleted, compacted, warning: 'BACKUP_DISK_FULL' }
    }
    return { status: 'ok', deleted, compacted }
}

/** Tests replace `run`. Production uses `defaultRunBackupCleanup`. */
export const backupCleanupRunner: { run: typeof defaultRunBackupCleanup } = {
    run: defaultRunBackupCleanup,
}
