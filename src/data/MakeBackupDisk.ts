/**
 * MakeBackupDisk.ts — makeBackupDisk command and Operation (idea#404, Engine PR 4)
 *
 * One op with refusable steps: Check, Erase (skipped on an already-adopted
 * IDEA disk), Re-dock (adopt exactly once; reused from eraseDisk), Create
 * (BACKUP.yaml scheduled at 02:30, empty links, backups/ root). borg init
 * stays per-instance on the first backupApp. No resume path: the operator
 * plugs the disk back in and runs the command again.
 *
 * Refs: proposals/scheduled-backup-disk.md §4, idea#404.
 */

import { fs, path } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { Disk, isSystemDiskRecord } from './Disk.js'
import { localEngineId } from './Engine.js'
import { DiskID, Timestamp } from './CommonTypes.js'
import { createOperation, updateOperation } from './Operations.js'
import { attachTraceResult, readSummaryFromTrace, resolveSummaryTarget } from './SummariseDisk.js'
import { eraseBlocker, eraseDisk, instancesUsingDisk, instancesUsingDiskMessage } from './EraseDisk.js'
import { isSystemDevice, driveNameOf } from './SystemDisk.js'
import { createBackupDiskConfig } from '../monitors/backupMonitor.js'
import { disksRoot } from './Config.js'
import { log, print } from '../utils/utils.js'
import { DEFAULT_BACKUP_TIME } from '../utils/backupSchedule.js'

/** 8 GiB. Engine-owned eligibility threshold (Steve, idea#404); documented in COMMANDS.md. */
export const MAKE_BACKUP_DISK_MIN_BYTES = 8 * 1024 * 1024 * 1024

/** A positive finite total size, otherwise null (missing, 0, or unreadable). */
export const readableBackupDiskBytes = (sizeBytes: unknown): number | null =>
    typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : null

/** Shared TOO_SMALL wording for makeBackupDisk, createBackupDisk and initialiseDisk … backup (engine#452). */
export const backupDiskMinSizeRefusal = (targetId: string, bytes: number | null): { code: 'TOO_SMALL', text: string } => {
    if (bytes == null) {
        return { code: 'TOO_SMALL', text: `could not read the size of '${targetId}', so it was not turned into a Backup Disk.` }
    }
    return {
        code: 'TOO_SMALL',
        text: `this disk is ${bytes} bytes; a Backup Disk must be at least ${MAKE_BACKUP_DISK_MIN_BYTES} bytes (8 GiB).`,
    }
}

/**
 * First readable size from the arguments wins (disk.sizeBytes, then a candidate
 * or summary fallback). Throws MakeBackupDiskError TOO_SMALL when the size cannot
 * be read or is under 8 GiB. Exactly 8 GiB is allowed.
 */
export const assertBackupDiskMinSize = (targetId: string, ...sizes: unknown[]): number => {
    let bytes: number | null = null
    for (const size of sizes) {
        bytes = readableBackupDiskBytes(size)
        if (bytes != null) break
    }
    if (bytes == null || bytes < MAKE_BACKUP_DISK_MIN_BYTES) {
        const { code, text } = backupDiskMinSizeRefusal(targetId, bytes)
        throw new MakeBackupDiskError(code, text)
    }
    return bytes
}

export const MAKE_BACKUP_DISK_STEPS = ['Check', 'Erase', 'Re-dock', 'Create'] as const

export class MakeBackupDiskError extends Error {
    constructor(public code: string, text: string) { super(`${code}: ${text}`) }
}

export interface MakeBackupDiskOps {
    /** True when the whole disk is still present (sysfs). Used to tell UNPLUGGED from REDOCK_TIMEOUT. */
    devicePresent: (device: string) => Promise<boolean>
    ensureBackupRoot: (device: string) => Promise<void>
    isSystemDevice: (device: string) => Promise<boolean>
    now: () => number
    /** Production calls eraseDisk; tests can stub this to avoid the 20 s republish wait. */
    runErase: (
        storeHandle: DocHandle<Store>,
        targetId: string,
        summaryTraceId: string,
        confirmName: string,
        onRedock?: () => void,
    ) => Promise<{ diskId: DiskID; removedInstances: { id: string; name: string; dataBytes: number }[] }>
}

