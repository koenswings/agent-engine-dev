/**
 * FilesMount.ts: mount Files Disks into opted-in Apps (idea#133, Files Disk step 2)
 *
 * proposals/files-disk.md §7.3, §7.5:
 *   - Opt-in: x-app.filesMount { path, services } → App.filesMount
 *   - Paths: <path>/<slug>-<id6>; display names in a read-only JSON bind
 *   - Compose override: long bind syntax, create_host_path: false, one file per
 *     instance under ~/.local/state/idea-engine/; COMPOSE_FILE on every compose call
 *   - Status: Running → up -d; Stopped → leave; Pauzed → up --no-start --force-recreate
 *   - filesMounts written only after a successful compose up
 *   - Grouping window for runtime docks: FILES_REMOUNT_GROUP_MS (3 s)
 *   - Hold-back (Kid, Q1): cheap gate for every App + Nextcloud occ status
 */

import os from 'os'
import path from 'path'
import { $, YAML, chalk, fs } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import type { App } from './App.js'
import { diskMountRoot } from './Disk.js'
import type { Disk } from './Disk.js'
import type { Instance, Status } from './Instance.js'
import { DiskID, InstanceID } from './CommonTypes.js'
import { localEngineId } from './Engine.js'
import { resourceLock, instanceKey } from '../utils/ResourceLock.js'
import { log } from '../utils/utils.js'

/** Grouping window for runtime Files Disk docks (open Q2). Documented in ARCHITECTURE.md. */
export const FILES_REMOUNT_GROUP_MS = 3_000

export const ENGINE_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'idea-engine')
export const FILES_OVERRIDE_DIR = path.join(ENGINE_STATE_DIR, 'files-overrides')
export const FILES_DISPLAY_DIR = path.join(ENGINE_STATE_DIR, 'files-display')
export const IDEA_FILES_JSON = '.idea-files.json'

/** App.filesMount from x-app.filesMount (§7.5). */
export interface AppFilesMount {
    path: string
    services: string[]
}

export type RemountAction = 'up-d' | 'up-no-start' | 'skip' | 'hold'

export interface FilesMountOps {
    composeUp: (instanceDir: string, overridePath: string, args: string[]) => Promise<void>
    nextcloudOccStatus: (instanceId: InstanceID) => Promise<NextcloudOccStatus | null>
    now?: () => number
}

export interface NextcloudOccStatus {
    installed: boolean
    maintenance: boolean
    needsDbUpgrade: boolean
}

let opsOverride: FilesMountOps | null = null
/** Tests only: replace compose / occ calls. Pass null to restore. */
export const setFilesMountOpsForTests = (ops: FilesMountOps | null): void => { opsOverride = ops }

const defaultOps: FilesMountOps = {
    composeUp: async (instanceDir, overridePath, args) => {
        const env = { ...process.env, COMPOSE_FILE: `compose.yaml:${overridePath}` }
        await $({ cwd: instanceDir, env })`docker compose ${args}`
    },
    nextcloudOccStatus: async (instanceId) => {
        try {
            const out = await $`docker exec ${instanceId}-nextcloud-app-1 runuser --user www-data -- php occ status --output=json`
            const parsed = JSON.parse(String(out.stdout ?? out).trim())
            if (!parsed || typeof parsed !== 'object') return null
            return {
                installed: parsed.installed === true,
                maintenance: parsed.maintenance === true,
                needsDbUpgrade: parsed.needsDbUpgrade === true,
            }
        } catch {
            return null
        }
    },
}

const ops = (): FilesMountOps => opsOverride ?? defaultOps

/** Create ~/.local/state/idea-engine/ (and override/display subfolders) at startup. */
export const ensureEngineStateDir = async (): Promise<void> => {
    await fs.ensureDir(FILES_OVERRIDE_DIR)
    await fs.ensureDir(FILES_DISPLAY_DIR)
}

/**
 * Sanitise a shareName into a path slug: lower-case, spaces→hyphens, drop anything
 * that isn't a–z 0–9 hyphen/underscore; no leading dot; collapse empties to 'files'.
 */
export const slugFromShareName = (shareName: string): string => {
    const slug = shareName
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/^\.+/, '')
    return slug || 'files'
}

/** First six characters of the disk ID (always-suffixed path rule). */
export const diskId6 = (diskId: string): string => String(diskId).slice(0, 6)

export const containerFilesPath = (mountPath: string, shareName: string, diskId: string): string =>
    `${mountPath.replace(/\/$/, '')}/${slugFromShareName(shareName)}-${diskId6(diskId)}`

