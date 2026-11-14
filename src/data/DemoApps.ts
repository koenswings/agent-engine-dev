/**
 * DemoApps.ts — setupDemo / removeDemo and the demoApps capability (engine#369).
 *
 * Console "Demo apps" button, Option A, Engine-first. Operators only is
 * enforced in the Console; this Engine has no sender identity and does not
 * refuse by role. One demo set per Engine, App Disks only, pack inside the
 * demo instance folder, hooks from the app bundle only.
 */
import { DocHandle } from '@automerge/automerge-repo'
import { fs, path, $ } from 'zx'
import type { Store } from './Store.js'
import { getDisk, getLocalEngine, getInstances } from './Store.js'
import type { Instance } from './Instance.js'
import type { Disk } from './Disk.js'
import { diskMountRoot, isSystemDisk } from './Disk.js'
import type { AppID, DiskID, EngineID, InstanceID, Timestamp } from './CommonTypes.js'
import { parseAppId } from './App.js'
import { compareVersions } from './Version.js'
import { lookupDiskArg } from './DiskArg.js'
import { lookupLocalInstanceArg } from './InstanceArg.js'
import { resourceLock, instanceKey, diskKey } from '../utils/ResourceLock.js'
import { log } from '../utils/utils.js'
import { createOperation, updateOperation } from './Operations.js'
import { attachTraceResult } from './SummariseDisk.js'
import { trackInFlight, assertSameDockAfterWait, dockIdentityOf } from './InstanceInFlight.js'
import { composeProjectFor } from '../utils/instanceIds.js'
import { hasInternet } from './InstallApp.js'
import { availableBytes } from './CopyMoveApp.js'
import { usbRoot } from './Config.js'
import {
    AppDemoSpec, DemoAppName, LocatedPack, PackJson, PackVerifyError,
    downloadUrlToFile, existingPackIsValid, extractPackTar, instancePackDir,
    instancePackRoot, pickBestLocalPack, readAppDemoSpec, scanIdeaDemoDir,
    spaceNeededBytes, verifyExtractedPack, verifyTarSha256,
    DownloadFn,
} from './DemoPack.js'

export type DemoStepId = 'install' | 'download' | 'verify' | 'seed' | 'start' | 'ready' | 'classwork' | 'stop' | 'remove'
export type DemoStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export type DemoCode =
    | 'UNKNOWN_APP' | 'NOT_FOUND' | 'NOT_DOCKED' | 'NOT_LOCAL' | 'SYSTEM_DISK' | 'NOT_APP_DISK'
    | 'DEMO_EXISTS' | 'DEMO_AMBIGUOUS' | 'NO_SOURCE' | 'PACK_OUTDATED' | 'NO_SPACE' | 'BUSY'
    | 'NOT_DEMO' | 'HELPER_OUTDATED' | 'DOWNLOAD_FAILED' | 'CHECKSUM_MISMATCH' | 'INVALID_PACK' | 'INSTALL_FAILED'
    | 'HOOK_MISSING' | 'HOOK_FAILED' | 'START_FAILED' | 'NOT_READY' | 'DOCK_CHANGED' | 'INTERRUPTED'
    | 'REMOVE_FAILED' | 'DEMO_READY' | 'DEMO_REMOVED'

export interface DemoPackWarning {
    code: 'PACK_OUTDATED'
    packVersion: number
    minVersion: number
}

export interface DemoAppProgress {
    app: DemoAppName
    instanceId: string | null
    steps: { id: DemoStepId, status: DemoStepStatus, bytesTotal?: number | null }[]
    source: 'local' | 'github' | null
    packVersion: string | null
    code: DemoCode | null
    detail: string | null
}

export interface DemoSkipped {
    app: DemoAppName
    code: 'NO_SOURCE'
    detail: string
}

export interface DemoProgress {
    targetDiskId: string | null
    apps: DemoAppProgress[]
    /** Always present. Apps skipped at pre-check (NO_SOURCE only, and only when --apps was omitted). */
    skipped: DemoSkipped[]
    code: DemoCode | null
    resultText: string | null
}

export const DEMO_APP_NAMES: readonly DemoAppName[] = ['kolibri', 'nextcloud']
export const DEMO_DISPLAY_NAME: Record<DemoAppName, string> = {
    kolibri: 'Kolibri Demo',
    nextcloud: 'Nextcloud Demo',
}
export const DEMO_PROGRESS_TYPE = 'idea/progress' as const
export const INTERNET_PROBE_MS = 60_000

export interface DemoProgressMsg {
    type: typeof DEMO_PROGRESS_TYPE
    opId: string
    step: DemoStepId
    bytesDone: number
    bytesTotal: number
}

export class DemoError extends Error {
    constructor(public code: DemoCode, text: string, public traceResult?: unknown) {
        super(`${code}: ${text}`)
        this.name = 'DemoError'
    }
}

export const isDemoAppName = (s: string): s is DemoAppName =>
    (DEMO_APP_NAMES as readonly string[]).includes(s)

export const appNameOfInstance = (inst: Instance): string => {
    try { return String(parseAppId(String(inst.instanceOf)).name) } catch {
        const id = String(inst.instanceOf ?? '')
        const m = id.match(/^([a-z]+)-\d/i)
        return m ? m[1].toLowerCase() : id.toLowerCase()
    }
}

export const isDemoInstance = (inst: Instance | undefined | null): boolean =>
    !!inst && (inst as Instance & { demo?: true }).demo === true

export const demoKey = (engineId: string): string => `demo:${engineId}`

// ── Capability (implemented in Engine.ts so engineCapabilities has no cycle) ──

import { isDemoAppsCapabilityOn, checkDemoAppsCapability } from './Engine.js'
export { DEMO_APPS_CAPABILITY, checkDemoAppsCapability, resetDemoAppsCapabilityForTests, isDemoAppsCapabilityOn } from './Engine.js'

// ── Heartbeat fields (ephemeral; never stored) ────────────────────────────────

