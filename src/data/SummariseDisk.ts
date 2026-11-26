/**
 * SummariseDisk.ts — content summary for erase confirmation (idea#134, §7.4)
 *
 * summariseDisk <diskId|candidateId> walks a mounted IDEA disk (or reports
 * readable:false for an unformatted candidate) and stores the JSON result on
 * CommandTrace.result. Caps: 100_000 entries or 10 seconds → partial: true.
 * Backups come from BACKUP.yaml + the store, never borg list.
 */

import { appIdentityOfDir } from './App.js'
import path from 'path'
import { fs, YAML } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { Disk, diskMountRoot, joinMountRoot } from './Disk.js'
import { localEngineId } from './Engine.js'
import { DiskID, Timestamp } from './CommonTypes.js'
import { getCommandLogHandle, stashTraceResult, logStr, commandLogText } from './CommandLogStore.js'
import { redactString } from '../utils/redact.js'
import { getActiveTrace } from '../utils/CommandLogger.js'
import { log } from '../utils/utils.js'
import { labelForUnformatted } from './UnformattedDisks.js'

export const SUMMARY_MAX_ENTRIES = 100_000
export const SUMMARY_MAX_MS = 10_000
export const SUMMARY_MAX_AGE_MS = 10 * 60 * 1000

export interface ContentSummary {
    /** files-disk.md §7.4 / Console store.ts — must match Console parse + EraseDialog. */
    targetId: string
    label: string
    model: string | null
    sizeBytes: number
    usedBytes: number | null
    fsType: string | null
    apps: { name: string; version: string }[]
    instances: { id: string; name: string; running: boolean; dataBytes: number | null }[]
    backups: { instanceId: string; instanceName: string; lastBackup: number | null; snapshots: number | null }[]
    files: { fileCount: number; totalBytes: number; partial: boolean } | null
    other: { entryCount: number; totalBytes: number; partial: boolean } | null
    otherPartitions: { device: string; fsType: string | null }[]
    readable: boolean
    serial: string | null
    computedAt: number
}

export interface SummariseOps {
    now: () => number
    walk: (root: string, onEntry: (rel: string, size: number) => void | false, deadline: number) => Promise<{ truncated: boolean }>
}

const defaultWalk = async (
    root: string,
    onEntry: (rel: string, size: number) => void | false,
    deadline: number,
): Promise<{ truncated: boolean }> => {
    let truncated = false
    const walkDir = async (dir: string, relBase: string): Promise<boolean> => {
        if (Date.now() > deadline) { truncated = true; return false }
        let entries: string[]
        try { entries = await fs.readdir(dir) } catch { return true }
        for (const name of entries) {
            if (Date.now() > deadline) { truncated = true; return false }
            const full = path.join(dir, name)
            const rel = relBase ? `${relBase}/${name}` : name
            let st
            try { st = await fs.lstat(full) } catch { continue }
            if (st.isDirectory()) {
                const cont = onEntry(rel + '/', 0)
                if (cont === false) { truncated = true; return false }
                if (!(await walkDir(full, rel))) return false
            } else {
                const cont = onEntry(rel, st.size)
                if (cont === false) { truncated = true; return false }
            }
        }
        return true
    }
    await walkDir(root, '')
    return { truncated }
}

let ops: SummariseOps = { now: () => Date.now(), walk: defaultWalk }
export const setSummariseOpsForTests = (o: Partial<SummariseOps> | null): void => {
    ops = o ? { ...ops, ...o, now: o.now ?? ops.now, walk: o.walk ?? ops.walk } : { now: () => Date.now(), walk: defaultWalk }
}

/** Resolve a diskId or unformatted candidateId on this Engine. */
export const resolveSummaryTarget = (store: Store, targetId: string): {
    kind: 'disk' | 'unformatted'
    disk?: Disk
    candidate?: { candidateId: string; device: string; sizeBytes: number; model: string | null; fsType: string | null; label: string; serial?: string | null }
    label: string
    serial: string | null
} | null => {
    const eng = store.engineDB[localEngineId]
    const disk = store.diskDB[targetId as DiskID]
    if (disk && disk.dockedTo === localEngineId && disk.device) {
        return { kind: 'disk', disk, label: disk.name, serial: null }
    }
    const cand = eng?.unformattedDisks?.find(c => c.candidateId === targetId)
    if (cand) {
        return { kind: 'unformatted', candidate: cand, label: cand.label, serial: (cand as any).serial ?? cand.candidateId }
    }
    // idea#310: a non-IDEA USB disk the scanner offers Erase for (e.g. an old Engine SSD with an OS
    // rootfs) is in neither list above; resolve it from diskCandidates. Docked disks are never candidates;
    // the system-disk and mounted refusals stay in eraseDisk.
    const dc = (eng?.diskCandidates ?? []).find(c => c?.candidateId === targetId && c.kind === 'usbDisk' && (c.actions ?? []).includes('erase'))
    if (dc) {
        const parts = dc.partitions ?? []
        const fsType = parts.some(p => p.fsType === 'ext4') ? 'ext4' : (parts.find(p => p.fsType)?.fsType ?? null)
        const candidate = {
            candidateId: dc.candidateId, device: dc.device, sizeBytes: dc.sizeBytes, model: dc.model,
            fsType, label: labelForUnformatted(dc.model, dc.sizeBytes), serial: dc.serial,
        }
        return { kind: 'unformatted', candidate, label: candidate.label, serial: dc.serial ?? dc.candidateId }
    }
    return null
}