export const overridePathFor = (instanceId: InstanceID): string =>
    path.join(FILES_OVERRIDE_DIR, `${instanceId}.yaml`)

export const displayJsonHostPath = (instanceId: InstanceID): string =>
    path.join(FILES_DISPLAY_DIR, `${instanceId}${IDEA_FILES_JSON}`)

/** Parse x-app.filesMount; returns null when missing or invalid. */
export const parseFilesMount = (xapp: any): AppFilesMount | null => {
    const fm = xapp?.filesMount
    if (!fm || typeof fm !== 'object') return null
    if (typeof fm.path !== 'string' || !fm.path.startsWith('/')) return null
    if (!Array.isArray(fm.services) || fm.services.length === 0) return null
    const services = fm.services.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
    if (services.length === 0) return null
    return { path: fm.path, services: [...services] }
}

/** Docked Files Disks on this Engine that are mountable (not password-protected). */
export const mountableFilesDisks = (store: Store, engineId: string = localEngineId): Disk[] =>
    Object.values(store.diskDB).filter(d =>
        d.dockedTo === engineId &&
        d.device &&
        d.diskTypes?.includes('files') &&
        d.filesConfig &&
        !d.filesConfig.passwordProtected &&
        !d.filesConfig.error
    )

/** Opted-in instances on this Engine (App.filesMount set; not Undocked/Missing). */
export const optedInInstances = (store: Store, engineId: string = localEngineId): Instance[] =>
    Object.values(store.instanceDB).filter(inst => {
        if (inst.status === 'Undocked' || inst.status === 'Missing') return false
        const disk = inst.storedOn ? store.diskDB[inst.storedOn] : null
        if (!disk || disk.dockedTo !== engineId) return false
        const app = store.appDB[inst.instanceOf]
        return !!(app?.filesMount)
    })

/**
 * What to do for one instance when Files Disks change (§7.3 status table + Q1 hold).
 * `hold` means queue and retry later; never recreate while held.
 */
export const remountActionFor = (status: Status, held: boolean): RemountAction => {
    if (held) return 'hold'
    if (status === 'Running') return 'up-d'
    if (status === 'Stopped') return 'skip'
    if (status === 'Pauzed' || status === 'Docked' || status === 'Error') return 'up-no-start'
    // Starting is covered by held; Undocked/Missing aren't remounted
    return 'skip'
}

/**
 * Cheap gate (every opted-in App) + Nextcloud occ status (Kid, Q1).
 * Fail closed: missing occ / non-zero / bad JSON → held.
 */
export const shouldHoldFilesRemount = async (
    store: Store,
    instance: Instance,
    occ: (id: InstanceID) => Promise<NextcloudOccStatus | null> = ops().nextcloudOccStatus,
): Promise<boolean> => {
    if (instance.status === 'Starting') return true
    const lock = resourceLock.getLockInfo(instanceKey(instance.id))
    if (lock && (lock.kind === 'startApp' || lock.kind === 'stopApp' || lock.kind === 'upgradeApp' ||
        lock.kind === 'remountFiles' || lock.kind === 'copyApp' || lock.kind === 'moveApp')) {
        return true
    }
    // A Running Operation on this instance (same idea as stillStartable / idea#109)
    const opsRunning = Object.values(store.operationDB ?? {}).some(op =>
        (op.status === 'Running' || op.status === 'Pending') &&
        (op.subject?.type === 'instance' && op.subject.id === instance.id) &&
        (op.kind === 'startApp' || op.kind === 'stopApp' || op.kind === 'upgradeApp')
    )
    if (opsRunning) return true

    const app = store.appDB[instance.instanceOf]
    if (app?.name === 'nextcloud' || app?.filesMount?.services.includes('nextcloud-app')) {
        // Only apply the occ gate when the instance is (or was) Running: a Pauzed
        // recreate doesn't need Nextcloud ready yet; the next start will remount.
        if (instance.status === 'Running') {
            const status = await occ(instance.id)
            if (!status) return true
            if (!status.installed || status.maintenance || status.needsDbUpgrade) return true
        }
    }
    return false
}

