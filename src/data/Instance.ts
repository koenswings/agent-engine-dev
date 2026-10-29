import { isCommitSha } from './AppIdParse.js'
import { $, YAML, chalk, fs, os, sleep } from "zx";

$.verbose = false;
import { ensureNcAdminPassword } from "./AppSecrets.js";
import { addOrUpdateEnvVariable, deepPrint, log, randomPort, readEnvVariable, uuid, print, isEngineOnline } from "../utils/utils.js";
import { DockerEvents, DockerMetrics, DockerLogs, InstanceID, AppID, PortNumber, ServiceImage, Timestamp, Version, DeviceName, InstanceName, AppName, Hostname, DiskID, OperationCause, EngineID } from "./CommonTypes.js";
import { createOperation, updateOperation } from './Operations.js'
import { composeFileEnv } from './FilesMount.js'
import { Store, getDisk, getEngine, getLocalEngine, getInstancesOfEngine, } from "./Store.js";
import { Disk, diskMountRoot, diskFsRoot, deviceMountRoot } from "./Disk.js";
import { localEngineId } from "./Engine.js";
import { network } from "./Network.js";
import { createAppId } from "./App.js";
import { Docker } from "node-docker-api";
import { createMeta } from '../data/Meta.js'
import { config, disksRoot, skipImageLoad } from '../data/Config.js'
import { DocHandle } from "@automerge/automerge-repo";
import { CommandLogStore, LogEntry, getCommandLogHandle, liveCommandLogHandle, addTrace, closeTrace, flushLogs } from './CommandLogStore.js'
import { getActiveTrace, flushTrace } from '../utils/CommandLogger.js'
import { dockerAvailable } from '../utils/dockerAvailable.js'
import { rebindKolibriMorangoInstanceId } from './InstanceCopy.js'
import { hostIdentity, writeHostIdentityEnv, nextcloudUrl, writeNextcloudUrlEnv, isNextcloudInstance, nextcloudTrustedDomainsBridge, hostNetworkInterfaces } from './HostIdentity.js'
import { trackInFlight, startDiskGoneReason, dockIdentityOf } from './InstanceInFlight.js'

// ── Step-progress helpers ─────────────────────────────────────────────────────

const setStep = (
  storeHandle: DocHandle<Store>,
  instanceId: InstanceID,
  step: number,
  total: number,
  label: string,
  opId?: string,
) => {
  storeHandle.change(doc => {
    const inst = doc.instanceDB[instanceId]
    if (!inst) return
    inst.currentStep = step
    inst.totalSteps = total
    inst.stepLabel = label
  })
  // Mirror step progress into the unified Operation record when provided
  if (opId) {
    updateOperation(storeHandle, opId, {
      currentStep: step,
      totalSteps: total,
      stepLabel: label,
      progressPercent: total > 0 ? Math.round((step / total) * 100) : null,
    })
  }
}

const clearStep = (storeHandle: DocHandle<Store>, instanceId: InstanceID) => {
  storeHandle.change(doc => {
    const inst = doc.instanceDB[instanceId]
    if (!inst) return
    inst.currentStep = null
    inst.totalSteps = null
    inst.stepLabel = null
    inst.metrics = null  // clear live metrics when instance is no longer running
  })
}

// ── Start outcome → command log (idea#109) ───────────────────────────────────

export const START_INSTANCE_COMMAND = 'startInstance'

/**
 * The traceId of the `startInstance` trace this start runs inside (the Console
 * command, or the dock auto-start in Disk.ts), or null when there is none
 * (post-copy, post-move, backup-post-start).
 */
const activeStartTraceId = (handle: DocHandle<CommandLogStore>): string | null => {
  const active = getActiveTrace()
  if (active && active.command === START_INSTANCE_COMMAND && liveCommandLogHandle(handle).doc()?.traces[active.traceId]) {
    return active.traceId
  }
  return null
}

/**
 * Add a start warning (e.g. a service image that could not be loaded from the
 * App Disk) to the start's History entry as a log line with level 'warn'.
 * Inside a `startInstance` trace it is appended right away and true is
 * returned. Otherwise false is returned and the caller keeps the entry for
 * recordInstanceStartWarnings / recordInstanceStartFailure. Never throws.
 */
export const addInstanceStartWarning = async (
  entry: LogEntry,
  handle: DocHandle<CommandLogStore> | null = getCommandLogHandle(),
): Promise<boolean> => {
  if (!handle) return false
  try {
    const traceId = activeStartTraceId(handle)
    if (!traceId) return false
    await flushTrace(traceId)
    flushLogs(handle, traceId, [entry])
    return true
  } catch (e) {
    log(`Could not record a start warning in the command log: ${e}`)
    return false
  }
}

/** A standalone `startInstance` trace for a start that runs outside one. */
const addStandaloneStartTrace = (
  handle: DocHandle<CommandLogStore>,
  instance: Instance,
  disk: Disk,
  cause: OperationCause,
  pendingWarnings: LogEntry[],
): string => {
  const traceId = crypto.randomUUID()
  addTrace(handle, {
    traceId,
    command: START_INSTANCE_COMMAND,
    args: JSON.stringify({ instanceName: instance.name, instanceId: instance.id, diskId: disk.id, cause }),
    startedAt: pendingWarnings[0]?.timestamp ?? Date.now(),
    completedAt: null,
    status: 'running',
    errorMessage: null,
  })
  flushLogs(handle, traceId, pendingWarnings)
  return traceId
}

/**
 * Record a failed instance start in the command log, so it appears in the
 * Console History panel of that instance (the same pattern as the failed
 * `diskDetection` traces of idea#82; the Console matches traces by
 * args.instanceId / args.instanceName).
 *
 * - Inside a `startInstance` trace: that trace is closed with status 'error'.
 *   closeTrace never turns an 'error' trace back into 'ok', so the caller's
 *   own closing call cannot hide the failure.
 * - Otherwise: a completed `startInstance` trace with status 'error' is added,
 *   with args { instanceName, instanceId, diskId, cause } and the pending
 *   warnings as 'warn' log lines.
 *
 * Never throws: recording the failure must not break the caller.
 */
export const recordInstanceStartFailure = async (
  instance: Instance,
  disk: Disk,
  cause: OperationCause,
  message: string,
  pendingWarnings: LogEntry[] = [],
  handle: DocHandle<CommandLogStore> | null = getCommandLogHandle(),
): Promise<void> => {
  if (!handle) return
  try {
    let traceId = activeStartTraceId(handle)
    if (traceId) {
      await flushTrace(traceId)
      flushLogs(handle, traceId, pendingWarnings)
    } else {
      traceId = addStandaloneStartTrace(handle, instance, disk, cause, pendingWarnings)
    }
    closeTrace(handle, traceId, 'error', message)
  } catch (e) {
    log(`Could not record the failed start of instance '${instance.id}' in the command log: ${e}`)
  }
}

/**
 * Record the warnings of a start that succeeded outside a `startInstance`
 * trace: a completed `startInstance` trace with status 'ok' whose logs hold the
 * warnings. Does nothing without warnings. Never throws.
 */
export const recordInstanceStartWarnings = async (
  instance: Instance,
  disk: Disk,
  cause: OperationCause,
  pendingWarnings: LogEntry[],
  handle: DocHandle<CommandLogStore> | null = getCommandLogHandle(),
): Promise<void> => {
  if (!handle || pendingWarnings.length === 0) return
  try {
    let traceId = activeStartTraceId(handle)
    if (traceId) {
      await flushTrace(traceId)
      flushLogs(handle, traceId, pendingWarnings)
      return
    }
    traceId = addStandaloneStartTrace(handle, instance, disk, cause, pendingWarnings)
    closeTrace(handle, traceId, 'ok')
  } catch (e) {
    log(`Could not record the start warnings of instance '${instance.id}' in the command log: ${e}`)
  }
}

/**
 * Set an instance to Error with a diagnosis in statusCondition.
 */
/** Device-node check for a pulled disk; null in testMode (simulated devices). Tests may override. */
let deviceExistsCheck: ((dev: string) => boolean) | null | undefined = undefined
export const setDeviceExistsCheckForTests = (fn: ((dev: string) => boolean) | null | undefined): void => { deviceExistsCheck = fn }
const deviceExists = (): ((dev: string) => boolean) | null =>
  deviceExistsCheck !== undefined ? deviceExistsCheck : (config.settings.testMode ? null : (dev: string) => fs.existsSync(`/dev/${dev}`))

