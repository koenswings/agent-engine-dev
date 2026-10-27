/**
 * FlashCard.ts — flashCard, cancelFlash, initialiseDisk (idea#201 §10, Engine API contract v2)
 *
 *   flashCard <candidateId> <version|current> <confirmSizeBytes>
 *   cancelFlash <operationId>
 *   initialiseDisk <candidateId> [empty|files|backup]
 *
 * Refusals throw "CODE: text" (trace ends error, Console maps the code). Accepted work
 * runs as an Operation (kind flashCard / initialiseDisk, subject {type:'disk', id: candidateId}).
 * A flash runs in the background so the serial command queue stays free for cancelFlash;
 * its Operation carries progress and ends Done with safeToRemove, or Failed "CODE: text"
 * (a cancel ends Failed "CANCELLED: ..."; there is no Cancelled status, decision 1).
 *
 * Safety (§10): only a card in this Engine's current clientCards scan is a flash target;
 * the root helper idea-flash-card re-checks everything itself (by-id re-resolve before and
 * during the write, removable, not system/boot, nothing mounted, no IDEA META, image SHA,
 * read-back SHA) and powers the card off. initialiseDisk is the only path that mounts an
 * unknown disk read-write and writes META.yaml, and only after a read-only look found none.
 */
import path from 'path'
import { spawn, ChildProcess } from 'child_process'
import { $, fs, YAML } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { DeviceName, DiskID, DiskName, EngineID, Timestamp } from './CommonTypes.js'
import { localEngineId } from './Engine.js'
import { createOperation, updateOperation } from './Operations.js'
import { refreshClientCards, ScannedCard, ScanResult, NewDisk, setClientCardProbes } from './ClientCards.js'
import { refreshClientImages, imagePathOf, resolveImage } from './ClientImages.js'
import { attachTraceResult } from './SummariseDisk.js'
import { getActiveTrace } from '../utils/CommandLogger.js'
import { isSystemDevice } from './SystemDisk.js'
import { ENGINE_STATE_DIR } from './FilesMount.js'
import { lookForIdeaMeta, safeMount, mountPointOf, unmountAndRemove } from '../monitors/mounts.js'
import { forgetMetaLook } from '../monitors/metaLookCache.js'
import { log, print, uuid } from '../utils/utils.js'
import { readEngineTimezone, validateClientTimezone, ZONEINFO_DIR } from './ClientTimezone.js'

export const FLASH_HELPER = '/usr/local/sbin/idea-flash-card'
export const FLASH_LOG = path.join(ENGINE_STATE_DIR, 'flash.log')
export const FLASH_STEPS = ['checking', 'verifying-image', 'writing', 'reading-back', 'flushing', 'powering-off'] as const
export type FlashStep = typeof FLASH_STEPS[number]
export const INITIALISE_ROLES = ['empty', 'files', 'backup'] as const
export type InitialiseRole = typeof INITIALISE_ROLES[number]

export interface FlashInProgress { operationId: string; candidateId: string; version: string; step: FlashStep }

export class CardError extends Error {
    constructor(public code: string, text: string) { super(`${code}: ${text}`) }
}

export interface FlashHelperArgs {
    byId: string; device: string; sizeBytes: number; image: string; sha256: string
    /** idea#303: partitions with an OS rootfs layout (hasOsRootfsLayout); a META.yaml there does not block the flash */
    osRootfsPartitions: string[]
    /** idea#208: the Engine's own validated tz name → idea-timezone.txt on the card; absent: no file (client stays UTC) */
    timezone?: string
}

