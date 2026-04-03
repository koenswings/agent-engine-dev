#! ../../node_modules/.bin/tsx

// NOTE: This script is OBSOLETED. The META.yaml file is generated when the first app is put onto it 

import { strict as assert } from 'assert';
import { $, argv, chalk, cd, fs } from 'zx';
import { ssh } from '../src/utils/ssh.js'
import pack from '../package.json' with { type: "json" } 
import { config } from '../src/data/Config.js'
import { buildInstance } from '../src/data/Instance.js';
import { log } from 'console';
import { deepPrint, uuid } from '../src/utils/utils.js';
import { AppName } from '../src/data/CommonTypes.js';


// Configure zx
//$.verbose = false;

const defaults  = config.defaults

const metaPath = '/home/pi'

// Check if there are disks mounted on this machine in which the app can be created
if (!fs.existsSync('/disks')) {
  exitWithError("Error: No disks mounted on this machine")
}
const devices = (await $`ls /disks`).stdout.split('\n')
log(`Disks found on this machine: ${deepPrint(devices)}`)
if ((devices.length == 1) && devices.includes("")) {
  exitWithError("Error: No disks mounted on this machine")
}

// Define the default disk as the first mounted disk on this machine
const defaultDisk = devices[0]


// Check for the help flag and print usage if help is requested
if (argv.h || argv.help) {
  console.log(`Turns a disk into a non-bootable app disk`)
  console.log(`Usage: build-app-disk.ts [options]` )
  console.log(``)
  console.log(`Options:`)
  console.log(`  -h, --help           display help for command`)  
  console.log(`  --version            output the version number of command`)
  console.log(`  --disk <string>      the device name of the mounted disk in which the instance will be created (default: ${defaultDisk})`)
  console.log(`  --name <string>      a name for the disk (default is a generated id)`)
  console.log(``)
  process.exit(0)
}

// Check for the version flag and print the version if requested
if (argv.v || argv.version) {
  console.log(`Version: ${pack.version}`)
  process.exit(0)
}


// OBSOLETED
// META.yaml is auto generated or updated upon inserting the disk
const addMetadata = async (diskName:string, disk:string) => {
  console.log(chalk.blue('Adding metadata...'));
  try {
      // Convert the diskMetadata object to a YAML string 
      // const diskMetadataYAML = YAML.stringify(diskMetadata)
      // fs.writeFileSync('./script/build_image_assets/META.yaml', diskMetadataYAML)
      // // Copy the META.yaml file to the remote machine using zx
      // await copyAsset('META.yaml', '/')
      // await $$`echo '${YAML.stringify(diskMetadata)}' | sudo tee /META.yaml`;

      await $`sudo echo 'hostname: ${diskName}' >> ${metaPath}/META.yaml`
      await $`sudo echo 'created: ${new Date().getTime()}' >> ${metaPath}/META.yaml`
      await $`sudo echo 'diskId: ${diskName}-disk' >> ${metaPath}/META.yaml`
      // Move the META.yaml file to the root directory
      await $`sudo mv ${metaPath}/META.yaml /disks/${disk}/META.yaml`
  } catch (e) {
    console.log(chalk.red('Error adding metadata'));
    console.error(e);
    process.exit(1);
  }
}

const disk = argv.d || argv.disk || defaultDisk
const name = argv.n || argv.name || uuid()
    
console.log(`Building an app disk with name ${name}...`)

try {

  // Check if the specified disk is in the list of mounted disks
  if (!devices.includes(disk)) {
    exitWithError(`Error: Disk ${disk} not found on this machine`)
  }

  await addMetadata(name, disk)

} catch (error) {

  exitWithError(`Error when building appDisk\n${error.message}`);

}

// Log into your favorite registry
// try {
//   // await $`sudo docker login --username ${user} ${registry}`
//   await $`sudo docker login ${registry}`
// } catch (error) {
//     exitWithError(`\nError when logging into ${registry} as user ${user}\n${error.message}`);
//   } 



function exitWithError(errorMessage:string):void {
    console.error(chalk.red(errorMessage));
    process.exit(1);
  }

// void (async function () {
//     const { $ } = await import('zx')
//     await $`ls`;
//   })();