let internetCache: { at: number, value: boolean } | null = null
let demoHb: { internet?: boolean, demoLocal?: boolean } = {}

export const peekDemoHbFields = (): { internet?: boolean, demoLocal?: boolean } => ({ ...demoHb })

export const resetDemoHbForTests = (): void => { internetCache = null; demoHb = {} }

export const cachedInternet = async (now: number = Date.now(), probe: () => Promise<boolean> = hasInternet): Promise<boolean> => {
    if (internetCache && now - internetCache.at < INTERNET_PROBE_MS) return internetCache.value
    const value = await probe()
    internetCache = { at: now, value }
    return value
}

export const dockedIdeaDemoRoots = async (store: Store, engineId: string, mountRoot: (disk: Disk) => Promise<string>): Promise<string[]> => {
    const roots: string[] = []
    for (const disk of Object.values(store.diskDB ?? {})) {
        if (!disk || String(disk.dockedTo) !== String(engineId) || !disk.device) continue
        if ((disk.diskTypes ?? []).includes('system')) continue
        try { roots.push(path.join(await mountRoot(disk), 'IDEA-DEMO')) } catch { /* undocked mid-scan */ }
    }
    const root = usbRoot()
    for (const stick of (getLocalEngine(store)?.usbSticks ?? [])) {
        if (!stick?.device) continue
        roots.push(path.join(root, String(stick.device), 'IDEA-DEMO'))
    }
    return roots
}

const bundleOnDockedDisk = async (store: Store, engineId: string, app: DemoAppName, mountRoot: (disk: Disk) => Promise<string>): Promise<boolean> => {
    for (const disk of Object.values(store.diskDB ?? {})) {
        if (!disk || String(disk.dockedTo) !== String(engineId) || !disk.device) continue
        try {
            const root = await mountRoot(disk)
            const appsDir = path.join(root, 'apps')
            if (!await fs.pathExists(appsDir)) continue
            for (const name of await fs.readdir(appsDir)) {
                if (name.startsWith('.')) continue
                try { if (parseAppId(name).name === app && await fs.pathExists(path.join(appsDir, name, 'app.yaml'))) return true } catch { /* not an app id */ }
            }
        } catch { /* skip */ }
    }
    return false
}

export const computeDemoLocal = async (
    store: Store,
    engineId: string,
    apps: DemoAppName[] = [...DEMO_APP_NAMES],
    deps: { mountRoot?: (disk: Disk) => Promise<string>, findBundle?: (app: DemoAppName) => Promise<string | null> } = {},
): Promise<boolean> => {
    const mountRoot = deps.mountRoot ?? diskMountRoot
    const roots = await dockedIdeaDemoRoots(store, engineId, mountRoot)
    for (const app of apps) {
        const pinMin = 0
        const found: LocatedPack[] = []
        for (const dir of roots) found.push(...await scanIdeaDemoDir(dir, app, pinMin, null))
        // Accept any schema-valid local pack (minVersion is applied per bundle when setup runs).
        const usable = found.filter(p => p.kind === 'dir' || p.kind === 'tar')
        if (!usable.length) return false
        const hasBundle = deps.findBundle ? !!(await deps.findBundle(app)) : await bundleOnDockedDisk(store, engineId, app, mountRoot)
        if (!hasBundle) return false
    }
    return true
}

export const refreshDemoHb = async (
    storeHandle: DocHandle<Store>,
    engineId: string,
    deps: { probe?: () => Promise<boolean>, mountRoot?: (disk: Disk) => Promise<string> } = {},
): Promise<{ internet: boolean, demoLocal: boolean }> => {
    const internet = await cachedInternet(Date.now(), deps.probe ?? hasInternet)
    let demoLocal = false
    try { demoLocal = await computeDemoLocal(storeHandle.doc(), engineId, [...DEMO_APP_NAMES], { mountRoot: deps.mountRoot }) } catch (e) {
        log(`demoLocal: ${(e as Error).message}`)
    }
    demoHb = { internet, demoLocal }
    return { internet, demoLocal }
}

// ── Args ──────────────────────────────────────────────────────────────────────

export const SETUP_DEMO_USAGE = 'Usage: setupDemo <targetDiskId> [--apps kolibri,nextcloud]'
export const REMOVE_DEMO_USAGE = 'Usage: removeDemo [<instanceId>...]'

export const parseAppsList = (raw: string | undefined | null, fallback: DemoAppName[] = [...DEMO_APP_NAMES]): DemoAppName[] => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
    const parts = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    if (!parts.length) return fallback
    const out: DemoAppName[] = []
    for (const p of parts) {
        if (!isDemoAppName(p)) throw new DemoError('UNKNOWN_APP', `'${p}' is not a known demo app (kolibri, nextcloud)`)
        if (!out.includes(p)) out.push(p)
    }
    return out
}

/** Parse the optional `--apps` tokens from a variadic rest list. */
export const parseAppsFlag = (rest: string[]): DemoAppName[] => {
    if (!rest.length) return [...DEMO_APP_NAMES]
    const tokens = rest.filter(t => t !== '--apps' && t !== '--')
    if (rest.includes('--apps') && tokens.length === 0) throw new DemoError('UNKNOWN_APP', '--apps needs a comma-separated list')
    if (!rest.includes('--apps') && rest.length && rest[0].startsWith('--')) {
        throw new DemoError('UNKNOWN_APP', `unknown argument ${rest[0]}`)
    }
    return parseAppsList(tokens[0] ?? '')
}

// ── Finding demos ─────────────────────────────────────────────────────────────

export const dockedDemoInstances = (store: Store, engineId: string, app?: DemoAppName): Instance[] => {
    const out: Instance[] = []
    for (const inst of getInstances(store)) {
        if (!isDemoInstance(inst)) continue
        if (app && appNameOfInstance(inst) !== app) continue
        const disk = inst.storedOn ? getDisk(store, inst.storedOn) : undefined
        if (!disk || String(disk.dockedTo) !== String(engineId)) continue
        out.push(inst)
    }
    return out
}

