/**
 * containerdImageStoreCheck.ts — startup warning when Docker is not using
 * the containerd image store (idea#322). Digest pins need RepoDigests to
 * survive `docker load`, which only holds with driver-type
 * io.containerd.snapshotter.v1. Startup is never blocked. Skipped in test
 * runs (IDEA_WATCH_DIR is set). Tests inject detect(); they never call the
 * real docker.
 */
import { chalk } from 'zx'
import { log, print } from '../utils/utils.js'
import {
    CONTAINERD_IMAGE_STORE_REQUIRED,
    DOCKER_UNAVAILABLE,
    detectContainerdImageStore,
    imageStoreRequiredMessage,
    imageStoreUnreachableMessage,
    type ImageStoreCheck,
} from '../utils/containerdImageStore.js'

export type ImageStoreDetect = () => Promise<ImageStoreCheck>

/** Named selfCheck problem text, including the error code; null when the store is containerd. */
export const containerdImageStoreProblem = (check: ImageStoreCheck): string | null => {
    if (check.containerd) return null
    if (check.kind === 'unreachable') return `${DOCKER_UNAVAILABLE}: ${imageStoreUnreachableMessage(check)}`
    return `${CONTAINERD_IMAGE_STORE_REQUIRED}: ${imageStoreRequiredMessage(check)}`
}

/**
 * Engine startup self-check for the containerd image store. Warns only; does
 * not fail startup. Skipped when IDEA_WATCH_DIR is set (tests). Returns the
 * problem text or null.
 */
export const runContainerdImageStoreSelfCheck = async (opts: {
    detect?: ImageStoreDetect
    skip?: boolean
} = {}): Promise<string | null> => {
    if (opts.skip ?? Boolean(process.env.IDEA_WATCH_DIR)) {
        log('[selfCheck] IDEA_WATCH_DIR is set — skipping the containerd image store check')
        return null
    }
    let check: ImageStoreCheck
    try {
        check = await (opts.detect ?? detectContainerdImageStore)()
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        check = { kind: 'unreachable', containerd: false, driverStatus: null, detail }
    }
    const problem = containerdImageStoreProblem(check)
    if (problem) {
        print(chalk.red(`  - WARNING: ${problem}`))
        log(`[selfCheck] WARNING: ${problem}`)
        return problem
    }
    log(`[selfCheck] containerd image store=ok (driver-type io.containerd.snapshotter.v1)`)
    return null
}
