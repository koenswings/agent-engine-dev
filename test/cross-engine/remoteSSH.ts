/**
 * remoteSSH.ts — SSH helpers for cross-engine test fixture management and fleet discovery.
 *
 * Simulates disk dock/undock events on a remote fleet engine by writing and
 * removing fixture files over SSH. This is the cross-engine equivalent of
 * diskSim.dockFixture() / triggerUndock().
 *
 * Requires key-based SSH access from the management Pi to the fleet engines.
 * The SSH key at ~/.ssh/id_ed25519 is used (same key installed during provisioning).
 */

import { $ } from 'zx'
import path from 'path'
import mDnsSd from 'node-dns-sd'

// Paths on the remote engine (must match usbDeviceMonitor expectations)
const REMOTE_DISKS_ROOT = '/disks'
const REMOTE_DEV_ROOT   = '/dev/engine'

// Local fixture path (resolved from repo root, as in diskSim.ts)
const FIXTURES_DIR = path.resolve(process.cwd(), 'test/fixtures')

// Fixed test device — same as single-engine tests
export const TEST_DEVICE = 'sdz1'

// SSH options shared across all commands
const SSH_OPTS = [
    '-i', `${process.env.HOME}/.ssh/id_ed25519`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
]

// ── Fleet discovery ──────────────────────────────────────────────────────────

/**
 * Discover live Engine hosts via mDNS — exactly as the Engine itself does.
 *
 * Uses node-dns-sd to query _engine._tcp.local and returns the hostname
 * (or IP address as fallback) of each responding engine. This is the same
 * mechanism the Engine's mDNS monitor uses; the test runner participates in
 * discovery the same way any peer would.
 *
 * Override with FLEET_HOSTS env var (comma-separated IPs or hostnames) to bypass
 * mDNS — useful when mDNS is unreliable on a subnet:
 *   FLEET_HOSTS=192.168.0.138,192.168.0.180 pnpm test:cross-engine
 *
 * @param waitSecs  mDNS query duration in seconds (default: 10 — one full mDNS cycle)
 */
export const discoverEngineHosts = async (waitSecs = 10): Promise<string[]> => {
    if (process.env.FLEET_HOSTS) {
        const manual = process.env.FLEET_HOSTS.split(',').map(h => h.trim()).filter(Boolean)
        console.log(`[remoteSSH] FLEET_HOSTS override: ${manual.join(', ')}`)
        return manual
    }

    console.log(`[remoteSSH] Discovering engines via mDNS (_engine._tcp.local, ${waitSecs}s)...`)
    let deviceList: any[] = []
    try {
        deviceList = await mDnsSd.discover({ name: '_engine._tcp.local', wait: waitSecs })
    } catch (err) {
        console.warn(`[remoteSSH] mDNS discovery error:`, err)
    }

    const hosts = deviceList
        .map(device => {
            const txt = device.packet?.additionals?.find((a: any) => a.type === 'TXT')
            const hostname: string | undefined = txt?.rdata?.name
            const address: string | undefined = device.address
            // Prefer <hostname>.local if available (matches SSH config), fall back to IP
            return hostname ? `${hostname}.local` : address
        })
        .filter((h): h is string => !!h)

    console.log(`[remoteSSH] Discovered ${hosts.length} engine(s) via mDNS: ${hosts.join(', ')}`)
    return hosts
}

/**
 * Copy a fixture directory to /disks/<device>/ on the remote engine and create
 * the sentinel file at /dev/engine/<device>. This triggers chokidar's 'add'
 * event on the remote engine, causing it to dock the disk.
 *
 * @param host     Hostname or IP of the target engine
 * @param fixture  Name of the fixture directory under test/fixtures/ (default: disk-sample-v1)
 * @param device   Device name (default: sdz1)
 */
