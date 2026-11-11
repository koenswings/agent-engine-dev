/**
 * Presence sampler (idea#411 contract §5.6): every 5 minutes, no Automerge.
 * "Engine up" = localhost TCP port 80 accepts a connection.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { usageLog } from './log.js'
import {
    INSTANCE_ID_RE,
    USAGE_SCHEMA_PRESENCE,
    engineHostname,
    formatRfc3339,
    kitLocalDay,
    usageRoot,
} from './paths.js'
import { defaultReadTempC } from './skip.js'
import { appendPresence, trimPresenceRing } from './store.js'
import type { PresenceRecord } from './types.js'

export interface SamplerDeps {
    hostname?: () => string
    now?: () => Date
    readBootId?: () => string
    readUptimeS?: () => number
    readNtpSynced?: () => boolean
    engineUp?: () => boolean | Promise<boolean>
    listInstancesUp?: () => string[] | Promise<string[]>
    readTempC?: () => number | null
    readThrottled?: () => string
}

export function defaultReadBootId(): string {
    try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return 'unknown' }
}

export function defaultReadUptimeS(): number {
    try {
        const raw = fs.readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/)[0]
        const n = Number(raw)
        return Number.isFinite(n) ? Math.floor(n) : 0
    } catch { return 0 }
}

export function defaultReadNtpSynced(): boolean {
    const r = spawnSync('timedatectl', ['show', '--property=NTPSynchronized', '--value'], { encoding: 'utf8', timeout: 2000 })
    if (r.status === 0) return r.stdout.trim().toLowerCase() === 'yes'
    return false
}

export function probeEngineUp(timeoutMs = 200): Promise<boolean> {
    return new Promise(resolve => {
        const sock = net.connect({ host: '127.0.0.1', port: 80 })
        const done = (up: boolean) => {
            sock.removeAllListeners()
            sock.destroy()
            resolve(up)
        }
        sock.setTimeout(timeoutMs)
        sock.on('connect', () => done(true))
        sock.on('timeout', () => done(false))
        sock.on('error', () => done(false))
    })
}

export function defaultReadThrottled(): string {
    const r = spawnSync('vcgencmd', ['get_throttled'], { encoding: 'utf8', timeout: 2000 })
    if (r.status === 0 && r.stdout) {
        const m = r.stdout.match(/throttled=(0x[0-9a-fA-F]+)/)
        if (m) return m[1]
        return r.stdout.trim()
    }
    return 'unknown'
}

export function defaultListInstancesUp(): string[] {
    const r = spawnSync('docker', [
        'ps', '--format', '{{.Label "com.docker.compose.project"}}',
    ], { encoding: 'utf8', timeout: 5000 })
    if (r.status !== 0) return []
    const seen = new Set<string>()
    for (const line of r.stdout.split('\n')) {
        const p = line.trim()
        if (INSTANCE_ID_RE.test(p)) seen.add(p)
    }
    return [...seen]
}

export async function collectPresence(deps: SamplerDeps = {}): Promise<PresenceRecord> {
    const now = (deps.now ?? (() => new Date()))()
    const engineUp = await Promise.resolve((deps.engineUp ?? probeEngineUp)())
    const instancesUp = await Promise.resolve((deps.listInstancesUp ?? defaultListInstancesUp)())
    return {
        schema: USAGE_SCHEMA_PRESENCE,
        engine: (deps.hostname ?? engineHostname)(),
        ts: formatRfc3339(now),
        bootId: (deps.readBootId ?? defaultReadBootId)(),
        uptimeS: (deps.readUptimeS ?? defaultReadUptimeS)(),
        ntpSynced: (deps.readNtpSynced ?? defaultReadNtpSynced)(),
        engineUp,
        instancesUp,
        tempC: (deps.readTempC ?? defaultReadTempC)(),
        throttled: (deps.readThrottled ?? defaultReadThrottled)(),
    }
}

export async function samplePresence(deps: SamplerDeps = {}, root = usageRoot()): Promise<PresenceRecord> {
    const now = (deps.now ?? (() => new Date()))()
    const rec = await collectPresence(deps)
    const day = kitLocalDay(now)
    appendPresence(rec, day, root)
    trimPresenceRing(day, root)
    return rec
}

export { usageLog }