export interface FlashCardOps {
    helperInstalled: () => boolean
    spawnHelper: (a: FlashHelperArgs) => ChildProcess
    scan: (h: DocHandle<Store>) => Promise<ScanResult>
    images: (h: DocHandle<Store>) => ReturnType<typeof refreshClientImages>
    appendFlashLog: (line: string) => Promise<void>
    isSystemDevice: (d: string) => Promise<boolean>
    /** ro look for META (rule 1); never rw */
    lookForMeta: (partition: string) => ReturnType<typeof lookForIdeaMeta>
    mountRw: (partition: string) => ReturnType<typeof safeMount>
    writeMeta: (partition: string, yaml: string) => Promise<void>
    /** Forget the usb monitor's cached ro META look, so addDevice sees the new META.yaml */
    forgetMetaLook: (partition: string) => void
    /** The usb monitor's addDevice (registers the now-IDEA disk) */
    addDevice: (partition: string) => Promise<void>
    /** Unmount the rw mount this command made and remove the mount point (never rm -fr) */
    unmount: (partition: string) => Promise<{ ok: boolean; message?: string }>
    createFilesDisk: (h: DocHandle<Store>, diskId: string) => Promise<unknown>
    createBackupDisk: (h: DocHandle<Store>, diskId: string) => Promise<unknown>
    now: () => number
    /** idea#208: the Engine's own time zone (timedatectl, as pi) */
    engineTimezone: () => Promise<string>
    zoneinfoDir: string
    /** `sudo -n idea-flash-card --version` → its protocol number; null when unknown or the probe fails */
    helperVersion: () => Promise<number | null>
}

let addDeviceImpl: ((p: string) => Promise<void>) | null = null
export const setInitialiseAddDevice = (fn: ((p: string) => Promise<void>) | null): void => { addDeviceImpl = fn }

const defaultOps: FlashCardOps = {
    helperInstalled: () => { try { fs.accessSync(FLASH_HELPER, fs.constants.X_OK); return true } catch { return false } },
    spawnHelper: (a) => spawn('sudo', ['-n', FLASH_HELPER, '--by-id', a.byId, '--expect-device', a.device,
        '--expect-size', String(a.sizeBytes), '--image', a.image, '--sha256', a.sha256,
        ...a.osRootfsPartitions.flatMap(p => ['--os-rootfs', p]),
        ...(a.timezone ? ['--timezone', a.timezone] : [])], { stdio: ['ignore', 'pipe', 'pipe'] }),
    scan: (h) => refreshClientCards(h),
    images: (h) => refreshClientImages(h),
    appendFlashLog: async (line) => { await fs.ensureDir(path.dirname(FLASH_LOG)); await fs.appendFile(FLASH_LOG, line + '\n') },
    isSystemDevice: (d) => isSystemDevice(d),
    lookForMeta: (p) => lookForIdeaMeta(p),
    mountRw: (p) => safeMount(p),
    writeMeta: async (p, yaml) => {
        const r = await $({ input: yaml })`sudo -n /usr/bin/tee ${mountPointOf(p)}/META.yaml`.nothrow()
        if (r.exitCode !== 0) throw new Error(`could not write META.yaml on ${p}: ${r.stderr.trim()}`)
    },
    forgetMetaLook: (p) => forgetMetaLook(p),
    addDevice: async (p) => { if (!addDeviceImpl) throw new Error('usb monitor not running'); await addDeviceImpl(`/dev/engine/${p}`) },
    unmount: (p) => unmountAndRemove(p),
    createFilesDisk: async (h, id) => (await import('./CreateFilesDisk.js')).createFilesDisk(h, id),
    createBackupDisk: async (h, id) => {
        const disk = h.doc()?.diskDB?.[id as DiskID]
        if (!disk) throw new Error(`disk ${id} is not in the store`)
        return (await import('../monitors/backupMonitor.js')).createBackupDiskConfig(h, disk as any, 'on-demand' as any, [])
    },
    now: () => Date.now(),
    engineTimezone: () => readEngineTimezone(),
    zoneinfoDir: ZONEINFO_DIR,
    helperVersion: async () => {
        const r = await $`sudo -n ${FLASH_HELPER} --version`.nothrow().quiet()
        return r.exitCode === 0 ? parseFlashHelperVersion(r.stdout) : null
    },
}
let ops: FlashCardOps = defaultOps
export const setFlashCardOpsForTests = (o: Partial<FlashCardOps> | null): void => { ops = o ? { ...defaultOps, ...o } : defaultOps }

