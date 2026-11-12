/**
 * BackupVerify.ts — listBackup, verifyBackup, clearBackupLock, removeBackupRole (idea#446)
 *
 * Scratch verify extracts into <Backup Disk>/.idea-verify/<id>-<stamp>/ through
 * helper v9 (`borg-extract-verify`). It never stops the live instance, never
 * takes the instance lock, never writes instances/<id>, and never starts
 * containers. Archive inventory reuses helper `borg-list` (v10, idea#450).
 */

import { YAML, chalk, fs } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { log, print } from '../utils/utils.js'
import { disksRoot, skipBorg } from './Config.js'
import { Disk, isSystemDiskRecord, processDisk, diskMountRoot, joinMountRoot } from './Disk.js'
import { Store, getLocalEngine } from './Store.js'
import { resolveDiskArg } from './DiskArg.js'
import { resolveInstanceArg } from './InstanceArg.js'
import { InstanceID, Timestamp } from './CommonTypes.js'
import { attachTraceResult } from './SummariseDisk.js'
import { resourceLock, diskKey } from '../utils/ResourceLock.js'
import {
    AppDataRunner, runAppData, helperAtLeast,
    borgListArgs, borgExtractVerifyArgs, quarantineBackupsArgs, verifyStampNow,
} from '../utils/appDataHelper.js'
import { parseBackupExcludeList, parseBackupVerifyLists } from '../utils/backupExclude.js'
import { isBackupActive, runningBackupOnDisk, BACKUP_IN_PROGRESS, recordBackupStaleLocks, clearBackupStaleLock } from '../monitors/backupMonitor.js'

/** idea#450: v9's 2-arg borg-list printed no archives list on real borg; require the fixed v10. */
export const BACKUP_VERIFY_HELPER_MIN = 10
export const VERIFY_MEMBER_CAP = 10_000
export const VERIFY_SPACE_MARGIN = 0.10

export interface BackupArchiveInfo {
    name: string
    start?: string | null
    end?: string | null
    originalSize?: number | null
    compressedSize?: number | null
}

export interface BackupPathCheck {
    path: string
    expect: 'present' | 'absent'
    source: 'exclude' | 'verify.present' | 'verify.absent'
    ok: boolean
}

const helperOutdated = async (what: string, run: AppDataRunner): Promise<void> => {
    const helper = await helperAtLeast(BACKUP_VERIFY_HELPER_MIN, what, run)
    if (helper) throw new Error(`HELPER_OUTDATED: ${helper}`)
}

const requireBackupTarget = async (disk: Disk, command: string): Promise<string> => {
    if (await isSystemDiskRecord(disk)) {
        throw new Error(`${command}: ${disk.name} (${disk.id}) is this Pi's system disk and cannot be a Backup Disk target`)
    }
    if (!disk.device) throw new Error(`${command}: disk '${disk.id}' is not currently docked`)
    if (!(disk.diskTypes ?? []).includes('backup')) {
        throw new Error(`${command}: disk '${disk.id}' is not a Backup Disk (no BACKUP.yaml role)`)
    }
    return String(disk.device)
}

const repoDir = (device: string, instanceId: string): string =>
    `${disksRoot()}/${device}/backups/${instanceId}`

export const backupLockPath = (device: string, instanceId: string): string =>
    `${repoDir(device, instanceId)}/${BACKUP_IN_PROGRESS}`

export const verifyDir = (device: string, instanceId: string, stamp: string): string =>
    `${disksRoot()}/${device}/.idea-verify/${instanceId}-${stamp}`

const requireRepo = async (device: string, instanceId: string, command: string): Promise<string> => {
    const dir = repoDir(device, instanceId)
    if (!(await fs.pathExists(`${dir}/config`))) {
        throw new Error(`${command}: no docked Backup Disk repository for instance ${instanceId}`)
    }
    return dir
}

const requireNotSkipBorg = (command: string): void => {
    if (skipBorg()) throw new Error(`${command}: skipBorg is set; refusing rather than reporting an empty success`)
}

const backupToDiskBusy = (store: Store, diskId: string): string | null => {
    const op = runningBackupOnDisk(store, diskId)
    if (op) return `a backupApp of instance ${op.args?.instanceId ?? ''} to this disk is ${op.status}`
    return null
}

const instanceBackupBusy = (store: Store, instanceId: string, diskId: string): string | null => {
    if (isBackupActive(instanceId)) return `a backup of instance ${instanceId} is already in progress`
    const op = runningBackupOnDisk(store, diskId)
    if (op && String(op.args?.instanceId) === String(instanceId)) {
        return `a backupApp of instance ${instanceId} to this disk is ${op.status}`
    }
    return null
}