export const markInstanceError = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk, e: unknown): Promise<void> => {
  // hw180: a start that fails because its disk was pulled (undock pending, record undocked or
  // moved, device node gone) is not an app failure: the instance goes to Undocked, never Error.
  const gone = startDiskGoneReason(String(disk.id), disk.device ?? null, dockIdentityOf(storeHandle.doc()?.diskDB?.[disk.id]), deviceExists())
  if (gone) {
    log(`Instance ${instance.id}: start failed because ${gone} — marking Undocked, not Error (${e instanceof Error ? e.message : String(e)})`)
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      if (!inst) return
      inst.status = 'Undocked' as Status
      inst.statusCondition = null
      inst.metrics = null
    })
    return
  }
  const condition = await diagnoseInstance(instance, disk, e)
  storeHandle.change(doc => {
    const inst = doc.instanceDB[instance.id]
    if (!inst) return
    inst.status = 'Error' as Status
    inst.statusCondition = condition
  })
}

// ── Start / stop step definitions ────────────────────────────────────────────
// These are the canonical step labels exposed to the Console.
// Pixel can use these verbatim in a step-based progress window.

export const START_STEPS = [
  'Checking if already running',     // 0  (pre-check, skipped if not needed)
  'Generating port',                  // 1
  'Generating password',             // 2
  'Loading service images',          // 3
  'Creating containers',             // 4
  'Starting containers',             // 5
] as const

export const STOP_STEPS = [
  'Finding containers',              // 0
  'Stopping containers',             // 1
] as const

export const BACKUP_STEPS = [
  'Initialising backup repository',  // 0
  'Stopping app',                    // 1
  'Running backup',                  // 2
  'Restarting app',                  // 3
  'Updating backup index',           // 4
] as const


export interface Instance {
  id: InstanceID;
  instanceOf: AppID;   // Reference by name since we can store the AppMaster object only once in Yjs
  name: InstanceName;
  status: Status;
  statusCondition: string | null;  // Human-readable error diagnosis; null when not in Error state
  port: PortNumber;
  /** Second Engine-allocated host port, only for Apps whose compose references `${port_zip` (agent-engine-dev#267); null/absent otherwise. */
  portZip?: PortNumber | null;
  serviceImages: ServiceImage[];
  created: Timestamp;       // We must use a timestamp number as Date objects are not supported in YJS
  lastBackup: Timestamp | null;  // Unix ms of last successful backup; null if never backed up
  lastStarted: Timestamp;   // We must use a timestamp number as Date objects are not supported in YJS
  storedOn: DiskID | null;  // The disk that this instance is stored on. null if we do not know it yet
  /** Step-based progress for start/stop. Null when no active operation. */
  currentStep: number | null;
  totalSteps: number | null;
  stepLabel: string | null;
  /** Live Docker resource metrics. Null when instance is not Running. */
  metrics: DockerMetrics | null;
  /** Files Disks currently mounted into this instance; written only after a successful compose up (idea#133). */
  filesMounts?: DiskID[] | null;
  /** A newer, offerable bundle of this App on a docked disk (agent-engine-dev#230, console#168 shape); null when none. */
  updateAvailable?: UpdateAvailable | null;
}

export interface UpdateAvailable {
  appId: AppID;
  sourceDiskId?: DiskID;
  sourceEngineId?: EngineID;
  fromVersion?: string;
  toVersion?: string;
  major?: boolean;
  estimatedMinutes?: number;
  sizeBytes?: number;
  migrationNote?: string;
}

export type Status = 'Undocked'      // Disk is not currently docked; instance data is intact on the disk
  | 'Docked'
  | 'Starting'
  | 'Running'
  | 'Pauzed'        // Stopped running but containers are still there (so still consuming resources)
  | 'Stopped'       // Stopped running and containers are removed (so not consuming resources)
  | 'Missing'       // Instance directory no longer found on the disk (deleted or moved to another disk)
  | 'Error';


export const buildInstance = async (instanceName: InstanceName, appName: AppName, gitAccount: string, version: Version, device: DeviceName): Promise<InstanceID | undefined> => {
  print(`Building new instance '${instanceName}' from version ${version} of app '${appName}' on device '${device}' of the local engine.`)

  // CODING STYLE: only use absolute pathnames !
  // CODING STYLE: use try/catch for error handling

  let instanceId

  try {

    // Read the meta file on the disk and extract the disk id
    // Do it
    // const disk = findDiskByDevice(store, getLocalEngine(store), device)
    // if (!disk) {
    //   was-console-log(chalk.red(`Disk ${device} not found on engine ${getLocalEngine(store).hostname}`))
    //   return
    // } else {
    //   instanceId = createInstanceId(instanceName, appName, disk.id).toString() as InstanceID
    //   log(`Instance ID: ${instanceId}`)
    // } 
    const instanceId = createInstanceId(appName).toString() as InstanceID
    // System disk -> '' (/apps, /instances); other disks -> <disksRoot>/<device>
    const root = await deviceMountRoot(String(device))
    const onSystemDisk = root === ''
    log(`buildInstance: target root '${root || '/'}' for device ${device}`)
    log(`Instance ID: ${instanceId}`)


    // Create the app infrastructure if it does not exist
    // TODO: This should be done when creating the disk — https://github.com/koenswings/idea/issues/46
    // TODO: Here we should only be checking if it is an apps disk! — https://github.com/koenswings/idea/issues/46
    if (onSystemDisk) {
      // /apps, /instances, /services may be root-owned on the system disk (idea04).
      // Use exactly the sudoers ENGINE_APPDIRS commands (10-engine) to create them
      // and hand them to pi; the Engine runs as pi and writes into them.
      await $`sudo -n /usr/bin/mkdir -p /apps /instances /services`
      await $`sudo -n /usr/bin/chown pi:pi /apps /instances /services`
    } else {
      await $`mkdir -p ${root}/apps ${root}/services ${root}/instances`
    }

    // **************************
    // STEP 1 - App Type creation
    // **************************

    // Clone the app from the repository
    // Remove /tmp/apps/${typeName} if it exists
    await $`rm -rf /tmp/apps/${appName}`
    let appVersion = ""
    print(`Cloning version ${version} of app ${appName} from git account ${gitAccount}`)
    if (version === "latest") {
      print(`Cloning the latest development version of app ${appName} from git account ${gitAccount}`)
      await $`git clone https://github.com/${gitAccount}/app-${appName} /tmp/apps/${appName}`
      // Set appVersion to the latest commit hash
      const gitLog = await $`cd /tmp/apps/${appName} && git log -n 1 --pretty=format:%H`
      appVersion = gitLog.stdout.trim()
      print(`App version: ${appVersion}`)

    } else {
      print(`Cloning version ${version} of app ${appName} from git account ${gitAccount}`)
      // A branch name may contain '/' (feat/x): the ref goes to git intact as one
      // argument, the folder name of the App master is derived from it (Atlas).
      assertGitRef(version)
      if (isCommitSha(version)) {
        // A commit SHA is not a branch or tag: clone, then check the commit out (Kid, #221)
        await $`git ${['clone', '--', `https://github.com/koenswings/app-${appName}`, `/tmp/apps/${appName}`]}`
        await $`git ${['-C', `/tmp/apps/${appName}`, 'checkout', '--detach', version]}`
      } else {
        await $`git ${appCloneArgs('koenswings', appName, version, `/tmp/apps/${appName}`)}`
      }
      appVersion = versionDirName(version)
      if (appVersion !== version) log(`App ref '${version}' is stored as version '${appVersion}' (folder ${appName}-${appVersion})`)
    }


    // Create the app type
    // Overwrite if it exists
    // We want to copy the content of a directory and rename the directory at the same time: 
    //   See https://unix.stackexchange.com/questions/412259/how-can-i-copy-a-directory-and-rename-it-in-the-same-command
    await $`cp -fr /tmp/apps/${appName}/. ${root}/apps/${appName}-${appVersion}/`


    // **************************
    // STEP 2 - App Instance creation
    // **************************

    // OLD
    // Create the app instance
    // If there is already a instance with the name instanceName, try instanceName-1, instanceName-2, etc.
    // let instanceNumber = 1
    // let baseInstanceName = instanceName 
    // while (true) {
    //   try {
    //     await $`mkdir /disks/${device}/instances/${instanceName}`
    //     break
    //   } catch (e) {
    //     instanceNumber++
    //     instanceName = `${baseInstanceName}-${instanceNumber}` as InstanceName
    //   }
    // }
    // Again use /. to specify the content of the dir, not the dir itself 
    await $`cp -fr /tmp/apps/${appName}/. ${root}/instances/${instanceId}/`




    // If the app has an init_data.tar.gz file, unpack it in the app folder
    if (fs.existsSync(`${root}/instances/${instanceId}/init_data.tar.gz`)) {
      print(`Unpacking the init_data.tar.gz file in the app folder`)
      await $`tar -xzf ${root}/instances/${instanceId}/init_data.tar.gz -C ${root}/instances/${instanceId}`
      // Rename the folder init_data to data
      await $`mv ${root}/instances/${instanceId}/init_data ${root}/instances/${instanceId}/data`
      // Remove the init_data.tar.gz file
      await $`rm ${root}/instances/${instanceId}/init_data.tar.gz`
    }
    // Not needed as Docker will auto-create any data folder we specify in the compose
    // } else {
    //   // Create an empty data folder
    //   await $`mkdir /disks/${device}/instances/${instanceId}/data`
    // }

    // Open the compose.yaml file of the app instance and add the version info to the compose file and the instance name
    print(`Opening the compose.yaml file of the app instance and adding the version info to the compose file (${appVersion}) and the instance name (${instanceName})`)
    const composeFile = await $`cat ${root}/instances/${instanceId}/compose.yaml`
    const compose = YAML.parse(composeFile.stdout)
    compose['x-app'].version = appVersion
    compose['x-app'].instanceName = instanceName
    const composeYAML = YAML.stringify(compose)
    await $`echo ${composeYAML} > ${root}/instances/${instanceId}/compose.yaml`

    // Remove the temporary app folder
    await $`rm -rf /tmp/apps/${appName}`

    // **************************
    // STEP 3 - Persist the services
    // **************************

    // Extract the service images of the services from the compose file, and then pull them and save them in /services
    const services = compose.services
    for (const serviceName in services) {
      const serviceImage = services[serviceName].image
      // Pull the sercice image
      const serviceImageTar = serviceImageTarPath(`${root}`, serviceImage)
      if (fs.existsSync(serviceImageTar)) {
        print(`Service image ${serviceImage} already exists`)
      } else {
        print(`Pulling service image ${serviceImage}`)
        await $`docker image pull ${serviceImage}`
        // Save the service image
        await $`docker save ${serviceImage} > ${serviceImageTar}`
      }
    }

    // **************************
    // STEP 4 - Create the META.yaml file if it is not already there
    // **************************

    if (onSystemDisk) {
      // The system disk's META is /META.yaml, written at image build; never create a second one
      print(`System disk ${device}: using existing /META.yaml`)
    } else if (!fs.existsSync(`${root}/META.yaml`)) {
      log(`Creating META.yaml file on disk ${device}`)
      createMeta(device)
    } else {
      print(`META.yaml file already exists on disk ${device}`)
    }

    // OBSOLETE 
    // Create the META.yaml file
    // Do it
    // await addMetadata(instanceId)
    // was-console-log(chalk.blue('Adding metadata...'));
    // try {
    //     // Convert the diskMetadata object to a YAML string 
    //     // const diskMetadataYAML = YAML.stringify(diskMetadata)
    //     // fs.writeFileSync('./script/build_image_assets/META.yaml', diskMetadataYAML)
    //     // // Copy the META.yaml file to the remote machine using zx
    //     // await copyAsset('META.yaml', '/')
    //     // await $$`echo '${YAML.stringify(diskMetadata)}' | sudo tee /META.yaml`;

    //     const metaPath = ''

    //     // Read the hardware ID if the disk


    //     await $`sudo echo 'created: ${new Date().getTime()}' >> ${metaPath}/META.yaml`
    //     await $`sudo echo 'diskId: ${name}-disk' >> ${metaPath}/META.yaml`
    //     // Move the META.yaml file to the root directory
    //     await $`sudo mv ${metaPath}/META.yaml /META.yaml`
    // } catch (e) {
    //   was-console-log(chalk.red('Error adding metadata'));
    //   console.error(e);
    //   process.exit(1);
    // }



    print(chalk.green(`Instance ${instanceId} built`))
    return instanceId
  } catch (e) {
    print(chalk.red('Error building app instance'))
    console.error(e)
    return undefined
  }
}

