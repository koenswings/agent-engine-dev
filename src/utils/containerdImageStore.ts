/**
 * Detect whether Docker uses the containerd image store.
 *
 * Digest pins (idea#322 / idea#445) rely on RepoDigests surviving `docker load`.
 * That only holds when `docker info` DriverStatus includes
 * `driver-type: io.containerd.snapshotter.v1` (the Pis run Docker 29 with that
 * store). The classic overlay2 store (e.g. the box's Docker 27) drops
 * RepoDigests on load, so a digest verify would fail or be meaningless.
 *
 * `detectContainerdImageStore` takes an injectable exec so tests never call
 * the real `docker`. `getImageStore` is the cached helper used by image
 * verify: in test runs (`IDEA_WATCH_DIR` is set) it does not probe the host
 * Docker and treats the store as containerd, unless a test injects a result.
 */

import { $ } from 'zx'
import { DOCKER_PROBE_TIMEOUT_MS } from './dockerAvailable.js'

/** DriverStatus pair that identifies Docker's containerd image store. */
export const CONTAINERD_SNAPSHOTTER_DRIVER_TYPE = 'io.containerd.snapshotter.v1'
export const CONTAINERD_DRIVER_TYPE_KEY = 'driver-type'

/** Image verify fails with this code when the store is not containerd (or cannot be confirmed). */
export const CONTAINERD_IMAGE_STORE_REQUIRED = 'CONTAINERD_IMAGE_STORE_REQUIRED'
/** Image verify fails with this code when Docker does not answer, so the store cannot be checked. */
export const DOCKER_UNAVAILABLE = 'DOCKER_UNAVAILABLE'

export type ImageStoreKind = 'containerd' | 'classic' | 'unreachable' | 'unknown'

export type ImageStoreCheck = {
    kind: ImageStoreKind
    /** True only when DriverStatus has driver-type io.containerd.snapshotter.v1. */
    containerd: boolean
    driverStatus: [string, string][] | null
    detail?: string
}

export type DockerInfoExec = () => Promise<{ exitCode: number, stdout: string, stderr: string }>

export class ImageStoreError extends Error {
    constructor(
        readonly code: typeof CONTAINERD_IMAGE_STORE_REQUIRED | typeof DOCKER_UNAVAILABLE,
        text: string,
    ) {
        super(`${code}: ${text}`)
        this.name = 'ImageStoreError'
    }
}

const DRIVER_STATUS_FORMAT = '{{json .DriverStatus}}'