/** Parse `borg info --json` (helper v9 borg-list without an archive). */
export const parseBorgListInventory = (json: string): BackupArchiveInfo[] => {
    let parsed: any
    try { parsed = JSON.parse(json) } catch {
        throw new Error('borg-list did not return JSON archive inventory')
    }
    const archives = parsed?.archives
    if (!Array.isArray(archives)) throw new Error('borg-list JSON has no archives list')
    return archives.map((a: any) => ({
        name: String(a?.name ?? ''),
        start: a?.start ?? a?.time ?? null,
        end: a?.end ?? null,
        originalSize: typeof a?.stats?.original_size === 'number' ? a.stats.original_size
            : (typeof a?.original_size === 'number' ? a.original_size : null),
        compressedSize: typeof a?.stats?.compressed_size === 'number' ? a.stats.compressed_size
            : (typeof a?.compressed_size === 'number' ? a.compressed_size : null),
    })).filter((a: BackupArchiveInfo) => a.name)
}

export const newestArchive = (archives: BackupArchiveInfo[]): BackupArchiveInfo => {
    if (!archives.length) throw new Error('No backup archives found in the repository')
    const timed = archives.map(a => {
        const raw = String(a.end || a.start || '')
        const t = Date.parse(raw)
        return { a, t: Number.isFinite(t) ? t : NaN }
    })
    const withTime = timed.filter(x => Number.isFinite(x.t))
    if (withTime.length) {
        withTime.sort((x, y) => y.t - x.t)
        return withTime[0].a
    }
    // Engine archive names are ISO with : and . replaced by -, so lexicographic order is chronological.
    return [...archives].sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0)[0]
}

/** Member paths from `borg list` (plain lines or --json-lines). */
export const parseBorgMemberList = (text: string): string[] => {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    const out: string[] = []
    for (const line of lines) {
        if (line.startsWith('{')) {
            try {
                const o = JSON.parse(line)
                const path = o.path ?? o.name
                if (typeof path === 'string' && path) out.push(path)
                continue
            } catch { /* fall through as a plain path */ }
        }
        out.push(line)
    }
    return out
}

export const instanceRelativeMember = (member: string, instanceId: string): string | null => {
    const n = member.replace(/^\/+/, '').replace(/\/+$/, '')
    const marker = `instances/${instanceId}`
    const idx = n.indexOf(marker)
    if (idx === -1) return n || null
    const rest = n.slice(idx + marker.length).replace(/^\/+/, '')
    return rest
}

/** Path-prefix: `data/keys` matches that path and everything under it. */
export const memberMatchesPath = (rel: string, declared: string): boolean =>
    rel === declared || rel.startsWith(`${declared}/`)

export const pathsFoundInMembers = (members: string[], instanceId: string, declared: string): boolean => {
    for (const m of members) {
        const rel = instanceRelativeMember(m, instanceId)
        if (rel && memberMatchesPath(rel, declared)) return true
    }
    return false
}

const walkFiles = async (root: string): Promise<{ rels: string[], bytes: number }> => {
    const rels: string[] = []
    let bytes = 0
    const walk = async (dir: string, prefix: string) => {
        let entries: string[]
        try { entries = await fs.readdir(dir) } catch { return }
        for (const name of entries) {
            const full = `${dir}/${name}`
            const rel = prefix ? `${prefix}/${name}` : name
            let st
            try { st = await fs.lstat(full) } catch { continue }
            if (st.isDirectory()) await walk(full, rel)
            else {
                rels.push(rel)
                bytes += Number(st.size) || 0
            }
        }
    }
    if (await fs.pathExists(root)) await walk(root, '')
    return { rels, bytes }
}

const neededBytesFor = (archive: BackupArchiveInfo): number => {
    const raw = archive.originalSize ?? (archive.compressedSize != null ? archive.compressedSize * 2 : 0)
    return Math.ceil(raw * (1 + VERIFY_SPACE_MARGIN))
}

const freeBytesOf = async (device: string, disk: Disk): Promise<number | null> => {
    if (typeof disk.freeBytes === 'number' && disk.freeBytes >= 0) return disk.freeBytes
    try {
        const { $ } = await import('zx')
        const mp = `${disksRoot()}/${device}`
        const out = (await $`df -Pk -- ${mp}`).stdout.trim().split('\n')
        const parts = out[out.length - 1]?.split(/\s+/) ?? []
        const availKb = Number(parts[3])
        if (Number.isFinite(availKb)) return availKb * 1024
    } catch { /* */ }
    return null
}