/**
 * Path of the saved image tar for a service image on an App Disk:
 * <diskRoot>/services/<image with every / replaced by _>.tar
 * e.g. traefik/whoami:v1 → <diskRoot>/services/traefik_whoami:v1.tar
 * Used both when building an instance (docker save) and when starting it
 * (docker image load), so the two always agree.
 */
export const serviceImageTarPath = (diskRoot: string, serviceImage: string): string =>
  `${diskRoot}/services/${serviceImage.replace(/\//g, '_')}.tar`

export const createInstanceId = (appName: AppName): InstanceID => {
  const id = uuid()
  // return instanceName + "_on_" + diskId as InstanceID
  return appName + "-" + id as InstanceID
}

export const extractAppName = (instanceId: InstanceID): InstanceName => {
  // return instanceId.split('_on_')[0] as InstanceName
  return instanceId.split('-')[0] as InstanceName
}

export const createOrUpdateInstance = async (storeHandle: DocHandle<Store>, instanceId: InstanceID, disk: Disk): Promise<Instance | undefined> => {
  let instance: Instance
  try {
    const composeFile = await $`cat ${await diskMountRoot(disk)}/instances/${instanceId}/compose.yaml`
    const compose = YAML.parse(composeFile.stdout)
    const services = Object.keys(compose.services)
    const servicesImages = services.map(service => compose.services[service].image)
    // const instanceId = createInstanceId(instanceName, disk.id)  
    const instanceName = compose['x-app'].instanceName as InstanceName
    storeHandle.change(doc => {
      const storedInstance: Instance | undefined = doc.instanceDB[instanceId]
      if (!storedInstance) {
        // Create a new instance object
        log(`Creating new instance object ${instanceId} on disk ${disk.id}`)
        instance = {
          id: instanceId,
          instanceOf: createAppId(compose['x-app'].name, compose['x-app'].version) as AppID,
          name: instanceName as InstanceName,
          storedOn: disk.id,
          status: 'Docked' as Status,
          statusCondition: null,
          port: 0 as PortNumber, // Will be set later
          serviceImages: servicesImages as ServiceImage[],
          created: new Date().getTime() as Timestamp,
          lastBackup: null,
          lastStarted: 0 as Timestamp,
          currentStep: null,
          totalSteps: null,
          stepLabel: null,
          metrics: null,
          filesMounts: null,
        }
        doc.instanceDB[instanceId] = instance
      } else {
        // Granularly update the existing instance object
        log(`Updating existing instance object ${instanceId} on disk ${disk.id}`)
        instance = storedInstance
        instance.instanceOf = createAppId(compose['x-app'].name, compose['x-app'].version) as AppID
        instance.name = instanceName as InstanceName
        // Preserve Stopped status — the operator explicitly stopped this instance.
        // Only reset to Docked if the instance was in a transient or detached state
        // (Missing, Undocked, Error) so it can be started again after re-dock.
        // Running / Starting / Stopped are intentional states that must not be overwritten here.
        if (instance.status === 'Missing' || instance.status === 'Undocked' || instance.status === 'Error') {
          instance.status = 'Docked' as Status
        }
        instance.storedOn = disk.id
        instance.serviceImages = servicesImages as ServiceImage[]

      }
    })
    return instance!
  } catch (e) {
    log(chalk.red(`Error initializing instance ${instanceId} on disk ${disk.id}`))
    console.error(e)
    return undefined
  }
}


/**
 * Host ports reserved for Engine / Console on host-network fleets.
 * Prefer A r30: never allocate these to apps (Console serves :8080; :80 legacy/proxy).
 * Live grade5a Kolibri uses :18080 by fixture — that is instance-owned, not reserved here.
 */
export const RESERVED_HOST_PORTS: ReadonlySet<number> = new Set([
  80,
  8080,
])

export const isReservedHostPort = (port: number): boolean => RESERVED_HOST_PORTS.has(port)

/**
 * Prefer A r30: app-kolibri tag 1.0 host-network compose does not wire `${port}` into
 * KOLIBRI_HTTP_PORT / KOLIBRI_LISTEN_PORT (process defaults to 8080 → Console collision).
 * Duration fixtures hardcode 18080. After Engine allocates a free port, keep compose listen
 * env in sync so the container binds the same port Automerge / Console proxy use.
 */
