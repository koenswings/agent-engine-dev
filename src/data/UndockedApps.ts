/**
 * UndockedApps.ts: the startup check that marks this Engine's instances Undocked
 * when their containers are not running (called from start.ts).
 *
 * All Engines share one store (instanceDB, diskDB). An Engine may only judge the
 * instances whose disk is docked on it: the store's disk -> engine relation
 * (Disk.dockedTo, the same relation getDisksOfEngine / getInstancesOfEngine use).
 * The local `docker ps` says nothing about containers on another Pi, so an instance
 * on a disk docked elsewhere, on a disk that is not docked anywhere, on a disk
 * missing from diskDB or with no storedOn is left exactly as it is.
 *
 * A user's Stop survives a restart (idea#176). An instance the operator stopped has
 * no running container by design, so "no container" must not turn it into
 * Undocked: the dock pass (processSystemInstance / createOrUpdateInstance) would
 * then reset Undocked to Docked and tracedStartInstance would auto-start it. The
 * last stopApp operation of the instance says who stopped it:
 *   - an operator stop (console/cli/cross-engine command), or no stop record at
 *     all: the instance stays Stopped and is not auto-started;
 *   - a stop the Engine did itself as one step of a longer operation (backup,
 *     copy, move, disk undock): an interrupted operation, so the instance is
 *     marked Undocked as before and the dock pass starts it again;
 *   - any other status with an operator stop still in force (AutoStart.ts, e.g.
 *     an operator stop interrupted by the restart) and no container: Stopped.
 * The dock pass applies the same rule (shouldAutoStart in tracedStartInstance),
 * so the testMode/dev startup undock + re-add of every disk, a boot where a disk
 * is gone or renamed, and a real unplug + replug keep the Stop too.
 *
 * idea#449: with `systemDiskSkip` set (config.yaml or IDEA_SYSTEM_DISK_SKIP) the system
 * disk gets no dock pass, so an instance on it is never marked Starting (nobody would set
 * it Running again). One that is already Starting (an earlier boot) is set Running when
 * its containers are up and healthy; nothing is started or recreated.
 */
import { $ } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { EngineID, InstanceID } from './CommonTypes.js'
import { isUserStopped, lastStopOperation, shouldAutoStart, userStopInForce } from './AutoStart.js'
import { Instance, Status } from './Instance.js'
import { Store } from './Store.js'
import { localEngineId } from './Engine.js'
import { config } from './Config.js'
import type { Disk } from './Disk.js'
import type { Timestamp } from './CommonTypes.js'

/** True when the instance's disk is docked on `engineId` according to the store. */
export const isInstanceDockedOn = (store: Store, instance: Instance | undefined | null, engineId: EngineID): boolean => {
    if (!instance?.storedOn) return false
    const disk = store.diskDB?.[instance.storedOn]
    if (!disk?.dockedTo) return false
    return String(disk.dockedTo) === String(engineId)
}

// The decision rules live in AutoStart.ts, shared with the dock path (idea#176).
export { USER_CAUSES, USER_STOP_CAUSES, lastStopOperation, lastUserStop, userStopInForce, isUserStopped, shouldAutoStart } from './AutoStart.js'

/** Does this Pi run a container of the instance? (`docker ps -q -f name=<id>`) */
export type ContainerRunningCheck = (instanceId: InstanceID) => Promise<boolean>

const dockerContainerRunning: ContainerRunningCheck = async (instanceId) => {
    const result = await $`docker ps -q -f name=${instanceId}`
    return result.stdout.trim() !== ''
}

/**
 * idea#449: every container of compose project <id> is running and healthy (or has no
 * healthcheck). Read-only: docker ps + inspect, nothing is started or recreated.
 */
export const dockerContainersHealthy: ContainerRunningCheck = async (instanceId) => {
    const ids = (await $`docker ps -aq --filter ${`label=com.docker.compose.project=${instanceId}`}`).stdout.split('\n').map(x => x.trim()).filter(Boolean)
    if (!ids.length) return false
    const info = JSON.parse((await $`docker inspect ${ids}`).stdout) as any[]
    return info.every(c => c?.State?.Status === 'running' && (!c?.State?.Health || c.State.Health.Status === 'healthy'))
}

/** idea#449: the system disk record (its 'system' marker, idea#152). */
export const isSystemDiskMarked = (disk: Pick<Disk, 'diskTypes'> | undefined | null): boolean =>
    !!disk && (disk.diskTypes ?? []).includes('system')

export interface UndockedAppsOptions {
    /** config.settings.systemDiskSkip by default */
    systemDiskSkip?: boolean
    /** dockerContainersHealthy by default */
    containersHealthy?: ContainerRunningCheck
}

/** idea#449: will a dock pass (processDisk → startInstance) re-check this instance after boot? */
export const dockPassWillRun = (store: Store, instance: Instance, systemDiskSkip: boolean): boolean =>
    !(systemDiskSkip && isSystemDiskMarked(instance.storedOn ? store.diskDB?.[instance.storedOn] : null))

