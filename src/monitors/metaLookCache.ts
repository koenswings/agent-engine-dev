/**
 * The read-only META look cache (idea#201 §10), one look per device.
 *
 * The usb monitor shares one read-only look per device between the device's own
 * addDevice and the stick check of a FAT partition on the same drive, so they
 * never race (two ro mounts of one device) and agree on the answer.
 *
 * A cached answer is only true until something writes META.yaml on the device.
 * Every command that writes META.yaml and then calls addDevice (initialiseDisk,
 * eraseDisk) must forget the device's look first (forgetMetaLook), or addDevice
 * reuses the old "no META.yaml" answer and leaves the disk undocked
 * (happy-zebra 2026-10-17, initialiseDisk AA000000000000004526).
 *
 * Kept in its own module (no Store or monitor imports) so commands can forget a
 * look without importing the usb monitor.
 */
import { IdeaLookResult } from './mounts.js'

export interface MetaLookCache {
    /** The cached look of the device, or a new one from `look` (a failed look is not kept) */
    get: (device: string, look: () => Promise<IdeaLookResult>) => Promise<IdeaLookResult>
    /** Forget the device's look, so the next get looks again */
    forget: (device: string) => void
    /** Forget every look */
    clear: () => void
}

export const createMetaLookCache = (): MetaLookCache => {
    const looks = new Map<string, Promise<IdeaLookResult>>()
    return {
        get: (device, look) => {
            let p = looks.get(device)
            if (!p) {
                const fresh = look()
                p = fresh
                looks.set(device, fresh)
                // A failed look may be retried on the next add event
                fresh.then(r => { if (!r.ok && looks.get(device) === fresh) looks.delete(device) }, () => {
                    if (looks.get(device) === fresh) looks.delete(device)
                })
            }
            return p
        },
        forget: (device) => { looks.delete(device) },
        clear: () => { looks.clear() },
    }
}

/** The usb monitor's cache (one per Engine process). */
export const metaLookCache: MetaLookCache = createMetaLookCache()

/**
 * Forget the cached read-only META look of a device. Call it after writing
 * META.yaml on the device and before calling addDevice for it.
 */
export const forgetMetaLook = (device: string): void => {
    metaLookCache.forget(device.replace(/^\/dev\/(engine\/)?/, ''))
}