export const syncKolibriHostListenPort = async (composePath: string, port: PortNumber, portZip: PortNumber | null = null): Promise<void> => {
  if (!fs.existsSync(composePath)) return
  const raw = await fs.readFile(composePath, 'utf8')
  let compose: any
  try {
    compose = YAML.parse(raw)
  } catch {
    return
  }
  const services = compose?.services
  if (!services || typeof services !== 'object') return

  let changed = false
  for (const name of Object.keys(services)) {
    const svc = services[name]
    if (!svc || typeof svc !== 'object') continue
    if (svc.network_mode !== 'host') continue
    const img = String(svc.image ?? '')
    const isKolibri = name.includes('kolibri') || img.includes('kolibri')
    if (!isKolibri) continue

    const portStr = String(port)
    const env = svc.environment
    if (Array.isArray(env)) {
      const next = [...env]
      const setEnv = (key: string) => {
        const idx = next.findIndex((e: unknown) => typeof e === 'string' && (e as string).startsWith(`${key}=`))
        const line = `${key}=${portStr}`
        if (idx >= 0) {
          if (next[idx] !== line) { next[idx] = line; changed = true }
        } else {
          next.push(line)
          changed = true
        }
      }
      setEnv('KOLIBRI_HTTP_PORT')
      setEnv('KOLIBRI_LISTEN_PORT')
      if (portZip) {
        const idx = next.findIndex((e: unknown) => typeof e === 'string' && (e as string).startsWith('KOLIBRI_ZIP_CONTENT_PORT='))
        // A `${port_zip…}` reference stays: compose resolves it from .env at every up (#267)
        if (idx < 0 || !String(next[idx]).includes('${port_zip')) {
          const line = `KOLIBRI_ZIP_CONTENT_PORT=${portZip}`
          if (idx < 0) { next.push(line); changed = true } else if (next[idx] !== line) { next[idx] = line; changed = true }
        }
      }
      svc.environment = next
    } else if (env && typeof env === 'object') {
      if (String(env.KOLIBRI_HTTP_PORT ?? '') !== portStr) { env.KOLIBRI_HTTP_PORT = portStr; changed = true }
      if (String(env.KOLIBRI_LISTEN_PORT ?? '') !== portStr) { env.KOLIBRI_LISTEN_PORT = portStr; changed = true }
      if (portZip && !String(env.KOLIBRI_ZIP_CONTENT_PORT ?? '').includes('${port_zip') && String(env.KOLIBRI_ZIP_CONTENT_PORT ?? '') !== String(portZip)) {
        env.KOLIBRI_ZIP_CONTENT_PORT = String(portZip); changed = true
      }
      svc.environment = env
    } else {
      svc.environment = [
        `KOLIBRI_HTTP_PORT=${portStr}`,
        `KOLIBRI_LISTEN_PORT=${portStr}`,
        ...(portZip ? [`KOLIBRI_ZIP_CONTENT_PORT=${portZip}`] : []),
      ]
      changed = true
    }
  }

  if (changed) {
    await fs.writeFile(composePath, YAML.stringify(compose))
    log(`Synced KOLIBRI_HTTP_PORT/KOLIBRI_LISTEN_PORT=${port} in ${composePath}`)
  }
}

/**
 * Prefer A r30: `docker compose up -d` can succeed while a host-network process
 * immediately Exits (e.g. "Port 8080 is occupied"). Probe shortly after up and
 * throw so startInstance marks Error — never Automerge Running with docker missing.
 */
