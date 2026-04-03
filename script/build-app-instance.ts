#! ../../node_modules/.bin/tsx

import { strict as assert } from 'assert';
import { $, argv, chalk, cd, fs } from 'zx'
import { ssh } from '../src/utils/ssh.js'
import pack from '../package.json' with { type: "json" };
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
  console.log(`Builds an instance of an app on the specified disk.`)
  console.log(`Usage: build_app_instance.ts [options] <app>` )
  console.log(`with ` )
  console.log(`  <app> is the name of the app to build an instance of`)
  console.log(`  it must be stored in a repository on github with name app-<appName>`)
  console.log(``)
  console.log(`Options:`)
  console.log(`  -h, --help           display help for command`)  
  console.log(`  --version            output the version number of command`)
  console.log(`  --instance <string>  a user-presented name for the instance (default: <appName>)`)
  console.log(`  --disk <string>      the device name of the mounted disk in which the instance will be created (default: ${defaultDisk})`)
  console.log(`  --git <string>       the git account to pull the app from (default: ${defaults.gitAccount})`)
  console.log(`  --tag <string>       the git tag to pull the app from (default is latest which retrieves the latest version on the main branch)`)
  console.log(``)
  process.exit(0)
}

// Check for the version flag and print the version if requested
if (argv.v || argv.version) {
  console.log(`Version: ${pack.version}`)
  process.exit(0)
}


// Check app argument
const apps = argv._
// if (apps.length == 0) {
//   exitWithError("Error: You must specify one app");
// }
assert(apps.length == 1, "Error: You must specify the app that you want to create an instance of")
const appName = apps[0] as AppName


// Now override the default configuration using the command line
const gitAccount = argv.g || argv.git || defaults.gitAccount
const instanceName = argv.i || argv.instance || appName
const gitTag = argv.t || argv.tag || "latest"
const disk = argv.d || argv.disk || defaultDisk




console.log(`Building instance ${instanceName} of app ${appName} on disk ${disk} from git account ${gitAccount} with tag ${gitTag}...`)

try {

  // Check if the specified disk is in the list of mounted disks
  if (!devices.includes(disk)) {
    exitWithError(`Error: Disk ${disk} not found on this machine`)
  }

  buildInstance(instanceName, appName, gitAccount, gitTag, disk)

} catch (error) {

  exitWithError(`Error when building ${appName}\n${error.message}`);

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