export const remoteDockFixture = async (
    host: string,
    fixture = 'disk-sample-v1',
    device = TEST_DEVICE,
): Promise<void> => {
    const localFixturePath = path.join(FIXTURES_DIR, fixture)
    const remoteDiskPath   = `${REMOTE_DISKS_ROOT}/${device}`
    const remoteSentinel   = `${REMOTE_DEV_ROOT}/${device}`

    console.log(`[remoteSSH] Docking ${fixture} on ${host} as /dev/engine/${device}`)

    // Ensure remote directories exist with correct ownership for pi
    await $`ssh ${SSH_OPTS} pi@${host} sudo mkdir -p ${REMOTE_DISKS_ROOT} ${REMOTE_DEV_ROOT}`
    await $`ssh ${SSH_OPTS} pi@${host} sudo mkdir -p ${remoteDiskPath}`
    await $`ssh ${SSH_OPTS} pi@${host} sudo chown pi:pi ${remoteDiskPath}`

    // Copy fixture to remote disk path (fresh copy — no stale META.yaml mutations)
    await $`rsync -a --delete -e ${`ssh ${SSH_OPTS.join(' ')}`} ${localFixturePath}/ pi@${host}:${remoteDiskPath}/`

    // Create sentinel to trigger chokidar dock event
    await $`ssh ${SSH_OPTS} pi@${host} sudo touch ${remoteSentinel}`

    console.log(`[remoteSSH] Fixture docked on ${host}`)
}

/**
 * Remove the sentinel file on the remote engine, triggering chokidar's 'unlink'
 * event (undock). The disk content at /disks/<device>/ is left in place
 * (testMode on the engine skips umount + rm, same as single-engine tests).
 *
 * @param host    Hostname or IP of the target engine
 * @param device  Device name (default: sdz1)
 */
export const remoteUndock = async (
    host: string,
    device = TEST_DEVICE,
): Promise<void> => {
    const remoteSentinel = `${REMOTE_DEV_ROOT}/${device}`
    console.log(`[remoteSSH] Undocking /dev/engine/${device} on ${host}`)
    await $`ssh ${SSH_OPTS} pi@${host} sudo rm -f ${remoteSentinel}`
    console.log(`[remoteSSH] Undock triggered on ${host}`)
}

/**
 * Remove the fixture directory from /disks/<device>/ on the remote engine.
 * Call in afterAll() to leave the remote system clean.
 *
 * @param host    Hostname or IP of the target engine
 * @param device  Device name (default: sdz1)
 */
export const remoteCleanupDisk = async (
    host: string,
    device = TEST_DEVICE,
): Promise<void> => {
    const remoteDiskPath = `${REMOTE_DISKS_ROOT}/${device}`
    console.log(`[remoteSSH] Cleaning up ${remoteDiskPath} on ${host}`)
    await $`ssh ${SSH_OPTS} pi@${host} sudo rm -rf ${remoteDiskPath}`.catch(() => {})
}

/**
 * Check whether the remote engine's Engine process is running (pm2 status).
 * Returns true if pm2 reports the engine as 'online'.
 *
 * @param host  Hostname or IP of the target engine
 */
export const isEngineRunning = async (host: string): Promise<boolean> => {
    try {
        const result = await $`ssh ${SSH_OPTS} pi@${host} sudo pm2 show engine`
        return result.stdout.includes('online')
    } catch {
        return false
    }
}

/**
 * Pull a Docker image on the remote engine if it is not already cached.
 * Used in beforeAll() to avoid pull timeouts during test runs.
 *
 * @param host   Hostname or IP of the target engine
 * @param image  Docker image reference (e.g. 'traefik/whoami')
 */
export const ensureImagePulled = async (host: string, image: string): Promise<void> => {
    console.log(`[remoteSSH] Ensuring ${image} is cached on ${host}...`)
    await $`ssh ${SSH_OPTS} pi@${host} sudo docker pull ${image}`
    console.log(`[remoteSSH] Image ${image} ready on ${host}`)
}