/** Disk paths that are IDEA data, never counted as "other" user files. idea#347: .idea-quarantine included. */
export const isIdeaDiskPath = (rel: string): boolean =>
    rel === 'META.yaml' || rel === 'FILES.yaml' || rel === 'BACKUP.yaml' ||
    ['apps', 'instances', 'services', 'backups', 'lost+found', 'files', '.idea-quarantine', '.pre-update'].some(d => rel === d || rel.startsWith(`${d}/`))

export const summariseDisk = async (
    storeHandle: DocHandle<Store>,
    targetId: string,
): Promise<ContentSummary> => {
    const store = storeHandle.doc()!
    const target = resolveSummaryTarget(store, targetId)
    if (!target) throw new Error(`No disk or unformatted candidate '${targetId}' on this Engine.`)

    if (target.kind === 'unformatted') {
        const c = target.candidate!
        const summary: ContentSummary = {
            targetId,
            label: c.label,
            model: c.model,
            sizeBytes: c.sizeBytes,
            usedBytes: null,
            fsType: c.fsType,
            apps: [],
            instances: [],
            backups: [],
            files: null,
            other: null,
            otherPartitions: [],
            readable: false,
            serial: (c as any).serial ?? c.candidateId,
            computedAt: ops.now(),
        }
        return summary
    }

    const disk = target.disk!
    const root = await diskMountRoot(disk)
    const deadline = ops.now() + SUMMARY_MAX_MS
    let entries = 0
    let filesCount = 0, filesBytes = 0
    let otherCount = 0, otherBytes = 0
    let truncated = false

    const underFiles = (rel: string) => rel === 'files' || rel.startsWith('files/')
    const isIdeaPath = isIdeaDiskPath

    const walkResult = await ops.walk(root, (rel, size) => {
        entries++
        if (entries > SUMMARY_MAX_ENTRIES) return false
        if (underFiles(rel) && !rel.endsWith('/')) { filesCount++; filesBytes += size }
        else if (!isIdeaPath(rel) && !rel.endsWith('/')) { otherCount++; otherBytes += size }
    }, deadline)
    truncated = walkResult.truncated || entries > SUMMARY_MAX_ENTRIES

    const apps: ContentSummary['apps'] = Object.values(store.appDB)
        .filter(a => {
            // Apps that came from this disk: instances stored here reference them,
            // or apps/ folder listing — use instances on disk + apps folder if present
            return Object.values(store.instanceDB).some(i => i.storedOn === disk.id && i.instanceOf === a.id)
        })
        .map(a => ({ name: a.name as string, version: a.version as string }))

    // Also list apps present on the disk filesystem
    const seenAppKeys = new Set(apps.map(a => `${a.name}@${a.version}`))
    try {
        const appDirs = await fs.readdir(joinMountRoot(root, 'apps'))
        for (const id of appDirs) {
            // engine#480: same name/version as the App record (from x-app), so kiwix@release-1.0 is not listed twice
            const { name, version } = await appIdentityOfDir(joinMountRoot(root, 'apps', id), id)
            const key = `${name}@${version}`
            if (!seenAppKeys.has(key)) {
                seenAppKeys.add(key)
                apps.push({ name, version })
            }
        }
    } catch { /* no apps/ */ }

    const instances: ContentSummary['instances'] = Object.values(store.instanceDB)
        .filter(i => i.storedOn === disk.id)
        .map(i => ({
            id: i.id,
            name: i.name as string,
            running: i.status === 'Running' || i.status === 'Starting',
            dataBytes: 0 as number | null,
        }))

    // Fill instance data sizes from a focused walk
    for (const inst of instances) {
        const instRoot = joinMountRoot(root, 'instances', inst.id)
        try {
            const r = await ops.walk(instRoot, (_rel, size) => { inst.dataBytes = (inst.dataBytes ?? 0) + size }, deadline)
            if (r.truncated) truncated = true
        } catch { /* missing */ }
    }

    const backups: ContentSummary['backups'] = []
    try {
        const yamlText = await fs.readFile(joinMountRoot(root, 'BACKUP.yaml'), 'utf8')
        const parsed = YAML.parse(yamlText)
        const links = parsed?.links ?? disk.backupConfig?.links ?? []
        for (const link of links) {
            const name = typeof link === 'string' ? link : link?.instanceName ?? link?.name
            if (!name) continue
            const inst = Object.values(store.instanceDB).find(i => i.name === name || i.id === name)
            backups.push({
                instanceId: inst?.id ?? String(name),
                instanceName: name,
                lastBackup: inst?.lastBackup ?? null,
                snapshots: null,
            })
        }
    } catch {
        if (disk.backupConfig?.links) {
            for (const link of disk.backupConfig.links as any[]) {
                const name = typeof link === 'string' ? link : link?.instanceName
                if (!name) continue
                const inst = Object.values(store.instanceDB).find(i => i.name === name || i.id === name)
                backups.push({
                    instanceId: inst?.id ?? String(name),
                    instanceName: name,
                    lastBackup: null,
                    snapshots: null,
                })
            }
        }
    }

    const filesPartial = truncated
    const otherPartial = truncated
    return {
        targetId,
        label: disk.name,
        model: null,
        sizeBytes: disk.sizeBytes ?? 0,
        usedBytes: disk.sizeBytes != null && disk.freeBytes != null ? disk.sizeBytes - disk.freeBytes : null,
        fsType: 'ext4',
        apps,
        instances,
        backups,
        files: { fileCount: filesCount, totalBytes: filesBytes, partial: filesPartial },
        other: { entryCount: otherCount, totalBytes: otherBytes, partial: otherPartial },
        otherPartitions: [],
        readable: true,
        serial: null,
        computedAt: ops.now(),
    }
}

