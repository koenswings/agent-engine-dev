/**
 * UpdateFetch.ts — cross-Engine Fetch for updateApp (agent-engine-dev#263, builds on #230).
 *
 * Push model, no gate or helper change: the instance's Engine (target) asks the Engine where
 * the source disk is docked (`pushAppBundle`, sent with sendCommand) to push apps/<appId>/ with
 * rsyncToPeer through the existing receive-app path into <target disk>/apps/<appId>/. The source
 * answers with `appFetchResult <requestId> ok|TRANSFER_FAILED <why>`.
 *
 *  - Before the push the target writes apps/<appId>/.idea-fetching (the request id). Dock and the
 *    app listing ignore such a folder until apps/<appId>/.idea-fetched exists.
 *  - After the push the target refuses any other bundle-root `.idea-*` entry (pushed by the
 *    source), re-checks SHA256SUMS in full, then renames .idea-fetching to .idea-fetched.
 *  - Failure: TRANSFER_FAILED; the partial folder is moved aside (apps/.idea-aborted-<appId>-<stamp>,
 *    same filesystem, never removed).
 *  - Source: rsync --partial, 3 retries with backoff; a thermal pause at 75 °C (resumes at 65 °C)
 *    stops the rsync (the --partial resume continues it) and is reported as
 *    idea/updateProgress `fetchPaused {reason, bytesDone, bytesTotal, since}`.
 */
import { DocHandle } from '@automerge/automerge-repo'
import { fs, path } from 'zx'
import type { Store } from './Store.js'
import type { Command, EngineID } from './CommonTypes.js'
import { Disk, diskMountRoot, appDataRoot } from './Disk.js'
import { log, uuid } from '../utils/utils.js'
import { UpdateAppError } from './UpdateAppPolicy.js'
import type { UpdateProgress, FetchPaused } from './UpdateApp.js'

const UPDATE_PROGRESS_TYPE = 'idea/updateProgress' as const   // = UpdateApp.UPDATE_PROGRESS_TYPE (no import cycle)
import type { PeerEngine } from '../utils/rsync.js'
import { killRegisteredProcess } from './Operations.js'

export const FETCHING_MARKER = '.idea-fetching'
export const FETCHED_MARKER = '.idea-fetched'
export const FETCH_RETRIES = 3
export const FETCH_BACKOFF_MS = [5_000, 20_000, 60_000]
export const THERMAL_PAUSE_C = 75
export const THERMAL_RESUME_C = 65
export const THERMAL_POLL_MS = 10_000
/** No answer from the source Engine within this time: TRANSFER_FAILED. */
export const FETCH_TIMEOUT_MS = 6 * 60 * 60 * 1000
/** App ids and request tokens accepted for a cross-Engine Fetch; rejects `+`, so dev bundles `0.0-dev+<sha12>` never travel (agent-app-dev#36). */
export const RE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** True when apps/<appId>/ is a Fetch still in progress (or aborted): dock and listing skip it. */
export const isUnfinishedFetch = async (bundleDir: string): Promise<boolean> =>
    await fs.pathExists(path.join(bundleDir, FETCHING_MARKER)) && !await fs.pathExists(path.join(bundleDir, FETCHED_MARKER))

// ── Target side ─────────────────────────────────────────────────────────────

type FetchAnswer = { ok: true } | { ok: false, why: string }
const pending = new Map<string, (a: FetchAnswer) => void>()

/** `appFetchResult <requestId> ok|TRANSFER_FAILED <why…>` from the source Engine. */
export const handleAppFetchResult = (requestId: string, status: string, why: string[] = []): boolean => {
    const resolve = pending.get(requestId)
    if (!resolve) { log(`appFetchResult: no Fetch waits for request ${requestId}`); return false }
    pending.delete(requestId)
    resolve(status === 'ok' ? { ok: true } : { ok: false, why: why.join(' ') || status })
    return true
}

