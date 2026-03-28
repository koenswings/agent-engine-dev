import { $, chalk, YAML } from 'zx'
import { deepPrint, fileExists, log, stripPartition, uuid } from '../utils/utils.js'
import { DeviceName, DiskID, DiskName, Timestamp, Version } from './CommonTypes.js'
import { config } from './Config.js'

export interface DiskMeta {
  diskId: DiskID         
  // The serial number of the disk or user-assigned iif there is no serial number - We store it so that it easily inspectable
  
  isHardwareId?: boolean 
  // True if the diskId is a hardware id, false if it is a user-assigned id. If this is not present, the diskId has a generated id.
  
  diskName: DiskName     
  // The user-defined name of the disk.  Not necessarily unique
  
  created: Timestamp     
  // The timestamp when the disk was created
  
  version?: Version      
  // Only applicable to Engine Disks - the version of the engine running on the disk
  
  lastDocked: Timestamp  
  // The timestamp when the disk was last docked (for all other disks) or when the engine was last booted (in case of a system disk)
}

// Create a sample META.yaml file for an appdisk with id AA000000000000000724 and a create timestamp corresponding to 2024-12-12 and a lastDocked timestamp corresponding to 2025-01-07
const sampleMeta: DiskMeta = {
  diskId: 'AA000000000000000724' as DiskID,
  isHardwareId: true,
  diskName: 'MyAppDisk' as DiskName,
  created: 1731446400000 as Timestamp,
  lastDocked: 1733673600000 as Timestamp
}

const devMeta: DiskMeta = {
  diskId: 'DevEngine' as DiskID,
  isHardwareId: true,
  diskName: 'DevelopmentEngine' as DiskName,
  created: 1731446400000 as Timestamp,
  lastDocked: 1733673600000 as Timestamp,
  version: '1.0.0' as Version
}

// The corresponding YAML string
// diskId: 'AA000000000000000724'
// isHardwareId: true
// diskName: 'Nextcloud' 
// created:    1731446400000 
// lastDocked: 1733673600000 

