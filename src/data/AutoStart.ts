/**
 * AutoStart.ts: the one gate for every start the Engine does on its own (idea#176).
 *
 * The Engine starts instances by itself when a disk is docked: at boot (the
 * watcher's initial 'add' for every device in the watch folder), on a real USB
 * plug, after the testMode/dev startup undock + re-add of every disk, and when a
 * move, restore or install registers an instance on a disk (processInstance /
 * processSystemInstance → tracedStartInstance). All of those ask shouldAutoStart.
 *
 * Rule: the operator's last word wins. An instance is not auto-started while
 *   - its status is Stopped, or
 *   - an operator stop is "in force": the latest stopApp operation of the
 *     instance with an operator cause (console/cli/cross-engine command), not
 *     Cancelled, with no operator start after it and no successful start of any
 *     kind after it (instance.lastStarted).
 * Status alone is not enough: the undock of a disk (a real unplug, a boot where
 * the disk is gone or renamed, or the testMode/dev startup undock of every disk)
 * overwrites Stopped with Undocked, and the dock pass then resets Undocked to
 * Docked. The operation record survives that.
 *
 * Stops the Engine does itself as one step of a longer operation (backup-pre-stop,
 * post-copy, post-move, disk-undocked) are not operator stops: an instance
 * stopped that way and interrupted is still started again, as before. They also
 * do not end an operator stop that is in force (a user-stopped app on a disk that
 * is unplugged and plugged back stays Stopped).
 *
 * Pure functions on the store (no Engine, Docker or file system access).
 */
import { InstanceID, Operation, OperationCause } from './CommonTypes.js'
import type { Instance } from './Instance.js'
import type { Store } from './Store.js'

/** Operation causes that come from the operator (idea#176). */
export const USER_CAUSES: ReadonlySet<OperationCause> = new Set<OperationCause>([
    'console-command', 'cli-command', 'cross-engine-cmd',
])
/** Kept for readers of the first version of the fix. */
export const USER_STOP_CAUSES = USER_CAUSES

const opInstanceId = (op: Operation): string | undefined =>
    op.subject?.type === 'instance' ? String(op.subject.id) : (op.args?.instanceId ? String(op.args.instanceId) : undefined)

const instanceOps = (store: Store, instanceId: InstanceID, kind: Operation['kind'], pred: (op: Operation) => boolean = () => true): Operation[] =>
    Object.values(store.operationDB ?? {}).filter((op): op is Operation =>
        !!op && op.kind === kind && opInstanceId(op) === String(instanceId) && pred(op))

const latest = (ops: Operation[]): Operation | undefined =>
    ops.reduce<Operation | undefined>((a, b) => (!a || (b.startedAt ?? 0) >= (a.startedAt ?? 0)) ? b : a, undefined)

/** The most recent stopApp operation of the instance, any cause and any Engine. */
export const lastStopOperation = (store: Store, instanceId: InstanceID): Operation | undefined =>
    latest(instanceOps(store, instanceId, 'stopApp'))

/** The most recent operator stop of the instance (not Cancelled), any Engine. */
export const lastUserStop = (store: Store, instanceId: InstanceID): Operation | undefined =>
    latest(instanceOps(store, instanceId, 'stopApp', op => USER_CAUSES.has(op.cause) && op.status !== 'Cancelled'))

/**
 * The operator stop that is still in force for the instance, or undefined. It ends
 * with an operator start issued after it (whatever its outcome) or with any
 * successful start after it (lastStarted: a user start, the "already running"
 * shortcut, a restart after a copy/move/backup of a running app).
 */
export const userStopInForce = (store: Store, instance: Instance | undefined | null): Operation | undefined => {
    if (!instance) return undefined
    const stop = lastUserStop(store, instance.id)
    if (!stop) return undefined
    const at = stop.startedAt ?? 0
    if ((instance.lastStarted ?? 0) > at) return undefined
    const laterUserStart = instanceOps(store, instance.id, 'startApp', op =>
        USER_CAUSES.has(op.cause) && op.status !== 'Cancelled' && (op.startedAt ?? 0) > at)
    return laterUserStart.length ? undefined : stop
}

export interface AutoStartDecision {
    start: boolean
    reason: string
    /** Set when an operator stop is the reason not to start. */
    userStop?: Operation
}

/** May the Engine start this instance by itself (disk dock, re-add, registration)? */
export const shouldAutoStart = (store: Store, instance: Instance): AutoStartDecision => {
    const stop = userStopInForce(store, instance)
    if (stop) return { start: false, reason: `stopped by the operator (${stop.cause}, operation ${String(stop.id).slice(0, 8)})`, userStop: stop }
    if (instance.status === 'Stopped') return { start: false, reason: 'status is Stopped' }
    return { start: true, reason: 'no operator stop in force' }
}

/**
 * Startup (checkAndSetUndockedApps): a Stopped instance stays Stopped when an
 * operator stop is in force, or when the store has no stop record at all for it
 * (trust the store's status). A Stopped instance whose last stop was the Engine's
 * own step of an interrupted operation is not "user stopped".
 */
export const isUserStopped = (store: Store, instance: Instance): boolean => {
    if (instance.status !== 'Stopped') return false
    return !!userStopInForce(store, instance) || !lastStopOperation(store, instance.id)
}