const defaultDevicePresent = async (device: string): Promise<boolean> => {
    const whole = driveNameOf(String(device).replace(/^\/dev\//, ''))
    try {
        await fs.access(`/sys/block/${whole}`)
        return true
    } catch {
        return false
    }
}

const defaultEnsureBackupRoot = async (device: string): Promise<void> => {
    await fs.ensureDir(path.join(disksRoot(), device, 'backups'))
}

const defaultOps: MakeBackupDiskOps = {
    devicePresent: defaultDevicePresent,
    ensureBackupRoot: defaultEnsureBackupRoot,
    isSystemDevice: (d) => isSystemDevice(d),
    now: () => Date.now(),
    runErase: (h, targetId, summaryTraceId, confirmName, onRedock) => eraseDisk(h, targetId, summaryTraceId, confirmName, { onRedock }),
}

let ops: MakeBackupDiskOps = defaultOps

export const setMakeBackupDiskOpsForTests = (o: Partial<MakeBackupDiskOps> | null): void => {
    ops = o ? { ...defaultOps, ...o } : defaultOps
}

const fail = (storeHandle: DocHandle<Store>, opId: string | null, code: string, text: string): never => {
    if (opId) {
        updateOperation(storeHandle, opId, {
            status: 'Failed',
            completedAt: ops.now() as Timestamp,
            error: `${code}: ${text}`,
        })
    }
    throw new MakeBackupDiskError(code, text)
}

const looksUnplugged = (message: string): boolean => {
    const m = message.toLowerCase()
    return (
        /\benodev\b/.test(m) ||
        /no such device/.test(m) ||
        /no medium found/.test(m) ||
        /medium not found/.test(m)
    )
}

/**
 * Map an erase/re-dock failure. If the whole disk has left sysfs, or the
 * error is a typical unplug errno, that is UNPLUGGED (Console: "unplugged
 * during setup, plug it back in and try again"). If the disk is still
 * present and erase finished but the IDEA record never came back, that is
 * REDOCK_TIMEOUT. Presence is checked at the moment of failure via
 * /sys/block/<whole> (injectable in tests).
 */
const mapEraseOrRedockError = async (
    err: unknown,
    device: string | null,
): Promise<{ code: string, text: string }> => {
    const raw = err instanceof Error ? err.message : String(err)
    const present = device ? await ops.devicePresent(device) : false
    if (!present || looksUnplugged(raw)) {
        return {
            code: 'UNPLUGGED',
            text: 'the disk was unplugged during setup; plug it back in and try again',
        }
    }
    if (/did not come back as empty/i.test(raw)) {
        return { code: 'REDOCK_TIMEOUT', text: raw }
    }
    if (/system disk/i.test(raw)) return { code: 'SYSTEM_DISK', text: raw }
    if (/summary is missing|older than/i.test(raw)) return { code: 'SUMMARY_STALE', text: raw }
    if (/Typed name does not match/i.test(raw)) return { code: 'CONFIRM_MISMATCH', text: raw }
    if (/serial mismatch/i.test(raw)) return { code: 'SERIAL_MISMATCH', text: raw }
    if (/^INVALID_INSTANCE_ID:/.test(raw) || /INVALID_INSTANCE_ID/.test(raw)) {
        return { code: 'INVALID_INSTANCE_ID', text: raw.replace(/^INVALID_INSTANCE_ID:\s*/, '') }
    }
    if (/is not docked/i.test(raw)) return { code: 'NOT_DOCKED', text: raw }
    if (/No disk or unformatted/i.test(raw)) return { code: 'NOT_FOUND', text: raw }
    if (/try again later/i.test(raw)) return { code: 'BUSY', text: raw }
    if (/is in use by/i.test(raw)) return { code: 'IN_USE', text: raw }
    if (/partition table also has/i.test(raw)) return { code: 'HIDDEN_PARTITIONS', text: raw }
    if (/operating system|os-release/i.test(raw)) return { code: 'OS_ROOTFS', text: raw }
    return { code: 'WRITE_FAILED', text: raw }
}

const needsErase = (target: NonNullable<ReturnType<typeof resolveSummaryTarget>>): boolean =>
    target.kind !== 'disk'

const sizeOf = (
    target: NonNullable<ReturnType<typeof resolveSummaryTarget>>,
    summarySize?: number | null,
): number | null => {
    return readableBackupDiskBytes(summarySize)
        ?? (target.kind === 'disk'
            ? readableBackupDiskBytes(target.disk!.sizeBytes)
            : readableBackupDiskBytes(target.candidate?.sizeBytes))
}

const deviceOf = (target: NonNullable<ReturnType<typeof resolveSummaryTarget>>): string | null => {
    if (target.kind === 'disk') return target.disk?.device ?? null
    return target.candidate?.device ?? null
}

/**
 * Create step, also used by initialiseDisk <candidateId> backup so that path
 * is not a weaker on-demand second route (Steve, idea#404 Q3).
 */
export const applyMakeBackupDiskCreate = async (
    storeHandle: DocHandle<Store>,
    disk: Disk,
    sizeBytesFallback?: unknown,
): Promise<void> => {
    if (!disk.device) {
        throw new MakeBackupDiskError('NOT_DOCKED', `Disk '${disk.name}' (${disk.id}) is not currently docked.`)
    }
    // engine#452: same 8 GiB floor as makeBackupDisk Check, shared helper.
    assertBackupDiskMinSize(disk.id, disk.sizeBytes, sizeBytesFallback)
    await createBackupDiskConfig(storeHandle, disk, 'scheduled', [])
    await ops.ensureBackupRoot(disk.device)
}

export const makeBackupDisk = async (
    storeHandle: DocHandle<Store>,
    targetId: string,
    summaryTraceId?: string,
    confirmName?: string,
): Promise<{ operationId: string, diskId: DiskID, erased: boolean }> => {
    if (!targetId) throw new MakeBackupDiskError('BAD_ARGS', 'usage: makeBackupDisk <targetId> [<summaryTraceId> <confirmName…>]')

    const store = storeHandle.doc()
    if (!store) throw new MakeBackupDiskError('BAD_ARGS', 'Store is not available. Please connect first.')

    const target = resolveSummaryTarget(store, targetId)
    if (!target) throw new MakeBackupDiskError('NOT_FOUND', `No disk or unformatted candidate '${targetId}' on this Engine.`)

    const erase = needsErase(target)
    if (erase && (!summaryTraceId || !confirmName)) {
        throw new MakeBackupDiskError(
            'BAD_ARGS',
            'makeBackupDisk needs <summaryTraceId> and the typed disk label when the stick will be erased',
        )
    }

    const opId = createOperation(
        storeHandle,
        'makeBackupDisk',
        {
            targetId,
            ...(summaryTraceId ? { summaryTraceId } : {}),
            ...(confirmName ? { confirmName } : {}),
        },
        'console-command',
        { type: 'disk', id: targetId },
    )

    const step = (index: number, label: string) => {
        updateOperation(storeHandle, opId, {
            status: 'Running',
            currentStep: index,
            totalSteps: MAKE_BACKUP_DISK_STEPS.length,
            stepLabel: label,
            progressPercent: Math.round((index / MAKE_BACKUP_DISK_STEPS.length) * 100),
        })
    }

    try {
        step(0, 'Check')

        if (target.kind === 'disk') {
            const disk = target.disk!
            if ((disk.diskTypes ?? []).includes('system') || `ENGINE_${disk.id}` === localEngineId || await isSystemDiskRecord(disk)) {
                fail(storeHandle, opId, 'SYSTEM_DISK', `${disk.name} is this Pi's system disk and cannot become a Backup Disk.`)
            }
            if (disk.device && await ops.isSystemDevice(disk.device)) {
                fail(storeHandle, opId, 'SYSTEM_DISK', `${disk.name} is this Pi's system disk and cannot become a Backup Disk.`)
            }
            if (!disk.device || String(disk.dockedTo) !== String(localEngineId)) {
                fail(storeHandle, opId, 'NOT_DOCKED', `Disk '${disk.name}' (${disk.id}) is not docked to this Engine.`)
            }
            if ((disk.diskTypes ?? []).includes('backup') || disk.backupConfig != null) {
                fail(storeHandle, opId, 'ALREADY_BACKUP', `${disk.name} is already a Backup Disk; use setBackupMode to change mode or time.`)
            }
            const blocker = await eraseBlocker(storeHandle.doc()!, disk)
            if (blocker) fail(storeHandle, opId, 'BUSY', blocker)
            const users = await instancesUsingDisk(storeHandle.doc()!, disk)
            // Combined App/Files disks keep their instances; only a wipe would need this. Adopt path allows it.
            if (erase && users.length > 0) fail(storeHandle, opId, 'IN_USE', instancesUsingDiskMessage(disk.name, users))
        } else {
            const c = target.candidate!
            if (await ops.isSystemDevice(c.device)) {
                fail(storeHandle, opId, 'SYSTEM_DISK', `${c.label} is this Pi's system disk and cannot become a Backup Disk.`)
            }
            const blocker = await eraseBlocker(storeHandle.doc()!, null)
            if (blocker) fail(storeHandle, opId, 'BUSY', blocker)
        }

        const summary = (erase && summaryTraceId)
            ? readSummaryFromTrace(storeHandle.doc()!, summaryTraceId, targetId)
            : null
        if (erase) {
            if (!summary) fail(storeHandle, opId, 'SUMMARY_STALE', 'The summary is missing, for another disk, or older than 10 minutes. Check the disk again.')
            if (summary!.label !== confirmName) {
                fail(storeHandle, opId, 'CONFIRM_MISMATCH', `Typed name does not match the disk label '${summary!.label}'.`)
            }
        }

        const bytes = sizeOf(target, summary?.sizeBytes)
        if (bytes == null || bytes < MAKE_BACKUP_DISK_MIN_BYTES) {
            const refusal = backupDiskMinSizeRefusal(targetId, bytes)
            return fail(storeHandle, opId, refusal.code, refusal.text)
        }

        let diskId: DiskID
        if (erase) {
            step(1, 'Erase')
            const dev = deviceOf(target)
            let erased: { diskId: DiskID }
            // engine#432: eraseDisk re-docks the disk itself, so it tells us when that starts;
            // Re-dock is then visible while the disk is mounted and registered again.
            let redockShown = false
            const onRedock = () => { if (!redockShown) { redockShown = true; step(2, 'Re-dock') } }
            try {
                erased = await ops.runErase(storeHandle, targetId, summaryTraceId!, confirmName!, onRedock)
            } catch (e) {
                const mapped = await mapEraseOrRedockError(e, dev)
                return fail(storeHandle, opId, mapped.code, mapped.text)
            }
            diskId = erased.diskId
            onRedock()   // an erase path that never called the hook still shows the step
            const published = storeHandle.doc()!.diskDB[diskId]
            if (!published || String(published.dockedTo) !== String(localEngineId) || !published.device) {
                const mapped = await mapEraseOrRedockError(
                    new Error(`Erase finished but the disk did not come back as empty (id ${diskId}).`),
                    deviceOf(target) ?? published?.device ?? null,
                )
                fail(storeHandle, opId, mapped.code, mapped.text)
            }
        } else {
            step(1, 'Erase (skipped)')
            step(2, 'Re-dock (skipped)')
            diskId = target.disk!.id
        }

        step(3, 'Create')
        const disk = storeHandle.doc()!.diskDB[diskId]
        if (!disk) fail(storeHandle, opId, 'NOT_FOUND', `Disk '${diskId}' was not in the store after re-dock.`)
        try {
            await applyMakeBackupDiskCreate(storeHandle, disk)
        } catch (e) {
            if (e instanceof MakeBackupDiskError) fail(storeHandle, opId, e.code, e.message.replace(new RegExp(`^${e.code}:\\s*`), ''))
            const msg = e instanceof Error ? e.message : String(e)
            fail(storeHandle, opId, 'WRITE_FAILED', msg)
        }

        const final = storeHandle.doc()!.diskDB[diskId]
        updateOperation(storeHandle, opId, {
            status: 'Done',
            completedAt: ops.now() as Timestamp,
            currentStep: 3,
            totalSteps: 4,
            stepLabel: 'Create',
            progressPercent: 100,
        })
        attachTraceResult({ targetId, diskId, erased: erase ? 'true' : 'false', mode: 'scheduled', schedule: DEFAULT_BACKUP_TIME })
        print(`makeBackupDisk: '${final?.name ?? diskId}' (${diskId}) is now a scheduled Backup Disk (daily ${DEFAULT_BACKUP_TIME})`)
        log(`makeBackupDisk ${diskId}: erased=${erase} mode=scheduled daily=${DEFAULT_BACKUP_TIME}`)
        return { operationId: opId, diskId, erased: erase }
    } catch (e) {
        if (e instanceof MakeBackupDiskError) throw e
        const msg = e instanceof Error ? e.message : String(e)
        return fail(storeHandle, opId, 'WRITE_FAILED', msg)
    }
}