export const readMetaUpdateId = async (deviceSpec?: DeviceName): Promise<DiskMeta> => {
  let path
  let device: DeviceName
  // In dev/test mode with no specific device: return devMeta so the engine can start
  // without its own system disk present (prevents process.exit on dev machines / CI).
  // When a deviceSpec IS provided (an app disk), fall through and read the actual
  // META.yaml — but skip hardware ID lookup (see below).
  if ((config.settings.isDev || config.settings.testMode) && !deviceSpec) {
    log(`Running in ${config.settings.isDev ? 'development' : 'test'} mode, returning devMeta`)
    return devMeta
  }
  try {
    if (deviceSpec) {
      path = `/disks/${deviceSpec}/META.yaml`
      device = deviceSpec as DeviceName
    } else {
      path = `/META.yaml`
      device = (await $`findmnt / -no SOURCE`).stdout.split('/')[2].trim() as DeviceName
      //log(`last character of device is ${device[device.length - 1]}`)
    }
    log(`Reading metadata for device ${device} at path ${path}`)

    //log(`Our current dir is ${await $`pwd`} with content ${await $`ls`} and path ${path}`)
    if (await fileExists(path)) {

      // Read the META.yaml file
      const metaContent = (await $`cat ${path}`).stdout.trim()
      const meta: DiskMeta = YAML.parse(metaContent)
      log(`metaContent: ${metaContent}`)
      log(`meta: ${deepPrint(meta)}`)
      let update = false

      // Find the hardware id.
      // In testMode/isDev: skip block device access and use the id from the META file as-is.
      // Fixture disks have isHardwareId: false and a stable generated id — no hardware lookup needed.
      let diskId: DiskID
      if (config.settings.isDev || config.settings.testMode) {
        log(`testMode/isDev: using diskId from META file (${meta.diskId}), skipping hardware id lookup`)
        diskId = meta.diskId
      } else {
        diskId = await readHardwareId(device) as DiskID
        if (!diskId) {
          log(`No hardware id found for device ${device}`)
          if (meta.hasOwnProperty('isHardwareId') && meta.isHardwareId) {
            log(`The disk id in the META file is a hardware id, so must come from another disk. So this disk is a clone and it is cloned onto media without a hardware id. Generating a new hardware id`)
            diskId = uuid() as DiskID
            // Resetting the isHardwareId flag
            meta.isHardwareId = false
          } else {
            log(`The disk id in the META file is a user-assigned id. Keeping it as is`)
            diskId = meta.diskId
          }
        }
      }

      // If the diskId does not match the one in the META file, update it
      if (String(meta.diskId) !== String(diskId)) {
        meta.diskId = diskId
        if (meta.isHardwareId) {
          log(`Found a new hardware id that is different from the one in the META file. Updating disk id to ${diskId}`)
        } else {
          log(`Created a new id that is different from the one in the META file. Updating disk id to ${diskId}`)
        }
        update = true
      }

      // Update the lastDocked timestamp
      meta.lastDocked = new Date().getTime() as Timestamp
      update = true  // Always update the lastDocked timestamp

      // Upgrade older META files that do not have the diskName field
      if (!meta.hasOwnProperty('diskName')) {
        log(`Upgrading older META file format to include diskName field and remove obsolete properties`)
        meta.diskName = diskId.toString() as DiskName
        // Remove the properties engineId and hostname
        // Ignore type checking the next two lines
        // @ts-ignore
        meta.engineId = undefined
        // @ts-ignore
        meta.hostname = undefined
        update = true
      }

      // Update the META file if necessary.
      // Skip in testMode/isDev — writeMeta requires sudo and we don't want to mutate fixtures.
      if (update && !config.settings.isDev && !config.settings.testMode) {
        await writeMeta(meta, path)
      }
      return meta
    } else {
      log(`No META file found at path ${path}. This disk has not yet been touched by the system.`)
      throw new Error(`No META file found at path ${path}`)
    }
  } catch (e) {
    log(`Error reading metadata: ${e}`)
    throw e
  }
}

export const readHardwareId = async (device: DeviceName): Promise<DiskID | undefined> => {
  log(`Reading disk id for device ${device}`)
  try {
    const rootDevice = stripPartition(device)
    log(`Root device is ${rootDevice}`)
    //const model = (await $`lsblk -o MODEL /dev/${rootDevice} --noheadings`).stdout.trim()
    const model = (await $`cat /sys/block/${rootDevice}/device/model`).stdout.trim()
    log(`Model is ${model}`)
    const vendor = (await $`cat /sys/block/${rootDevice}/device/vendor`).stdout.trim()
    log(`Vendor is ${vendor}`)
    if (model === 'Flash Drive FIT') {
      return await readHardwareIdSamsungFIT(device)
    } else if (vendor === 'INTENSO') {
      return await readHardwareIdIntenso(device)
    } else {
      log(`Model ${model} of vendor ${vendor} not recognized`)
      return undefined
    }
  } catch (e) {
    log(`Error reading disk id of device ${device}: ${e}`)
    return undefined
  }
}

export const readHardwareIdSamsungFIT = async (device: DeviceName): Promise<DiskID | undefined> => {
  try {
    const id = (await $`/usr/lib/udev/scsi_id --whitelisted --replace-whitespace --device=/dev/${device}`).stdout.trim()
    log(`ID is ${id}`)  
    return id as DiskID
  } catch (e) {
    log(`Error reading disk id of device ${device}: ${e}`)
    return undefined
  }
}

export const readHardwareIdIntenso = async (device: DeviceName): Promise<DiskID | undefined> => {
  try {
    const hdparm = (await $`which hdparm`).stdout
    log(`hdparm is at ${hdparm}`)
    //const info = (await $`hdparm -I /dev/${device}`).stdout
    //log(`Info is ${info}`)
    const sn = (await $`hdparm -I /dev/${device} | grep 'Serial\ Number'`).stdout
    log(`Serial number is ${sn}`)
    const id = sn.trim().split(':')
    log(`split ID is ${id}`)
    if (id.length === 2) {
      return id[1].trim() as DiskID
    } else {
      log(`Cannot read disk id for device ${device}`)
      return undefined
    }
  } catch (e) {
    log(`Error reading disk id of device ${device}: ${e}`)
    return undefined
  }
}