export interface FetchTargetDeps {
    mountRoot: (disk: Disk) => Promise<string>
    rootToken: (disk: Disk) => Promise<string>
    send: (engineId: EngineID, command: string) => void
    verifySums: (dir: string) => Promise<boolean>
    newId: () => string
    now: () => number
    timeoutMs: number
}

export interface FetchRequest {
    localEngineId: string; instanceId: string; newAppId: string
    sourceDisk: Disk; targetDisk: Disk
}

const stamp = (now: number) => new Date(now).toISOString().replace(/[-:.]/g, '')

/** Move a partial Fetch aside on the same filesystem (never removed). Returns the new path. */
export const setFetchAside = async (bundleDir: string, now: number): Promise<string> => {
    const aside = path.join(path.dirname(bundleDir), `.idea-aborted-${path.basename(bundleDir)}-${stamp(now)}`)
    await fs.rename(bundleDir, aside)
    log(`updateApp Fetch: partial ${bundleDir} moved aside to ${aside}`)
    return aside
}

/** Bundle-root `.idea-*` entries the source pushed (anything but our own .idea-fetching). */
export const pushedIdeaEntries = async (bundleDir: string): Promise<string[]> =>
    (await fs.readdir(bundleDir)).filter(n => n.startsWith('.idea-') && n !== FETCHING_MARKER)

/**
 * Fetch apps/<newAppId>/ from the source disk (docked to another Engine) onto the instance's
 * disk. Resolves with the local bundle folder (marker .idea-fetched written) or throws
 * TRANSFER_FAILED. A folder that already carries .idea-fetched and passes SHA256SUMS is reused.
 */
export const fetchBundle = async (req: FetchRequest, d: FetchTargetDeps): Promise<string> => {
    const sourceEngine = String(req.sourceDisk.dockedTo ?? '')
    if (!sourceEngine || !req.sourceDisk.device) throw new UpdateAppError('SOURCE_MISSING', `source disk ${req.sourceDisk.id} is not docked to any Engine`)
    for (const t of [req.newAppId, String(req.sourceDisk.id), req.localEngineId, String(req.targetDisk.id), req.instanceId]) {
        if (!RE_TOKEN.test(t)) throw new UpdateAppError('TRANSFER_FAILED', `cannot ask for a Fetch with the token '${t}'`)
    }
    const root = await d.mountRoot(req.targetDisk)
    const dir = path.join(root, 'apps', req.newAppId)
    if (await fs.pathExists(dir)) {
        if (await fs.pathExists(path.join(dir, FETCHED_MARKER)) && await d.verifySums(dir)) return dir
        if (await fs.pathExists(path.join(dir, FETCHING_MARKER))) await setFetchAside(dir, d.now())
        else throw new UpdateAppError('TRANSFER_FAILED', `${dir} exists and is not a finished Fetch; not overwriting it`)
    }
    const requestId = d.newId()
    await fs.ensureDir(dir)
    await fs.writeFile(path.join(dir, FETCHING_MARKER), `${requestId}\n`)
    const answer = new Promise<FetchAnswer>((resolve) => {
        pending.set(requestId, resolve)
        const t = setTimeout(() => { if (pending.delete(requestId)) resolve({ ok: false, why: `no answer from Engine ${sourceEngine} within ${Math.round(d.timeoutMs / 60000)} min` }) }, d.timeoutMs)
        ;(t as any).unref?.()
    })
    const token = await d.rootToken(req.targetDisk)
    log(`updateApp Fetch: asking Engine ${sourceEngine} to push ${req.newAppId} from ${req.sourceDisk.id} (request ${requestId})`)
    d.send(sourceEngine as EngineID, `pushAppBundle ${req.sourceDisk.id} ${req.newAppId} ${req.localEngineId} ${token} ${requestId} ${req.instanceId}`)
    const a = await answer
    const fail = async (why: string): Promise<never> => {
        const aside = await setFetchAside(dir, d.now()).catch(() => null)
        throw new UpdateAppError('TRANSFER_FAILED', `${why}${aside ? `; the partial folder was moved aside to ${aside}` : ''}`)
    }
    if (!a.ok) return fail(a.why)
    const pushed = await pushedIdeaEntries(dir)
    if (pushed.length) return fail(`the source pushed bundle-root ${pushed.join(', ')}; refused`)
    const marker = (await fs.readFile(path.join(dir, FETCHING_MARKER), 'utf8').catch(() => '')).trim()
    if (marker !== requestId) return fail(`${FETCHING_MARKER} was changed by the transfer; refused`)
    if (!await d.verifySums(dir)) return fail('the fetched bundle does not match its SHA256SUMS')
    await fs.rename(path.join(dir, FETCHING_MARKER), path.join(dir, FETCHED_MARKER))   // one atomic step
    log(`updateApp Fetch: ${dir} fetched and verified`)
    return dir
}

