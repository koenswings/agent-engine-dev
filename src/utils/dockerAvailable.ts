/**
 * dockerAvailable() — is there a Docker daemon this Engine can use? (idea#168 Stage 1)
 *
 * Three Docker-only paths used to be gated on testMode: the metrics poll
 * (dockerMetricsMonitor), the startInstance "containers already running"
 * shortcut and the container logs in diagnoseInstance. testMode means "fixture
 * disks, no sudo mount/umount"; the duration pool runs it AND real Docker, so
 * those paths were off exactly where they matter (no metrics, a re-dock
 * recreated running containers, failures had no container logs).
 *
 * They now ask dockerAvailable():
 *   - settings.dockerAvailable (env IDEA_DOCKER_AVAILABLE=true|false) when set;
 *   - else a cached `docker info` probe: true is kept DOCKER_PROBE_TTL_OK_MS,
 *     false DOCKER_PROBE_TTL_FAIL_MS (a daemon that comes up later is noticed).
 * Concurrent callers share one probe. Never throws.
 */

import { $ } from 'zx'
import { config } from '../data/Config.js'
import { log } from './utils.js'

export const DOCKER_PROBE_TTL_OK_MS = 10 * 60_000
export const DOCKER_PROBE_TTL_FAIL_MS = 60_000
export const DOCKER_PROBE_TIMEOUT_MS = 5_000

/** Resolves true when a Docker daemon answers. Injectable for tests. */
export type DockerProbe = () => Promise<boolean>

const defaultProbe: DockerProbe = async () => {
    try {
        const r = await $`docker info --format {{.ServerVersion}}`.quiet().nothrow().timeout(DOCKER_PROBE_TIMEOUT_MS)
        return r.exitCode === 0 && r.stdout.trim().length > 0
    } catch {
        return false
    }
}

let probe: DockerProbe = defaultProbe
let cached: { value: boolean, at: number } | null = null
let inflight: Promise<boolean> | null = null
let now: () => number = () => Date.now()

export const dockerAvailable = async (): Promise<boolean> => {
    const forced = config.settings.dockerAvailable
    if (typeof forced === 'boolean') return forced
    if (cached && now() - cached.at < (cached.value ? DOCKER_PROBE_TTL_OK_MS : DOCKER_PROBE_TTL_FAIL_MS)) return cached.value
    if (inflight) return inflight
    inflight = (async () => {
        let value = false
        try {
            value = await probe()
        } catch {
            value = false
        }
        if (!cached || cached.value !== value) log(`dockerAvailable: docker ${value ? 'answers' : 'does not answer'} (docker info)`)
        cached = { value, at: now() }
        return value
    })().finally(() => { inflight = null })
    return inflight
}

/** Tests: replace the probe and/or the clock; always clears the cache. */
export const setDockerProbeForTests = (p: DockerProbe | null, clock?: (() => number) | null): void => {
    probe = p ?? defaultProbe
    now = clock ?? (() => Date.now())
    cached = null
    inflight = null
}
