/**
 * dockerMetricsMonitor.ts
 *
 * Polls `docker stats --no-stream --format json` every POLL_INTERVAL_MS for
 * all containers belonging to Running instances on the local engine, then
 * writes parsed metrics to instance.metrics in the Automerge store.
 *
 * When an instance stops running (status !== 'Running'), metrics is set to null.
 *
 * The Console reads instance.metrics and formats the raw numbers itself.
 */

import { $ } from 'zx'
import { log } from '../utils/utils.js'
import { DocHandle } from '@automerge/automerge-repo'
import { Store, getLocalEngine, getInstancesOfEngine } from '../data/Store.js'
import { DockerMetrics } from '../data/CommonTypes.js'
import { localEngineId } from '../data/Engine.js'
import { config } from '../data/Config.js'

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
): Promise<Map<string, DockerMetrics>> => {
    // docker stats container names follow the pattern: <instanceId>-<service>-1
    // We filter containers by name prefix matching any of the instance IDs.
    const result = new Map<string, DockerMetrics>()
    if (instanceIds.length === 0) return result

    try {
        // docker stats does not support --filter; resolve container names via docker ps first
        const filterArgs = instanceIds.flatMap(id => ['--filter', `name=${id}`])
        const psProc = await $`docker ps --format {{.Names}} ${filterArgs}`
        const containerNames = psProc.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        if (containerNames.length === 0) return result
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

    return result
}

// ── Main monitor loop ─────────────────────────────────────────────────────────

const poll = async (storeHandle: DocHandle<Store>): Promise<void> => {
    if (config.settings.testMode) return  // no Docker in test mode

    const store = storeHandle.doc()
    const localEngine = getLocalEngine(store)
    if (!localEngine) return

    const allInstances = getInstancesOfEngine(store, localEngine)
    const runningInstances = allInstances.filter(i => i.status === 'Running')
    const runningIds = runningInstances.map(i => i.id as string)

    // Collect live metrics for running containers
    const metricsMap = await collectMetrics(runningIds)

    // Write back to store — one change() call covers all instances
    storeHandle.change(doc => {
        for (const inst of allInstances) {
            const instanceInDoc = doc.instanceDB[inst.id as any]
            if (!instanceInDoc) continue

            if (inst.status === 'Running') {
                const m = metricsMap.get(inst.id as string)
                // If running but no container found yet (brief window during start), keep previous metrics
                if (m) {
                    instanceInDoc.metrics = m as any
                }
            } else {
                // Not running — clear metrics
                if (instanceInDoc.metrics !== null) {
                    instanceInDoc.metrics = null
                }
            }
        }
    })
}

export const enableDockerMetricsMonitor = (storeHandle: DocHandle<Store>): void => {
    log('[dockerMetrics] Starting Docker metrics monitor')

    const run = async () => {
        try {
            await poll(storeHandle)
        } catch (e: any) {
            log(`[dockerMetrics] Unhandled error in poll: ${e.message ?? e}`)
        }
        setTimeout(run, POLL_INTERVAL_MS)
    }

    // First poll after a short delay (give instances time to start on engine boot)
    setTimeout(run, 5_000)
}