const diskNameOf = (store: Store, id: string | null | undefined): string => {
    const d = id ? getDisk(store, id as DiskID) : undefined
    return d ? `${d.name} (${d.id})` : String(id ?? 'unknown')
}

// ── Operation helpers ─────────────────────────────────────────────────────────

const asPlain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const writeDemo = (storeHandle: DocHandle<Store>, opId: string, patch: Partial<DemoProgress> & { apps?: DemoAppProgress[] }): void => {
    const appsPlain = patch.apps !== undefined ? asPlain(patch.apps) : undefined
    storeHandle.change(doc => {
        const op = doc.operationDB?.[opId] as (typeof doc.operationDB[string] & { demo?: DemoProgress }) | undefined
        if (!op) return
        const cur: DemoProgress = op.demo ?? { targetDiskId: null, apps: [], skipped: [], code: null, resultText: null }
        op.demo = {
            targetDiskId: patch.targetDiskId !== undefined ? patch.targetDiskId : cur.targetDiskId,
            apps: appsPlain ?? asPlain(cur.apps),
            skipped: patch.skipped !== undefined ? asPlain(patch.skipped) : asPlain(cur.skipped ?? []),
            code: patch.code !== undefined ? patch.code : cur.code,
            resultText: patch.resultText !== undefined ? patch.resultText : cur.resultText,
        }
    })
}

const setAppStep = (apps: DemoAppProgress[], app: DemoAppName, id: DemoStepId, status: DemoStepStatus, extra?: Partial<DemoAppProgress> & { bytesTotal?: number | null }): DemoAppProgress[] =>
    apps.map(a => {
        if (a.app !== app) return a
        return {
            ...a,
            ...extra,
            steps: a.steps.map(s => s.id === id ? { ...s, status, ...(extra && 'bytesTotal' in extra ? { bytesTotal: extra.bytesTotal } : {}) } : s),
        }
    })

export const stepPlan = (spec: AppDemoSpec | null): DemoStepId[] => {
    const hookIds = (spec?.steps ?? []).map(s => s.id as DemoStepId)
    const needsRunning = (spec?.steps ?? []).some(s => s.needs === 'running')
    const plan: DemoStepId[] = ['install', 'download', 'verify']
    let started = false
    for (const s of spec?.steps ?? []) {
        if (s.needs === 'running' && !started) {
            plan.push('start', 'ready')
            started = true
        }
        plan.push(s.id as DemoStepId)
    }
    if (needsRunning === false || !started) {
        // Leave the demo running after a stopped-only seed (or a missing hook list).
        plan.push('start', 'ready')
    }
    // Dedup start/ready if already added
    const seen = new Set<string>()
    const out: DemoStepId[] = []
    for (const id of plan) {
        if ((id === 'start' || id === 'ready') && seen.has(id)) continue
        seen.add(id)
        out.push(id)
    }
    void hookIds
    return out
}

// ── Bundle lookup ─────────────────────────────────────────────────────────────

export const findDockedBundle = async (
    store: Store,
    engineId: string,
    app: DemoAppName,
    mountRoot: (disk: Disk) => Promise<string> = diskMountRoot,
): Promise<{ disk: Disk, dir: string, appId: string, spec: AppDemoSpec } | null> => {
    type Cand = { disk: Disk, dir: string, appId: string, spec: AppDemoSpec, version: string }
    const cands: Cand[] = []
    for (const disk of Object.values(store.diskDB ?? {})) {
        if (!disk || String(disk.dockedTo) !== String(engineId) || !disk.device) continue
        try {
            const root = await mountRoot(disk)
            const appsDir = path.join(root, 'apps')
            if (!await fs.pathExists(appsDir)) continue
            for (const name of await fs.readdir(appsDir)) {
                if (name.startsWith('.')) continue
                let parsed: { name: string, version: string }
                try { parsed = parseAppId(name) } catch { continue }
                if (parsed.name !== app) continue
                const dir = path.join(appsDir, name)
                const spec = await readAppDemoSpec(dir)
                if (!spec) continue
                cands.push({ disk, dir, appId: name, spec, version: String(parsed.version) })
            }
        } catch { /* skip */ }
    }
    if (!cands.length) return null
    cands.sort((a, b) => {
        const c = compareVersions(a.version, b.version)
        if (c !== null) return c
        return a.version < b.version ? -1 : a.version > b.version ? 1 : 0
    })
    return cands[cands.length - 1]
}

export interface SetupDemoDeps {
    mountRoot: (disk: Disk) => Promise<string>
    hasInternet: () => Promise<boolean>
    availableBytes: (p: string) => Promise<number>
    install: (args: { appId: string, targetDiskId: string, instanceName: string, fresh: true, start: false, demo: true, sourceDiskId?: string }) => Promise<InstanceID>
    start: (inst: Instance, disk: Disk) => Promise<void>
    stop: (inst: Instance, disk: Disk) => Promise<void>
    remove: (instanceArg: string, engineId: string) => Promise<{ instanceId: InstanceID, quarantinePath: string, keptVolumes: string[] }>
    runHook: (args: { hookPath: string, step: string, cwd: string, env: Record<string, string>, timeoutSec: number }) => Promise<{ code: number, stderr: string }>
    download: DownloadFn
    broadcast: (msg: DemoProgressMsg) => void
    now: () => number
    sleep: (ms: number) => Promise<void>
    /** Injected python3 check for tests; production uses checkDemoAppsCapability's default. */
    checkDemoApps?: () => boolean
}