export const assertComposeContainersHealthy = async (instanceDir: string, instanceId: InstanceID): Promise<void> => {
  void instanceDir
  await sleep(2500)
  let psOut = ''
  try {
    const format = '{{.Names}}\t{{.Status}}\t{{.ID}}'
    const r = await $`docker ps -a --filter name=${instanceId} --format ${format}`
    psOut = (r.stdout || '').trim()
  } catch (e) {
    log(`assertComposeContainersHealthy: docker ps failed for ${instanceId}: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  if (!psOut) {
    log(`assertComposeContainersHealthy: no containers matching ${instanceId}`)
    return
  }
  const lines = psOut.split('\n').filter(Boolean)
  const exited: { name: string; status: string; id: string }[] = []
  for (const line of lines) {
    const [name, status, id] = line.split('\t')
    if (!name) continue
    if (/Exited|Dead/i.test(status || '')) {
      exited.push({ name, status: status || '', id: id || '' })
    }
  }
  if (exited.length === 0) return

  const parts: string[] = []
  for (const c of exited) {
    let logs = ''
    try {
      const lr = await $`docker logs --tail 60 ${c.name}`.quiet()
      logs = `${lr.stdout || ''}${lr.stderr || ''}`.trim()
    } catch {
      try {
        const lr = await $`docker logs --tail 60 ${c.id}`.quiet()
        logs = `${lr.stdout || ''}${lr.stderr || ''}`.trim()
      } catch { /* ignore */ }
    }
    const occupied = logs.match(/Port\s+\d+\s+is occupied\.?/i)
    if (occupied) {
      parts.push(`${c.name}: ${occupied[0]} (${c.status})`)
    } else {
      const tail = logs.split('\n').slice(-8).join(' | ')
      parts.push(`${c.name}: ${c.status}${tail ? ` — ${tail}` : ''}`)
    }
  }
  throw new Error(
    `Container(s) exited after compose up for ${instanceId}. ` +
    `Automerge must not stay Running. ${parts.join('; ')}`
  )
}


/**
 * Prefer A r40: after compose up, require the instance host port to accept TCP
 * for a short stable window before Automerge Running. Covers the Kolibri
 * `start && tail -f` pattern where ZeroConfPlugin dies (~8s) but Docker stays
 * Up (r40 FAIL@102). When the port stays dead, force-recreate once and
 * re-probe; still dead → throw (startInstance marks Error).
 */
export const assertInstancePortReady = async (
  instanceId: InstanceID,
  port: number,
  instanceDir: string,
  opts: { readyTimeoutMs?: number; stableMs?: number; forceRecreate?: boolean } = {},
): Promise<void> => {
  if (!port || !Number.isFinite(port) || port <= 0) {
    log(`assertInstancePortReady: no port for ${instanceId}; skipping sidecar probe`)
    return
  }
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000
  const stableMs = opts.stableMs ?? 10_000
  const forceRecreate = opts.forceRecreate !== false

  const probeStable = async (budgetMs: number): Promise<boolean> => {
    const deadline = Date.now() + budgetMs
    let firstReadyAt: number | null = null
    while (Date.now() < deadline) {
      const up = await isEngineOnline('127.0.0.1', port)
      if (up) {
        if (firstReadyAt === null) firstReadyAt = Date.now()
        else if (Date.now() - firstReadyAt >= stableMs) return true
      } else {
        firstReadyAt = null
      }
      await sleep(1000)
    }
    return false
  }

  if (await probeStable(readyTimeoutMs)) {
    log(`assertInstancePortReady: ${instanceId} :${port} stable for ${stableMs}ms`)
    return
  }

  if (forceRecreate) {
    log(`assertInstancePortReady: ${instanceId} :${port} not ready — force-recreate once (r40/r22)`)
    try {
      await $({ cwd: instanceDir } as any)`docker compose up -d --force-recreate`
    } catch (e: any) {
      log(`assertInstancePortReady: force-recreate failed: ${e?.message ?? e}`)
    }
    await assertComposeContainersHealthy(instanceDir, instanceId)
    if (await probeStable(readyTimeoutMs)) {
      log(`assertInstancePortReady: ${instanceId} :${port} stable after force-recreate`)
      return
    }
  }

  // Pull a short log tail to surface ZeroConf / NonUniqueNameException in the Error.
  let hint = ''
  try {
    const format = '{{.Names}}'
    const r = await $`docker ps -a --filter name=${instanceId} --format ${format}`.quiet()
    const name = (r.stdout || '').trim().split('\n').filter(Boolean)[0]
    if (name) {
      const lr = await $`docker logs --tail 40 ${name}`.quiet()
      const logs = `${lr.stdout || ''}${lr.stderr || ''}`
      const m = logs.match(/NonUniqueNameException|ZeroConfPlugin|AttributeError.*name|START_ERROR|Bus state: EXITED/i)
      if (m) hint = ` Last logs mention: ${m[0]}.`
      // Also try kolibri.txt inside the container when present.
      try {
        const kt = await $`docker exec ${name} tail -n 30 /root/.kolibri/logs/kolibri.txt`.quiet()
        const klogs = `${kt.stdout || ''}`
        const km = klogs.match(/NonUniqueNameException|ZeroConfPlugin|AttributeError.*name|START_ERROR/i)
        if (km) hint = ` Kolibri logs: ${km[0]}.`
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  throw new Error(
    `Instance ${instanceId} container is up but host port ${port} never stayed ready ` +
    `for ${stableMs}ms within ${readyTimeoutMs}ms (and after one force-recreate). ` +
    `Automerge must not stay Running with a dead sidecar.${hint} ` +
    `If this is Kolibri after copyApp, the copy likely still shares the original morango ` +
    `instance id (zeroconf NonUniqueNameException); see rebindKolibriMorangoInstanceId.`,
  )
}

export const createPortNumber = async (store: Store, exclude: readonly number[] = []): Promise<PortNumber> => {
  let port = randomPort()
  let portInUse = true
  let portInUseResult
  const localEngine = getLocalEngine(store)
  const instances = getInstancesOfEngine(store, localEngine)

  // Check if the port is already in use on the system / reserved for Console
  while (portInUse) {
    if (isReservedHostPort(port) || exclude.includes(port)) {
      log(`Port ${port} is reserved for Engine/Console or excluded. Generating a new one.`)
      port = randomPort()
      continue
    }
    log(`Checking if port ${port} is in use`)
    try {
      portInUseResult = await $`netstat -tuln | grep -w ${port}`
      log(`Port ${port} is in use`)
      port = randomPort()
    } catch (e) {
      log(`Port ${port} is not in use. Checking if it is reserved by another instance`)
      const inst = instances.find(instance => instance && (instance.port == port || Number(instance.portZip ?? 0) == port))
      if (inst) {
        log(`Port ${port} is reserved by another instance. Generating a new one.`)
        //port++
        port = randomPort()
      } else {
        log(`Port ${port} is not reserved by another instance`)
        portInUse = false
      }
    }
  }
  return port
}

// KSW - UNTESTED >>>
export const checkPortNumber = async (port: PortNumber): Promise<boolean> => {
  log(`Checking if port ${port} is in use`)
  try {
    const portInUseResult = await $`netstat -tuln | grep -w ${port}`
    log(`Port ${port} is in use`)
    return true
  } catch (e) {
    log(`Port ${port} is not in use`)
    return false
  }
}
// KSW - UNTESTED <<<

/**
 * The other instance in the store that owns `port` on this engine (idea#168
 * r35), or undefined. Candidates are the instances on disks docked to this
 * engine, other than `self`, whose stored port equals `port`; a stored port
 * stays with an instance while it is stopped, so a copy can no longer take
 * the port of an original that is down for a moment. When two records claim
 * the same port (data from before this fix), exactly one of them owns it: a
 * Running/Starting claimant, else the older record (created, then id), so the
 * original keeps its port and the newer copy moves.
 */
export const storePortOwner = (store: Store, self: Instance, port: number): Instance | undefined => {
  if (!port) return undefined
  let engine: ReturnType<typeof getLocalEngine>
  try { engine = getLocalEngine(store) } catch { return undefined }
  const me = store.instanceDB?.[self.id] ?? self
  const myCreated = Number(me.created ?? 0)
  return getInstancesOfEngine(store, engine).find(other => {
    if (!other || String(other.id) === String(self.id)) return false
    if (Number(other.port) !== Number(port) && Number(other.portZip ?? 0) !== Number(port)) return false
    if (other.status === 'Running' || other.status === 'Starting') return true
    const otherCreated = Number(other.created ?? 0)
    return otherCreated < myCreated || (otherCreated === myCreated && String(other.id) < String(self.id))
  })
}

/**
 * Decide the host port for a start (step 1 of startInstance) and write it to
 * the instance's .env. Keeps the .env port unless it is listening right now
 * (netstat), reserved for Engine/Console, or owned by another instance in the
 * store on this engine (storePortOwner, idea#168 r35); otherwise, and when the
 * .env has no port (a fresh install or a copy), allocates one with
 * createPortNumber, which skips listening, reserved and store-owned ports.
 */
export const choosePortForStart = async (storeHandle: DocHandle<Store>, instance: Instance, envPath: string): Promise<PortNumber> => {
  let port: PortNumber = 0 as PortNumber
  try {
    log(`Trying to find a port number for instance ${instance.id} in the .env file`)
    port = parseInt(await readEnvVariable(envPath, 'port') as string) as PortNumber
  } catch (e) {
    log(`No .env file found for instance ${instance.id}`)
  }
  if (!(port == 0) && !isNaN(port)) {
    log(`Found a port number for instance ${instance.id} in the .env file: ${port}`)
    // Prefer A r30: if .env port is in use OR reserved (Console :8080), reallocate for
    // every app — including kolibri. idea#168 r35: also when another instance in the
    // store owns it (e.g. the original of a copy, stopped for the snapshot).
    const portInUse = await checkPortNumber(port)
    const portReserved = isReservedHostPort(port)
    const owner = portInUse || portReserved ? undefined : storePortOwner(storeHandle.doc(), instance, port)
    if (portInUse || portReserved || owner) {
      const why = portReserved ? 'reserved for Engine/Console'
        : portInUse ? 'already in use'
        : `owned by instance '${owner!.name}' (${owner!.id}) in the store`
      log(`Port ${port} is ${why}. Generating a new port number.`)
      port = await createPortNumber(storeHandle.doc())
      await addOrUpdateEnvVariable(envPath, 'port', port.toString())
    } else {
      log(`Port ${port} is not in use`)
    }
  } else {
    log(`No port number has previously been generated.`)
    // Prefer A r30: never hardcode kolibri → 8080 (collides with host-net Console).
    log(`Generating a new port number for instance ${instance.id}.`)
    port = await createPortNumber(storeHandle.doc())
    // Write a .env file in which you define the port variable
    await addOrUpdateEnvVariable(envPath, 'port', port.toString())
  }
  return port
}

/** True when compose text references `${port_zip}` or a default form such as `${port_zip:-8081}` (#267). */
export const composeUsesPortZip = (composeText: string): boolean => /\$\{port_zip(?=[}:?+-])/.test(composeText)

/** Write one .env variable atomically (temp file + rename), keeping every other line. */
export const writeEnvVariableAtomic = async (envPath: string, variable: string, value: string): Promise<void> => {
  const text = fs.existsSync(envPath) ? await fs.readFile(envPath, 'utf8') : ''
  const lines = text.split('\n')
  const idx = lines.findIndex(l => l.startsWith(`${variable}=`))
  if (idx >= 0) lines[idx] = `${variable}=${value}`
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push(`${variable}=${value}`, '')
  }
  const tmp = `${envPath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, lines.join('\n'))
  await fs.rename(tmp, envPath)
}

/**
 * Decide `port_zip` for a start (agent-engine-dev#267): null unless the compose references
 * `${port_zip`. Keeps the .env value unless it is listening, reserved, equal to this
 * instance's `port`, or owned (port or portZip) by another instance in the store; else a
 * fresh createPortNumber port that is not `port`. Written atomically to .env next to `port`.
 */
export const choosePortZipForStart = async (
  storeHandle: DocHandle<Store>, instance: Instance, envPath: string, composePath: string, port: PortNumber,
): Promise<PortNumber | null> => {
  const composeText = fs.existsSync(composePath) ? await fs.readFile(composePath, 'utf8') : ''
  if (!composeUsesPortZip(composeText)) return null
  const current = parseInt(await readEnvVariable(envPath, 'port_zip') ?? '') || 0
  if (current > 0 && current !== Number(port) && !isReservedHostPort(current)
    && !storePortOwner(storeHandle.doc(), instance, current) && !(await checkPortNumber(current as PortNumber))) {
    return current as PortNumber
  }
  const zip = await createPortNumber(storeHandle.doc(), [Number(port)])
  await writeEnvVariableAtomic(envPath, 'port_zip', String(zip))
  log(`Allocated port_zip ${zip} for instance ${instance.id}`)
  return zip
}

/**
 * Build a human-readable diagnosis string when an instance fails.
 * Collects: the caught error message + recent docker logs for each service container.
 * Safe to call in a catch block — never throws.
 */
export const diagnoseInstance = async (instance: Instance, disk: Disk, caughtError: unknown): Promise<string> => {
  const parts: string[] = []

  // 1. Engine-level error message
  if (caughtError) {
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError)
    parts.push(`Engine error: ${msg}`)
  }

  // 2. Docker container logs (last 20 lines per service) — whenever Docker answers (idea#168; was !testMode)
  if (await dockerAvailable()) {
    for (const image of (instance.serviceImages ?? [])) {
      // Container name convention: <instanceId>-<serviceName>-1
      // Derive service name from image: last path segment before tag
      const serviceName = image.split('/').pop()?.split(':')[0] ?? 'service'
      const containerName = `${instance.id}-${serviceName}-1`
      try {
        const logs = await $`docker logs --tail=20 ${containerName}`.quiet()
        const output = (logs.stdout + logs.stderr).trim()
        if (output) {
          parts.push(`Container logs (${serviceName}):\n${output.split('\n').map(l => '  ' + l).join('\n')}`)
        }
      } catch { /* container may not exist yet */ }
    }
  }

  return parts.join('\n\n') || 'Unknown error'
}

/**
 * Refuse a git ref that git itself would refuse or that could be read as an
 * option (git check-ref-format rules, simplified). '/' is allowed.
 */
export const assertGitRef = (ref: string): void => {
  const bad = !ref || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') ||
    ref.endsWith('.lock') || ref.includes('..') || ref.includes('//') || ref.includes('@{') ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.split('/').some(c => c.startsWith('.'))
  if (bad) throw new Error(`Invalid app version / git ref '${ref}'`)
}

/** Folder-safe form of a ref for <appName>-<version> (one path component): feat/x → feat-x. */
export const versionDirName = (ref: string): string => {
  const v = ref.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+/, '').replace(/-+$/, '')
  return v || 'ref'
}

/** argv after `git` for cloning one branch/tag of an App repo; the ref is passed unchanged. */
export const appCloneArgs = (gitAccount: string, appName: string, ref: string, dest: string): string[] =>
  ['clone', '--branch', ref, '--', `https://github.com/${gitAccount}/app-${appName}`, dest]

/** #179: every start is tracked in flight on its disk so an eject waits for it to settle. */
export const startInstance = (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk, cause: OperationCause = 'console-command'): Promise<void> =>
  trackInFlight(String(disk.id), `startInstance ${instance.id}`, startInstanceTracked(storeHandle, instance, disk, cause))