export const defaultFetchTargetDeps = (storeHandle: DocHandle<Store>, verifySums: (dir: string) => Promise<boolean>): FetchTargetDeps => ({
    mountRoot: (disk) => diskMountRoot(disk),
    rootToken: (disk) => appDataRoot(disk),
    send: (engineId, command) => { void import('../utils/commandUtils.js').then(m => m.sendCommand(storeHandle, engineId, command as Command)) },
    verifySums,
    newId: () => uuid(),
    now: () => Date.now(),
    timeoutMs: FETCH_TIMEOUT_MS,
})

// ── Source side ─────────────────────────────────────────────────────────────

export interface PushDeps {
    mountRoot: (disk: Disk) => Promise<string>
    address: (engineId: string) => Promise<string | undefined>
    push: (src: string, peer: PeerEngine, helperArgs: string[], onProgress: (p: { progressPercent: number }) => void, opId: string) => Promise<void>
    stop: (opId: string) => boolean
    dirBytes: (dir: string) => Promise<number>
    temperatureC: () => Promise<number | null>
    reply: (engineId: EngineID, command: string) => void
    broadcast: (msg: UpdateProgress) => void
    now: () => number
    sleep: (ms: number) => Promise<void>
    backoffMs: number[]
    thermalPollMs: number
}

export interface PushRequest { sourceDiskId: string; appId: string; targetEngineId: string; targetRoot: string; requestId: string; instanceId: string }