/** idea#208: --timezone needs idea-flash-card v3 or later */
export const FLASH_HELPER_TIMEZONE_MIN = 3
/** Parse "idea-flash-card <N>" (the helper's --version line); null for anything else. */
export const parseFlashHelperVersion = (out: string): number | null => {
    const m = /^idea-flash-card ([0-9]{1,6})$/.exec(String(out ?? '').trim())
    return m ? Number(m[1]) : null
}

// ── Busy state (one flash / initialise per Engine) ───────────────────────────
const running = new Map<string, { proc: ChildProcess | null; cancelled: boolean; kind: 'flashCard' | 'initialiseDisk' }>()
export const cardOperationRunning = (): boolean => running.size > 0
export const clearFlashStateForTests = (): void => { running.clear() }
setClientCardProbes({ busy: () => cardOperationRunning(), helperInstalled: () => ops.helperInstalled() })

const engineBusyReason = (store: Store | undefined, engineId: string): string | null => {
    const e: any = store?.engineDB?.[engineId as EngineID]
    if (running.size) return 'another flash or initialise is running on this Engine'
    if (e?.flashInProgress) return 'a flash is running on this Engine'
    if (e?.eraseInProgress) return 'an erase is running on this Engine'
    return null
}

const setFlashInProgress = (h: DocHandle<Store>, v: FlashInProgress | null) => {
    h.change(doc => { const e: any = doc.engineDB[localEngineId]; if (e) e.flashInProgress = v })
}

/** Parse a helper stderr line "refused: CODE: text" / "failed: CODE: text". */
export const parseHelperError = (stderr: string): { code: string; text: string } => {
    const lines = stderr.trim().split('\n').reverse()
    for (const l of lines) {
        const m = /^(?:refused|failed):\s*([A-Z][A-Z0-9_]+):\s*(.*)$/.exec(l.trim())
        if (m) return { code: m[1], text: m[2] }
    }
    return { code: 'WRITE_FAILED', text: stderr.trim().split('\n').pop() || 'flash helper failed without a message' }
}

export interface FlashResult {
    candidateId: string; byId: string; version: string; sha256: string
    bytesWritten: number; readBackSha256: string | null; durationMs: number; safeToRemove: boolean
}

// ── flashCard ────────────────────────────────────────────────────────────────

/**
 * Checks, then starts the flash and returns { operationId, done }. Refusals throw CardError
 * before any Operation is created. `done` settles when the helper exits (never rejects).
 */