const defaultExec: DockerInfoExec = async () => {
    const r = await $`docker info --format ${DRIVER_STATUS_FORMAT}`.quiet().nothrow().timeout(DOCKER_PROBE_TIMEOUT_MS)
    return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

/**
 * Parse `docker info --format '{{json .DriverStatus}}'` (preferred) or the
 * raw Go `{{.DriverStatus}}` text. Returns null when the text cannot be read
 * as a list of key/value pairs. Keys may contain spaces (classic overlay2
 * reports "Backing Filesystem", "Native Overlay Diff", …).
 */
export const parseDriverStatus = (raw: string): [string, string][] | null => {
    const text = raw.trim()
    if (!text || text === 'null') return []
    try {
        const v = JSON.parse(text)
        if (Array.isArray(v)) {
            const pairs: [string, string][] = []
            for (const row of v) {
                if (!Array.isArray(row) || row.length < 2) return null
                if (typeof row[0] !== 'string' || typeof row[1] !== 'string') return null
                pairs.push([row[0], row[1]])
            }
            return pairs
        }
    } catch { /* fall through to the Go text format */ }
    // `[[Backing Filesystem extfs] [Supports d_type true] [driver-type io.containerd.snapshotter.v1]]`
    if (!/^\[\[.*\]\]$/s.test(text)) return null
    const inners = [...text.matchAll(/\[([^\[\]]+)\]/g)].map(m => m[1].trim())
    if (inners.length === 0) return null
    const pairs: [string, string][] = []
    for (const inner of inners) {
        const sp = inner.lastIndexOf(' ')
        if (sp <= 0) return null
        pairs.push([inner.slice(0, sp), inner.slice(sp + 1)])
    }
    return pairs
}

export const hasContainerdImageStore = (pairs: [string, string][]): boolean =>
    pairs.some(([key, value]) => key === CONTAINERD_DRIVER_TYPE_KEY && value === CONTAINERD_SNAPSHOTTER_DRIVER_TYPE)

const formatPairs = (pairs: [string, string][] | null): string => {
    if (!pairs || pairs.length === 0) return '(empty DriverStatus)'
    return pairs.map(([k, v]) => `${k}=${v}`).join(', ')
}

export const imageStoreRequiredMessage = (check: ImageStoreCheck): string => {
    if (check.kind === 'unknown') {
        return `Docker DriverStatus could not be parsed${check.detail ? ` (${check.detail})` : ''}. ` +
            `Digest-pinned service images cannot be verified until the containerd image store ` +
            `(driver-type ${CONTAINERD_SNAPSHOTTER_DRIVER_TYPE}) is confirmed (idea#322)`
    }
    return `Docker is not using the containerd image store ` +
        `(DriverStatus has no driver-type ${CONTAINERD_SNAPSHOTTER_DRIVER_TYPE}; saw ${formatPairs(check.driverStatus)}). ` +
        `Digest-pinned service images cannot be verified because RepoDigests do not survive ` +
        `docker load on the classic store (idea#322)`
}

export const imageStoreUnreachableMessage = (check: ImageStoreCheck): string =>
    `Docker did not answer, so the containerd image store could not be checked` +
    `${check.detail ? `: ${check.detail}` : ''}. ` +
    `Digest-pinned service images cannot be verified until Docker is reachable (idea#322)`

export const imageStoreError = (check: ImageStoreCheck): ImageStoreError => {
    if (check.kind === 'unreachable') return new ImageStoreError(DOCKER_UNAVAILABLE, imageStoreUnreachableMessage(check))
    return new ImageStoreError(CONTAINERD_IMAGE_STORE_REQUIRED, imageStoreRequiredMessage(check))
}

const execDetail = (r: { exitCode: number, stdout: string, stderr: string }): string => {
    const out = (r.stderr || r.stdout || '').trim().split('\n')[0]
    return out ? `exit ${r.exitCode}: ${out}` : `exit ${r.exitCode}`
}

/** Probe Docker and classify the image store. Never throws. Tests pass a fake exec. */
export const detectContainerdImageStore = async (exec: DockerInfoExec = defaultExec): Promise<ImageStoreCheck> => {
    let r: { exitCode: number, stdout: string, stderr: string }
    try {
        r = await exec()
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        return { kind: 'unreachable', containerd: false, driverStatus: null, detail }
    }
    if (r.exitCode !== 0) {
        return { kind: 'unreachable', containerd: false, driverStatus: null, detail: execDetail(r) }
    }
    const pairs = parseDriverStatus(r.stdout)
    if (pairs === null) {
        const snippet = r.stdout.trim().slice(0, 120)
        return {
            kind: 'unknown',
            containerd: false,
            driverStatus: null,
            detail: snippet ? `unparseable DriverStatus: ${snippet}` : 'empty or unparseable DriverStatus',
        }
    }
    if (hasContainerdImageStore(pairs)) {
        return { kind: 'containerd', containerd: true, driverStatus: pairs }
    }
    return { kind: 'classic', containerd: false, driverStatus: pairs }
}

const TEST_DEFAULT: ImageStoreCheck = {
    kind: 'containerd',
    containerd: true,
    driverStatus: [[CONTAINERD_DRIVER_TYPE_KEY, CONTAINERD_SNAPSHOTTER_DRIVER_TYPE]],
    detail: 'test default (IDEA_WATCH_DIR); host Docker was not probed',
}

let testProbe: (() => Promise<ImageStoreCheck>) | null = null
let cached: ImageStoreCheck | null = null

/**
 * Cached image-store result for image verify. An injected test probe always
 * wins. In test runs (`IDEA_WATCH_DIR`) the host Docker is not probed.
 */
export const getImageStore = async (): Promise<ImageStoreCheck> => {
    if (testProbe) return testProbe()
    if (cached) return cached
    if (process.env.IDEA_WATCH_DIR) {
        cached = TEST_DEFAULT
        return cached
    }
    cached = await detectContainerdImageStore()
    return cached
}

/** Image verify: throw a coded error when the store is not containerd. */
export const assertContainerdImageStore = async (): Promise<void> => {
    const check = await getImageStore()
    if (!check.containerd) throw imageStoreError(check)
}

/**
 * Tests: inject a fixed result or a fake `docker info` exec; always clears the
 * cache. Pass null to restore the default.
 */
export const setImageStoreForTests = (probe: ImageStoreCheck | DockerInfoExec | null): void => {
    if (probe === null) testProbe = null
    else if (typeof probe === 'function') testProbe = () => detectContainerdImageStore(probe)
    else testProbe = async () => probe
    cached = null
}