export const createMeta = async (device: DeviceName, engineVersion: Version | undefined = undefined): Promise<DiskMeta> => {
  // Find the hardware id
  let isHardwareId
  let diskId = await readHardwareId(device) as DiskID
  if (!diskId) {
    diskId = uuid() as DiskID
    isHardwareId = false
  } else {
    isHardwareId = true
  }

  const meta: DiskMeta = {
    diskId: diskId,
    isHardwareId: isHardwareId,
    diskName: diskId.toString() as DiskName,
    created: new Date().getTime() as Timestamp,
    lastDocked: new Date().getTime() as Timestamp
  }
  if (engineVersion) {
    meta.version = engineVersion
  }

  try {
    // Create the META.yaml file
    await writeMeta(meta, `/disks/${device}/META.yaml`)
  } catch (e) {
    console.log(chalk.red('Error creating metadata'));
  }
  return meta
}

const writeMeta = async (meta: DiskMeta, rootPath: string): Promise<void> => {
  log(`Writing metadata ${deepPrint(meta)} to ${rootPath}`)
  try {
    // const enginePath = `/home/pi`
    // Remove the old META file
    // await $`sudo rm -f ${enginePath}/METAtemp.yaml`
    // await $`sudo touch ${enginePath}/METAtemp.yaml`
    // await $`sudo echo 'diskId: ${meta.diskId}' >> ${enginePath}/METAtemp.yaml`
    // await $`sudo echo 'diskName: ${meta.diskName}' >> ${enginePath}/METAtemp.yaml`
    // await $`sudo echo 'created: ${meta.created}' >> ${enginePath}/METAtemp.yaml`
    // await $`sudo echo 'lastDocked: ${meta.lastDocked}' >> ${enginePath}/METAtemp.yaml`
    // if (meta.version) {
    //   await $`sudo echo 'version: ${meta.version}' >> ${enginePath}/METAtemp.yaml`
    // }
    // if (meta.isHardwareId) {
    //   await $`sudo echo 'isHardwareId: true' >> ${enginePath}/METAtemp.yaml`
    // }
    // // Move the META.yaml file to the root directory
    // await $`sudo mv ${enginePath}/METAtemp.yaml ${rootPath}`

    // Generate a temporary file in /home/pi using mktemp
    const tmpFile = (await $`sudo mktemp --suffix=.yaml --tmpdir=/home/pi`).stdout.trim()
    await $`sudo echo 'diskId: ${meta.diskId}' >> ${tmpFile}`
    await $`sudo echo 'diskName: ${meta.diskName}' >> ${tmpFile}`
    await $`sudo echo 'created: ${meta.created}' >> ${tmpFile}`
    await $`sudo echo 'lastDocked: ${meta.lastDocked}' >> ${tmpFile}`
    if (meta.version) {
      await $`sudo echo 'version: ${meta.version}' >> ${tmpFile}`
    }
    if (meta.isHardwareId) {
      await $`sudo echo 'isHardwareId: true' >> ${tmpFile}`
    }
    // Move the META.yaml file to the root directory
    await $`sudo mv ${tmpFile} ${rootPath}`

  } catch (e) {
    console.log(chalk.red('Error writing metadata'))
    console.error(e)
  }
}

