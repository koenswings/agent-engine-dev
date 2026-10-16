/**
 * dockerMetricsMonitor.ts
 *
 * Polls `docker stats --no-stream --format json` every POLL_INTERVAL_MS for
 * all containers belonging to Running instances on the local engine, then
 * broadcasts them as an ephemeral 'idea/metrics' message on the store handle
 * (never stored; store design 2026-10-13). Stored instance.metrics left by
 * older Engines is cleared once.
 *
 * The Console (src/store/live.ts) keeps the latest message per Engine and
 * formats the raw numbers itself.
 */

import { $ } from 'zx'
import { log } from '../utils/utils.js'
import { DocHandle } from '@automerge/automerge-repo'
import { Store, getLocalEngine, getInstancesOfEngine } from '../data/Store.js'
import { METRICS_TYPE } from '../data/Liveness.js'
import { DockerMetrics } from '../data/CommonTypes.js'
import { localEngineId } from '../data/Engine.js'
import { dockerAvailable } from '../utils/dockerAvailable.js'
import { resourceLock, instanceKey } from '../utils/ResourceLock.js'

$.verbose = false

const POLL_INTERVAL_MS = 15_000

// ── Byte-string parser ────────────────────────────────────────────────────────
// docker stats JSON emits strings like "256MiB", "1.5GiB", "1.23kB", "10MB"

const UNIT_MULTIPLIERS: Record<string, number> = {
    b:   1,
    kb:  1000,
    mb:  1000 ** 2,
    gb:  1000 ** 3,
    tb:  1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
}

const parseBytes = (raw: string): number | null => {
    if (!raw) return null
    const m = raw.trim().match(/^([\d.]+)\s*([a-zA-Z]+)$/)
    if (!m) return null
    const value = parseFloat(m[1])
    const unit = m[2].toLowerCase()
    const mult = UNIT_MULTIPLIERS[unit]
    if (mult === undefined || isNaN(value)) return null
    return Math.round(value * mult)
}

const parsePercent = (raw: string): number | null => {
    if (!raw) return null
    const m = raw.trim().match(/^([\d.]+)\s*%$/)
    if (!m) return null
    const v = parseFloat(m[1])
    return isNaN(v) ? null : v
}

// ── docker stats output shape ─────────────────────────────────────────────────
// `docker stats --no-stream --format json` outputs one JSON object per line.
// Fields (from Docker docs): Container, Name, CPUPerc, MemUsage, MemPerc,
// NetIO, BlockIO, PIDs.

interface RawDockerStats {
    Container?: string
    Name?: string
    CPUPerc?: string
    MemUsage?: string    // e.g. "256MiB / 1GiB"
    MemPerc?: string
    NetIO?: string       // e.g. "1.23kB / 456B"
    BlockIO?: string     // e.g. "10MB / 5MB"
}

const parseStatsLine = (line: string): { name: string; metrics: DockerMetrics } | null => {
    let raw: RawDockerStats
    try {
        raw = JSON.parse(line)
    } catch {
        return null
    }

    const name = raw.Name ?? raw.Container ?? ''
    if (!name) return null

    // MemUsage: "256MiB / 1GiB"
    const [memUsageStr, memLimitStr] = (raw.MemUsage ?? '').split('/').map(s => s.trim())

    // NetIO: "1.23kB / 456B"
    const [netRxStr, netTxStr] = (raw.NetIO ?? '').split('/').map(s => s.trim())

    // BlockIO: "10MB / 5MB"
    const [blockReadStr, blockWriteStr] = (raw.BlockIO ?? '').split('/').map(s => s.trim())

    const metrics: DockerMetrics = {
        cpuPercent:     parsePercent(raw.CPUPerc ?? ''),
        memUsageBytes:  parseBytes(memUsageStr ?? ''),
        memLimitBytes:  parseBytes(memLimitStr ?? ''),
        memPercent:     parsePercent(raw.MemPerc ?? ''),
        netRxBytes:     parseBytes(netRxStr ?? ''),
        netTxBytes:     parseBytes(netTxStr ?? ''),
        blockReadBytes: parseBytes(blockReadStr ?? ''),
        blockWriteBytes:parseBytes(blockWriteStr ?? ''),
        sampledAt:      Date.now(),
    }

    return { name, metrics }
}

