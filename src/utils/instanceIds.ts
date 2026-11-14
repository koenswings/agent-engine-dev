/**
 * instanceIds.ts — instance id checks before any compose or Docker action (idea#479).
 *
 * New instance ids match INSTANCE_ID_RE (`^[a-z0-9][a-z0-9-]{0,63}$`). Older
 * Engines also wrote legacy dotted ids such as
 * `nextcloud-yj8ral61js46bphogbi.backup-20261027-181633`. Those are accepted on
 * the removal path only (removeInstance and helper `quarantine`, v13), never for
 * install, start, update, copy, move or erase. On dock or boot they stay listed
 * (so removeInstance can clear them) with status Error, and they get no compose
 * up, no .env rewrite and no port allocation (idea#494). Manual startInstance
 * is refused with the same message.
 *
 * Compose does not keep the dot. A project started with `docker compose up` in
 * `instances/<id>` gets the folder name normalised the way compose-go
 * `loader.NormalizeProjectName` does it: lowercase, keep only [a-z0-9_-], trim
 * leading '_' and '-'. An explicit `-p` must already be normalised, or compose
 * refuses with "invalid project name". So every compose `-p` and every
 * `com.docker.compose.project=` label filter uses composeProjectName(id). For a
 * strict id that is the id itself.
 */
import { INSTANCE_ID_RE } from '../usage/paths.js'

/** Legacy dotted id: dot-separated [a-z0-9-] segments that each start with [a-z0-9]; no '..', no leading or trailing dot. */
export const LEGACY_DOTTED_INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
export const LEGACY_DOTTED_INSTANCE_ID_MAX = 128

export const isStrictInstanceId = (id: string): boolean => INSTANCE_ID_RE.test(String(id ?? ''))

export const isLegacyDottedInstanceId = (id: string): boolean => {
    const s = String(id ?? '')
    return s.length <= LEGACY_DOTTED_INSTANCE_ID_MAX && LEGACY_DOTTED_INSTANCE_ID_RE.test(s)
}

/** compose-go loader.NormalizeProjectName. */
export const composeProjectName = (id: string): string =>
    (String(id ?? '').toLowerCase().match(/[a-z0-9_-]/g) ?? []).join('').replace(/^[_-]+/, '')

export interface InstanceIdCheckOptions {
    /** Only removeInstance passes this (idea#479). */
    allowLegacyDotted?: boolean
}

export type InstanceIdCheck =
    | { ok: true, project: string, legacy: boolean }
    | { ok: false, reason: string }

export const checkInstanceIdForDocker = (id: string, opts: InstanceIdCheckOptions = {}): InstanceIdCheck => {
    const s = String(id ?? '')
    if (isStrictInstanceId(s)) return { ok: true, project: s, legacy: false }
    if (isLegacyDottedInstanceId(s)) {
        if (opts.allowLegacyDotted) return { ok: true, project: composeProjectName(s), legacy: true }
        return { ok: false, reason: `instance id '${s}' is a legacy dotted id; only removeInstance accepts it` }
    }
    return { ok: false, reason: `instance id '${s}' does not match ${INSTANCE_ID_RE.source}` }
}

export class InstanceIdError extends Error {
    code = 'INVALID_INSTANCE_ID'
    constructor(text: string) { super(`INVALID_INSTANCE_ID: ${text}`) }
}

/** The compose project name for `id`, or throw InstanceIdError before any Docker call. */
export const composeProjectFor = (id: string, opts: InstanceIdCheckOptions = {}): string => {
    const c = checkInstanceIdForDocker(id, opts)
    if (!c.ok) throw new InstanceIdError(c.reason)
    return c.project
}

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project'

/**
 * `docker ps --filter` value matching exactly this instance's compose project
 * (idea#479). `--filter name=<id>` is a substring match: it also hits
 * `<id>backup-…` containers of a dotted legacy id and marked the live instance
 * Error. null when the id leaves no project name (nothing must be matched).
 */
export const composeProjectLabelFilter = (id: string): string | null => {
    const p = composeProjectName(id)
    return p ? `label=${COMPOSE_PROJECT_LABEL}=${p}` : null
}

/** True when a container's labels put it in this instance's compose project (exact, never a name prefix). */
export const containerInInstanceProject = (labels: Record<string, string> | null | undefined, id: string): boolean => {
    const p = composeProjectName(id)
    return Boolean(p) && (labels ?? {})[COMPOSE_PROJECT_LABEL] === p
}

/**
 * Compose default container name is `<project>-<service>-<n>`. Exact project
 * only: `nextcloud-…bi-nextcloud-1` belongs to the live id, but
 * `nextcloud-…bibackup-…-nextcloud-1` does not (idea#479, engine#367).
 * Never `startsWith(id)`: that is a prefix match on the backup stack.
 */
export const containerNameBelongsToInstance = (name: string, id: string): boolean => {
    const p = composeProjectName(id)
    if (!p || !name) return false
    return name === p || name.startsWith(`${p}-`)
}

/** statusCondition / startInstance refusal for a legacy dotted id (idea#494). */
export const LEGACY_DOTTED_INSTANCE_MESSAGE = 'Legacy instance id with a dot; remove it and reinstall'
