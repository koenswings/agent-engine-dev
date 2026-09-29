/**
 * UnformattedDisks.ts — whole non-system disks without ext4 (idea#134)
 *
 * Published on Engine.unformattedDisks so the Console can offer Erase / the
 * Files erase-first shortcut on non-IDEA sticks. Never mounted. IDs come from
 * the serial (or a generated id that stays stable while the disk stays plugged).
 */

import { $ } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { EngineID } from './CommonTypes.js'
import { isSystemDevice, driveNameOf } from './SystemDisk.js'
import { readHardwareId } from './Meta.js'
import { log, uuid } from '../utils/utils.js'
import { localEngineId } from './Engine.js'

export interface UnformattedDisk {
    candidateId: string
    device: string          // whole-disk name, e.g. sdb
    sizeBytes: number
    model: string | null
    fsType: string | null   // dominant non-ext4 type, or null if none
    label: string           // typed confirmation text, e.g. "SanDisk 32 GB"
    serial: string | null   // for eraseDisk summary matching
}

export interface LsblkDevice {
    name: string
    type?: string
    fstype?: string | null
    size?: string | number
    model?: string | null
    serial?: string | null
    children?: LsblkDevice[]
}

export interface UnformattedOps {
    lsblkJson: () => Promise<LsblkDevice[]>
}

const defaultOps: UnformattedOps = {
    lsblkJson: async () => {
        const out = await $`lsblk -J -b -o NAME,TYPE,FSTYPE,SIZE,MODEL,SERIAL`.nothrow()
        if (out.exitCode !== 0 || !out.stdout.trim()) return []
        const parsed = JSON.parse(out.stdout) as { blockdevices?: LsblkDevice[] }
        return parsed.blockdevices ?? []
    },
}

let ops = defaultOps
export const setUnformattedOpsForTests = (o: Partial<UnformattedOps> | null): void => {
    ops = o ? { ...defaultOps, ...o } : defaultOps
}

/** Stable-while-plugged generated ids when there is no serial. */
const generatedIds = new Map<string, string>()  // device → id

export const clearGeneratedUnformattedIdsForTests = (): void => { generatedIds.clear() }

const hasExt4 = (node: LsblkDevice): boolean => {
    if ((node.fstype ?? '').toLowerCase() === 'ext4') return true
    return (node.children ?? []).some(hasExt4)
}

const firstFsType = (node: LsblkDevice): string | null => {
    if (node.fstype) return node.fstype
    for (const c of node.children ?? []) {
        const t = firstFsType(c)
        if (t) return t
    }
    return null
}

/** Round size to a short display: "32 GB", "240 GB". */
export const formatSizeLabel = (sizeBytes: number): string => {
    if (sizeBytes >= 1_000_000_000) return `${Math.round(sizeBytes / 1_000_000_000)} GB`
    if (sizeBytes >= 1_000_000) return `${Math.round(sizeBytes / 1_000_000)} MB`
    return `${sizeBytes} B`
}

export const labelForUnformatted = (model: string | null, sizeBytes: number): string => {
    const size = formatSizeLabel(sizeBytes)
    return model && model.trim() ? `${model.trim()} ${size}` : `USB disk ${size}`
}

/** Make labels unique among a list by appending " (2)", " (3)", … (display only). */
export const uniquifyLabels = (items: { label: string }[]): void => {
    const counts = new Map<string, number>()
    for (const it of items) {
        const base = it.label
        const n = (counts.get(base) ?? 0) + 1
        counts.set(base, n)
        if (n > 1) it.label = `${base} (${n})`
    }
    // First occurrence of a clashing name also needs (1)? No — only 2nd+ get a suffix.
    // Re-walk: if any base appears >1, the first stays plain and others get (2),(3).
    // The loop above already left the first plain and numbered the rest. Good.
}

/**
 * Scan lsblk and return whole non-system disks that have no ext4 anywhere
 * (including partition 3+). System and swap-only handling: a disk with swap but
 * no ext4 is still listed (erase script refuses swap at erase time); we exclude
 * nothing here for swap alone — the script is authoritative.
 */
export const scanUnformattedDisks = async (): Promise<UnformattedDisk[]> => {
    const devices = await ops.lsblkJson()
    const out: UnformattedDisk[] = []
    // Drop generated ids for devices that disappeared
    const seen = new Set<string>()
    for (const d of devices) {
        if ((d.type ?? 'disk') !== 'disk') continue
        const name = d.name
        if (!/^sd[a-z]$/.test(name)) continue  // whole sdX only; partitions 3+ out of scope for listing parents with ext4 on p3 still excluded via hasExt4
        seen.add(name)
        if (await isSystemDevice(name)) continue
        if (hasExt4(d)) continue
        const sizeBytes = typeof d.size === 'number' ? d.size : parseInt(String(d.size ?? '0'), 10) || 0
        const model = d.model?.trim() || null
        const serialRaw = d.serial?.trim() || null
        // Prefer hardware id for known models (Meta.readHardwareId), else lsblk serial, else generated
        let candidateId: string
        let serial: string | null = serialRaw
        try {
            const hw = await readHardwareId(name as any)
            if (hw) { candidateId = hw; serial = hw }
            else if (serialRaw) candidateId = serialRaw
            else {
                if (!generatedIds.has(name)) generatedIds.set(name, uuid())
                candidateId = generatedIds.get(name)!
            }
        } catch {
            if (serialRaw) candidateId = serialRaw
            else {
                if (!generatedIds.has(name)) generatedIds.set(name, uuid())
                candidateId = generatedIds.get(name)!
            }
        }
        out.push({
            candidateId,
            device: name,
            sizeBytes,
            model,
            fsType: firstFsType(d),
            label: labelForUnformatted(model, sizeBytes),
            serial,
        })
    }
    for (const k of [...generatedIds.keys()]) if (!seen.has(k)) generatedIds.delete(k)
    uniquifyLabels(out)
    return out
}

/** Write Engine.unformattedDisks for this Engine (whole-list replace). */
export const refreshUnformattedDisks = async (
    storeHandle: DocHandle<Store>,
    engineId: EngineID = localEngineId as EngineID,
): Promise<UnformattedDisk[]> => {
    const list = await scanUnformattedDisks()
    storeHandle.change(doc => {
        const eng = doc.engineDB[engineId]
        if (!eng) return
        eng.unformattedDisks = list.map(({ candidateId, device, sizeBytes, model, fsType, label, serial }) => ({
            candidateId, device, sizeBytes, model, fsType, label, serial,
        }))
    })
    log(`Unformatted disks: ${list.map(d => `${d.device}(${d.label})`).join(', ') || '(none)'}`)
    return list
}