// ── Collect metrics for a set of instance IDs ─────────────────────────────────

const collectMetrics = async (
    instanceIds: string[]
): Promise<{ metrics: Map<string, DockerMetrics>, runningContainers: string[] | null }> => {
    // docker stats container names follow the pattern: <instanceId>-<service>-1
    // We filter containers by name prefix matching any of the instance IDs.
    const result = new Map<string, DockerMetrics>()
    // null = docker ps did not answer: never conclude anything about container state
    let runningContainers: string[] | null = null
    if (instanceIds.length === 0) return { metrics: result, runningContainers: [] }

    try {
        // docker stats does not support --filter; resolve container names via docker ps first
        const filterArgs = instanceIds.flatMap(id => ['--filter', `name=${id}`])
        const psProc = await $`docker ps --format {{.Names}} ${filterArgs}`
        const containerNames = psProc.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        runningContainers = containerNames
        if (containerNames.length === 0) return { metrics: result, runningContainers }
        const proc = await $`docker stats --no-stream --format json ${containerNames}`
        const lines = proc.stdout.split('\n').filter(l => l.trim())

        for (const line of lines) {
            const parsed = parseStatsLine(line)
            if (!parsed) continue
            // Map container name back to instance ID
            const instanceId = instanceIds.find(id => parsed.name.startsWith(id))
            if (!instanceId) continue
            // Merge: if multiple containers belong to the same instance, accumulate
            const existing = result.get(instanceId)
            if (!existing) {
                result.set(instanceId, parsed.metrics)
            } else {
                // Sum CPU and net/block across containers; use latest sampledAt
                existing.cpuPercent     = (existing.cpuPercent    ?? 0) + (parsed.metrics.cpuPercent    ?? 0)
                existing.memUsageBytes  = (existing.memUsageBytes ?? 0) + (parsed.metrics.memUsageBytes ?? 0)
                existing.netRxBytes     = (existing.netRxBytes    ?? 0) + (parsed.metrics.netRxBytes    ?? 0)
                existing.netTxBytes     = (existing.netTxBytes    ?? 0) + (parsed.metrics.netTxBytes    ?? 0)
                existing.blockReadBytes = (existing.blockReadBytes ?? 0) + (parsed.metrics.blockReadBytes ?? 0)
                existing.blockWriteBytes= (existing.blockWriteBytes ?? 0) + (parsed.metrics.blockWriteBytes ?? 0)
                existing.sampledAt      = Date.now()
            }
        }
    } catch (e: any) {
        log(`[dockerMetrics] docker stats error: ${e.message ?? e}`)
    }

    return { metrics: result, runningContainers }
}

// ── Containers stopped outside the Engine ─────────────────────────────────────
// A `docker compose stop` (or a crash) done outside the Engine leaves the store at
// Running. Each poll already lists the running containers of Running instances, so
// a Running instance with no running container on EXTERNAL_STOP_MISSES consecutive
// polls is set to Docked: present, not running, NOT an operator stop (Stopped stays
// reserved for stops through the Engine), so auto-start rules that act on
// Docked/Error apply again. Skipped while the Engine holds the instance's lock
// (its own start/stop/remount) and within EXTERNAL_STOP_GRACE_MS of lastStarted.

export const EXTERNAL_STOP_MISSES = 2
export const EXTERNAL_STOP_GRACE_MS = 60_000
const externalStopMisses = new Map<string, number>()
/** Tests only. */
export const resetExternalStopTrackingForTests = (): void => { externalStopMisses.clear() }

