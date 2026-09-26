/**
 * diskDetection.ts
 *
 * Makes USB disk detection failures visible (idea#82).
 *
 * Disk detection depends on the udev rule 90-docking.rules, which creates the
 * /dev/engine/<device> links the USB device monitor watches. tmpfiles.d always
 * creates /dev/engine, so a missing rule leaves an empty folder and docking
 * silently does nothing. boot.sh reinstalls the rule on every boot when it is
 * missing or differs from the shipped asset (self-repair). This module:
 *
 *   - runs a startup self-check that reports what the self-repair could not fix
 *   - records disk detection failures (self-check, monitor start, mount, META
 *     read, undock) as failed `diskDetection` traces in the command log, so they
 *     appear in the Console History panel (no store schema change)
 */

import path from 'path'
import { $, fs, sleep } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { CommandLogStore, getCommandLogHandle, addTrace, closeTrace } from '../data/CommandLogStore.js'

export const DISK_DETECTION_COMMAND = 'diskDetection'
export const UDEV_RULE_PATH = '/etc/udev/rules.d/90-docking.rules'
export const UDEV_RULE_ASSET = 'script/build_image_assets/90-docking.rules'
export const ENGINE_WATCH_DIR = '/dev/engine'
export const SYS_BLOCK_DIR = '/sys/class/block'

// Devices the udev rule links into /dev/engine: KERNEL=="sd?|sd?1|sd?2"
export const RULE_DEVICE_PATTERN = /^sd[a-z][12]?$/

export type DiskDetectionStep = 'selfCheck' | 'monitorStart' | 'watcher' | 'mount' | 'readMeta' | 'dock' | 'undock'

/**
 * Record a disk detection failure: always logged, and added to the command log
 * as a completed trace with status 'error' (shows up in Console History).
 */
export const recordDiskDetectionFailure = (
    step: DiskDetectionStep,
    message: string,
    details: Record<string, unknown> = {},
    handle: DocHandle<CommandLogStore> | null = getCommandLogHandle()
): void => {
    log(`[diskDetection] ${step} failed: ${message}`)
    if (!handle) return
    try {
        const traceId = crypto.randomUUID()
        const now = Date.now()
        addTrace(handle, {
            traceId,
            command: DISK_DETECTION_COMMAND,
            args: JSON.stringify({ step, ...details }),
            startedAt: now,
            completedAt: null,
            status: 'running',
            errorMessage: null,
        })
        closeTrace(handle, traceId, 'error', message)
    } catch (e) {
        log(`[diskDetection] could not record the failure in the command log: ${e}`)
    }
}

export const errorMessage = (e: unknown): string =>
    e instanceof Error ? e.message : String(e)

export interface DiskDetectionPaths {
    rulePath: string
    ruleAsset: string
    watchDir: string
    sysBlockDir: string
}

export const defaultDiskDetectionPaths = (): DiskDetectionPaths => ({
    rulePath: UDEV_RULE_PATH,
    // The Engine runs from its repo folder (config.yaml is read relative to cwd)
    ruleAsset: path.resolve(UDEV_RULE_ASSET),
    watchDir: ENGINE_WATCH_DIR,
    sysBlockDir: SYS_BLOCK_DIR,
})

/**
 * Check the udev setup disk detection relies on. Returns the problems found
 * (empty when everything is in place):
 *   - the udev rule file exists (and matches the shipped asset, when present)
 *   - the watch folder (/dev/engine) exists
 *   - every sd* device covered by the rule has a matching /dev/engine/<name> entry
 */
export const checkDiskDetection = (paths: DiskDetectionPaths): string[] => {
    const problems: string[] = []

    if (!fs.existsSync(paths.rulePath)) {
        problems.push(`udev rule ${paths.rulePath} is missing`)
    } else if (fs.existsSync(paths.ruleAsset)) {
        const installed = fs.readFileSync(paths.rulePath, 'utf8').trim()
        const shipped = fs.readFileSync(paths.ruleAsset, 'utf8').trim()
        if (installed !== shipped) problems.push(`udev rule ${paths.rulePath} differs from ${paths.ruleAsset}`)
    }

    if (!fs.existsSync(paths.watchDir)) {
        problems.push(`${paths.watchDir} does not exist`)
        return problems
    }

    let devices: string[] = []
    try {
        devices = fs.readdirSync(paths.sysBlockDir).filter(d => RULE_DEVICE_PATTERN.test(d))
    } catch (e) {
        problems.push(`cannot list ${paths.sysBlockDir}: ${errorMessage(e)}`)
    }
    const present = new Set(fs.readdirSync(paths.watchDir))
    const missing = devices.filter(d => !present.has(d)).sort()
    if (missing.length > 0) {
        problems.push(`no ${paths.watchDir} entry for ${missing.join(', ')}`)
    }
    return problems
}

export interface SelfCheckOptions {
    paths?: DiskDetectionPaths
    settle?: () => Promise<void>
    retryDelayMs?: number
    handle?: DocHandle<CommandLogStore> | null
}

const udevSettle = async (): Promise<void> => {
    // Wait until udev has processed its event queue (no root needed).
    await $`udevadm settle --timeout=10`.nothrow()
}

/**
 * Engine startup self-check. Skipped in test runs (IDEA_WATCH_DIR is set: tests
 * use a private watch folder, idea#105). Waits for udev to settle, then checks.
 * boot.sh may still be repairing the rule when the Engine starts, so problems are
 * re-checked once after a delay; only what is still wrong is reported, as one
 * failed `diskDetection` trace. Returns the reported problems.
 */
export const runDiskDetectionSelfCheck = async (opts: SelfCheckOptions = {}): Promise<string[]> => {
    if (process.env.IDEA_WATCH_DIR) {
        log(`[diskDetection] IDEA_WATCH_DIR is set — skipping the udev self-check`)
        return []
    }
    const paths = opts.paths ?? defaultDiskDetectionPaths()
    const settle = opts.settle ?? udevSettle
    const retryDelayMs = opts.retryDelayMs ?? 30_000

    await settle()
    let problems = checkDiskDetection(paths)
    if (problems.length > 0) {
        log(`[diskDetection] self-check found problems, re-checking in ${retryDelayMs} ms: ${problems.join('; ')}`)
        await sleep(retryDelayMs)
        await settle()
        problems = checkDiskDetection(paths)
    }
    if (problems.length === 0) {
        log(`[diskDetection] self-check passed`)
        return []
    }
    recordDiskDetectionFailure(
        'selfCheck',
        `USB disk detection is not working: ${problems.join('; ')}`,
        { problems },
        opts.handle === undefined ? getCommandLogHandle() : opts.handle
    )
    return problems
}