export const flashCard = async (
    storeHandle: DocHandle<Store>, candidateId: string, versionArg: string, confirmSizeArg: string,
): Promise<{ operationId: string; done: Promise<FlashResult | null> }> => {
    if (!candidateId || !versionArg || !/^[0-9]+$/.test(confirmSizeArg ?? '')) {
        throw new CardError('BAD_ARGS', 'usage: flashCard <candidateId> <version|current> <confirmSizeBytes>')
    }
    const confirmSize = Number(confirmSizeArg)
    const busy = engineBusyReason(storeHandle.doc(), String(localEngineId))
    if (busy) throw new CardError('BUSY', busy)
    const scan = await ops.scan(storeHandle)
    const card: ScannedCard | undefined = scan.clientCards.find(c => c.candidateId === candidateId)
    if (!card) {
        if (scan.newDisks.some(d => d.candidateId === candidateId)) throw new CardError('NOT_REMOVABLE', `${candidateId} is not a removable card`)
        throw new CardError('NOT_FOUND', `card ${candidateId} is not present on this Engine`)
    }
    if (await ops.isSystemDevice(card.device)) throw new CardError('SYSTEM_DISK', `${card.device} is this Pi's system disk`)
    if (card.refusal) throw new CardError(card.refusal, `card ${candidateId} cannot be flashed now (${card.refusal}${card.mountpoints.length ? `: ${card.mountpoints.join(', ')}` : ''})`)
    if (!ops.helperInstalled()) throw new CardError('HELPER_MISSING', `${FLASH_HELPER} is not installed`)
    if (card.sizeBytes !== confirmSize) throw new CardError('SIZE_CHANGED', `card size is ${card.sizeBytes}, the dialog showed ${confirmSize}`)
    if (!card.byId || !card.byId.startsWith('/dev/disk/by-id/usb-')) throw new CardError('NOT_REMOVABLE', `${card.device} has no USB by-id link`)
    const imgs = await ops.images(storeHandle)
    const r = resolveImage(imgs, versionArg)
    if (!r.ok) throw new CardError(r.code, r.text)
    const image = r.image
    if (image.imageSizeBytes != null && image.imageSizeBytes > card.sizeBytes) {
        throw new CardError('IMAGE_TOO_LARGE', `image needs ${image.imageSizeBytes} bytes, the card has ${card.sizeBytes}`)
    }

    // idea#303: an old Engine system disk (OS rootfs + META.yaml, e.g. a retired Engine stick) may be
    // reflashed. Same read-only look and rootfs rule as adoption (lookForIdeaMeta / hasOsRootfsLayout,
    // idea#279); the helper still refuses META.yaml on every partition not named here.
    const osRootfsPartitions: string[] = []
    for (const p of card.ext4PartitionNames.filter(n => /^sd[a-z][12]$/.test(n))) {
        const look = await ops.lookForMeta(p)
        if (look.ok && look.osRootfs) osRootfsPartitions.push(p)
    }

    // idea#208: pass the Engine's own zone; an empty or invalid one is skipped (logged), never fatal
    // Version gate: an older helper refuses the unknown --timezone with BAD_ARGS, so never pass it there.
    const helperVersion = await ops.helperVersion().catch(() => null)
    let timezone: string | undefined
    if (helperVersion == null || helperVersion < FLASH_HELPER_TIMEZONE_MIN) {
        print(`flashCard: idea-timezone.txt skipped: ${FLASH_HELPER} is too old (version ${helperVersion ?? 'unknown'}, needs >= ${FLASH_HELPER_TIMEZONE_MIN}); the client stays on UTC`)
    } else {
        const tz = validateClientTimezone(await ops.engineTimezone().catch(() => ''), ops.zoneinfoDir)
        timezone = tz.ok ? tz.zone : undefined
        if (!tz.ok) log(`flashCard: idea-timezone.txt skipped (${tz.reason}); the client stays on UTC`)
    }

    const traceId = getActiveTrace()?.traceId
    const opId = createOperation(storeHandle, 'flashCard',
        { candidateId, version: image.version, confirmSizeBytes: String(confirmSize) }, 'console-command', { type: 'disk', id: candidateId })
    const started = ops.now()
    const entry = { proc: null as ChildProcess | null, cancelled: false, kind: 'flashCard' as const }
    running.set(opId, entry)
    updateOperation(storeHandle, opId, { status: 'Running', currentStep: 0, totalSteps: FLASH_STEPS.length, stepLabel: 'checking' })
    setFlashInProgress(storeHandle, { operationId: opId, candidateId, version: image.version, step: 'checking' })
    refreshClientCards(storeHandle).catch(() => {})   // show BUSY now, not at the next poll
    print(`Flashing ${image.fileName} to ${card.device} (${card.byId}, ${card.sizeBytes} bytes), operation ${opId}`)

    const done = new Promise<FlashResult | null>((resolve) => {
        let proc: ChildProcess
        try {
            proc = ops.spawnHelper({ byId: card.byId!, device: card.device, sizeBytes: card.sizeBytes, image: imagePathOf(image.version), sha256: image.sha256, osRootfsPartitions, timezone })
        } catch (e) {
            finish(null, { code: 'HELPER_MISSING', text: String(e) }); return
        }
        entry.proc = proc
        let out = '', err = '', lastStep: FlashStep = 'checking', lastPct = -1
        let final: any = null
        proc.stdout?.on('data', (b: Buffer) => {
            out += b.toString()
            let i
            while ((i = out.indexOf('\n')) >= 0) {
                const line = out.slice(0, i); out = out.slice(i + 1)
                let j: any
                try { j = JSON.parse(line) } catch { continue }
                if (j.result) { final = j; continue }
                const step = j.step as FlashStep
                const idx = FLASH_STEPS.indexOf(step)
                if (idx < 0) continue
                const pct = j.total > 0 ? Math.min(100, Math.floor((j.bytes / j.total) * 100)) : null
                if (step !== lastStep) {
                    lastStep = step
                    updateOperation(storeHandle, opId, { currentStep: idx, totalSteps: FLASH_STEPS.length, stepLabel: step, progressPercent: pct })
                    setFlashInProgress(storeHandle, { operationId: opId, candidateId, version: image.version, step })
                } else if (pct != null && pct !== lastPct && Math.floor(pct / 5) !== Math.floor(Math.max(lastPct, 0) / 5)) {
                    // Store design 2026-10-13 drops progress-only patches; a flash stores its
                    // progress in 5 % steps (≤ 20 changes per step) by repeating currentStep.
                    updateOperation(storeHandle, opId, { currentStep: idx, progressPercent: pct })
                }
                if (pct != null) lastPct = pct
            }
        })
        proc.stderr?.on('data', (b: Buffer) => { err += b.toString() })
        proc.on('error', (e) => finish(null, { code: 'HELPER_MISSING', text: e.message }))
        proc.on('close', (code) => {
            if (code === 0 && final?.result === 'ok') finish(final, null)
            else if (entry.cancelled) finish(null, { code: 'CANCELLED', text: 'flash cancelled; the card is wiped or incomplete — flash it again before use' })
            else finish(null, parseHelperError(err || `helper exited with code ${code}`))
        })

        let settled = false
        function finish(ok: any, failure: { code: string; text: string } | null) {
            if (settled) return
            settled = true
            running.delete(opId)
            const durationMs = ops.now() - started
            const safe = ok ? ok.safeToRemove === true : false
            const result: FlashResult = {
                candidateId, byId: card!.byId!, version: image.version, sha256: image.sha256,
                bytesWritten: ok ? Number(ok.bytesWritten) || 0 : 0, readBackSha256: ok?.readBackSha256 ?? null, durationMs, safeToRemove: safe,
            }
            if (ok) {
                if (ok.timezoneFile === 'failed') log(`Flash ${opId}: idea-timezone.txt could not be written (${(err.match(/^warning: TIMEZONE_FAILED: (.*)$/m) ?? [])[1] ?? 'no detail'}); the client stays on UTC`)
                else if (ok.timezoneFile === 'written') log(`Flash ${opId}: idea-timezone.txt = ${timezone}`)
                updateOperation(storeHandle, opId, {
                    status: 'Done', completedAt: ops.now() as Timestamp, progressPercent: 100, safeToRemove: safe,
                    error: safe ? null : 'POWER_OFF_FAILED: the card was written but could not be switched off — eject it before removing it',
                })
            } else {
                updateOperation(storeHandle, opId, { status: 'Failed', completedAt: ops.now() as Timestamp, error: `${failure!.code}: ${failure!.text}`, safeToRemove: false })
            }
            setFlashInProgress(storeHandle, null)
            if (traceId) attachTraceResult(ok ? result : { ...result, error: `${failure!.code}: ${failure!.text}` }, traceId)
            const line = JSON.stringify({ at: new Date(ops.now()).toISOString(), operationId: opId, traceId: traceId ?? null,
                result: ok ? (safe ? 'ok' : 'POWER_OFF_FAILED') : failure!.code, version: image.version, sha256: image.sha256,
                byId: card!.byId, device: card!.device, sizeBytes: card!.sizeBytes, bytesWritten: result.bytesWritten, durationMs,
                timezone: timezone ?? null, timezoneFile: ok ? (ok.timezoneFile ?? null) : null })
            ops.appendFlashLog(line).catch(e => log(`flash.log: ${e}`))
            log(ok ? `Flash ${opId} done (safeToRemove=${safe})` : `Flash ${opId} failed: ${failure!.code}: ${failure!.text}`)
            refreshClientCards(storeHandle).catch(() => {})
            resolve(ok ? result : null)
        }
    })
    return { operationId: opId, done }
}

