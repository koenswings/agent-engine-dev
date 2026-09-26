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

import { $, fs, path } from 'zx'
import { Status } from '../../src/data/Instance.js'

// Resolve fixtures from the repo root (process.cwd()), not from __dirname.
// Compiled files land in dist/test/harness/ — __dirname-relative paths to
// test/fixtures/ would be wrong. process.cwd() is always the repo root when
// tests are run via pnpm scripts.
export const FIXTURES_DIR = path.resolve(process.cwd(), 'test/fixtures')
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'

// Host to use for HTTP health checks against started containers.
// On the Pi (native or SSH): 'localhost' (default).
// In a sandbox container where Docker runs via the host daemon socket: set
// TEST_HOST to the Docker bridge gateway (e.g. 172.20.0.1) so published ports
// on the host are reachable from inside the container.
export const TEST_HOST = process.env.TEST_HOST ?? 'localhost'

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
        userDB: {},
        operationDB: {},
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

/**
 * Poll the store until an instance with the given id reaches the expected status,
 * or until timeout is reached. Returns true if the status was reached, false otherwise.
 */
export const waitForStatus = async (
    storeHandle: DocHandle<Store>,
    instanceId: string,
    expectedStatus: Status,
    timeoutMs = 30_000,
    intervalMs = 200,
): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const store = storeHandle.doc()
        if (store) {
            const instance = store.instanceDB[instanceId as any]
            if (instance && instance.status === expectedStatus) return true
        }
        await new Promise(r => setTimeout(r, intervalMs))
    }
    return false
}

/**
 * Force-stop and remove all Docker containers whose names contain the given instance id.
 * Uses `docker rm -f` so it works whether containers are running or stopped.
 * Safe to call even if no containers exist. Used in after() hooks to keep the system clean.
 */
export const cleanupContainers = async (instanceId: string): Promise<void> => {
    try {
        const result = await $`docker ps -aq --filter name=${instanceId}`
        const ids = result.stdout.trim().split('\n').filter(id => id.trim())
        for (const id of ids) {
            await $`docker rm -f ${id}`.catch(() => {})
        }
    } catch {
        // No containers found — nothing to clean up
    }
}

/**
 * Poll an HTTP URL until it returns a 2xx response, or the timeout is reached.
 * Returns true if a successful response was received, false if timed out.
 * Used to verify that a container is actually serving traffic after startup.
 */
export const waitForHttp = async (
    url: string,
    timeoutMs = 30_000,
    intervalMs = 500,
): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url)
            if (res.ok) return true
        } catch {
            // connection refused / network error — container not ready yet
        }
        await new Promise(r => setTimeout(r, intervalMs))
    }
    return false
}

/**
 * Poll an HTTP URL until the connection is refused (container is down), or the
 * timeout is reached. Returns true if the port went silent, false if it was
 * still responding when the timeout expired.
 *
 * Use this for post-undock assertions — waitForHttp(url, 3s) is unreliable
 * because the engine sets status=Undocked immediately after container.stop(),
 * but the kernel may still deliver packets for a brief moment while the
 * container process exits. waitForHttpDown confirms the port is actually closed.
 */
export const waitForHttpDown = async (
    url: string,
    timeoutMs = 10_000,
    intervalMs = 300,
): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), intervalMs)
            await fetch(url, { signal: controller.signal })
            clearTimeout(timer)
            // Got a response — container still up; keep polling
        } catch {
            // Connection refused or aborted — container is down
            return true
        }
        await new Promise(r => setTimeout(r, intervalMs))
    }
    return false // still responding at timeout
}