/** Build the compose override YAML (long bind syntax) and the display-name JSON. */
export const buildOverride = (
    filesMount: AppFilesMount,
    disks: { id: DiskID; shareName: string; hostFilesPath: string }[],
    displayJsonHost: string,
): { yaml: string; display: Record<string, string> } => {
    const display: Record<string, string> = {}
    const volumeEntries: any[] = []
    for (const d of disks) {
        const slugId = `${slugFromShareName(d.shareName)}-${diskId6(d.id)}`
        display[slugId] = d.shareName
        volumeEntries.push({
            type: 'bind',
            source: d.hostFilesPath,
            target: `${filesMount.path.replace(/\/$/, '')}/${slugId}`,
            read_only: false,
            bind: { create_host_path: false },
        })
    }
    volumeEntries.push({
        type: 'bind',
        source: displayJsonHost,
        target: `${filesMount.path.replace(/\/$/, '')}/${IDEA_FILES_JSON}`,
        read_only: true,
        bind: { create_host_path: false },
    })
    const services: Record<string, { volumes: any[] }> = {}
    for (const s of filesMount.services) {
        services[s] = { volumes: volumeEntries }
    }
    return { yaml: YAML.stringify({ services }), display }
}

/** Write a fresh override + display JSON for an instance from the current store. */
export const writeInstanceOverride = async (
    store: Store,
    instance: Instance,
    excludeDiskId?: DiskID,
): Promise<{ overridePath: string; diskIds: DiskID[] } | null> => {
    const app = store.appDB[instance.instanceOf]
    if (!app?.filesMount) return null
    await ensureEngineStateDir()
    const disks = mountableFilesDisks(store).filter(d => d.id !== excludeDiskId)
    const diskInfos: { id: DiskID; shareName: string; hostFilesPath: string }[] = []
    for (const d of disks) {
        const root = await diskMountRoot(d)
        diskInfos.push({
            id: d.id,
            shareName: d.filesConfig!.shareName,
            hostFilesPath: path.join(root, 'files'),
        })
    }
    const displayHost = displayJsonHostPath(instance.id)
    const { yaml, display } = buildOverride(app.filesMount, diskInfos, displayHost)
    await fs.writeFile(displayHost, JSON.stringify(display, null, 2) + '\n')
    const overridePath = overridePathFor(instance.id)
    await fs.writeFile(overridePath, yaml)
    return { overridePath, diskIds: diskInfos.map(d => d.id) }
}

/**
 * COMPOSE_FILE=compose.yaml:<override> for every compose call on an opted-in
 * instance. Writes a fresh override first. Returns the env fragment.
 */
export const composeFileEnv = async (
    store: Store,
    instance: Instance,
    excludeDiskId?: DiskID,
): Promise<Record<string, string> | null> => {
    const written = await writeInstanceOverride(store, instance, excludeDiskId)
    if (!written) return null
    return { COMPOSE_FILE: `compose.yaml:${written.overridePath}` }
}

/**
 * Remount one opted-in instance for the current set of Files Disks.
 * Takes the instance lock; reuses stillStartable-style checks via shouldHoldFilesRemount.
 * Writes Instance.filesMounts only after a successful compose up.
 * `excludeDiskId`: undock path — rebuild without that Files Disk.
 * `skipSameDiskId`: dock path — don't touch instances stored on this disk (processAppDisk will start them).
 */
export const remountInstance = async (
    storeHandle: DocHandle<Store>,
    instanceId: InstanceID,
    opts: { excludeDiskId?: DiskID; skipSameDiskId?: DiskID } = {},
): Promise<'done' | 'skipped' | 'held' | 'failed'> => {
    const store = storeHandle.doc()!
    const instance = store.instanceDB[instanceId]
    if (!instance) return 'skipped'
    if (opts.skipSameDiskId && instance.storedOn === opts.skipSameDiskId) return 'skipped'
    const app = store.appDB[instance.instanceOf]
    if (!app?.filesMount) return 'skipped'

    const held = await shouldHoldFilesRemount(store, instance)
    const action = remountActionFor(instance.status, held)
    if (action === 'hold') {
        log(`Files remount of ${instanceId}: held (not ready)`)
        return 'held'
    }
    if (action === 'skip') {
        log(`Files remount of ${instanceId}: skipped (status ${instance.status})`)
        return 'skipped'
    }

    const lockKey = instanceKey(instanceId)
    if (!resourceLock.acquire(lockKey, 'remountFiles')) {
        log(chalk.yellow(`Files remount of ${instanceId}: instance lock held`))
        return 'held'
    }
    try {
        const written = await writeInstanceOverride(store, instance, opts.excludeDiskId)
        if (!written) return 'skipped'
        const disk = instance.storedOn ? store.diskDB[instance.storedOn] : null
        if (!disk?.device) return 'skipped'
        // stillStartable-style: disk still docked, instance not Undocked
        const snap = storeHandle.doc()!
        const curDisk = snap.diskDB[disk.id]
        const curInst = snap.instanceDB[instanceId]
        if (!curDisk?.dockedTo || curInst?.status === 'Undocked') {
            log(`Files remount of ${instanceId}: disk undocked or instance Undocked — skipping`)
            return 'skipped'
        }
        const instanceDir = path.join(await diskMountRoot(disk), 'instances', instanceId)
        const composeArgs = action === 'up-d' ? ['up', '-d'] : ['up', '--no-start', '--force-recreate']
        await ops().composeUp(instanceDir, written.overridePath, composeArgs)
        // filesMounts only after success (§7.3)
        storeHandle.change(doc => {
            const inst = doc.instanceDB[instanceId]
            if (inst) inst.filesMounts = written.diskIds as DiskID[]
        })
        log(`Files remount of ${instanceId}: ${action} ok; filesMounts=${written.diskIds.join(',') || '(none)'}`)
        return 'done'
    } catch (e: any) {
        log(chalk.red(`Files remount of ${instanceId} failed: ${e.message ?? e}`))
        return 'failed'
    } finally {
        resourceLock.release(lockKey)
    }
}

