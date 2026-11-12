/**
 * instanceNetworks.ts — prune unused per-instance Docker networks (idea#468).
 *
 * After removeInstance, eraseDisk, or forgetDisk --with-instances, and after a
 * successful moveApp source-project down: remove unused networks labelled
 * `com.docker.compose.project=<instanceId>`. Never the shared frontend/backend
 * networks. Never a host-wide sweep. Never a network that still has containers
 * attached: we use Docker's `dangling=true` filter and `docker network rm`'s
 * own refusal. A prune failure is logged and does not fail the command.
 *
 * forgetDisk --with-instances is a store edit. The executing Engine prunes only
 * its own local unused label-matched networks for the forgotten instance ids.
 * It does not reach into other Engines.
 *
 * When IDEA_WATCH_DIR is set (tests) and the caller did not pass `run`, docker
 * is not invoked.
 */
import { fs, path, $ } from 'zx'
import { log } from './utils.js'
import type { InstanceID } from '../data/CommonTypes.js'

/** Shared Engine networks created by buildDockerInfrastructure; never pruned. */
export const SHARED_DOCKER_NETWORKS = ['frontend', 'backend'] as const

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project'

export type DockerRun = (args: string[]) => Promise<string>

export const defaultDockerRun: DockerRun = async (args) =>
    (await $`docker ${args}`.quiet()).stdout

export const isSharedDockerNetwork = (name: string): boolean =>
    (SHARED_DOCKER_NETWORKS as readonly string[]).includes(name.trim())

export interface PruneNetworksOptions {
    /** Injected docker argv runner. When omitted, tests (IDEA_WATCH_DIR) skip docker. */
    run?: DockerRun
    /** Call docker even when IDEA_WATCH_DIR is set (the unit tests pass `run` instead). */
    force?: boolean
}

export interface PruneNetworksResult {
    removed: string[]
    skipped: string[]
    errors: string[]
}

const shouldSkipDocker = (opts: PruneNetworksOptions): boolean =>
    !opts.run && !opts.force && Boolean(process.env.IDEA_WATCH_DIR)

/**
 * List unused networks labelled as this compose project, skip frontend/backend,
 * and `docker network rm` each one. `docker network rm` refuses if a container
 * is still attached (including a race after the dangling filter). Never throws.
 */
export const pruneUnusedInstanceNetworks = async (
    instanceId: string,
    opts: PruneNetworksOptions = {},
): Promise<PruneNetworksResult> => {
    const result: PruneNetworksResult = { removed: [], skipped: [], errors: [] }
    if (!instanceId) return result
    if (shouldSkipDocker(opts)) return result
    const run = opts.run ?? defaultDockerRun
    let raw = ''
    try {
        raw = await run([
            'network', 'ls',
            '--filter', `label=${COMPOSE_PROJECT_LABEL}=${instanceId}`,
            '--filter', 'dangling=true',
            '--format', '{{.ID}}\t{{.Name}}',
        ])
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log(`pruneUnusedInstanceNetworks: docker network ls failed for ${instanceId}: ${msg}`)
        result.errors.push(msg)
        return result
    }
    for (const line of raw.split('\n').map(s => s.trim()).filter(Boolean)) {
        const tab = line.indexOf('\t')
        const id = (tab === -1 ? line : line.slice(0, tab)).trim()
        const name = (tab === -1 ? '' : line.slice(tab + 1)).trim()
        if (!id) continue
        if (isSharedDockerNetwork(name) || isSharedDockerNetwork(id)) {
            result.skipped.push(name || id)
            log(`pruneUnusedInstanceNetworks: skipping shared network ${name || id}`)
            continue
        }
        try {
            await run(['network', 'rm', id])
            result.removed.push(name || id)
            log(`pruneUnusedInstanceNetworks: removed ${name || id} (project ${instanceId})`)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            // Docker refuses when the network still has endpoints; leave it.
            result.errors.push(`${name || id}: ${msg}`)
            log(`pruneUnusedInstanceNetworks: left ${name || id} for ${instanceId}: ${msg}`)
        }
    }
    return result
}

/** Prune each id in turn (forgetDisk --with-instances). Local unused networks only. */
export const pruneUnusedInstanceNetworksForIds = async (
    instanceIds: string[],
    opts: PruneNetworksOptions = {},
): Promise<PruneNetworksResult> => {
    const acc: PruneNetworksResult = { removed: [], skipped: [], errors: [] }
    for (const id of instanceIds) {
        const r = await pruneUnusedInstanceNetworks(id, opts)
        acc.removed.push(...r.removed)
        acc.skipped.push(...r.skipped)
        acc.errors.push(...r.errors)
    }
    return acc
}

/**
 * Bring the compose project down using the live instance path and file
 * (idea#424 / idea#468). No `-v` (named volumes stay). Missing compose.yaml is
 * not an error — the caller still runs prune / label cleanup. Does not glob
 * the quarantine directory.
 */
export const composeDownAt = async (
    dir: string, id: InstanceID, run: DockerRun = defaultDockerRun,
): Promise<void> => {
    const composeFile = path.join(dir, 'compose.yaml')
    if (!fs.existsSync(composeFile)) {
        log(`composeDownAt: no compose.yaml at ${composeFile}; will rely on label cleanup / prune for project ${id}`)
        return
    }
    await run(['compose', '-p', String(id), '-f', composeFile, 'down'])
}