/**
 * Stash a JSON result for the active (or given) trace. closeTrace applies it in
 * the same Automerge change as status=ok so Console sees both together
 * (Prefer A r42: summariseDisk printed OK but EraseDialog timed out — no result).
 */
export const attachTraceResult = (result: unknown, traceId?: string): void => {
    const id = traceId ?? getActiveTrace()?.traceId
    if (!id) return
    const json = JSON.stringify(result)
    stashTraceResult(id, json)
    // Eager write when a handle exists (unit tests / mid-flight readers).
    const h = getCommandLogHandle()
    if (!h) return
    h.change(doc => {
        const t = doc.traces[id]
        // ImmutableString, redacted like closeTrace's write of the same result (engine#471 b)
        if (t) t.result = logStr(redactString(json))
    })
}

/**
 * engine#582: summariseDisk traces this Engine process wrote itself (traceId → when).
 * The command-log document is reachable by peers, so eraseDisk and makeBackupDisk only
 * accept a summary whose trace this Engine produced: a trace that only appears in the
 * document is ignored. Entries older than SUMMARY_MAX_AGE_MS are pruned; a restart
 * forgets them all (the disk is checked again).
 */
const ownSummaryTraces = new Map<string, number>()

/** Remember that this Engine wrote the summariseDisk trace `traceId` (default: the active trace). */
export const rememberOwnSummaryTrace = (traceId?: string, now: number = Date.now()): void => {
    const id = traceId ?? getActiveTrace()?.traceId
    if (!id) return
    for (const [k, at] of ownSummaryTraces) if (now - at > SUMMARY_MAX_AGE_MS) ownSummaryTraces.delete(k)
    ownSummaryTraces.set(id, now)
}

/** Whether `traceId` is a summariseDisk trace this Engine wrote (engine#582). */
export const isOwnSummaryTrace = (traceId: string): boolean => ownSummaryTraces.has(traceId)

/** Tests only. */
export const clearOwnSummaryTracesForTests = (): void => ownSummaryTraces.clear()

/** Read a summariseDisk result from a trace; null if missing/invalid/too old, or not written by this Engine (engine#582). */
export const readSummaryFromTrace = (
    store: Store,
    traceId: string,
    expectTargetId: string,
): ContentSummary | null => {
    if (!isOwnSummaryTrace(traceId)) return null
    const h = getCommandLogHandle()
    if (!h) return null
    const t = h.doc()?.traces[traceId]
    if (!t || t.command !== 'summariseDisk' || t.status !== 'ok') return null
    // plain string (log written before engine#471) or ImmutableString
    const text = commandLogText(t.result)
    if (String(text ?? '') === '') return null
    const age = Date.now() - (t.completedAt ?? t.startedAt)
    if (age > SUMMARY_MAX_AGE_MS) return null
    try {
        const summary = JSON.parse(text!) as ContentSummary
        if (summary.targetId !== expectTargetId) return null
        return summary
    } catch { return null }
}
