/**
 * diskSim.ts — Disk simulation harness for automated tests.
 *
 * Simulates physical disk dock/undock events by:
 *  - Copying a fixture directory to /disks/<device>/ (simulating a mounted disk)
 *  - Creating/removing a sentinel file at /dev/engine/<device> (triggering chokidar)
 *
 * Requires config.settings.testMode = true so usbDeviceMonitor skips sudo mount/umount.
 * Set IDEA_TEST_MODE=true in the test script environment to activate this without
 * modifying config.yaml.
 */

import { fs, path } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'

// Fixed device name used for all single-disk tests.
// Must match validDevice() pattern: sd[a-z][1-2] or sd[a-z].
// sdz1 is chosen as very unlikely to conflict with real block devices on a test machine.
// testMode skips actual mount/umount, so there is no risk of touching real hardware.
export const TEST_DEVICE = 'sdz1'

// Paths the harness manages
export const DISKS_ROOT   = '/disks'
export const DEV_ROOT     = '/dev/engine'
export const DISK_PATH    = `${DISKS_ROOT}/${TEST_DEVICE}`
export const SENTINEL     = `${DEV_ROOT}/${TEST_DEVICE}`

/**
 * Create an in-memory Automerge Repo and an initialised Store document.
 * The local engine entry is added so usbDeviceMonitor can dock disks to it.
 */
export const createTestStore = async (): Promise<{ repo: Repo; storeHandle: DocHandle<Store> }> => {
    const repo = new Repo({ network: [], storage: undefined })

    const storeHandle = repo.create<Store>({
        engineDB: {},
        diskDB: {},
        appDB: {},
        instanceDB: {},
    })

    await storeHandle.whenReady()

    // Register the local engine — required by usbDeviceMonitor when docking a disk
    await createOrUpdateEngine(storeHandle, localEngineId)

    return { repo, storeHandle }
}

/**
 * Copy a fixture directory into /disks/<device>/ so the engine can read it.
 * The fixture is treated as a pre-mounted disk — testMode skips the actual mount.
 */
export const dockFixture = async (fixturePath: string, device = TEST_DEVICE): Promise<void> => {
    const diskPath = `${DISKS_ROOT}/${device}`
    await fs.ensureDir(DISKS_ROOT)
    await fs.ensureDir(DEV_ROOT)
    // Copy fixture (fresh each time so META.yaml mutations don't accumulate)
    await fs.copy(fixturePath, diskPath, { overwrite: true })
    // Touch sentinel — chokidar sees 'add' event and triggers addDevice()
    await fs.writeFile(SENTINEL, '')
}

/**
 * Remove the sentinel file, triggering chokidar 'unlink' → undockDisk().
 * The disk content at /disks/<device>/ remains (testMode skips umount + rm).
 */
export const triggerUndock = async (device = TEST_DEVICE): Promise<void> => {
    await fs.remove(SENTINEL)
}

/**
 * Remove the fixture copy from /disks/<device>/. Call in after() to keep the
 * system clean. Does not interact with the engine — purely filesystem cleanup.
 */
export const cleanupDisk = async (device = TEST_DEVICE): Promise<void> => {
    await fs.remove(`${DISKS_ROOT}/${device}`)
}

/**
 * Poll the store until predicate returns true, or timeout is reached.
 * Returns true if predicate passed, false if timed out.
 */
export const waitFor = async (
    storeHandle: DocHandle<Store>,
    predicate: (store: Store) => boolean,
    timeoutMs = 10_000,
    intervalMs = 100,
): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const store = storeHandle.doc()
        if (store && predicate(store)) return true
        await new Promise(r => setTimeout(r, intervalMs))
    }
    return false
}