const defaultDeps = (storeHandle: DocHandle<Store>): SetupDemoDeps => ({
    mountRoot: (disk) => diskMountRoot(disk),
    hasInternet,
    availableBytes,
    install: async (args) => {
        const { installApp } = await import('./InstallApp.js')
        const id = await installApp(storeHandle, {
            appId: args.appId as AppID,
            targetDiskId: args.targetDiskId,
            sourceDiskId: args.sourceDiskId,
            instanceName: args.instanceName as any,
            fresh: true,
            start: false,
            demo: true,
        })
        if (!id) throw new DemoError('INSTALL_FAILED', `installApp did not return an instance id for ${args.appId}`)
        return id
    },
    start: async (inst, disk) => (await import('./Instance.js')).startInstance(storeHandle, inst, disk),
    stop: async (inst, disk) => (await import('./Instance.js')).stopInstance(storeHandle, inst, disk),
    remove: async (instanceArg, engineId) => (await import('./RemoveInstance.js')).removeInstance(storeHandle, instanceArg, engineId),
    runHook: async ({ hookPath, step, cwd, env, timeoutSec }) => {
        try {
            const out = await $({ cwd, env: { ...process.env, ...env }, timeout: timeoutSec * 1000, nothrow: true })`bash ${hookPath} ${step}`
            return { code: out.exitCode ?? 0, stderr: String(out.stderr ?? '') }
        } catch (e: any) {
            const stderr = String(e?.stderr ?? e?.message ?? e)
            const code = typeof e?.exitCode === 'number' ? e.exitCode : 1
            return { code, stderr }
        }
    },
    download: downloadUrlToFile,
    broadcast: (msg) => { try { storeHandle.broadcast(msg as any) } catch { /* no peers */ } },
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
})

const localEngine = (store: Store, engineId?: string): string =>
    String(engineId ?? getLocalEngine(store)?.id ?? '')

// ── setupDemo ─────────────────────────────────────────────────────────────────

