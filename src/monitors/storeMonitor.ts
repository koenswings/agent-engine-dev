import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../data/Store.js'
import { log } from '../utils/utils.js'
import { EngineID, InstanceID } from '../data/CommonTypes.js'
import { handleCommand } from '../utils/commandUtils.js'
import { commands } from '../data/Commands.js';
import { localEngineId } from '../data/Engine.js';
import { CommandLogStore } from '../data/CommandLogStore.js';



const engineSetMonitor = (patch, storeHandle): boolean => {
    if (patch.action === 'put' &&  // Since we never change the object value, we know that 'put' means an addition 
        patch.path.length === 2 &&
        patch.path[0] === 'engineDB' &&
        typeof patch.path[1] === 'string' // engineId
    ) {
        const engineId = patch.path[1].toString() as EngineID
        log(`New engine added with ID: ${engineId}`)
        return true
    } else {
        return false
    }
}

// Mutating commands run one at a time per engine queue (per store handle): the
// next mutating command is run, then removed, then the next one is run.
// idea#168: a queue head is never left in place, so it can never block the queue.
// idea#498: read-only verifyMoveTarget runs outside that serial lock so it does
// not wait behind startInstance's port-ready window; mutating commands stay serial.
const _busy = new WeakMap<object, Set<string>>()
const _parallel = new WeakMap<object, Set<string>>()

const queuedText = (c: unknown): string => typeof c === 'string' ? c : String(c ?? '')

/** Read-only Engine commands that may run in parallel with a mutating command (idea#498). */
export const isReadOnlyQueuedCommand = (command: string): boolean =>
    command.trim().split(/\s+/)[0] === 'verifyMoveTarget'

const removeQueuedCommand = (storeHandle: DocHandle<Store>, engineId: EngineID, command: string): void => {
    storeHandle.change(doc => {
        const list = doc.engineDB[engineId as any]?.commands as any[] | undefined
        if (!list) return
        const i = list.findIndex(c => queuedText(c) === command)
        if (i !== -1) list.splice(i, 1)
    })
}

/**
 * Run the head of an engine's command queue, remove it, and go on with the next
 * head. Used by the live path (queue patches) and by the startup replay, so both
 * behave the same and a command is never run twice.
 *
 * Every head goes through handleCommand, also a bare word without a space
 * (idea#168): a registered command without arguments (reboot, ls, disks, ...)
 * runs; anything else (unknown, or a command that needs arguments) is refused by
 * handleCommand with an error trace and nothing runs. Either way the head is
 * removed afterwards. Before, a bare word was skipped and stayed at the head,
 * blocking every later command until a restart.
 */
const drainReadOnlyCommands = (storeHandle: DocHandle<Store>, engineId: EngineID, cmdLogHandle?: DocHandle<CommandLogStore> | null): void => {
    const queue = storeHandle.doc()?.engineDB[engineId as any]?.commands as unknown[] | undefined
    if (!queue?.length) return
    let running = _parallel.get(storeHandle)
    if (!running) { running = new Set(); _parallel.set(storeHandle, running) }
    for (const raw of [...queue]) {
        const command = queuedText(raw)
        if (!isReadOnlyQueuedCommand(command) || running.has(command)) continue
        running.add(command)
        log(`Processing read-only command for engine ${engineId} (parallel): ${command}`)
        // Same #262 setImmediate: do not run inside the store 'change' event.
        new Promise<void>(resolve => setImmediate(resolve))
            .then(() => handleCommand(commands, storeHandle, 'engine', command, cmdLogHandle ?? null))
            .catch(e => log(`Command '${command}' failed outside its trace: ${e?.message ?? e}`))
            .finally(() => {
                running!.delete(command)
                removeQueuedCommand(storeHandle, engineId, command)
                processCommandQueue(storeHandle, engineId, cmdLogHandle)
            })
    }
}

