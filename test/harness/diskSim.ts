/**
 * diskSim.ts — Disk simulation harness for automated tests.
 *
 * Simulates physical disk dock/undock events by:
 *  - Copying a fixture directory to <IDEA_DISKS_ROOT>/<device>/ (simulating a mounted disk)
 *  - Creating/removing a sentinel file at <IDEA_WATCH_DIR>/<device> (triggering chokidar)
 *
 * Tests share nothing with a live Engine (idea#105):
 *  - IDEA_WATCH_DIR and IDEA_DISKS_ROOT point at a private, per-run temp folder
 *    created by script/test-run.sh — never /dev/engine or /disks.
 *  - IDEA_SYSTEM_DISK_SKIP=true so the test watcher never registers the system
 *    disk (and never restarts the live /instances/*).
 *  - Pretend disks use test-only device names (idea-test-N) that a live Engine ignores.
 *  - Containers created from fixtures carry the TEST_CONTAINER_LABEL label so cleanup
 *    only ever removes containers created by tests.
 *
 * This module fails fast at import time if the isolation environment is missing.
 * Always run tests via the pnpm test:* scripts (script/test-run.sh).
 *
 * Requires config.settings.testMode = true so usbDeviceMonitor skips sudo mount/umount
 * (IDEA_TEST_MODE=true, set by script/test-run.sh).
 */

import { $, fs, path, YAML } from 'zx'
import { Status } from '../../src/data/Instance.js'

// Resolve fixtures from the repo root (process.cwd()), not from __dirname.
// Compiled files land in dist-test/test/harness/ — __dirname-relative paths to
// test/fixtures/ would be wrong. process.cwd() is always the repo root when
// tests are run via pnpm scripts.
export const FIXTURES_DIR = path.resolve(process.cwd(), 'test/fixtures')
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'

// ── Isolation guard (idea#105) ───────────────────────────────────────────────
// Paths a live Engine owns. The harness must never write to or watch these.
const LIVE_WATCH_DIR  = '/dev/engine'
const LIVE_DISKS_ROOT = '/disks'

const isLivePath = (p: string, livePath: string): boolean => {
    const resolved = path.resolve(p)
    return resolved === livePath || resolved.startsWith(livePath + '/')
}

/**
 * Throw unless the test isolation environment is set up. Called at import time
 * so any suite using the harness fails before touching the filesystem.
 * Exported for unit testing.
 */
export const assertTestIsolation = (env: NodeJS.ProcessEnv = process.env): { watchDir: string; disksRoot: string } => {
    const hint = 'Run tests via the pnpm test:* scripts (script/test-run.sh), which set up a private test environment.'
    if (env.IDEA_SYSTEM_DISK_SKIP !== 'true') {
        throw new Error(`diskSim: IDEA_SYSTEM_DISK_SKIP must be 'true' so tests never touch the live system disk. ${hint}`)
    }
    const watchDir = env.IDEA_WATCH_DIR
    if (!watchDir || isLivePath(watchDir, LIVE_WATCH_DIR)) {
        throw new Error(`diskSim: IDEA_WATCH_DIR must be set to a private folder (not ${LIVE_WATCH_DIR}); got '${watchDir ?? ''}'. ${hint}`)
    }
    const disksRoot = env.IDEA_DISKS_ROOT
    if (!disksRoot || isLivePath(disksRoot, LIVE_DISKS_ROOT)) {
        throw new Error(`diskSim: IDEA_DISKS_ROOT must be set to a private folder (not ${LIVE_DISKS_ROOT}); got '${disksRoot ?? ''}'. ${hint}`)
    }
    return { watchDir: path.resolve(watchDir), disksRoot: path.resolve(disksRoot) }
}

const isolation = assertTestIsolation()

// Host to use for HTTP health checks against started containers.
// On the Pi (native or SSH): 'localhost' (default).
// In a sandbox container where Docker runs via the host daemon socket: set
// TEST_HOST to the Docker bridge gateway (e.g. 172.20.0.1) so published ports
// on the host are reachable from inside the container.
export const TEST_HOST = process.env.TEST_HOST ?? 'localhost'

// Fixed device name used for all single-disk tests.
// Test-only name that real hardware never produces: a live Engine (testMode off)
// ignores it, the test Engine (testMode on) accepts it. See isTestDeviceName()
// in src/monitors/usbDeviceMonitor.ts.
export const TEST_DEVICE = 'idea-test-1'

/** Build a test-only device name (idea-test-<n>). */
export const testDevice = (n: number): string => `idea-test-${n}`

/** A random test-only device name, for suites that need a unique disk per test. */
export const uniqueTestDevice = (): string => testDevice(100000 + Math.floor(Math.random() * 900000))

// Docker label added to every service of every fixture compose file. Test
// cleanup only removes containers carrying this label.
export const TEST_CONTAINER_LABEL_KEY   = 'org.idea.test'
export const TEST_CONTAINER_LABEL_VALUE = 'true'
export const TEST_CONTAINER_LABEL       = `${TEST_CONTAINER_LABEL_KEY}=${TEST_CONTAINER_LABEL_VALUE}`