export const checkAndSetUndockedApps = async (
    storeHandle: DocHandle<Store>,
    engineId: EngineID = localEngineId,
    containerRunning: ContainerRunningCheck = dockerContainerRunning,
    opts: UndockedAppsOptions = {},
): Promise<void> => {
    const systemDiskSkip = opts.systemDiskSkip ?? !!config.settings.systemDiskSkip
    const containersHealthy = opts.containersHealthy ?? dockerContainersHealthy
    const store = storeHandle.doc()
    const all = Object.values(store.instanceDB ?? {}).filter(Boolean)
    const mine = all.filter(inst => isInstanceDockedOn(store, inst, engineId))
    const others = all.length - mine.length
    if (others > 0) log(`checkAndSetUndockedApps: leaving ${others} instance(s) alone (disk docked on another Engine, not docked, or unknown)`)
    await Promise.all(mine.map(async (instance) => {
        if (instance.status === 'Undocked') return
        const instanceId = instance.id
        if (isUserStopped(store, instance)) {
            const op = lastStopOperation(store, instanceId)
            log(`checkAndSetUndockedApps: leaving instance ${instanceId} Stopped (${op ? `stopped by ${op.cause}` : 'no stop record'}); it is not auto-started`)
            return
        }
        // #167: after a restart, never keep claiming Running for a container nobody has checked yet.
        // Containers present (or docker not answering yet, e.g. right after a reboot): mark the
        // instance Starting; the dock pass (startInstance) then sets Running, or does a full start.
        const markStarting = (why: string) => storeHandle.change(doc => {
            const inst = doc.instanceDB[instanceId]
            if (!inst || inst.status !== 'Running' || !isInstanceDockedOn(doc, inst, engineId)) return
            // Only when the dock pass will start (and so re-check) it; else it would stay Starting.
            if (!shouldAutoStart(doc, inst).start) return
            log(`Setting status of instance ${instanceId} to Starting until the dock pass checks it (${why})`)
            inst.status = 'Starting' as Status
            inst.statusCondition = null
        })
        // idea#449: no dock pass will follow (systemDiskSkip and a system-disk instance), so
        // never mark it Starting; heal one left Starting by an earlier boot when its
        // containers are up and healthy (no start, no recreate).
        const noDockPass = !dockPassWillRun(store, instance, systemDiskSkip)
        const healStarting = async () => {
            let healthy = false
            try { healthy = await containersHealthy(instanceId) } catch (e) {
                log(`checkAndSetUndockedApps: cannot read the container health of ${instanceId} (${e}); leaving it ${instance.status}`)
                return
            }
            if (!healthy) {
                log(`checkAndSetUndockedApps: ${instanceId} stays ${instance.status}: its containers are not all running and healthy, and no dock pass follows (systemDiskSkip)`)
                return
            }
            storeHandle.change(doc => {
                const inst = doc.instanceDB[instanceId]
                if (!inst || inst.status !== 'Starting' || !isInstanceDockedOn(doc, inst, engineId)) return
                log(`Setting status of instance ${instanceId} to Running: its containers are up and healthy and no dock pass follows (systemDiskSkip); nothing was restarted`)
                inst.status = 'Running' as Status
                inst.statusCondition = null
                inst.lastStarted = Date.now() as Timestamp
            })
        }
        try {
            if (await containerRunning(instanceId)) {
                if (!noDockPass) { markStarting('containers found after restart'); return }
                if (instance.status === 'Starting') { await healStarting(); return }
                log(`checkAndSetUndockedApps: leaving ${instanceId} ${instance.status}: it is on the system disk and no dock pass follows (systemDiskSkip)`)
                return
            }
            storeHandle.change(doc => {
                const inst = doc.instanceDB[instanceId]
                // Re-check inside the change: the disk may have been undocked or moved
                // to another Engine (a sync) while docker ps ran.
                if (!inst || inst.status === 'Undocked' || !isInstanceDockedOn(doc, inst, engineId)) return
                if (isUserStopped(doc, inst)) return
                // An operator stop is still in force (e.g. it was interrupted by the
                // restart after its containers stopped): the instance is Stopped.
                const stopOp = userStopInForce(doc, inst)
                if (stopOp) {
                    log(`Setting status of instance ${instanceId} to Stopped (operator stop ${String(stopOp.id).slice(0, 8)} by ${stopOp.cause} is in force; no container on this Engine)`)
                    inst.status = 'Stopped' as Status
                    return
                }
                log(`Setting status of instance ${instanceId} to Undocked (no container on this Engine)`)
                inst.status = 'Undocked' as Status
            })
        } catch (error) {
            log(`Error checking docker status for ${instance.name}: ${error}`)
            if (noDockPass) { log(`checkAndSetUndockedApps: leaving ${instanceId} ${instance.status}: docker is not answering and no dock pass follows (systemDiskSkip)`); return }
            markStarting('docker not answering')
        }
    }))
}