const startInstanceTracked = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk, cause: OperationCause = 'console-command'): Promise<void> => {
  const store: Store = storeHandle.doc()
  print(`Starting instance '${instance.id}' on disk ${disk.id} of engine '${localEngineId}'.`)

  // Short-circuit: if containers are already running (e.g. engine restarted while app was up),
  // just update the status to Running and return — no need to recreate containers.
  // Gated on a Docker daemon, not testMode (idea#168: the duration pool runs testMode with real Docker).
  if (await dockerAvailable()) {
    try {
      const ps = await $`docker ps --filter name=${instance.id} --format {{.Names}}`
      if (ps.stdout.trim().length > 0) {
        log(`Instance '${instance.id}' containers already running — updating status to Running`)
        const port = parseInt(await readEnvVariable(`${await diskMountRoot(disk)}/instances/${instance.id}/.env`, 'port') as string) || 0
        storeHandle.change(doc => {
          const inst = doc.instanceDB[instance.id]
          if (!inst) return  // #179: never write to (or resurrect) a deleted row
          inst.status = 'Running' as Status
          inst.statusCondition = null
          if (port > 0) inst.port = port as PortNumber
          inst.lastStarted = Date.now() as Timestamp
        })
        return
      } else {
        log(`Instance '${instance.id}' containers are not running — proceeding with full start`)
      }
    } catch { /* docker not available or no containers — continue with normal start */ }
  }

  const totalStartSteps = START_STEPS.length

  // Create an Operation record so start progress appears in operationDB
  // alongside copy/move/backup ops and is visible to the UI uniformly.
  const startOpId = createOperation(
    storeHandle, 'startApp',
    { instanceId: instance.id, diskId: disk.id },
    cause,
    { type: 'instance', id: instance.id },
  )
  updateOperation(storeHandle, startOpId, { status: 'Running' })

  // Set the instance status to Starting
  log(`Setting instance '${instance.id}' status to Starting`)
  storeHandle.change(doc => {
    const inst = doc.instanceDB[instance.id]
    if (!inst) return  // #179: never write to (or resurrect) a deleted row
    inst.status = 'Starting' as Status
  })

  // Start warnings not yet in a History entry (the start runs outside a
  // startInstance trace); recorded when the start ends.
  const pendingWarnings: LogEntry[] = []
  const startWarning = async (message: string): Promise<void> => {
    log(`Warning while starting instance '${instance.id}': ${message}`)
    const entry: LogEntry = { level: 'warn', message, timestamp: Date.now() }
    if (!(await addInstanceStartWarning(entry))) pendingWarnings.push(entry)
  }

  try {

    const mountRoot = await diskMountRoot(disk)
    log(`Checking instance directory at '${mountRoot}/instances/${instance.id}'`)
    // Verify the instance directory exists on this engine before proceeding.
    // If it doesn't, the disk's data isn't here — fail early with a clear error.
    if (!fs.existsSync(`${mountRoot}/instances/${instance.id}`)) {
      throw new Error(`Instance directory not found at '${mountRoot}/instances/${instance.id}'. The disk may not be docked to this engine.`)
    }
    log(`Instance directory found — proceeding`)
    // Create an empty .env file if it does not yet exist
    if (!fs.existsSync(`${mountRoot}/instances/${instance.id}/.env`)) {
      await $`touch ${mountRoot}/instances/${instance.id}/.env`
    }

    // **************************
    // STEP 1 - Port generation
    // **************************
    setStep(storeHandle, instance.id, 1, totalStartSteps, START_STEPS[1], startOpId)

    // Generate a port  number for the app  and assign it to the variable port
    // Start from port number 3000 and check if the port is already in use by another app
    // The port is in use by another app if an app can be found in networkdata with the same port
    // let port = 3000
    // const instances = getEngineInstances(store, getLocalEngine(store))
    // was-console-log(`Searching for an available port number for instance ${instance.id}. Current instances: ${deepPrint(instances)}.`)
    // while (true) {
    //   const inst = instances.find(instance => instance && instance.port == port)
    //   if (inst) {
    //     port++
    //   } else {
    //     break
    //   }
    // }

    const port = await choosePortForStart(storeHandle, instance, `${mountRoot}/instances/${instance.id}/.env`)

    // Host-network Kolibri must listen on the Engine-allocated port (tag 1.0 omit; fixtures hardcode 18080).
    const portZip = await choosePortZipForStart(storeHandle, instance, `${mountRoot}/instances/${instance.id}/.env`, `${mountRoot}/instances/${instance.id}/compose.yaml`, port)
    await syncKolibriHostListenPort(`${mountRoot}/instances/${instance.id}/compose.yaml`, port, portZip)

    print(`Found a port number for instance ${instance.id}: ${port}`)
    // Assign the port number to the instance object
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      if (!inst) return  // #179: never write to (or resurrect) a deleted row
      inst.port = port as PortNumber
      if (portZip) inst.portZip = portZip
      else if (inst.portZip) inst.portZip = null
    })

    // **************************
    // STEP 2 - Password generation
    // **************************
    setStep(storeHandle, instance.id, 2, totalStartSteps, START_STEPS[2], startOpId)

    // **************************
    // STEP 1b - Generate a password for the app
    // **************************

    let pass: string = ""

    // Check if the pass is already defined in the .env file
    try {
      log(`Trying to find a pass for instance ${instance.id} in the .env file`)
      pass = await readEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'pass') as string
    } catch (e) {
      log(`No .env file found for instance ${instance.id}`)
    }
    // A new instance: no pass before this start (idea#202 keys on this)
    const newInstance = !(pass && !(pass == ""))
    // Check if port is undefined or NaN
    if (pass && !(pass == "")) {
      log(`Found a pass for instance ${instance.id} in the .env file`)
    } else {
      log(`No pass has previously been generated. Generating a new pass.`)
      pass = await uuid()
      log(`Generated a new pass for instance ${instance.id}`)
      // Write the password to the .env file
      await addOrUpdateEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'pass', pass)
    }
    // Separate Nextcloud admin secret, once, for apps whose compose reads it (idea#202)
    await ensureNcAdminPassword(`${mountRoot}/instances/${instance.id}`, newInstance)


    // **************************
    // STEP 3 - Preloading of services
    // **************************
    setStep(storeHandle, instance.id, 3, totalStartSteps, START_STEPS[3], startOpId)

    log(`Preloading the service images of the services from the compose file`)
    // Extract the service images of the services from the compose file, and pull them
    // Open the compose.yaml file of the app instance
    log(`Reading and parsing the compose.yaml file of the app instance`)
    const composeFile = await $`cat ${mountRoot}/instances/${instance.id}/compose.yaml`
    const compose = YAML.parse(composeFile.stdout)
    const services = compose.services
    if (!skipImageLoad()) {
      // Load images from pre-saved tar files on the disk (no internet required).
      // Always on in production; tests turn it on with settings.skipImageLoad = false (idea#81).
      // A missing tar or a failed load does not stop the start (idea#109 follow-up):
      // it becomes a warning in the start's History entry, and compose create/up
      // pull the image if it is not local and the Engine has internet. The start
      // fails only if create or up fails.
      for (const serviceName in services) {
        const serviceImage = services[serviceName].image
        const tarPath = serviceImageTarPath(mountRoot, serviceImage)
        if (!fs.existsSync(tarPath)) {
          await startWarning(`Service image ${serviceImage}: saved image ${tarPath} not found; continuing (Docker pulls the image if it is not local and the Engine has internet)`)
          continue
        }
        log(`Loading the service image ${serviceImage} from ${tarPath}`)
        try {
          await $`docker image load < ${tarPath}`
        } catch (e) {
          const reason = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0]
          await startWarning(`Service image ${serviceImage}: loading ${tarPath} failed (${reason}); continuing (Docker pulls the image if it is not local and the Engine has internet)`)
        }
      }
    } else {
      // Tests by default: fixtures have no tar files — Docker pulls the image at create time if not cached
      log(`skipImageLoad: skipping image load from tar; Docker will pull images as needed`)
    }

    // **************************
    // STEP 4 - Container creation
    // **************************
    setStep(storeHandle, instance.id, 4, totalStartSteps, START_STEPS[4], startOpId)

    await createInstanceContainers(storeHandle, instance, disk)

    // **************************
    // STEP 5 - Run the Instance
    // **************************
    setStep(storeHandle, instance.id, 5, totalStartSteps, START_STEPS[5], startOpId)

    await runInstance(storeHandle, instance, disk)
    updateOperation(storeHandle, startOpId, {
      status: 'Done',
      completedAt: Date.now() as Timestamp,
    })
    await recordInstanceStartWarnings(instance, disk, cause, pendingWarnings)
  }

  catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    print(chalk.red(`Error starting app instance '${instance.id}': ${errMsg}`))
    // Any failure (port, tar load, compose create, compose up) ends in Error,
    // never Running, and is recorded in the command log (idea#109).
    await markInstanceError(storeHandle, instance, disk, e)
    clearStep(storeHandle, instance.id)
    updateOperation(storeHandle, startOpId, {
      status: 'Failed',
      error: errMsg,
      completedAt: Date.now() as Timestamp,
    })
    await recordInstanceStartFailure(instance, disk, cause, errMsg, pendingWarnings)
  }
}