/** cancelFlash <operationId>: allowed while the write has not finished (before reading-back). */
export const cancelFlash = (storeHandle: DocHandle<Store>, operationId: string): void => {
    const op = storeHandle.doc()?.operationDB?.[operationId]
    const entry = running.get(operationId)
    if (!op || op.kind !== 'flashCard') throw new CardError('NOT_FOUND', `no flash operation ${operationId}`)
    if (!entry || op.status !== 'Running') throw new CardError('NOT_FOUND', `flash ${operationId} is not running (${op.status})`)
    const step = op.stepLabel as FlashStep | null
    if (step && FLASH_STEPS.indexOf(step) > FLASH_STEPS.indexOf('writing')) {
        throw new CardError('BUSY', `flash ${operationId} has finished writing (${step}); it cannot be cancelled now`)
    }
    entry.cancelled = true
    entry.proc?.kill('SIGTERM')
    print(`Cancel sent to flash ${operationId}`)
}

// ── initialiseDisk ───────────────────────────────────────────────────────────

/**
 * initialiseDisk failure cleanup: unmount the rw mount initialiseDisk made, unless a disk
 * record on this Engine uses the partition (then it is a docked disk and is left alone).
 * Never throws; a failed unmount is logged and the mount is left as it is.
 */
const releaseRwMount = async (storeHandle: DocHandle<Store>, partition: string): Promise<void> => {
    const inUse = Object.values(storeHandle.doc()?.diskDB ?? {})
        .some((d: any) => d?.device === partition && d?.dockedTo === localEngineId)
    if (inUse) { log(`initialiseDisk: ${partition} failed to register but a disk record uses it; left mounted`); return }
    try {
        const r = await ops.unmount(partition)
        log(r.ok ? `initialiseDisk: unmounted ${partition} after the failed registration`
            : `initialiseDisk: could not unmount ${partition} after the failed registration: ${r.message}`)
    } catch (e) {
        log(`initialiseDisk: could not unmount ${partition} after the failed registration: ${e instanceof Error ? e.message : String(e)}`)
    }
    // The next add of this partition must look again (it now has META.yaml)
    ops.forgetMetaLook(partition)
}