/** Instance ids to mark Docked now; updates the miss counters. */
export const detectExternalStops = (
    instances: { id: string, status: string, lastStarted?: number | null }[],
    runningContainers: string[] | null,
    isLocked: (instanceId: string) => boolean,
    now: number = Date.now(),
): string[] => {
    if (runningContainers === null) return []
    const stopped: string[] = []
    const seen = new Set<string>()
    for (const inst of instances) {
        if (inst.status !== 'Running') continue
        seen.add(inst.id)
        const hasContainer = runningContainers.some(n => n.startsWith(inst.id))
        if (hasContainer || isLocked(inst.id) || now - (inst.lastStarted ?? 0) < EXTERNAL_STOP_GRACE_MS) {
            externalStopMisses.delete(inst.id)
            continue
        }
        const misses = (externalStopMisses.get(inst.id) ?? 0) + 1
        externalStopMisses.set(inst.id, misses)
        if (misses >= EXTERNAL_STOP_MISSES) {
            externalStopMisses.delete(inst.id)
            stopped.push(inst.id)
        }
    }
    for (const id of [...externalStopMisses.keys()]) if (!seen.has(id)) externalStopMisses.delete(id)
    return stopped
}

// ── Main monitor loop ─────────────────────────────────────────────────────────

export const pollDockerMetricsOnce = async (storeHandle: DocHandle<Store>): Promise<void> => {
    if (!(await dockerAvailable())) return  // no Docker daemon (was: testMode; idea#168)

    const store = storeHandle.doc()
    const localEngine = getLocalEngine(store)
    if (!localEngine) return

    const allInstances = getInstancesOfEngine(store, localEngine)
    const runningInstances = allInstances.filter(i => i.status === 'Running')
    const runningIds = runningInstances.map(i => i.id as string)

    // Collect live metrics for running containers
    const { metrics: metricsMap, runningContainers } = await collectMetrics(runningIds)
    const externallyStopped = new Set(detectExternalStops(
        runningInstances as any, runningContainers, id => resourceLock.isLocked(instanceKey(id))))

    // Store design 2026-10-13: metrics are NOT written into the store doc any more
    // (9.8k changes/day kept forever). They go out as an ephemeral message that the
    // Engines relay to every peer of the store doc, so a Console on any Pi shows the
    // latest metrics of every Pi (agent-console-dev src/store/live.ts).
    const instances: Record<string, DockerMetrics> = {}
    for (const [id, m] of metricsMap) instances[id] = m
    storeHandle.broadcast(metricsMessage(String(localEngine.id), Date.now(), instances))

    // One-time cleanup: stored metrics left by older Engines are cleared (only
    // writes when something is still there). An instance stopped outside the
    // Engine (#208: no container on EXTERNAL_STOP_MISSES polls) goes Running → Docked.
    const doc0 = storeHandle.doc() as any
    const leftovers = allInstances.filter(i => doc0?.instanceDB?.[i.id as any]?.metrics != null)
    const stopped = allInstances.filter(i => externallyStopped.has(i.id as string) && doc0?.instanceDB?.[i.id as any]?.status === 'Running')
    if (leftovers.length || stopped.length) storeHandle.change(doc => {
        for (const inst of stopped) {
            const instanceInDoc = doc.instanceDB[inst.id as any]
            if (!instanceInDoc || instanceInDoc.status !== 'Running') continue
            log(`[dockerMetrics] Instance ${inst.id}: no running container on ${EXTERNAL_STOP_MISSES} polls (stopped outside the Engine) — status Running → Docked`)
            instanceInDoc.status = 'Docked' as any
        }
        for (const inst of leftovers) {
            const instanceInDoc = doc.instanceDB[inst.id as any]
            if (instanceInDoc && instanceInDoc.metrics != null) instanceInDoc.metrics = null
        }
    })
}

export interface MetricsMessage { type: typeof METRICS_TYPE, v: 1, engineId: string, sampledAt: number, instances: Record<string, DockerMetrics> }

/** The ephemeral metrics message (Running instances only). */
export const metricsMessage = (engineId: string, sampledAt: number, instances: Record<string, DockerMetrics>): MetricsMessage =>
    ({ type: METRICS_TYPE, v: 1, engineId, sampledAt, instances })

export const enableDockerMetricsMonitor = (storeHandle: DocHandle<Store>): void => {
    log('[dockerMetrics] Starting Docker metrics monitor')

    const run = async () => {
        try {
            await pollDockerMetricsOnce(storeHandle)
        } catch (e: any) {
            log(`[dockerMetrics] Unhandled error in poll: ${e.message ?? e}`)
        }
        setTimeout(run, POLL_INTERVAL_MS)
    }

    // First poll after a short delay (give instances time to start on engine boot)
    setTimeout(run, 5_000)
}