export const readRemoteDiskId = async (exec: any): Promise<DiskID | undefined> => {
  log(`Reading disk id remotely`)
  try {
    const rootDevice = (await exec`findmnt / -no SOURCE`).stdout.split('/')[2].trim();
    // First, find the full path to hdparm
    const hdparmPath = (await exec`which hdparm`).stdout.trim();
    if (!hdparmPath) {
      log('hdparm command not found on remote machine.');
      return undefined;
    }
    const sn = (await exec`${hdparmPath} -I /dev/${rootDevice} | grep 'Serial\\ Number'`).stdout;
    const id = sn.trim().split(':');
    if (id.length === 2) {
      const diskId = id[1].trim();
      log(`Remote disk id is ${diskId}`);
      return diskId as DiskID;
    } else {
      log(`Cannot read disk id for device ${rootDevice}`);
      return undefined;
    }
  } catch (e) {
    log(`Error reading disk id of the root device: ${e}`);
    return undefined;
  }
}

export const addMeta = async (exec: any, hostname: string, version: string) => {
  let id = await readRemoteDiskId(exec)
  if (id === undefined) {
    console.log(chalk.yellow(`Disk id is ${id}`));
    console.log(chalk.red('Remote disk has no disk id.  Generating one.'))
    id = uuid() as DiskID
  }
  console.log(chalk.blue('Adding metadata...'));
  try {
    await exec`sudo rm -f /META.yaml`;
    await exec`echo 'diskId: ${id}' | sudo tee -a /META.yaml`;
    await exec`echo 'diskName: ${id}' | sudo tee -a /META.yaml`;
    await exec`echo 'hostname: ${hostname}' | sudo tee -a /META.yaml`;
    await exec`echo 'created: ${new Date().getTime()}' | sudo tee -a /META.yaml`;
    await exec`echo 'version: ${version}' | sudo tee -a /META.yaml`;
    await exec`echo 'lastDocked: ${new Date().getTime()}' | sudo tee -a /META.yaml`;
  } catch (e) {
    console.log(chalk.red('Error adding metadata'));
    console.error(e);
    process.exit(1);
  }
}

// export const readRemoteDiskId = async (exec: any): Promise<DiskID | undefined> => {
//   log(`Reading disk id remotely`)
//   try {
//     const rootDevice = (await exec`findmnt / -no SOURCE`).stdout.split('/')[2].trim();
//     // First, find the full path to hdparm
//     const hdparmPath = (await exec`which hdparm`).stdout.trim();
//     if (!hdparmPath) {
//       log('hdparm command not found on remote machine.');
//       return undefined;
//     }
//     const sn = (await exec`${hdparmPath} -I /dev/${rootDevice} | grep 'Serial\\ Number'`).stdout;
//     const id = sn.trim().split(':');
//     if (id.length === 2) {
//       const diskId = id[1].trim();
//       log(`Remote disk id is ${diskId}`);
//       return diskId as DiskID;
//     } else {
//       log(`Cannot read disk id for device ${rootDevice}`);
//       return undefined;
//     }
//   } catch (e) {
//     log(`Error reading disk id of the root device: ${e}`);
//     return undefined;
//   }
// }

// export const addMeta = async (exec: any, hostname: string, version: string) => {
//   let id = await readRemoteDiskId(exec)
//   if (id === undefined) {
//     console.log(chalk.yellow(`Disk id is ${id}`));
//     console.log(chalk.red('Remote disk has no disk id.  Generating one.'))
//     id = uuid() as DiskID
//   }
//   console.log(chalk.blue('Adding metadata...'));
//   try {
//     await exec`sudo rm -f /META.yaml`;
//     await exec`echo 'diskId: ${id}' | sudo tee -a /META.yaml`;
//     await exec`echo 'diskName: ${id}' | sudo tee -a /META.yaml`;
//     await exec`echo 'hostname: ${hostname}' | sudo tee -a /META.yaml`;
//     await exec`echo 'created: ${new Date().getTime()}' | sudo tee -a /META.yaml`;
//     await exec`echo 'version: ${version}' | sudo tee -a /META.yaml`;
//     await exec`echo 'lastDocked: ${new Date().getTime()}' | sudo tee -a /META.yaml`;
//   } catch (e) {
//     console.log(chalk.red('Error adding metadata'));
//     console.error(e);
//     process.exit(1);
//   }
// }