export const initialiseDisk = async (
    storeHandle: DocHandle<Store>, candidateId: string, roleArg: string = 'empty',
): Promise<{ operationId: string; diskId: string; partition: string }> => {
    const role = (roleArg || 'empty') as InitialiseRole
    if (!candidateId || !INITIALISE_ROLES.includes(role)) throw new CardError('BAD_ARGS', 'usage: initialiseDisk <candidateId> [empty|files|backup]')
    const busy = engineBusyReason(storeHandle.doc(), String(localEngineId))
    if (busy) throw new CardError('BUSY', busy)
    const scan = await ops.scan(storeHandle)
    const disk: NewDisk | undefined = scan.newDisks.find(d => d.candidateId === candidateId)
    if (!disk) {
        if (scan.clientCards.some(c => c.candidateId === candidateId)) throw new CardError('NOT_FOUND', `${candidateId} is a client card; cards are flashed, not initialised`)
        throw new CardError('NOT_FOUND', `disk ${candidateId} is not a new disk on this Engine`)
    }
    if (await ops.isSystemDevice(disk.device)) throw new CardError('SYSTEM_DISK', `${disk.device} is this Pi's system disk`)
    const unformatted = (storeHandle.doc()?.engineDB?.[localEngineId]?.unformattedDisks ?? []).some(u => u?.candidateId === candidateId)
    const names = scan.newDiskPartitions?.[candidateId] ?? []
    const ext4 = disk.partitions.map((p, i) => ({ ...p, name: names[i] ?? `${disk.device}${i + 1}` })).filter(p => p.fsType === 'ext4')
    if (unformatted || ext4.length === 0) throw new CardError('NOT_EXT4', `${disk.device} has no ext4 partition; erase it first, then initialise it`)
    const target = ext4.find(p => /^sd[a-z][12]$/.test(p.name))
    if (!target) throw new CardError('NOT_EXT4', `${disk.device}: only partition 1 or 2 can become an IDEA disk`)
    const mounted = scan.newDisks.find(d => d.candidateId === candidateId)?.mountedReadOnly
    if (mounted) throw new CardError('MOUNTED', `${disk.device} is mounted`)

    const opId = createOperation(storeHandle, 'initialiseDisk', { candidateId, role }, 'console-command', { type: 'disk', id: candidateId })
    running.set(opId, { proc: null, cancelled: false, kind: 'initialiseDisk' })
    // Set once this command has mounted the partition read-write itself; cleared once the disk is registered
    let mountedHere = false
    let registered = false
    let diskId: DiskID | null = null
    const fail = (code: string, text: string): never => {
        updateOperation(storeHandle, opId, { status: 'Failed', completedAt: ops.now() as Timestamp, error: `${code}: ${text}` })
        throw new CardError(code, text)
    }
    try {
        updateOperation(storeHandle, opId, { status: 'Running', currentStep: 0, totalSteps: 3, stepLabel: 'checking' })
        const look = await ops.lookForMeta(target.name)
        if (!look.ok) fail('MOUNTED', look.message)
        if (look.ok && look.osRootfs) fail('OS_ROOTFS', `${target.name} holds an operating system (etc/os-release + usr/ or boot/); it cannot become an IDEA disk in place — flash it instead`)
        if (look.ok && look.hasMeta) fail('ALREADY_IDEA', `${target.name} already has an IDEA META.yaml`)
        updateOperation(storeHandle, opId, { currentStep: 1, stepLabel: 'writing META.yaml' })
        const m = await ops.mountRw(target.name)
        if (!m.ok) fail('MOUNTED', m.message)
        mountedHere = m.ok && !m.alreadyMounted
        diskId = uuid() as DiskID
        const meta = { diskId, diskName: 'IDEA Disk' as DiskName, isHardwareId: false, created: ops.now(), version: '1.0' }
        await ops.writeMeta(target.name, YAML.stringify(meta))
        updateOperation(storeHandle, opId, { currentStep: 2, stepLabel: 'registering' })
        // The monitor cached "no META.yaml" for this partition when it was plugged in: forget it,
        // or addDevice reuses that answer and never docks the disk (happy-zebra 2026-10-17).
        ops.forgetMetaLook(target.name)
        await ops.addDevice(target.name)
        registered = !!storeHandle.doc()?.diskDB?.[diskId]
        if (!registered) fail('WRITE_FAILED', `${target.name} got META.yaml but did not dock as ${diskId}`)
        if (role === 'files') await ops.createFilesDisk(storeHandle, diskId)
        if (role === 'backup') await ops.createBackupDisk(storeHandle, diskId)
        updateOperation(storeHandle, opId, { status: 'Done', completedAt: ops.now() as Timestamp })
        attachTraceResult({ candidateId, diskId, role, partition: target.name })
        print(`Initialised ${target.name} (${candidateId}) as IDEA disk ${diskId} (${role})`)
        return { operationId: opId, diskId, partition: target.name }
    } catch (e) {
        // Registration failed after this command mounted the partition read-write: release the
        // mount again (umount, then rmdir of the mount point), unless a disk record now uses the
        // partition. META.yaml stays on the disk, so a re-plug or Engine restart docks it.
        if (mountedHere && !registered) await releaseRwMount(storeHandle, target.name)
        if (e instanceof CardError) throw e
        const msg = e instanceof Error ? e.message : String(e)
        return fail('WRITE_FAILED', msg)
    } finally {
        running.delete(opId)
        refreshClientCards(storeHandle).catch(() => {})
    }
}
