/**
 * remoteSSH.ts — Engine fixture helpers for cross-engine tests.
 *
 * Simulates disk dock/undock events on fleet engines by writing/removing
 * fixture files. Transparently handles both remote engines (via SSH) and the
 * local engine on this machine (via direct shell), so wizardly-hugle is a
 * full fleet member with no special treatment.
 */

import { $, ProcessOutput } from 'zx'
import path from 'path'
import os from 'os'

// Paths on the engine (must match usbDeviceMonitor expectations)
const REMOTE_DISKS_ROOT = '/disks'
const REMOTE_DEV_ROOT   = '/dev/engine'

// Local fixture path (resolved from repo root, as in diskSim.ts)
const FIXTURES_DIR = path.resolve(process.cwd(), 'test/fixtures')

// Fixed test device — same as single-engine tests
export const TEST_DEVICE = 'sdz1'

// SSH options
const SSH_OPTS = [
    '-i', `${process.env.HOME}/.ssh/id_ed25519`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
]

// ── Transport helper ─────────────────────────────────────────────────────────

const localHostnames = new Set([
    'localhost',
    '127.0.0.1',
    os.hostname().toLowerCase(),
    `${os.hostname().toLowerCase()}.local`,
])

/**
 * Returns true if the given host refers to this machine.
 */
export const isLocal = (host: string): boolean =>
    localHostnames.has(host.toLowerCase())

/**
 * Run a shell command on the target engine.
 * - If the host is this machine: run directly via local shell.
 * - Otherwise: run via SSH.
 *
 * Usage:  await execOn(host)`sudo mkdir -p /disks/sdz1`
 */
export const execOn = (host: string) => {
    if (isLocal(host)) {
        // Local execution — run the command directly
        return $
    }
    // Remote execution — wrap every call through SSH
    return (strings: TemplateStringsArray, ...values: any[]): Promise<ProcessOutput> => {
        // Reconstruct the command string so it can be passed to ssh as a single arg
        const cmd = strings.reduce((acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''), '')
        return $`ssh ${SSH_OPTS} pi@${host} ${cmd}`
    }
}

// ── Fixture management ───────────────────────────────────────────────────────

/**
 * Dock a fixture disk on the target engine.
 *
 * Copies the fixture to /disks/<device>/ and creates the sentinel at
 * /dev/engine/<device>, triggering chokidar's 'add' event.
 *
 * Works for both local and remote engines.
 */
export const remoteDockFixture = async (
    host: string,
    fixture = 'disk-sample-v1',
    device = TEST_DEVICE,
): Promise<void> => {
    const localFixturePath = path.join(FIXTURES_DIR, fixture)
    const remoteDiskPath   = `${REMOTE_DISKS_ROOT}/${device}`
    const remoteSentinel   = `${REMOTE_DEV_ROOT}/${device}`
    const exec = execOn(host)

    console.log(`[remoteSSH] Docking ${fixture} on ${host} as /dev/engine/${device}`)

    await exec`sudo mkdir -p ${REMOTE_DISKS_ROOT} ${REMOTE_DEV_ROOT}`
    await exec`sudo mkdir -p ${remoteDiskPath}`
    await exec`sudo chown pi:pi ${remoteDiskPath}`

    if (isLocal(host)) {
        // Local: copy directly
        await $`cp -r ${localFixturePath}/. ${remoteDiskPath}/`
    } else {
        // Remote: rsync over SSH
        await $`rsync -a --delete -e ${`ssh ${SSH_OPTS.join(' ')}`} ${localFixturePath}/ pi@${host}:${remoteDiskPath}/`
    }

    await exec`sudo touch ${remoteSentinel}`

    console.log(`[remoteSSH] Fixture docked on ${host}`)
}

/**
 * Remove the sentinel on the target engine, triggering undock.
 */
export const remoteUndock = async (
    host: string,
    device = TEST_DEVICE,
): Promise<void> => {
    const remoteSentinel = `${REMOTE_DEV_ROOT}/${device}`
    console.log(`[remoteSSH] Undocking /dev/engine/${device} on ${host}`)
    await execOn(host)`sudo rm -f ${remoteSentinel}`
    console.log(`[remoteSSH] Undock triggered on ${host}`)
}

/**
 * Remove the fixture directory from /disks/<device>/. Call in afterAll().
 */
export const remoteCleanupDisk = async (
    host: string,
    device = TEST_DEVICE,
): Promise<void> => {
    const remoteDiskPath = `${REMOTE_DISKS_ROOT}/${device}`
    console.log(`[remoteSSH] Cleaning up ${remoteDiskPath} on ${host}`)
    await execOn(host)`sudo rm -rf ${remoteDiskPath}`.catch(() => {})
}

/**
 * Check whether the Engine process on the target host is running via pm2.
 */
export const isEngineRunning = async (host: string): Promise<boolean> => {
    try {
        const result = await execOn(host)`sudo pm2 show engine`
        return result.stdout.includes('online')
    } catch {
        return false
    }
}

/**
 * Pull a Docker image on the target engine if not already cached.
 */
export const ensureImagePulled = async (host: string, image: string): Promise<void> => {
    console.log(`[remoteSSH] Ensuring ${image} is cached on ${host}...`)
    await execOn(host)`sudo docker pull ${image}`
    console.log(`[remoteSSH] Image ${image} ready on ${host}`)
}