// export const oldStartInstance = async (store: Store, instance: Instance, disk: Disk): Promise<void> => {
//   was-console-log(`Starting instance '${instance.id}' on disk ${disk.id} of engine '${getLocalEngine(store).hostname}'.`)

//   try {



//     // **************************
//     // STEP 1 - Port generation
//     // **************************

//     // Generate a port  number for the app  and assign it to the variable port
//     // Start from port number 3000 and check if the port is already in use by another app
//     // The port is in use by another app if an app can be found in networkdata with the same port
//     // let port = 3000
//     // const instances = getEngineInstances(store, getLocalEngine(store))
//     // was-console-log(`Searching for an available port number for instance ${instance.id}. Current instances: ${deepPrint(instances)}.`)
//     // while (true) {
//     //   const inst = instances.find(instance => instance && instance.port == port)
//     //   if (inst) {
//     //     port++
//     //   } else {
//     //     break
//     //   }
//     // }

//     let port

//     // Find the container
//     log(`Trying to find a running container with the same instance id amongst the following running containers:`)
//     const docker = new Docker({ socketPath: '/var/run/docker.sock' });
//     const containers = await docker.container.list()
//     containers.forEach(container => {
//       was-console-log(container.data['Names'][0])
//     })
//     const container = containers.find(container => container.data['Names'][0].includes(instance.id))
//     if (container) {
//       port = parseInt(container.data['Ports'][0]['PublicPort'])
//       log(`Found a container for instance ${instance.id} running on port ${port}`)
//     } else {
//       // Check if the port is defined in the .env file
//       try {
//         log(`Trying to find a port number for instance ${instance.id} in the .env file`)
//         const envContent = (await $`cat /disks/${disk.device}/instances/${instance.id}/.env`).stdout
//         port = envContent.split('=')[1].slice(0, -1)
//       } catch (e) {
//         log(`No .env file found for instance ${instance.id}`)
//       }
//       if (port) {
//         log(`Found a port number for instance ${instance.id} in the .env file: ${port}`)
//       } else {
//         log(`No container found for instance ${instance.id} and no port number has previously been generated. Generating a new port number.`)
//         // Alternative is to check the system for an occupied port
//         // await $`netstat -tuln | grep ${port}`
//         // port = 3000
//         port = randomPort()
//       }
//     }

//     // Check if the port is already in use on the system
//     let portInUse = true
//     let portInUseResult
//     const instances = getEngineInstances(store, getLocalEngine(store))
//     while (portInUse) {
//       log(`Checking if port ${port} is in use`)
//       try {
//         portInUseResult = await $`netstat -tuln | grep ${port}`
//         log(`Port ${port} is in use`)
//         port++
//       } catch (e) {
//         log(`Port ${port} is not in use. Checking if it is reserved by another instance`)
//         const inst = instances.find(instance => instance && instance.port == port)
//         if (inst) {
//           log(`Port ${port} is reserved by another instance. Generating a new one.`)
//           //port++
//           port = randomPort()
//         } else {
//           log(`Port ${port} is not reserved by another instance`)
//           portInUse = false
//         }
//       }
//     }

//     was-console-log(`Found a port number for instance ${instance.id}: ${port}`)
//     instance.port = port as PortNumber

//     // Update the .env file
//     await addOrUpdateEnvVariable(`/disks/${disk.device}/instances/${instance.id}/.env`, 'port', port.toString())  
//     // await $`echo "port=${port}" > /disks/${disk.device}/instances/${instance.id}/.env`
//     // Do not set the instance port member here - only set it when running the app

//     // **************************
//     // STEP 2 - Preloading of services
//     // **************************

//     // Extract the service images of the services from the compose file, and pull them
//     // Open the compose.yaml file of the app instance
//     const composeFile = await $`cat /disks/${disk.device}/instances/${instance.id}/compose.yaml`
//     const compose = YAML.parse(composeFile.stdout)
//     const services = compose.services
//     for (const serviceName in services) {
//       const serviceImage = services[serviceName].image
//       // Load the service image from the saved tar file
//       await $`docker image load < /disks/${disk.device}/services/${serviceImage.replace(/\//g, '_')}.tar`
//     }

//     // **************************
//     // STEP 3 - Container creation
//     // **************************

//     await createInstanceContainers(store, instance, disk)

//     // **************************
//     // STEP 4 - run the Instance
//     // **************************

//     await runInstance(store, instance, disk)
//   }

//   catch (e) {
//     was-console-log(chalk.red('Error starting app instance'))
//     console.error(e)
//   }
// }

/**
 * Write the Engine hostname and eth0 IPv4 address into an instance .env as the
 * `hostname` and `ip` variables. Applies to every app, not only Nextcloud.
 * A missing hostname or IP is skipped (logged) rather than written empty.
 */
export const writeEngineHostEnv = async (
  envPath: string,
  hostname: string | undefined,
  instanceId: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): Promise<void> => {
  if (hostname) {
    await addOrUpdateEnvVariable(envPath, 'hostname', hostname)
  }
  const ip = interfaces["eth0"]?.find((iface) => iface.family === "IPv4")?.address
  if (ip) {
    log(`Found IP address ${ip} for instance ${instanceId}`)
    await addOrUpdateEnvVariable(envPath, 'ip', ip)
  } else {
    log(chalk.red(`No IP address found for instance ${instanceId}`))
  }
}

/**
 * Create the containers of an instance (`docker compose create`) and set it to
 * Pauzed. Errors propagate to the caller (idea#109): startInstance turns them
 * into Error status and a failed command-log trace.
 */
export const createInstanceContainers = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk): Promise<void> => {
  const store: Store = storeHandle.doc()
  const mountRoot = await diskMountRoot(disk)
  log(`Creating the containers for the services of the app instance`)

  // Every app, every start: tell the instance which Pi it runs on
  // (IDEA_HOSTNAME / IDEA_HOST_IPS, agent-engine-dev#163). Rewritten on each
  // start, so the values follow a moved or copied disk to its new Pi.
  const instanceDir = `${mountRoot}/instances/${instance.id}`
  const envPath = `${instanceDir}/.env`
  const identity = hostIdentity(store)
  await writeHostIdentityEnv(envPath, identity)
  log(`Host identity for instance ${instance.id}: IDEA_HOSTNAME=${identity.hostname} IDEA_HOST_IPS=${identity.ips.join(',')}`)
  // Every app, every start: where this Pi's (or the fleet's) Nextcloud is (#169); '' when none.
  const ncUrl = nextcloudUrl(store, localEngineId, instance.id)
  await writeNextcloudUrlEnv(envPath, ncUrl)
  log(`IDEA_NEXTCLOUD_URL for instance ${instance.id}: ${ncUrl || '(none)'}`)

  // hostname / ip for every app's compose (${hostname}, ${ip}): main's #217
  // writeEngineHostEnv, which replaced this PR's Nextcloud-only block.
  await writeEngineHostEnv(envPath, getLocalEngine(store).hostname, instance.id, hostNetworkInterfaces())

  log(`Creating containers of app instance '${instance.id}' on disk ${disk.id} of engine ${localEngineId}.`)
  try {
    const composeEnv = await composeFileEnv(store, instance)
    const createOpts = composeEnv
      ? { cwd: `${mountRoot}/instances/${instance.id}`, env: { ...process.env, ...composeEnv } }
      : { cwd: `${mountRoot}/instances/${instance.id}` }
    await $(createOpts)`docker compose create`
  } catch (e) {
    print(chalk.red(`Error creating the containers of app instance ${instance.id}`))
    throw e
  }
  storeHandle.change(doc => {
    const inst = doc.instanceDB[instance.id]
    if (!inst) return  // #179: never write to (or resurrect) a deleted row
    inst.status = 'Pauzed' as Status
  })
}



/**
 * Start the containers of an instance (`docker compose up -d`) and set it to
 * Running. Running is written only after `compose up` has succeeded (idea#109):
 * an instance never shows Running while its containers failed to start.
 * Errors from `compose up` propagate to the caller, which sets Error
 * (startInstance also records a failed command-log trace).
 */
