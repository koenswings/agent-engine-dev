/**
 * ChannelBuilderAutoStart.ts: the Engine starts the channel builder when a teacher
 * stick with a kolibri folder is mounted (idea#193 §8.2a, decided by Koen 2026-10-14).
 *
 * A deliberate, narrow exception to "the Engine starts apps only on operator
 * command" (AutoStart.ts covers disk docks):
 *   - only the App named kolibri-channel-builder (CHANNEL_BUILDER_APP_NAME), never a list;
 *   - only on the mount of a FAT/exFAT stick with a top-level kolibri folder on
 *     THIS Engine (UsbSticks.addStick); ext4 docks and startup cleanup never call it;
 *   - only an instance on a disk docked to this Engine; several → most recent lastStarted;
 *   - only from Docked (or Error: one try per trigger). Stopped / Pauzed, or an
 *     operator stop in force (userStopInForce), mean someone chose that: no start;
 *   - through the normal startInstance, cause 'usb-stick', under the instance lock
 *     (no second start while one runs), with a startInstance command trace;
 *   - never stops the builder afterwards; kill switch settings.autoStartChannelBuilder.
 */
import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from './Store.js'
import type { Instance } from './Instance.js'
import type { ChannelBuilderAutoStartResult, UsbStickPublic } from './Engine.js'
import { autoStartChannelBuilder } from './Config.js'
import { userStopInForce } from './AutoStart.js'
import { extractAppName } from './App.js'
import { resourceLock, instanceKey } from '../utils/ResourceLock.js'
import { log } from '../utils/utils.js'

export const CHANNEL_BUILDER_APP_NAME = 'kolibri-channel-builder'

export interface BuilderDecision {
    result: ChannelBuilderAutoStartResult | 'start'
    instance?: Instance
    reason: string
}

const appNameOf = (store: Store, inst: Instance): string =>
    String(store.appDB?.[inst.instanceOf]?.name ?? extractAppName(inst.instanceOf))

/** Builder instances on disks docked to this Engine (not Undocked/Missing). */
export const dockedBuilderInstances = (store: Store, engineId: string): Instance[] =>
    Object.values(store.instanceDB ?? {}).filter(inst => {
        if (!inst || inst.status === 'Undocked' || inst.status === 'Missing') return false
        if (appNameOf(store, inst) !== CHANNEL_BUILDER_APP_NAME) return false
        const disk = inst.storedOn ? store.diskDB[inst.storedOn] : null
        return !!disk && disk.dockedTo === engineId && !!disk.device
    })

/** Pure decision (no Docker, no store writes). */
export const decideBuilderAutoStart = (store: Store, engineId: string, enabled: boolean): BuilderDecision => {
    if (!enabled) return { result: 'disabled', reason: 'settings.autoStartChannelBuilder is false' }
    const all = dockedBuilderInstances(store, engineId)
    if (all.length === 0) return { result: 'noBuilder', reason: 'no kolibri-channel-builder instance docked on this Engine' }
    const inst = all.reduce((a, b) => ((b.lastStarted ?? 0) > (a.lastStarted ?? 0) ? b : a))
    if (inst.status === 'Running' || inst.status === 'Starting') return { result: 'alreadyRunning', instance: inst, reason: `status is ${inst.status}` }
    const stop = userStopInForce(store, inst)
    if (stop) return { result: 'operatorStopped', instance: inst, reason: `stopped by the operator (${stop.cause})` }
    if (inst.status === 'Stopped' || inst.status === 'Pauzed') return { result: 'operatorStopped', instance: inst, reason: `status is ${inst.status}` }
    if (inst.status === 'Docked' || inst.status === 'Error') return { result: 'start', instance: inst, reason: `status is ${inst.status}` }
    return { result: 'notStartable', instance: inst, reason: `status is ${inst.status}` }
}

export interface AutoStartDeps {
    engineId: () => Promise<string>
    start: (storeHandle: DocHandle<Store>, instance: Instance, stick: UsbStickPublic) => Promise<void>
}

const defaultDeps: AutoStartDeps = {
    engineId: async () => (await import('./Engine.js')).localEngineId,
    start: async (storeHandle, instance, stick) => {
        const { startInstance } = await import('./Instance.js')
        const { getCommandLogHandle, addTrace, closeTrace } = await import('./CommandLogStore.js')
        const { runWithTrace } = await import('../utils/CommandLogger.js')
        const disk = storeHandle.doc().diskDB[instance.storedOn!]
        const traceId = crypto.randomUUID()
        const args = JSON.stringify({ instanceName: instance.name, diskId: disk.id, reason: `auto-start: usb stick ${stick.stickId} with kolibri folder` })
        const h = getCommandLogHandle()
        if (h) addTrace(h, { traceId, command: 'startInstance', args, startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
        try {
            await runWithTrace({ traceId, command: 'startInstance', args }, () => startInstance(storeHandle, instance, disk, 'usb-stick'))
            if (h) closeTrace(h, traceId, 'ok')
        } catch (e: any) {
            if (h) closeTrace(h, traceId, 'error', e?.message ?? String(e))
            throw e
        }
    },
}
let deps: AutoStartDeps = defaultDeps
/** Tests only; null restores. */
export const setBuilderAutoStartDepsForTests = (d: Partial<AutoStartDeps> | null): void => {
    deps = d ? { ...defaultDeps, ...d } : defaultDeps
}

/** §8.2a: called by UsbSticks.addStick for a stick with hasKolibriFolder. */
export const autoStartChannelBuilderForStick = async (
    storeHandle: DocHandle<Store>,
    stick: UsbStickPublic,
): Promise<ChannelBuilderAutoStartResult> => {
    if (!stick.hasKolibriFolder) return 'notStartable'
    const decision = decideBuilderAutoStart(storeHandle.doc(), await deps.engineId(), autoStartChannelBuilder())
    if (decision.result !== 'start') {
        log(`auto-start: usb stick ${stick.stickId} with kolibri folder: not starting the channel builder (${decision.result}: ${decision.reason})`)
        return decision.result
    }
    const inst = decision.instance!
    const key = instanceKey(inst.id)
    if (!resourceLock.acquire(key, 'startApp')) {
        log(`auto-start: usb stick ${stick.stickId}: channel builder ${inst.id} is busy (${resourceLock.getLockInfo(key)?.kind}); not starting`)
        return 'busy'
    }
    try {
        log(`auto-start: usb stick ${stick.stickId} with kolibri folder: starting channel builder ${inst.id} (${decision.reason})`)
        await deps.start(storeHandle, inst, stick)
        const after = storeHandle.doc().instanceDB[inst.id]?.status
        return after === 'Error' ? 'failed' : 'started'
    } catch (e: any) {
        log(`auto-start: usb stick ${stick.stickId}: starting channel builder ${inst.id} failed: ${e?.message ?? e}`)
        return 'failed'
    } finally {
        resourceLock.release(key)
    }
}