export const setupDemo = async (
    storeHandle: DocHandle<Store>,
    targetDiskId: string,
    apps: DemoAppName[] = [...DEMO_APP_NAMES],
    engineId?: string,
    deps: Partial<SetupDemoDeps> = {},
    opts: { explicitApps?: boolean } = {},
): Promise<{ code: 'DEMO_READY', apps: { app: DemoAppName, instanceId: string, name: string, port: number, source: string | null, packVersion: string | null }[], skipped: string }> => {
    const d: SetupDemoDeps = { ...defaultDeps(storeHandle), ...deps }
    const store = storeHandle.doc()
    const eng = localEngine(store, engineId)
    if (!apps.length) apps = [...DEMO_APP_NAMES]
    const explicitApps = opts.explicitApps === true

    // Refusals — no Operation yet
    const diskRes = lookupDiskArg(store, eng as any, targetDiskId)
    if (!diskRes.ok) {
        const notDocked = /not (currently )?docked/i.test(diskRes.message)
        throw new DemoError(notDocked ? 'NOT_DOCKED' : 'NOT_FOUND', diskRes.message.replace(/\.$/, ''))
    }
    const disk = diskRes.disk
    if (await isSystemDisk(disk) || (disk.diskTypes ?? []).includes('system')) {
        throw new DemoError('SYSTEM_DISK', `disk ${disk.id} is this Pi's system disk; setupDemo targets an App Disk only`)
    }
    const types = disk.diskTypes ?? []
    if (!types.includes('app')) {
        throw new DemoError('NOT_APP_DISK', `disk ${disk.id} is not an App Disk (diskTypes: ${types.join(', ') || 'none'})`)
    }

    // One demo set per Engine: all docked demos must live on this target disk.
    const dockedDemos = dockedDemoInstances(store, eng)
    const demoDisks = [...new Set(dockedDemos.map(i => String(i.storedOn)))]
    if (demoDisks.length >= 2) {
        throw new DemoError('DEMO_AMBIGUOUS', `demo instances are docked on more than one disk (${demoDisks.join(', ')}); removeDemo first`)
    }
    if (demoDisks.length === 1 && demoDisks[0] !== String(disk.id)) {
        throw new DemoError('DEMO_EXISTS', `a demo already runs on ${diskNameOf(store, demoDisks[0])}`)
    }
    for (const app of apps) {
        const demos = dockedDemoInstances(store, eng, app)
        if (demos.length >= 2) throw new DemoError('DEMO_AMBIGUOUS', `two or more ${app} demo instances are docked on this Engine`)
    }

    // Steve on PR #374: if the boot-time check has not run yet, run it on demand. Never proceed blind.
    if (isDemoAppsCapabilityOn() === null) {
        checkDemoAppsCapability(d.checkDemoApps)
    }
    if (isDemoAppsCapabilityOn() !== true) {
        throw new DemoError('HELPER_OUTDATED', 'python3 is not on PATH; setupDemo is not available on this Engine')
    }

    const lockKeys = [demoKey(eng), diskKey(String(disk.id))]
    for (const inst of dockedDemoInstances(store, eng)) {
        if (apps.some(a => appNameOfInstance(inst) === a)) lockKeys.push(instanceKey(String(inst.id)))
    }
    if (!resourceLock.acquireAll(lockKeys, 'setupDemo')) {
        throw new DemoError('BUSY', 'another setupDemo or removeDemo is running on this Engine, or the target disk or a demo instance is locked')
    }

    const online = await d.hasInternet()
    const roots = await dockedIdeaDemoRoots(store, eng, d.mountRoot)
    const plans: { app: DemoAppName, bundle: { disk: Disk, dir: string, appId: string, spec: AppDemoSpec } | null, local: LocatedPack | null, source: 'local' | 'github' | null }[] = []
    const skipped: DemoSkipped[] = []
    try {
        const skippedPre = skipped
        const noSourceOrSkip = (app: DemoAppName, detail: string): boolean => {
            if (explicitApps) throw new DemoError('NO_SOURCE', detail)
            skippedPre.push({ app, code: 'NO_SOURCE', detail })
            return true
        }
        for (const app of apps) {
            const bundle = await findDockedBundle(store, eng, app, d.mountRoot)
            const spec = bundle?.spec ?? null
            const minVersion = spec?.pack?.minVersion ?? 0
            const found: LocatedPack[] = []
            for (const dir of roots) found.push(...await scanIdeaDemoDir(dir, app, minVersion, spec?.pack ?? null))
            const local = pickBestLocalPack(found, spec?.pack ?? null)
            const outdatedLocal = !local && (await Promise.all(roots.map(dir => scanIdeaDemoDir(dir, app, 0, spec?.pack ?? null)))).flat().length > 0
            let source: 'local' | 'github' | null = null
            if (local) source = 'local'
            else if (online && spec?.pack?.url) source = 'github'
            else if (outdatedLocal && !online) throw new DemoError('PACK_OUTDATED', `the only local ${app} pack is older than minVersion ${minVersion} and this Engine is offline`)
            else if (!local && !(online && spec?.pack?.url)) {
                if (noSourceOrSkip(app, `no usable local pack or GitHub asset for ${app}, and ${online ? 'the app bundle has no pack pin' : 'no internet'}`)) continue
            }
            // A brand-new install also needs the app bundle on a docked disk (or a later GitHub install — not used for demo offline).
            const existing = dockedDemoInstances(store, eng, app).find(i => String(i.storedOn) === String(disk.id))
            if (!existing && !bundle) {
                if (noSourceOrSkip(app, `no ${app} app bundle is on a disk docked to this Engine (needed to install the demo)`)) continue
            }
            plans.push({ app, bundle, local, source })
        }
        if (!plans.length) {
            const detail = skippedPre.length
                ? skippedPre.map(s => s.detail).join('; ')
                : 'no demo app has a usable source'
            throw new DemoError('NO_SOURCE', detail)
        }
        let need = 0
        try {
            const parts = plans.map(p => ({
                packBytes: p.local ? 0 : (p.bundle?.spec.pack?.bytes ?? 0), // already-copied local pack is not downloaded again; still budget 2x if missing on instance
                reserveBytes: p.bundle?.spec.reserveBytes ?? 0,
            }))
            // Always budget 2 × declared pack bytes (or 0 if unknown) + reserve + 1 GB, per §2.
            need = spaceNeededBytes(plans.map(p => ({
                packBytes: p.bundle?.spec.pack?.bytes ?? (p.local ? 0 : 0),
                reserveBytes: p.bundle?.spec.reserveBytes ?? 0,
            })))
            void parts
            const root = await d.mountRoot(disk)
            const free = await d.availableBytes(root)
            if (free < need) throw new DemoError('NO_SPACE', `not enough free space on ${disk.id} (need ${need}, free ${free})`)
        } catch (e) {
            if (e instanceof DemoError) throw e
            log(`setupDemo: free-space check failed: ${(e as Error).message}`)
        }
    } catch (e) {
        resourceLock.releaseAll(lockKeys)
        throw e
    }

    const appsProgress: DemoAppProgress[] = plans.map(p => ({
        app: p.app,
        instanceId: dockedDemoInstances(store, eng, p.app).find(i => String(i.storedOn) === String(disk.id))?.id ?? null,
        steps: stepPlan(p.bundle?.spec ?? null).map(id => ({ id, status: 'pending' as DemoStepStatus })),
        source: p.source,
        packVersion: p.local ? String(p.local.packVersion) : (p.bundle?.spec.pack ? 'github' : null),
        code: null,
        detail: null,
    }))
    const args: Record<string, string> = { targetDiskId: String(disk.id), apps: apps.join(',') }
    const opId = createOperation(storeHandle, 'setupDemo', args, 'console-command', { type: 'engine', id: eng as EngineID })
    writeDemo(storeHandle, opId, { targetDiskId: String(disk.id), apps: appsProgress, skipped, code: null, resultText: null })
    updateOperation(storeHandle, opId, { status: 'Running', currentStep: 0, totalSteps: appsProgress.reduce((s, a) => s + a.steps.length, 0), stepLabel: 'Starting' } as any)

    const dock = dockIdentityOf(disk)
    const recheck = (step: string) => assertSameDockAfterWait(storeHandle.doc(), String(disk.id), dock, `setupDemo (${step})`)

    const fail = (code: DemoCode, text: string, app?: DemoAppName, step?: DemoStepId): never => {
        if (app && step) writeDemo(storeHandle, opId, { apps: setAppStep((storeHandle.doc().operationDB[opId] as any).demo.apps, app, step, 'failed', { code, detail: text }), code, resultText: `${code}: ${text}` })
        else writeDemo(storeHandle, opId, { code, resultText: `${code}: ${text}` })
        updateOperation(storeHandle, opId, { status: 'Failed', error: `${code}: ${text}`, completedAt: d.now() as Timestamp })
        throw new DemoError(code, text)
    }

    const resultApps: { app: DemoAppName, instanceId: string, name: string, port: number, source: string | null, packVersion: string | null }[] = []

    try {
        await trackInFlight(String(disk.id), 'setupDemo', (async () => {
            let stepIndex = 0
            for (const plan of plans) {
                const app = plan.app
                const spec = plan.bundle?.spec ?? null
                const bump = (id: DemoStepId, status: DemoStepStatus, extra?: Partial<DemoAppProgress> & { bytesTotal?: number | null }) => {
                    const cur = (storeHandle.doc().operationDB[opId] as any).demo as DemoProgress
                    writeDemo(storeHandle, opId, { apps: setAppStep(cur.apps, app, id, status, extra) })
                    if (status === 'running') {
                        stepIndex += 1
                        updateOperation(storeHandle, opId, { currentStep: stepIndex - 1, stepLabel: `${app}: ${id}` } as any)
                    }
                }

                // install
                bump('install', 'running')
                recheck('install')
                let inst = dockedDemoInstances(storeHandle.doc(), eng, app).find(i => String(i.storedOn) === String(disk.id))
                if (!inst) {
                    if (!plan.bundle) fail('NO_SOURCE', `no ${app} bundle on a docked disk`, app, 'install')
                    try {
                        const id = await d.install({
                            appId: plan.bundle!.appId,
                            targetDiskId: String(disk.id),
                            instanceName: spec?.name ?? DEMO_DISPLAY_NAME[app],
                            fresh: true, start: false, demo: true,
                            sourceDiskId: String(plan.bundle!.disk.id),
                        })
                        inst = storeHandle.doc().instanceDB[id] as Instance
                        if (!inst) fail('INSTALL_FAILED', `instance ${id} was not in the store after install`, app, 'install')
                    } catch (e) {
                        if (e instanceof DemoError) throw e
                        fail('INSTALL_FAILED', (e as Error).message, app, 'install')
                    }
                }
                const instanceId = String(inst!.id)
                {
                    const cur = (storeHandle.doc().operationDB[opId] as any).demo as DemoProgress
                    writeDemo(storeHandle, opId, { apps: cur.apps.map(a => a.app === app ? { ...a, instanceId } : a) })
                }
                bump('install', 'done')
                // If we skipped because it existed, mark done (already).
                const instDir = path.join(await d.mountRoot(disk), 'instances', instanceId)
                const appVersion = (() => { try { return String(parseAppId(String(inst!.instanceOf)).version) } catch { return undefined } })()

                // download
                bump('download', 'running')
                recheck('download')
                const minVersion = spec?.pack?.minVersion ?? 0
                let pack: PackJson | null = await existingPackIsValid(instDir, app, { minVersion, appVersion })
                let source = pack ? 'local' as const : plan.source
                const bytesTotalHint = spec?.pack?.bytes ?? 0
                const progress = (done: number, total: number) => {
                    d.broadcast({ type: DEMO_PROGRESS_TYPE, opId, step: 'download', bytesDone: done, bytesTotal: total || bytesTotalHint })
                }
                if (!pack) {
                    const packDir = instancePackDir(instDir)
                    const extractDir = instancePackRoot(instDir)
                    await fs.ensureDir(packDir)
                    try {
                        if (plan.local?.kind === 'dir') {
                            await fs.copy(plan.local.path, extractDir, { overwrite: true })
                            source = 'local'
                        } else if (plan.local?.kind === 'tar') {
                            const dest = path.join(packDir, path.basename(plan.local.path))
                            if (path.resolve(plan.local.path) !== path.resolve(dest)) await fs.copy(plan.local.path, dest, { overwrite: true })
                            if (plan.local.tarSha256) await verifyTarSha256(dest, plan.local.tarSha256)
                            await fs.emptyDir(extractDir)
                            await extractPackTar(dest, extractDir)
                            source = 'local'
                        } else if (plan.source === 'github' && spec?.pack) {
                            const destPart = path.join(packDir, `${spec.pack.file}.part`)
                            const dest = path.join(packDir, spec.pack.file)
                            try {
                                await d.download(spec.pack.url, destPart, progress)
                            } catch (e) {
                                fail('DOWNLOAD_FAILED', (e as Error).message, app, 'download')
                            }
                            await verifyTarSha256(destPart, spec.pack.sha256)
                            await fs.move(destPart, dest, { overwrite: true })
                            await fs.emptyDir(extractDir)
                            await extractPackTar(dest, extractDir)
                            source = 'github'
                        } else {
                            fail('NO_SOURCE', `no pack could be copied or downloaded for ${app}`, app, 'download')
                        }
                    } catch (e) {
                        if (e instanceof DemoError) throw e
                        if (e instanceof PackVerifyError) fail(e.code, e.message.replace(/^[A-Z0-9_]+: /, ''), app, e.code === 'PACK_OUTDATED' ? 'verify' : 'download')
                        fail('DOWNLOAD_FAILED', (e as Error).message, app, 'download')
                    }
                } else {
                    bump('download', 'skipped', { source, packVersion: String(pack.packVersion), bytesTotal: pack.bytes })
                }
                if (source) {
                    const cur = (storeHandle.doc().operationDB[opId] as any).demo as DemoProgress
                    writeDemo(storeHandle, opId, { apps: cur.apps.map(a => a.app === app ? { ...a, source } : a) })
                }
                if (!pack) bump('download', 'done', { source, bytesTotal: bytesTotalHint })

                // verify
                bump('verify', 'running')
                try {
                    pack = await verifyExtractedPack(instancePackRoot(instDir), app, { minVersion, appVersion })
                } catch (e) {
                    if (e instanceof PackVerifyError) fail(e.code, e.message.replace(/^[A-Z0-9_]+: /, ''), app, 'verify')
                    fail('CHECKSUM_MISMATCH', (e as Error).message, app, 'verify')
                }
                {
                    const cur = (storeHandle.doc().operationDB[opId] as any).demo as DemoProgress
                    writeDemo(storeHandle, opId, { apps: cur.apps.map(a => a.app === app ? { ...a, packVersion: String(pack!.packVersion) } : a) })
                }
                bump('verify', 'done', { packVersion: String(pack!.packVersion) })
                // A successful verify clears an outdated-pack warning
                storeHandle.change(doc => {
                    const i = doc.instanceDB[instanceId as InstanceID] as (Instance & { demoPackWarning?: DemoPackWarning | null }) | undefined
                    if (i && i.demoPackWarning) i.demoPackWarning = null
                })

                const hookEnv = (port: number): Record<string, string> => ({
                    IDEA_DEMO: '1',
                    IDEA_DEMO_INSTANCE_ID: instanceId,
                    IDEA_DEMO_INSTANCE_DIR: instDir,
                    IDEA_DEMO_DATA_DIR: app === 'kolibri' ? path.join(instDir, 'data', 'kolibri') : path.join(instDir, 'data'),
                    IDEA_DEMO_PACK_DIR: instancePackRoot(instDir),
                    IDEA_DEMO_PORT: String(port || ''),
                    IDEA_DEMO_COMPOSE_PROJECT: composeProjectFor(instanceId),
                })

                const runHookStep = async (stepId: DemoStepId, stepSpec: NonNullable<AppDemoSpec['steps']>[number]) => {
                    bump(stepId, 'running')
                    recheck(stepId)
                    if (!isDemoInstance(storeHandle.doc().instanceDB[instanceId as InstanceID] as Instance)) {
                        fail('NOT_DEMO', `refusing to run a demo hook on ${instanceId} (not a demo instance)`, app, stepId)
                    }
                    const hookRel = stepSpec.run.split(/\s+/)[0]
                    if (!hookRel || hookRel.startsWith('/') || hookRel.split('/').includes('..')) {
                        fail('HOOK_MISSING', `hook path '${hookRel}' is not a safe path in the app bundle`, app, stepId)
                    }
                    const hookPath = path.join(plan.bundle?.dir ?? path.join(await d.mountRoot(disk), 'apps', String(inst!.instanceOf)), hookRel)
                    if (!plan.bundle?.dir || !await fs.pathExists(hookPath)) fail('HOOK_MISSING', `bundle has no hook ${hookRel}`, app, stepId)
                    const live = storeHandle.doc().instanceDB[instanceId as InstanceID] as Instance
                    const hook = await d.runHook({
                        hookPath,
                        step: stepSpec.id,
                        cwd: instDir,
                        env: hookEnv(Number(live?.port ?? 0)),
                        timeoutSec: stepSpec.timeoutSec,
                    })
                    if (hook.code !== 0) {
                        const tail = String(hook.stderr || '').trim().split('\n').slice(-20).join('\n')
                        fail('HOOK_FAILED', `${stepId} exited ${hook.code}${tail ? `: ${tail}` : ''}`, app, stepId)
                    }
                    bump(stepId, 'done')
                }

                const startAndReady = async () => {
                    bump('start', 'running')
                    recheck('start')
                    const live = storeHandle.doc().instanceDB[instanceId as InstanceID] as Instance
                    try { await d.start(live, disk) } catch (e) {
                        fail('START_FAILED', (e as Error).message, app, 'start')
                    }
                    const after = storeHandle.doc().instanceDB[instanceId as InstanceID] as Instance
                    if (!after || after.status === 'Error') fail('START_FAILED', after?.statusCondition ?? 'instance record missing', app, 'start')
                    bump('start', 'done')
                    bump('ready', 'running')
                    // startInstance already waits for the listen port; a status other than Running is NOT_READY.
                    const ready = storeHandle.doc().instanceDB[instanceId as InstanceID] as Instance
                    if (ready.status !== 'Running' && ready.status !== 'Starting') {
                        fail('NOT_READY', `instance status is ${ready.status}${ready.statusCondition ? `: ${ready.statusCondition}` : ''}`, app, 'ready')
                    }
                    // Starting is accepted briefly: the caller of startInstance normally leaves it Running.
                    if (ready.status !== 'Running') fail('NOT_READY', `instance did not become Running (status ${ready.status})`, app, 'ready')
                    bump('ready', 'done')
                }

                let started = false
                const hooks = spec?.steps ?? []
                if (!spec || !hooks.length) fail('HOOK_MISSING', `app bundle for ${app} has no demo.steps`, app, 'verify')
                for (const hs of hooks) {
                    if (hs.needs === 'running' && !started) {
                        await startAndReady()
                        started = true
                    }
                    await runHookStep(hs.id as DemoStepId, hs)
                }
                if (!started) await startAndReady()

                const final = storeHandle.doc().instanceDB[instanceId as InstanceID] as Instance
                resultApps.push({
                    app,
                    instanceId,
                    name: String(final?.name ?? spec?.name ?? DEMO_DISPLAY_NAME[app]),
                    port: Number(final?.port ?? 0),
                    source,
                    packVersion: pack ? String(pack.packVersion) : null,
                })
            }
        })())
    } catch (e) {
        resourceLock.releaseAll(lockKeys)
        if (e instanceof DemoError) {
            if (!(storeHandle.doc().operationDB[opId] as any)?.error) {
                const msg = e.message
                const code = e.code
                writeDemo(storeHandle, opId, { code, resultText: msg })
                updateOperation(storeHandle, opId, { status: 'Failed', error: msg, completedAt: d.now() as Timestamp })
            }
            if (/DOCK_CHANGED|not docked/i.test(e.message) && e.code !== 'DOCK_CHANGED') {
                // assertSameDockAfterWait throws a plain Error
            }
            throw e
        }
        const text = (e as Error).message
        const code: DemoCode = /dock|DOCK_CHANGED/i.test(text) ? 'DOCK_CHANGED' : 'INSTALL_FAILED'
        writeDemo(storeHandle, opId, { code, resultText: `${code}: ${text}` })
        updateOperation(storeHandle, opId, { status: 'Failed', error: `${code}: ${text}`, completedAt: d.now() as Timestamp })
        throw new DemoError(code, text)
    }

    const skippedStr = skipped.map(s => `${s.app}:${s.code}`).join(',')
    const skipNote = skipped.length ? ` (skipped ${skipped.map(s => `${s.app}: ${s.code}`).join(', ')})` : ''
    const result = { code: 'DEMO_READY' as const, apps: resultApps, skipped: skippedStr }
    writeDemo(storeHandle, opId, { code: 'DEMO_READY', resultText: `DEMO_READY${skipNote}`, apps: ((storeHandle.doc().operationDB[opId] as any).demo as DemoProgress).apps.map(a => ({ ...a, code: a.code ?? 'DEMO_READY' })) })
    updateOperation(storeHandle, opId, { status: 'Done', completedAt: d.now() as Timestamp })
    attachTraceResult(result)
    resourceLock.releaseAll(lockKeys)
    return result
}