// Paths the harness manages — private, per-run folders (never /disks or /dev/engine)
export const DISKS_ROOT   = isolation.disksRoot
export const DEV_ROOT     = isolation.watchDir
export const DISK_PATH    = `${DISKS_ROOT}/${TEST_DEVICE}`
export const SENTINEL     = `${DEV_ROOT}/${TEST_DEVICE}`

/** Path of a pretend disk's mount folder under the private mount root. */
export const diskPath = (device = TEST_DEVICE): string => `${DISKS_ROOT}/${device}`

/** Path of a pretend disk's sentinel file under the private watch folder. */
export const sentinelPath = (device = TEST_DEVICE): string => `${DEV_ROOT}/${device}`

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
 * Ensure every service in every instance/app compose.yaml under `root` carries
 * the test container label, so containers created from it are recognisable as
 * test containers. Idempotent.
 */
export const labelFixtureComposeFiles = async (root: string): Promise<void> => {
    for (const sub of ['instances', 'apps']) {
        const dir = path.join(root, sub)
        if (!(await fs.pathExists(dir))) continue
        for (const entry of await fs.readdir(dir)) {
            const composePath = path.join(dir, entry, 'compose.yaml')
            if (!(await fs.pathExists(composePath))) continue
            const compose = YAML.parse(await fs.readFile(composePath, 'utf-8'))
            let changed = false
            for (const service of Object.values<any>(compose?.services ?? {})) {
                if (Array.isArray(service.labels)) {
                    if (!service.labels.includes(TEST_CONTAINER_LABEL)) {
                        service.labels.push(TEST_CONTAINER_LABEL)
                        changed = true
                    }
                } else {
                    service.labels = service.labels ?? {}
                    if (service.labels[TEST_CONTAINER_LABEL_KEY] !== TEST_CONTAINER_LABEL_VALUE) {
                        service.labels[TEST_CONTAINER_LABEL_KEY] = TEST_CONTAINER_LABEL_VALUE
                        changed = true
                    }
                }
            }
            if (changed) await fs.writeFile(composePath, YAML.stringify(compose))
        }
    }
}

/**
 * Copy a fixture directory into <DISKS_ROOT>/<device>/ so the engine can read it.
 * The fixture is treated as a pre-mounted disk — testMode skips the actual mount.
 */
export const dockFixture = async (fixturePath: string, device = TEST_DEVICE): Promise<void> => {
    const target = diskPath(device)
    await fs.ensureDir(DISKS_ROOT)
    await fs.ensureDir(DEV_ROOT)
    // Copy fixture (fresh each time so META.yaml mutations don't accumulate)
    await fs.copy(fixturePath, target, { overwrite: true })
    await labelFixtureComposeFiles(target)
    // Touch sentinel — chokidar sees 'add' event and triggers addDevice()
    await fs.writeFile(sentinelPath(device), '')
}

/**
 * Remove the sentinel file, triggering chokidar 'unlink' → undockDisk().
 * The disk content at <DISKS_ROOT>/<device>/ remains (testMode skips umount + rm).
 */
export const triggerUndock = async (device = TEST_DEVICE): Promise<void> => {
    await fs.remove(sentinelPath(device))
}

/**
 * Remove the fixture copy from <DISKS_ROOT>/<device>/. Call in after() to keep the
 * system clean. Does not interact with the engine — purely filesystem cleanup.
 */
export const cleanupDisk = async (device = TEST_DEVICE): Promise<void> => {
    await fs.remove(diskPath(device))
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
 * Force-stop and remove the test containers of the given instance id.
 * Only containers that carry the test label (TEST_CONTAINER_LABEL) AND whose
 * name contains the instance id are removed — containers of a live Engine are
 * never touched, even if their name happens to match.
 * Uses `docker rm -f` so it works whether containers are running or stopped.
 * Safe to call even if no containers exist. Used in after() hooks to keep the system clean.
 */
export const cleanupContainers = async (instanceId: string): Promise<void> => {
    try {
        const result = await $`docker ps -aq --filter label=${TEST_CONTAINER_LABEL} --filter name=${instanceId}`
        const ids = result.stdout.trim().split('\n').filter(id => id.trim())
        for (const id of ids) {
            await $`docker rm -f ${id}`.catch(() => {})
        }
    } catch {
        // No containers found — nothing to clean up
    }
}

/**
 * Remove the Compose network(s) of a test instance (`<instanceId>_default`),
 * which `docker compose create/up` leave behind after the containers are gone.
 * Only networks whose compose project label equals the instance id are removed.
 * Leaked networks eventually exhaust Docker's address pools ("could not find
 * an available, non-overlapping IPv4 address pool"). Safe to call when none exist.
 */
export const cleanupNetworks = async (instanceId: string): Promise<void> => {
    const r = await $`docker network ls -q --filter label=com.docker.compose.project=${instanceId}`.quiet().nothrow()
    for (const id of r.stdout.trim().split('\n').filter(x => x.trim())) {
        await $`docker network rm ${id}`.quiet().nothrow()
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
