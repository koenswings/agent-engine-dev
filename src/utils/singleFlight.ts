/**
 * singleFlight — one run per key at a time. A call for a key whose run is still going gets that
 * run's promise instead of starting a second one; once it settles, the next call starts afresh.
 * Used for usbDeviceMonitor's addDevice so a udev add and eraseDisk's re-add of the same partition
 * never mount and register the disk twice (idea01 2026-10-16, trace 93de80a4).
 */
export const singleFlight = <A extends unknown[]>(
    keyOf: (...args: A) => string,
    run: (...args: A) => Promise<void>,
    onJoin?: (key: string) => void,
): ((...args: A) => Promise<void>) => {
    const inFlight = new Map<string, Promise<void>>()
    return (...args: A) => {
        const key = keyOf(...args)
        const running = inFlight.get(key)
        if (running) {
            onJoin?.(key)
            return running
        }
        const p = run(...args).finally(() => { if (inFlight.get(key) === p) inFlight.delete(key) })
        inFlight.set(key, p)
        return p
    }
}
