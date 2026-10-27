/**
 * idea#307: look at a partition again after its filesystem changes while it stays plugged in.
 *
 * The usb monitor's read-only look runs on the `add` event. When a disk is partitioned and
 * formatted while plugged in, that look can run before mkfs finishes and fail ('wrong fs type',
 * 'bad geometry'); no new `add` event follows, so the partition was never looked at again.
 *
 * The monitor records the partition's filesystem signature (fs type + UUID, from lsblk, read just
 * before the look) when the look fails. The existing lsblk poll (UnformattedDisks, every 5 s)
 * then calls retryChangedFailedLooks: a partition whose signature has changed since its failed
 * look gets the monitor's normal add path again, so the same read-only rules apply (ro,noload;
 * a device mounted elsewhere is refused). An unchanged partition is never retried, so a disk
 * that keeps failing is not mounted in a loop.
 *
 * Kept in its own module (no Store or monitor imports) so it can be unit-tested on its own.
 */
import { $ } from 'zx'

export interface PartitionSignature { fsType: string | null; uuid: string | null }

const failed = new Map<string, PartitionSignature | null>()

const sameSignature = (a: PartitionSignature | null, b: PartitionSignature | null): boolean =>
    (a?.fsType ?? null) === (b?.fsType ?? null) && (a?.uuid ?? null) === (b?.uuid ?? null)

/** Remember that the look of `device` failed while it had signature `sig` (null = unknown). */
export const recordFailedLook = (device: string, sig: PartitionSignature | null): void => { failed.set(device, sig) }

/** Forget a failed look (the partition was unplugged, or a later look succeeded). */
export const clearFailedLook = (device: string): void => { failed.delete(device) }

/** The partitions whose last look failed (for tests and logs). */
export const failedLookDevices = (): string[] => [...failed.keys()].sort()

export const clearFailedLooksForTests = (): void => { failed.clear() }

type LsblkNode = { name: string; fstype?: string | null; uuid?: string | null; children?: LsblkNode[] }

/** Read-only: fs type and UUID of every block device, from lsblk (no mount, no sudo). */
export const readPartitionSignatures = async (): Promise<Map<string, PartitionSignature>> => {
    const out = new Map<string, PartitionSignature>()
    const r = await $`lsblk -J -o NAME,FSTYPE,UUID`.nothrow().quiet()
    if (r.exitCode !== 0 || !r.stdout.trim()) return out
    const walk = (nodes: LsblkNode[] | undefined): void => {
        for (const n of nodes ?? []) {
            out.set(n.name, { fsType: (n.fstype ?? '').trim() || null, uuid: (n.uuid ?? '').trim() || null })
            walk(n.children)
        }
    }
    try { walk((JSON.parse(r.stdout) as { blockdevices?: LsblkNode[] }).blockdevices) } catch { /* unreadable lsblk output: no retry this round */ }
    return out
}

/**
 * For every partition with a failed look: when lsblk now shows a different fs type or UUID,
 * forget the failure and call `retry` (the monitor's add path). A partition lsblk no longer
 * lists is dropped (its unlink event handles the rest). Returns the retried devices.
 */
export const retryChangedFailedLooks = async (
    retry: (device: string) => Promise<unknown>,
    readSignatures: () => Promise<Map<string, PartitionSignature>> = readPartitionSignatures,
): Promise<string[]> => {
    if (failed.size === 0) return []
    const now = await readSignatures()
    const retried: string[] = []
    for (const [device, before] of [...failed.entries()]) {
        const current = now.get(device)
        if (!current) { failed.delete(device); continue }
        if (sameSignature(before, current)) continue
        failed.delete(device)
        retried.push(device)
        await retry(device)
    }
    return retried
}