export const processCommandQueue = (storeHandle: DocHandle<Store>, engineId: EngineID, cmdLogHandle?: DocHandle<CommandLogStore> | null): void => {
    drainReadOnlyCommands(storeHandle, engineId, cmdLogHandle)
    let busy = _busy.get(storeHandle)
    if (!busy) { busy = new Set(); _busy.set(storeHandle, busy) }
    if (busy.has(String(engineId))) return
    const queue = storeHandle.doc()?.engineDB[engineId as any]?.commands as unknown[] | undefined
    if (!queue?.length) return

    const idx = queue.findIndex(c => !isReadOnlyQueuedCommand(queuedText(c)))
    if (idx === -1) return
    const command = queuedText(queue[idx])
    busy.add(String(engineId))
    log(`Processing command for engine ${engineId}: ${command}`)
    // agent-engine-dev#262: never run a command inside the store 'change' event that announced
    // it. A storeHandle.change() made from inside that event is applied only after the event
    // returns, so a command that changes the store and then checks the result (forgetDisk)
    // saw its own change as not done. setImmediate runs it on a clean stack.
    new Promise<void>(resolve => setImmediate(resolve))
        .then(() => handleCommand(commands, storeHandle, 'engine', command, cmdLogHandle ?? null))
        .catch(e => log(`Command '${command}' failed outside its trace: ${e?.message ?? e}`))
        .finally(() => {
            busy!.delete(String(engineId))
            removeQueuedCommand(storeHandle, engineId, command)
            processCommandQueue(storeHandle, engineId, cmdLogHandle)
        })
}

const engineCommandsMonitor = (patch, storeHandle): boolean => {
    const isCommandPath =
        patch.path.length >= 3 &&
        patch.path[0] === 'engineDB' &&
        typeof patch.path[1] === 'string' &&
        patch.path[2] === 'commands'

    if (!isCommandPath) return false

    const engineId = patch.path[1] as EngineID
    if (engineId !== localEngineId) return true

    processCommandQueue(storeHandle, engineId, (storeHandle as any).__commandLogHandle ?? null)
    return true
}

const engineLastRunMonitor = (patch, storeHandle): boolean => {
    if (patch.action === 'put' &&
        patch.path.length === 3 &&
        patch.path[0] === 'engineDB' &&
        typeof patch.path[1] === 'string' && // engineId
        patch.path[2] === 'lastRun') {
        const lastRun = patch.value as number
        const engineId = patch.path[1] as EngineID
        log(`Engine ${engineId} last run updated to: ${lastRun}`)
        return true
    } else {
        return false
    }
}

const instancesMonitor = (patch, storeHandle): boolean => {
    if (patch.action === 'put' &&
        patch.path.length === 3 &&
        patch.path[0] === 'instanceDB' &&
        typeof patch.path[1] === 'string' && // instanceId
        patch.path[2] === 'status') {
        const instanceId = patch.path[1] as InstanceID
        const status = (patch.value ?? storeHandle.doc()?.instanceDB?.[instanceId]?.status) as string
        log(`Instance ${instanceId} status changed to: ${status}`)
        return true
    } else {
        return false
    }
}

const applyUntilTrue = (functions: ((patch, storeHandle) => boolean)[], patch, storeHandle): boolean => {
    for (const func of functions) {
        if (func(patch, storeHandle)) {
            return true
        }
    }
    return false
}

export const enableStoreMonitor = (storeHandle: DocHandle<Store>, commandLogHandle?: DocHandle<CommandLogStore> | null): void => {
    // Monitor for the addition or removal of engines in the store
    storeHandle.on('change', ({ doc, patches }) => {
        for (const patch of patches) {
            applyUntilTrue([engineSetMonitor, engineCommandsMonitor, engineLastRunMonitor, instancesMonitor], patch, storeHandle)
        }
        // idea#76 gap 1: a disk docked/undocked anywhere, or its appBundles changed: recompute update hints
        if (patches.some(p => p.path[0] === 'diskDB')) {
            import('../data/UpdateApp.js').then(m => {
                if (patches.some(p => m.patchTouchesBundles(p as any))) m.scheduleHintRefresh(storeHandle, String(localEngineId))
            }).catch(e => log(`update hint trigger failed: ${e}`))
        }
    })

    // Inject commandLogHandle into the monitor closure so engineCommandsMonitor
    // can pass it through to handleCommand
    ;(storeHandle as any).__commandLogHandle = commandLogHandle ?? null

    // On startup, process any commands already queued for this engine.
    // The storeMonitor only fires on new patches, so commands written before
    // this engine started (or while it was offline) would otherwise be silently ignored.
    // Same path as live commands (idea#168 / idea#498): mutating commands are serial;
    // read-only verifyMoveTarget may run in parallel. Each command runs once.
    const pending = storeHandle.doc()?.engineDB[localEngineId]?.commands?.length ?? 0
    if (pending) {
        log(`Replaying ${pending} pending command(s) from queue on startup`)
        processCommandQueue(storeHandle, localEngineId, commandLogHandle)
    }
}