// ── Grouped runtime remount (Q2: FILES_REMOUNT_GROUP_MS) ─────────────────────

interface PendingRemount {
    excludeDiskId?: DiskID
    skipSameDiskId?: DiskID
    /** Instance ids that returned 'held' and should be retried. */
    heldIds: Set<InstanceID>
}

let pending: PendingRemount | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let storeHandleRef: DocHandle<Store> | null = null
let flushInFlight: Promise<void> | null = null

const HOLD_RETRY_MS = 5_000

/** Remember the store handle so the debounce flush can run without a caller. */
export const setFilesMountStore = (h: DocHandle<Store> | null): void => { storeHandleRef = h }

/**
 * Schedule a remount of all opted-in instances after FILES_REMOUNT_GROUP_MS.
 * Multiple docks within the window coalesce into one recreate.
 * `skipSameDiskId`: Files role just appeared on this disk; its own instances start via processAppDisk.
 * `excludeDiskId`: this Files Disk is leaving (undock/eject).
 */
export const scheduleFilesRemount = (
    storeHandle: DocHandle<Store>,
    opts: { excludeDiskId?: DiskID; skipSameDiskId?: DiskID } = {},
): void => {
    storeHandleRef = storeHandle
    if (!pending) pending = { heldIds: new Set() }
    if (opts.excludeDiskId) pending.excludeDiskId = opts.excludeDiskId
    if (opts.skipSameDiskId) pending.skipSameDiskId = opts.skipSameDiskId
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => { flushTimer = null; void flushFilesRemount() }, FILES_REMOUNT_GROUP_MS)
}

/** Run immediately (tests / undock path that can't wait for the window). */
export const flushFilesRemountNow = async (storeHandle?: DocHandle<Store>): Promise<void> => {
    if (storeHandle) storeHandleRef = storeHandle
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    await flushFilesRemount()
}

const flushFilesRemount = async (): Promise<void> => {
    if (flushInFlight) { await flushInFlight; return }
    const h = storeHandleRef
    const job = pending
    pending = null
    if (!h || !job) return
    flushInFlight = (async () => {
        const store = h.doc()!
        const targets = new Set<InstanceID>([
            ...optedInInstances(store).map(i => i.id),
            ...job.heldIds,
        ])
        const stillHeld = new Set<InstanceID>()
        for (const id of targets) {
            const result = await remountInstance(h, id, {
                excludeDiskId: job.excludeDiskId,
                skipSameDiskId: job.skipSameDiskId,
            })
            if (result === 'held') stillHeld.add(id)
        }
        if (stillHeld.size > 0) {
            // Queue a retry once instances leave Starting / Nextcloud becomes ready
            if (!pending) pending = { heldIds: stillHeld, excludeDiskId: job.excludeDiskId }
            else stillHeld.forEach(id => pending!.heldIds.add(id))
            if (!flushTimer) {
                flushTimer = setTimeout(() => { flushTimer = null; void flushFilesRemount() }, HOLD_RETRY_MS)
            }
        }
    })()
    try { await flushInFlight } finally { flushInFlight = null }
}

/** Tests only: clear debounce state. */
export const resetFilesRemountScheduleForTests = (): void => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    pending = null
    flushInFlight = null
    storeHandleRef = null
}
