import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../data/Store.js'
import { log, deepPrint } from '../utils/utils.js'
import { EngineID, InstanceID } from '../data/CommonTypes.js'
import { handleCommand } from '../utils/commandUtils.js'
import { commands } from '../data/Commands.js';
import { localEngineId } from '../data/Engine.js';



const engineSetMonitor = (patch, storeHandle): boolean => {
    if (patch.action === 'put' &&  // Since we never change the object value, we know that 'put' means an addition 
        patch.path.length === 2 &&
        patch.path[0] === 'engineDB' &&
        typeof patch.path[1] === 'string' // engineId
    ) {
        const engineId = patch.path[1].toString() as EngineID
        log(`New engine added with ID: ${engineId}`)
        log(`Doc now contains: ${deepPrint(storeHandle.doc(), 2)}`)
        return true
    } else {
        return false
    }
}

const engineCommandsMonitor = (patch, storeHandle): boolean => {
    // Automerge emits 'put' when pushing to a non-empty list (path length 4,
    // path[3] = numeric index). The value is the new command string.
    if (patch.action === 'put' &&
        patch.path.length === 4 &&
        patch.path[0] === 'engineDB' &&
        typeof patch.path[1] === 'string' && // engineId
        patch.path[2] === 'commands' &&
        typeof patch.path[3] === 'number') {
        const command = patch.value as string
        const engineId = patch.path[1] as EngineID
        // Only execute commands addressed to this engine.
        if (engineId !== localEngineId) {
            log(`Command for engine ${engineId} ignored by this engine (${localEngineId}): ${command}`)
            return true
        }
        log(`New command added for engine ${engineId}: ${command}`)
        const cmdIndex = patch.path[3] as number
        handleCommand(commands, storeHandle, 'engine', command).then(() => {
            // Remove the command from the queue after it has been processed.
            // This prevents re-execution on engine restart and keeps the queue clean.
            storeHandle.change(doc => {
                const eng = doc.engineDB[engineId as any]
                if (eng) (eng.commands as any[]).splice(cmdIndex, 1)
            })
        })
        return true
    } else {
        return false
    }
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
        log(`Doc now contains: ${deepPrint(storeHandle.doc(), 2)}`)
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
        const status = patch.value as string
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

export const enableStoreMonitor = (storeHandle: DocHandle<Store>): void => {
    // Monitor for the addition or removal of engines in the store
    storeHandle.on('change', ({ doc, patches }) => {
        for (const patch of patches) {
            log(`StoreMonitor handles the following change: ${deepPrint(patch)}`)
            applyUntilTrue([engineSetMonitor, engineCommandsMonitor, engineLastRunMonitor, instancesMonitor], patch, storeHandle)
        }
    })

    // On startup, process any commands already queued for this engine.
    // The storeMonitor only fires on new patches, so commands written before
    // this engine started (or while it was offline) would otherwise be silently ignored.
    const store = storeHandle.doc()
    if (store?.engineDB[localEngineId]) {
        const pending = [...(store.engineDB[localEngineId].commands as string[])]
        if (pending?.length) {
            log(`Processing ${pending.length} pending command(s) from queue on startup`)
            // Process commands in order, removing each after execution.
            // We process them serially to avoid concurrent state mutations.
            ;(async () => {
                for (let i = 0; i < pending.length; i++) {
                    await handleCommand(commands, storeHandle, 'engine', pending[i])
                    storeHandle.change(doc => {
                        const eng = doc.engineDB[localEngineId as any]
                        // Always remove from index 0 since we process in order
                        if (eng) (eng.commands as any[]).splice(0, 1)
                    })
                }
            })()
        }
    }
}