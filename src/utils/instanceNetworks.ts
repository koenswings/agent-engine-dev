/**
 * instanceNetworks.ts — prune unused per-instance Docker networks (idea#468).
 *
 * After removeInstance, eraseDisk, or forgetDisk --with-instances, and after a
 * successful moveApp source-project down: remove unused networks labelled
 * `com.docker.compose.project=<instanceId>`. Never the shared frontend/backend
 * networks. Never a host-wide sweep. Never a network that any container still
 * references, running OR stopped. Docker's `dangling=true` filter and
 * `docker network rm` only look at running containers (endpoints): on idea03
 * (#343 proof) they removed the network of a stopped container left by an
 * undock, and the next dock of that disk failed in compose up with "network
 * <id> not found". So each candidate is also checked with
 * `docker ps -a --filter network=<id>`, which sees stopped containers, and is
 * left when that finds one or cannot be read. A prune failure is logged and
 * does not fail the command.
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
import { checkInstanceIdForDocker, composeProjectFor, InstanceIdCheckOptions, COMPOSE_PROJECT_LABEL } from './instanceIds.js'

/** Shared Engine networks created by buildDockerInfrastructure; never pruned. */
export const SHARED_DOCKER_NETWORKS = ['frontend', 'backend'] as const

export { COMPOSE_PROJECT_LABEL }

export type DockerRun = (args: string[]) => Promise<string>

export const defaultDockerRun: DockerRun = async (args) =>
    (await $`docker ${args}`.quiet()).stdout

export const isSharedDockerNetwork = (name: string): boolean =>
    (SHARED_DOCKER_NETWORKS as readonly string[]).includes(name.trim())

export interface PruneNetworksOptions extends InstanceIdCheckOptions {
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
 * leave any network a container (running or stopped) still references, and
 * `docker network rm` the rest. `docker network rm` also refuses if a container
 * is still attached (including a race after the checks). Never throws.
 */
export const pruneUnusedInstanceNetworks = async (
    instanceId: string,
    opts: PruneNetworksOptions = {},
): Promise<PruneNetworksResult> => {
    const result: PruneNetworksResult = { removed: [], skipped: [], errors: [] }
    if (!instanceId) return result
    // idea#479: check the id before any Docker call; label filter uses the compose project name.
    const idCheck = checkInstanceIdForDocker(instanceId, opts)
    if (!idCheck.ok) {
        log(`pruneUnusedInstanceNetworks: skipped: ${idCheck.reason}`)
        result.errors.push(idCheck.reason)
        return result
    }
    const project = idCheck.project
    if (shouldSkipDocker(opts)) return result
    const run = opts.run ?? defaultDockerRun
    let raw = ''
    try {
        raw = await run([
            'network', 'ls',
            '--filter', `label=${COMPOSE_PROJECT_LABEL}=${project}`,
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
        // Fail closed: a stopped container still references the network by id
        // and could not start again without it (idea#468, #343 proof on idea03).
        let users = ''
        try {
            users = (await run(['ps', '-a', '-q', '--filter', `network=${id}`])).trim()
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            result.errors.push(`${name || id}: container check failed: ${msg}`)
            log(`pruneUnusedInstanceNetworks: left ${name || id} for ${instanceId}: could not check its containers: ${msg}`)
            continue
        }
        if (users) {
            result.skipped.push(name || id)
            log(`pruneUnusedInstanceNetworks: left ${name || id} for ${instanceId}: still used by stopped container(s) ${users.split(/\s+/).join(', ')}`)
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
 * the quarantine directory. The id is checked first (idea#479): an invalid id
 * throws INVALID_INSTANCE_ID before docker runs, and `-p` is the compose
 * project name (a legacy dotted id, removal path only, loses its dots).
 */
export const composeDownAt = async (
    dir: string, id: InstanceID, run: DockerRun = defaultDockerRun, opts: InstanceIdCheckOptions = {},
): Promise<void> => {
    const project = composeProjectFor(String(id), opts)
    const composeFile = path.join(dir, 'compose.yaml')
    if (!fs.existsSync(composeFile)) {
        log(`composeDownAt: no compose.yaml at ${composeFile}; will rely on label cleanup / prune for project ${id}`)
        return
    }
    await run(['compose', '-p', project, '-f', composeFile, 'down'])
}
