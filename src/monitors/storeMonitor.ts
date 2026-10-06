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

// One command at a time per engine queue (per store handle): the head is run,
// then removed, then the next head is run. idea#168: a queue head is never left
// in place, so it can never block the queue.
const _busy = new WeakMap<object, Set<string>>()

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
export const processCommandQueue = (storeHandle: DocHandle<Store>, engineId: EngineID, cmdLogHandle?: DocHandle<CommandLogStore> | null): void => {
    let busy = _busy.get(storeHandle)
    if (!busy) { busy = new Set(); _busy.set(storeHandle, busy) }
    if (busy.has(String(engineId))) return
    const queue = storeHandle.doc()?.engineDB[engineId as any]?.commands as unknown[] | undefined
    if (!queue?.length) return

    const head = queue[0]
    const command = typeof head === 'string' ? head : String(head ?? '')
    busy.add(String(engineId))
    log(`Processing command for engine ${engineId}: ${command}`)
    handleCommand(commands, storeHandle, 'engine', command, cmdLogHandle ?? null)
        .catch(e => log(`Command '${command}' failed outside its trace: ${e?.message ?? e}`))
        .finally(() => {
            busy!.delete(String(engineId))
            storeHandle.change(doc => {
                const list = doc.engineDB[engineId as any]?.commands as any[] | undefined
                if (!list) return
                // Remove the command that ran: normally still the head
                const i = list.findIndex(c => (typeof c === 'string' ? c : String(c ?? '')) === command)
                if (i !== -1) list.splice(i, 1)
            })
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
    })

    // Inject commandLogHandle into the monitor closure so engineCommandsMonitor
    // can pass it through to handleCommand
    ;(storeHandle as any).__commandLogHandle = commandLogHandle ?? null

    // On startup, process any commands already queued for this engine.
    // The storeMonitor only fires on new patches, so commands written before
    // this engine started (or while it was offline) would otherwise be silently ignored.
    // Same path as live commands (idea#168): serial, each command runs once.
    const pending = storeHandle.doc()?.engineDB[localEngineId]?.commands?.length ?? 0
    if (pending) {
        log(`Replaying ${pending} pending command(s) from queue on startup`)
        processCommandQueue(storeHandle, localEngineId, commandLogHandle)
    }
}
