/** Shared types for idea-usage (idea#411). No Automerge / store imports. */

export type UsageSwitch = 'on' | 'off'
export type HookStatus =
    | 'ok'
    | 'timeout'
    | 'failed'
    | 'invalid'
    | 'skipped'
    | 'unlisted-no-hook'
    | 'no-hook'
export type SkipReason = 'backup' | 'update' | 'move' | 'temperature'
export type UsageMode = 'day' | 'sample'

export interface UsageHookDecl {
    service: string
    command: string[]
    timeoutS: number
}

export interface ListedTarget {
    kind: 'listed'
    instanceId: string
    name: string
    app: string
    appVersion?: string
    listed: true
    cwd: string
    hook: UsageHookDecl | null
    /** ISO-8601 creation time (instance directory birth). */
    createdAt?: string
}

export interface UnlistedTarget {
    kind: 'unlisted'
    instanceId: string
    name: string
    app: string
    appVersion?: string
    listed: false
    containerId: string
    hook: UsageHookDecl | null
    hookScript?: string
    /** ISO-8601 creation time (container Created). */
    createdAt?: string
}

export type UsageTarget = ListedTarget | UnlistedTarget

export interface ClockInfo {
    synced: boolean
    correctedBoots: number
}

export interface DayFile {
    schema: 'idea-usage-day/1'
    engine: string
    day: string
    app: string
    instance: string
    name: string
    demo: boolean
    listed: boolean
    clock: ClockInfo
    collectedAt: string
    hookStatus: HookStatus
    skipReason?: SkipReason
    [key: string]: unknown
}

export interface SampleRecord {
    schema: 'idea-usage-sample/1'
    app: string
    supported?: boolean
    sampledAt?: string
    collectedAt?: string
    office?: Record<string, unknown>
    [key: string]: unknown
}

export interface PresenceRecord {
    schema: 'idea-usage-presence/1'
    engine: string
    ts: string
    bootId: string
    uptimeS: number
    ntpSynced: boolean
    engineUp: boolean
    instancesUp: string[]
    tempC: number | null
    throttled: string
}

export interface ExecResult {
    stdout: string
    stderr: string
    exitCode: number
    timedOut: boolean
    oversizeStdout?: boolean
}

export interface DockerContainer {
    id: string
    name: string
    image: string
    project?: string
    service?: string
    workingDir?: string
    /** ISO-8601 creation time parsed from docker ps CreatedAt. */
    createdAt?: string
}

export interface BundleHook {
    app: string
    version: string
    appId: string
    hook: UsageHookDecl
    hookScript: string
    bundleDir: string
}