/** Read /sys/class/thermal/thermal_zone0/temp (millidegrees); null when there is none. */
export const readCpuTemperatureC = async (): Promise<number | null> => {
    try { const v = Number((await fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8')).trim()); return Number.isFinite(v) ? v / 1000 : null } catch { return null }
}

/** Push apps/<appId>/ to the target Engine and answer it. Never throws; the answer carries the outcome. */
export const pushAppBundle = async (store: Store, localEngineId: string, req: PushRequest, d: PushDeps): Promise<FetchAnswer> => {
    const answer = (a: FetchAnswer): FetchAnswer => {
        d.reply(req.targetEngineId as EngineID, a.ok ? `appFetchResult ${req.requestId} ok` : `appFetchResult ${req.requestId} TRANSFER_FAILED ${a.why.replace(/\s+/g, ' ')}`)
        return a
    }
    const disk = store.diskDB?.[req.sourceDiskId as any] as Disk | undefined
    if (!disk || String(disk.dockedTo) !== localEngineId || !disk.device) return answer({ ok: false, why: `source disk ${req.sourceDiskId} is not docked to Engine ${localEngineId}` })
    const src = path.join(await d.mountRoot(disk), 'apps', req.appId)
    if (!await fs.pathExists(path.join(src, 'compose.yaml')) || !await fs.pathExists(path.join(src, 'SHA256SUMS'))) return answer({ ok: false, why: `${req.appId} on ${req.sourceDiskId} has no compose.yaml or SHA256SUMS` })
    if ((await fs.readdir(src)).some(n => n.startsWith('.idea-'))) return answer({ ok: false, why: `${src} holds bundle-root .idea-* files; not pushing them` })
    const host = await d.address(req.targetEngineId)
    if (!host) return answer({ ok: false, why: `Engine ${req.targetEngineId} is not connected` })
    const peer: PeerEngine = { host, engineId: req.targetEngineId }
    const bytesTotal = await d.dirBytes(src).catch(() => 0)
    let bytesDone = 0
    const progress = (fetchPaused?: FetchPaused) => d.broadcast({ type: UPDATE_PROGRESS_TYPE, engineId: req.targetEngineId, instanceId: req.instanceId, step: 'Fetch', bytesDone, bytesTotal, ...(fetchPaused ? { fetchPaused } : {}) })
    const hot = async () => { const t = await d.temperatureC(); return t !== null && t >= THERMAL_PAUSE_C }
    const coolDown = async () => {
        const since = d.now()
        log(`pushAppBundle: thermal pause (>= ${THERMAL_PAUSE_C} °C) for ${req.appId} -> ${req.targetEngineId}`)
        for (;;) {
            progress({ reason: 'thermal', bytesDone, bytesTotal, since })
            const t = await d.temperatureC()
            if (t === null || t <= THERMAL_RESUME_C) break
            await d.sleep(d.thermalPollMs)
        }
        log(`pushAppBundle: resumed after ${Math.round((d.now() - since) / 1000)} s`)
    }
    const opId = `fetch-${req.requestId}`
    let lastErr = ''
    for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
        if (attempt > 0) await d.sleep(d.backoffMs[Math.min(attempt - 1, d.backoffMs.length - 1)])
        if (await hot()) await coolDown()
        let pausedHot = false
        let watching = true
        const watcher = (async () => {
            while (watching) {
                await d.sleep(d.thermalPollMs)
                if (watching && await hot()) { pausedHot = true; d.stop(opId); return }
            }
        })()
        try {
            await d.push(src.replace(/\/*$/, '/'), peer, ['receive-app', req.targetRoot, req.appId], ({ progressPercent }) => {
                bytesDone = Math.round(bytesTotal * progressPercent / 100); progress()
            }, opId)
            watching = false
            bytesDone = bytesTotal; progress()
            return answer({ ok: true })
        } catch (e) {
            watching = false
            lastErr = String((e as Error).message)
            if (pausedHot) { await coolDown(); attempt-- ; continue }   // a thermal pause is not a failed try
            log(`pushAppBundle: try ${attempt + 1} of ${FETCH_RETRIES + 1} failed: ${lastErr}`)
        }
        await watcher.catch(() => undefined)
    }
    return answer({ ok: false, why: `rsync failed after ${FETCH_RETRIES} retries: ${lastErr}` })
}

export const defaultPushDeps = (storeHandle: DocHandle<Store>): PushDeps => ({
    mountRoot: (disk) => diskMountRoot(disk),
    address: async (engineId) => (await import('./Network.js')).getEngineAddress(engineId as EngineID),
    push: async (src, peer, args, onProgress, opId) => (await import('../utils/rsync.js')).rsyncToPeer(src, peer, args, onProgress, opId, ['--partial']),
    stop: (opId) => killRegisteredProcess(opId),
    dirBytes: async (dir) => (await import('./CopyMoveApp.js')).directoryBytes(dir),
    temperatureC: readCpuTemperatureC,
    reply: (engineId, command) => { void import('../utils/commandUtils.js').then(m => m.sendCommand(storeHandle, engineId, command as Command)) },
    broadcast: (msg) => { try { storeHandle.broadcast(msg) } catch { /* no peers */ } },
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    backoffMs: FETCH_BACKOFF_MS,
    thermalPollMs: THERMAL_POLL_MS,
})