// ── removeDemo ────────────────────────────────────────────────────────────────

export const removeDemo = async (
    storeHandle: DocHandle<Store>,
    instanceIds: string[] = [],
    engineId?: string,
    deps: Partial<SetupDemoDeps> = {},
): Promise<{ code: 'DEMO_REMOVED', removed: { instanceId: string, quarantinePath: string, keptVolumes: string[] }[] }> => {
    const d: SetupDemoDeps = { ...defaultDeps(storeHandle), ...deps }
    const store = storeHandle.doc()
    const eng = localEngine(store, engineId)

    let targets: Instance[] = []
    if (!instanceIds.length) {
        targets = dockedDemoInstances(store, eng)
        if (!targets.length) throw new DemoError('NOT_FOUND', 'no demo instances are docked on this Engine')
    } else {
        for (const raw of instanceIds) {
            const found = lookupLocalInstanceArg(store, raw, eng)
            if (!found.ok) {
                if ((found as any).reason === 'not-local') throw new DemoError('NOT_LOCAL', `instance '${raw}' is not on this Engine`)
                throw new DemoError('NOT_FOUND', `instance '${raw}' is not on this Engine`)
            }
            const inst = found.instance
            if (!isDemoInstance(inst)) throw new DemoError('NOT_DEMO', `instance ${inst.id} ('${inst.name}') is not a demo instance; nothing was changed`)
            targets.push(inst)
        }
    }

    const lockKeys = [demoKey(eng), ...targets.map(t => instanceKey(String(t.id)))]
    if (!resourceLock.acquireAll(lockKeys, 'removeDemo')) {
        throw new DemoError('BUSY', 'another setupDemo or removeDemo is running on this Engine, or a demo instance is locked')
    }

    const args: Record<string, string> = { instanceIds: instanceIds.join(',') }
    const opId = createOperation(storeHandle, 'removeDemo', args, 'console-command', { type: 'engine', id: eng as EngineID })
    const appsProgress: DemoAppProgress[] = targets.map(t => ({
        app: (isDemoAppName(appNameOfInstance(t)) ? appNameOfInstance(t) : 'kolibri') as DemoAppName,
        instanceId: String(t.id),
        steps: [{ id: 'stop' as const, status: 'pending' as const }, { id: 'remove' as const, status: 'pending' as const }],
        source: null,
        packVersion: null,
        code: null,
        detail: null,
    }) )
    writeDemo(storeHandle, opId, { targetDiskId: null, apps: appsProgress, skipped: [], code: null, resultText: null })
    updateOperation(storeHandle, opId, { status: 'Running', currentStep: 0, totalSteps: targets.length * 2, stepLabel: 'Removing' } as any)

    const removed: { instanceId: string, quarantinePath: string, keptVolumes: string[] }[] = []
    const failures: string[] = []
    try {
        let step = 0
        for (const inst of targets) {
            const app = (isDemoAppName(appNameOfInstance(inst)) ? appNameOfInstance(inst) : 'kolibri') as DemoAppName
            const disk = inst.storedOn ? getDisk(storeHandle.doc(), inst.storedOn) as Disk : undefined
            const bump = (id: DemoStepId, status: DemoStepStatus, extra?: Partial<DemoAppProgress> & { bytesTotal?: number | null }) => {
                const cur = (storeHandle.doc().operationDB[opId] as any).demo as DemoProgress
                writeDemo(storeHandle, opId, { apps: setAppStep(cur.apps, app, id, status, extra) })
            }
            bump('stop', 'running')
            updateOperation(storeHandle, opId, { currentStep: step++, stepLabel: `stop ${inst.name}` } as any)
            if (disk && (inst.status === 'Running' || inst.status === 'Starting')) {
                try { await d.stop(inst, disk) } catch (e) {
                    const text = (e as Error).message
                    bump('stop', 'failed', { code: 'REMOVE_FAILED', detail: text })
                    failures.push(`${inst.id}: stop failed: ${text}`)
                    continue
                }
            }
            bump('stop', 'done')
            bump('remove', 'running')
            updateOperation(storeHandle, opId, { currentStep: step++, stepLabel: `remove ${inst.name}` } as any)
            try {
                const r = await d.remove(String(inst.id), eng)
                removed.push({ instanceId: String(r.instanceId), quarantinePath: r.quarantinePath, keptVolumes: r.keptVolumes ?? [] })
                bump('remove', 'done')
            } catch (e) {
                const text = (e as Error).message
                // Pass through the inner removeInstance code in the text.
                bump('remove', 'failed', { code: 'REMOVE_FAILED', detail: text })
                failures.push(`${inst.id}: ${text}`)
            }
        }
    } finally {
        resourceLock.releaseAll(lockKeys)
    }

    if (failures.length) {
        const text = failures.join('; ')
        writeDemo(storeHandle, opId, { code: 'REMOVE_FAILED', resultText: `REMOVE_FAILED: ${text}` })
        updateOperation(storeHandle, opId, { status: 'Failed', error: `REMOVE_FAILED: ${text}`, completedAt: d.now() as Timestamp })
        throw new DemoError('REMOVE_FAILED', text, { code: 'REMOVE_FAILED', removed, failures })
    }
    const result = { code: 'DEMO_REMOVED' as const, removed }
    writeDemo(storeHandle, opId, { code: 'DEMO_REMOVED', resultText: 'DEMO_REMOVED' })
    updateOperation(storeHandle, opId, { status: 'Done', completedAt: d.now() as Timestamp })
    attachTraceResult(result)
    return result
}

/** apply INTERRUPTED to a setupDemo/removeDemo Operation (called from recoverInterruptedOperations). */
export const markDemoInterrupted = (storeHandle: DocHandle<Store>, opId: string, message = 'INTERRUPTED: Engine restarted while operation was in progress — re-issue manually'): void => {
    storeHandle.change(doc => {
        const op = doc.operationDB?.[opId] as (typeof doc.operationDB[string] & { demo?: DemoProgress }) | undefined
        if (!op?.demo) return
        op.demo.code = 'INTERRUPTED'
        op.demo.resultText = message
        for (const a of op.demo.apps) {
            if (a.steps.some(s => s.status === 'running')) {
                a.code = 'INTERRUPTED'
                for (const s of a.steps) {
                    if (s.status === 'running') s.status = 'failed'
                }
            }
        }
    })
}

