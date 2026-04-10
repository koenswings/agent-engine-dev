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

// Track which commands are currently in-flight, keyed by engineId + command string.
// Commands for different instances can execute concurrently; commands for the same
// engine still execute serially (queue[0] is always processed next).
const _currentlyExecuting = new Set<string>()

const engineCommandsMonitor = (patch, storeHandle): boolean => {
    const isCommandPath =
        patch.path.length >= 3 &&
        patch.path[0] === 'engineDB' &&
        typeof patch.path[1] === 'string' &&
        patch.path[2] === 'commands'

    if (!isCommandPath) return false

    const engineId = patch.path[1] as EngineID
    if (engineId !== localEngineId) return true

    const doc = storeHandle.doc()
    const queue = doc?.engineDB[engineId as any]?.commands as string[] | undefined
    if (!queue?.length) return true

    const command = queue[0]
    if (!command || !command.includes(' ')) return true

    // Use engineId+command as the dedup key so a new command with the same text
    // (but on a different instance) can still run concurrently.
    const key = `${engineId}:${command}`
    if (_currentlyExecuting.has(key)) return true

    _currentlyExecuting.add(key)
    log(`Processing command for engine ${engineId}: ${command}`)
    handleCommand(commands, storeHandle, 'engine', command).then(() => {
        _currentlyExecuting.delete(key)
        storeHandle.change(doc => {
            const eng = doc.engineDB[engineId as any]
            if (eng) (eng.commands as any[]).splice(0, 1)
        })
    })
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
    // Replay any commands already in the queue at startup.
    const startupStore = storeHandle.doc()
    const startupCmds = [...((startupStore?.engineDB[localEngineId]?.commands as string[]) ?? [])]
    if (startupCmds.length) {
        log(`Replaying ${startupCmds.length} pending command(s) from queue on startup`)
        ;(async () => {
            for (const cmd of startupCmds) {
                const startupKey = `${localEngineId}:${cmd}`
                _currentlyExecuting.add(startupKey)
                await handleCommand(commands, storeHandle, 'engine', cmd)
                _currentlyExecuting.delete(startupKey)
                storeHandle.change(doc => {
                    const eng = doc.engineDB[localEngineId as any]
                    if (eng) (eng.commands as any[]).splice(0, 1)
                })
            }
        })()
    }
}