const readInstanceComposeXapp = async (store: Store, instanceId: InstanceID): Promise<unknown> => {
    const inst = store.instanceDB[instanceId]
    if (!inst?.storedOn) return undefined
    const disk = store.diskDB[inst.storedOn]
    if (!disk) return undefined
    const composePath = joinMountRoot(await diskMountRoot(disk as Disk), 'instances', instanceId, 'compose.yaml')
    if (!(await fs.pathExists(composePath))) return undefined
    const parsed = YAML.parse(await fs.readFile(composePath, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>)['x-app'] : undefined
}

const buildPathChecks = (
    instanceId: string,
    members: string[],
    exclude: string[],
    verify: { present: string[]; absent: string[] },
): BackupPathCheck[] => {
    const checks: BackupPathCheck[] = []
    for (const p of exclude) {
        checks.push({ path: p, expect: 'absent', source: 'exclude', ok: !pathsFoundInMembers(members, instanceId, p) })
    }
    for (const p of verify.present) {
        checks.push({ path: p, expect: 'present', source: 'verify.present', ok: pathsFoundInMembers(members, instanceId, p) })
    }
    for (const p of verify.absent) {
        checks.push({ path: p, expect: 'absent', source: 'verify.absent', ok: !pathsFoundInMembers(members, instanceId, p) })
    }
    return checks
}

const resolveArchiveName = (archives: BackupArchiveInfo[], requested?: string): BackupArchiveInfo => {
    if (!requested) return newestArchive(archives)
    const found = archives.find(a => a.name === requested)
    if (!found) throw new Error(`archive '${requested}' is not in the repository`)
    return found
}

const readLockStartedAt = async (lockPath: string): Promise<Timestamp | null> => {
    try {
        const raw = JSON.parse(await fs.readFile(lockPath, 'utf-8'))
        const n = Number(raw?.startedAt)
        return Number.isFinite(n) ? n as Timestamp : null
    } catch {
        return null
    }
}

export const listBackup = async (
    storeHandle: DocHandle<Store>,
    instanceArg: string,
    backupDiskId: string,
    archiveName?: string,
    run: AppDataRunner = runAppData,
): Promise<Record<string, unknown>> => {
    if (!storeHandle) throw new Error('Store is not available. Please connect first.')
    await helperOutdated('listBackup', run)
    requireNotSkipBorg('listBackup')
    const store = storeHandle.doc()
    const instance = resolveInstanceArg(store, instanceArg, 'listBackup')
    const disk = resolveDiskArg(store, getLocalEngine(store)?.id, backupDiskId, 'listBackup')
    const device = await requireBackupTarget(disk as Disk, 'listBackup')
    await requireRepo(device, instance.id, 'listBackup')

    const inventoryJson = await run(borgListArgs(device, instance.id))
    const archives = parseBorgListInventory(inventoryJson)
    const lockPath = backupLockPath(device, instance.id)
    const lockPresent = await fs.pathExists(lockPath)
    const result: Record<string, unknown> = {
        instanceId: instance.id,
        backupDiskId: disk.id,
        archives,
        lock: lockPresent ? { path: lockPath, startedAt: await readLockStartedAt(lockPath) } : null,
    }
    if (archiveName !== undefined) {
        const arch = resolveArchiveName(archives, archiveName)
        const memberText = await run(borgListArgs(device, instance.id, arch.name))
        const all = parseBorgMemberList(memberText)
        result.archive = arch.name
        result.members = all.slice(0, VERIFY_MEMBER_CAP)
        result.partial = all.length > VERIFY_MEMBER_CAP
        result.memberCount = all.length
    }
    attachTraceResult(result)
    print(chalk.green(`listBackup: ${archives.length} archive(s) for ${instance.id} on ${disk.id}`))
    return result
}

export const verifyBackup = async (
    storeHandle: DocHandle<Store>,
    instanceArg: string,
    backupDiskId: string,
    archiveName?: string,
    run: AppDataRunner = runAppData,
): Promise<Record<string, unknown>> => {
    if (!storeHandle) throw new Error('Store is not available. Please connect first.')
    await helperOutdated('verifyBackup', run)
    requireNotSkipBorg('verifyBackup')
    const store = storeHandle.doc()
    const instance = resolveInstanceArg(store, instanceArg, 'verifyBackup')
    const disk = resolveDiskArg(store, getLocalEngine(store)?.id, backupDiskId, 'verifyBackup')
    const device = await requireBackupTarget(disk as Disk, 'verifyBackup')
    await requireRepo(device, instance.id, 'verifyBackup')

    const busy = backupToDiskBusy(store, disk.id)
    if (busy) throw new Error(`verifyBackup: ${busy}`)

    const inventoryJson = await run(borgListArgs(device, instance.id))
    const archives = parseBorgListInventory(inventoryJson)
    const arch = resolveArchiveName(archives, archiveName)
    const needed = neededBytesFor(arch)
    const free = await freeBytesOf(device, disk as Disk)
    if (needed > 0 && free != null && free < needed) {
        throw new Error(`NO_SPACE: verify extract needs ${needed} bytes, free ${free}`)
    }

    const lockKey = diskKey(disk.id)
    if (!resourceLock.acquireAll([lockKey], 'verifyBackup')) {
        const held = resourceLock.getLockInfo(lockKey)
        throw new Error(`verifyBackup: the Backup Disk is locked${held ? ` by '${held.kind}'` : ''}`)
    }

    const stamp = verifyStampNow()
    const scratchPath = verifyDir(device, instance.id, stamp)
    let extractOk = false
    try {
        // Helper v9 does not print the dest path; it extracts in-place under
        // .idea-verify/<id>-<stamp>/ (no --strip-components) and exits 0.
        await run(borgExtractVerifyArgs(device, instance.id, arch.name, stamp))
        extractOk = true
        const usedPath = scratchPath

        let members: string[] = []
        try {
            members = parseBorgMemberList(await run(borgListArgs(device, instance.id, arch.name)))
        } catch (e: any) {
            log(`verifyBackup: member list failed after extract (${e?.message ?? e}); walking the scratch tree`)
        }
        const walked = await walkFiles(usedPath)
        // Prefer instance-relative paths from the scratch tree for checks, plus borg members.
        const scratchRels = walked.rels
            .map(r => instanceRelativeMember(r, instance.id) ?? r)
            .filter(Boolean) as string[]
        const checkMembers = members.length ? members : scratchRels.map(r => `instances/${instance.id}/${r}`)

        let exclude: string[] = []
        let verify = { present: [] as string[], absent: [] as string[] }
        try {
            const xapp = await readInstanceComposeXapp(storeHandle.doc(), instance.id)
            exclude = parseBackupExcludeList(xapp)
            verify = parseBackupVerifyLists(xapp)
        } catch (e: any) {
            throw new Error(`verifyBackup: invalid x-app.backup on the instance compose (${e?.message ?? e})`)
        }
        const checks = buildPathChecks(instance.id, checkMembers, exclude, verify)
        const memberCap = (members.length ? members : scratchRels).slice(0, VERIFY_MEMBER_CAP)
        const result = {
            ok: checks.every(c => c.ok),
            archive: arch.name,
            scratchPath: usedPath,
            archiveOriginalBytes: arch.originalSize ?? null,
            archiveCompressedBytes: arch.compressedSize ?? null,
            neededBytes: needed,
            freeBytes: free,
            scratchBytes: walked.bytes,
            members: memberCap,
            memberCount: (members.length ? members : scratchRels).length,
            partial: (members.length ? members : scratchRels).length > VERIFY_MEMBER_CAP,
            checks,
        }
        attachTraceResult(result)
        print(chalk.green(`verifyBackup: archive ${arch.name} → ${usedPath} (${result.ok ? 'ok' : 'checks failed'})`))
        return result
    } catch (e) {
        if (!extractOk && await fs.pathExists(scratchPath)) {
            log(`verifyBackup: extract failed; leaving ${scratchPath} in place (never deleted)`)
        }
        throw e
    } finally {
        resourceLock.releaseAll([lockKey])
    }
}

export const clearBackupLock = async (
    storeHandle: DocHandle<Store>,
    instanceArg: string,
    backupDiskId: string,
    run: AppDataRunner = runAppData,
): Promise<Record<string, unknown>> => {
    if (!storeHandle) throw new Error('Store is not available. Please connect first.')
    await helperOutdated('clearBackupLock', run)
    const store = storeHandle.doc()
    const instance = resolveInstanceArg(store, instanceArg, 'clearBackupLock')
    const disk = resolveDiskArg(store, getLocalEngine(store)?.id, backupDiskId, 'clearBackupLock')
    const device = await requireBackupTarget(disk as Disk, 'clearBackupLock')
    const busy = instanceBackupBusy(store, instance.id, disk.id)
    if (busy) throw new Error(`clearBackupLock: ${busy}`)

    const lockPath = backupLockPath(device, instance.id)
    const lockPresent = await fs.pathExists(lockPath)
    // idea#454: the lock file can already be gone while Disk.backupStaleLocks still lists
    // the instance (an older Engine's backup over a stale lock, or a lock removed by hand).
    // Then only the store entry is dropped; with neither present there is nothing to clear.
    const staleEntry = (storeHandle.doc().diskDB[disk.id]?.backupStaleLocks ?? [])
        .find(l => String(l.instanceId) === String(instance.id))
    if (!lockPresent && !staleEntry) {
        throw new Error(`clearBackupLock: no .backup-in-progress lock for instance ${instance.id} on disk ${disk.id}`)
    }
    const startedAt = lockPresent ? await readLockStartedAt(lockPath) : (staleEntry?.startedAt ?? null)

    const lockKey = diskKey(disk.id)
    if (!resourceLock.acquireAll([lockKey], 'clearBackupLock')) {
        const held = resourceLock.getLockInfo(lockKey)
        throw new Error(`clearBackupLock: the Backup Disk is locked${held ? ` by '${held.kind}'` : ''}`)
    }
    try {
        if (lockPresent) await fs.remove(lockPath)
        clearBackupStaleLock(storeHandle, disk.id, instance.id)
        const result = { instanceId: instance.id, backupDiskId: disk.id, lockPath, startedAt, cleared: true, lockFileRemoved: lockPresent }
        attachTraceResult(result)
        print(chalk.green(lockPresent
            ? `clearBackupLock: removed ${lockPath}`
            : `clearBackupLock: no lock file left at ${lockPath}; removed the stale-lock entry from the store (idea#454)`))
        return result
    } finally {
        resourceLock.releaseAll([lockKey])
    }
}

export const removeBackupRole = async (
    storeHandle: DocHandle<Store>,
    diskId: string,
    run: AppDataRunner = runAppData,
): Promise<Record<string, unknown>> => {
    if (!storeHandle) throw new Error('Store is not available. Please connect first.')
    await helperOutdated('removeBackupRole', run)
    const store = storeHandle.doc()
    const disk = resolveDiskArg(store, getLocalEngine(store)?.id, diskId, 'removeBackupRole')
    const device = await requireBackupTarget(disk as Disk, 'removeBackupRole')

    if (resourceLock.isLocked(diskKey(disk.id))) {
        const info = resourceLock.getLockInfo(diskKey(disk.id))
        throw new Error(`removeBackupRole: the disk is locked${info ? ` by '${info.kind}'` : ''}`)
    }
    const busy = backupToDiskBusy(store, disk.id)
    if (busy) throw new Error(`removeBackupRole: ${busy}`)

    const backupsBase = `${disksRoot()}/${device}/backups`
    if (await fs.pathExists(backupsBase)) {
        const entries = await fs.readdir(backupsBase)
        for (const entry of entries) {
            if (await fs.pathExists(`${backupsBase}/${entry}/${BACKUP_IN_PROGRESS}`)) {
                throw new Error(`removeBackupRole: a .backup-in-progress lock is still present for ${entry}; clear it first`)
            }
        }
    }
    if ((disk.backupStaleLocks ?? []).length) {
        throw new Error(`removeBackupRole: stale backup locks are still recorded on this disk; clear them first`)
    }

    const lockKey = diskKey(disk.id)
    if (!resourceLock.acquireAll([lockKey], 'removeBackupRole')) {
        const held = resourceLock.getLockInfo(lockKey)
        throw new Error(`removeBackupRole: the Backup Disk is locked${held ? ` by '${held.kind}'` : ''}`)
    }
    try {
        let quarantinePath: string | null = null
        if (await fs.pathExists(backupsBase)) {
            const out = (await run(quarantineBackupsArgs(device))).trim()
            const line = out.split(/\r?\n/).filter(Boolean).pop() ?? ''
            quarantinePath = line || `${disksRoot()}/${device}/.idea-quarantine/backups`
        }
        const yamlPath = `${disksRoot()}/${device}/BACKUP.yaml`
        if (await fs.pathExists(yamlPath)) await fs.remove(yamlPath)
        storeHandle.change(doc => {
            const d = doc.diskDB[disk.id]
            if (d) {
                d.backupConfig = null
                d.backupStaleLocks = null
            }
        })
        await processDisk(storeHandle, storeHandle.doc().diskDB[disk.id] as Disk)
        const after = storeHandle.doc().diskDB[disk.id]
        const result = {
            diskId: disk.id,
            quarantinePath,
            diskTypes: after?.diskTypes ?? [],
            backupConfig: after?.backupConfig ?? null,
        }
        attachTraceResult(result)
        print(chalk.green(`removeBackupRole: disk ${disk.id} is no longer a Backup Disk`))
        return result
    } finally {
        resourceLock.releaseAll([lockKey])
    }
}