export const runInstance = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk): Promise<void> => {
  const store: Store = storeHandle.doc()
  const mountRoot = await diskMountRoot(disk)

  log(`Running instance '${instance.id}' on disk ${disk.id} of engine '${localEngineId}'.`)

  const port = await readEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'port')
  print(`Ports: ${deepPrint(port)}`)
  if (port) {
    const parsedPort = parseInt(port)
    // If parsedPort is not NaN, assign it to the instance port
    if (!isNaN(parsedPort)) {
      log(`Port number extracted from .env file for instance ${instance.id}: ${parsedPort}`)
      storeHandle.change(doc => {
        const inst = doc.instanceDB[instance.id]
        if (!inst) return  // #179: never write to (or resurrect) a deleted row
        inst.port = parsedPort as PortNumber
      })
    } else {
      log(chalk.red(`Error parsing port number from .env file for instance ${instance.id}: the port variable is not a number`))
    }
  } else {
    log(chalk.red(`Error extracting port number from .env file for instance ${instance.id}`))
  }

  // Guard: the disk must still be docked and the instance not Undocked. A stale
  // startInstance from a previous run may reach this point after the disk has
  // been undocked (or the instance moved to Undocked by a test teardown).
  const stillStartable = (when: string): boolean => {
    const snap = storeHandle.doc()
    const currentDisk = snap?.diskDB[disk.id as any]
    const currentInst = snap?.instanceDB[instance.id as any]
    if (!currentDisk || !currentDisk.dockedTo) {
      log(`Disk ${disk.id} is no longer docked ${when} — skipping Running status update for ${instance.id}`)
      return false
    }
    if (currentInst?.status === 'Undocked') {
      log(`Instance ${instance.id} is already Undocked ${when} — skipping Running status update`)
      return false
    }
    return true
  }
  if (!stillStartable('before compose up')) return

  // r40: Kolibri copyApp leaves .idea-rebind-morango so we mint a fresh morango
  // instance id before the first advertise (zeroconf NonUniqueNameException).
  {
    const home = `${mountRoot}/instances/${instance.id}`
    const markers = [
      `${home}/data/kolibri/.idea-rebind-morango`,
      `${home}/.idea-rebind-morango`,
    ]
    const hit: string[] = []
    for (const m of markers) { if (await fs.pathExists(m)) hit.push(m) }
    if (hit.length) {
      try {
        await rebindKolibriMorangoInstanceId(home)
        for (const m of hit) await fs.remove(m).catch(() => undefined)
      } catch (e: any) {
        throw new Error(`Kolibri morango rebind before start failed: ${e?.message ?? e}`)
      }
    }
  }

  // Compose up the app. A failure throws and the instance never becomes Running.
  // Opted-in Apps get COMPOSE_FILE=compose.yaml:<override> (idea#133).
  let mountedDiskIds: DiskID[] | null = null
  try {
    const composeEnv = await composeFileEnv(store, instance)
    const upOpts = composeEnv
      ? { cwd: `${mountRoot}/instances/${instance.id}`, env: { ...process.env, ...composeEnv } }
      : { cwd: `${mountRoot}/instances/${instance.id}` }
    await $(upOpts)`docker compose up -d`
    // Prefer A r30: fail loud if host-net process Exits immediately (port occupied, etc.)
    await assertComposeContainersHealthy(`${mountRoot}/instances/${instance.id}`, instance.id)
    // Prefer A r40: container Up is not enough (Kolibri start&&tail; ZeroConf death).
    const readyPort = storeHandle.doc()?.instanceDB?.[instance.id]?.port
      ?? (port && !isNaN(parseInt(port)) ? parseInt(port) : 0)
    await assertInstancePortReady(
      instance.id,
      Number(readyPort) || 0,
      `${mountRoot}/instances/${instance.id}`,
    )
    if (composeEnv && store.appDB[instance.instanceOf]?.filesMount) {
      // filesMounts only after success — read back from the override we just wrote
      const { mountableFilesDisks } = await import('./FilesMount.js')
      mountedDiskIds = mountableFilesDisks(store).map(d => d.id)
    }
  } catch (e) {
    print(chalk.red(`Error running app instance ${instance.id}`))
    throw e
  }

  // The disk may have been undocked while compose up ran.
  if (!stillStartable('after compose up')) return
  storeHandle.change(doc => {
    const inst = doc.instanceDB[instance.id]
    if (!inst) return  // #179: never write to (or resurrect) a deleted row
    inst.lastStarted = new Date().getTime() as Timestamp
    inst.status = 'Running' as Status
    inst.statusCondition = null  // clear any previous error diagnosis
    if (mountedDiskIds) inst.filesMounts = mountedDiskIds
  })

  print(chalk.green(`App ${instance.id} running`))
  clearStep(storeHandle, instance.id)
  // idea#193 §4: reconcile USB stick storages once the App runs (x-app.usbMount.sync)
  if (storeHandle.doc()?.appDB?.[instance.instanceOf]?.usbMount?.sync) {
    const { syncUsbApps } = await import('./UsbSticks.js')
    void syncUsbApps(storeHandle, 'start', true, instance.id)
  }

  // Nextcloud post-start bridge. TODO-remove (agent-engine-dev#163) once every
  // disk's app-nextcloud carries before-starting/20-idea-trusted-domains.sh.
  // Sets the full trusted_domains list for this Pi (same managed-key algorithm as
  // the hook, so it is a no-op after the hook ran) and the Collabora wopi_url.
  // No fixed wait (the port-ready probe already ran) and never marks Error: a
  // failing occ only logs. Replaces the old `*.local:*` / `192.168.0.*:*` hack.
  if (await isNextcloudInstance(`${mountRoot}/instances/${instance.id}`)) {
    const ip = await readEnvVariable(`${mountRoot}/instances/${instance.id}/.env`, 'ip')
    await nextcloudTrustedDomainsBridge(instance.id, hostIdentity(storeHandle.doc() ?? store), undefined, ip || undefined)
  }
}

export const stopInstance = async (storeHandle: DocHandle<Store>, instance: Instance, disk: Disk, cause: OperationCause = 'console-command'): Promise<void> => {
  print(`Stopping app '${instance.id}' on disk '${disk.id}' of engine '${localEngineId}'.`)

  // Old implementation using Docker Compose
  // Problem with this approach: stopping an instance is not possible when its disk has already been removed
  // try {
  //   // Compose stop the app
  //   // Do it
  //   // await $`docker compose -f /disks/${disk.device}/instances/${instance.id}/compose.yaml stop`
  //   await $`cd /disks/${disk.device}/instances/${instance.id} && docker compose down`
  //   was-console-log(chalk.green(`App ${instance.id} stopped`))
  // } catch (e) {
  //   was-console-log(chalk.red(`Error stopping app instance ${instance.id}`))
  //   console.error(e)
  // }

  const totalStopSteps = STOP_STEPS.length

  // Create an Operation record so stop progress appears in operationDB uniformly
  const stopOpId = createOperation(
    storeHandle, 'stopApp',
    { instanceId: instance.id, diskId: disk.id },
    cause,
    { type: 'instance', id: instance.id },
  )
  updateOperation(storeHandle, stopOpId, { status: 'Running' })

  // New implementation using Docker API
  try {
    setStep(storeHandle, instance.id, 0, totalStopSteps, STOP_STEPS[0], stopOpId)
    // Find all containers running in the compose started by the instance
    // NOTE: this implementation requires all containers of an instance to be namespaced with the instance id
    log(`Filter for all running containers whose names start with the instance id`)
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });
    const containers = await docker.container.list()
    const instanceContainers = containers.filter(container => {
      const name = container.data['Names'][0]
      return name.startsWith(`/${instance.id}-`) || name.startsWith(`/${instance.id}_`)
    })
    // Log the containers
    log(`Found the following containers:`)
    instanceContainers.forEach(container => {
      log(container.data['Names'][0])
    })
    setStep(storeHandle, instance.id, 1, totalStopSteps, STOP_STEPS[1], stopOpId)
    for (let container of instanceContainers) {
      // First try to stop the container gracefully  If that does not work, kill it  
      try {
        log(`Stopping container ${container.data['Names'][0]} for instance ${instance.id}`)
        await container.stop()
        log(`Stopped container for instance ${instance.id}`)
      } catch (e) {
        log(`Error stopping container for instance ${instance.id}. Killing it instead.`)
        await container.kill()
        log(`Killed container for instance ${instance.id}`)
      }
    }
    // Set the status of the instance to Stopped
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      if (!inst) return  // #179: never write to (or resurrect) a deleted row
      inst.status = 'Stopped' as Status // Set the status to Stopped when the instance is stopped
    })
    clearStep(storeHandle, instance.id)
    updateOperation(storeHandle, stopOpId, {
      status: 'Done',
      completedAt: Date.now() as Timestamp,
    })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    print(chalk.red(`Error stopping app instance ${instance.id}`))
    console.error(e)
    const condition = await diagnoseInstance(instance, disk, e)
    storeHandle.change(doc => {
      const inst = doc.instanceDB[instance.id]
      if (!inst) return  // #179: never write to (or resurrect) a deleted row
      inst.status = 'Error' as Status
      inst.statusCondition = condition
    })
    clearStep(storeHandle, instance.id)
    updateOperation(storeHandle, stopOpId, {
      status: 'Failed',
      error: errMsg,
      completedAt: Date.now() as Timestamp,
    })
  }
}
