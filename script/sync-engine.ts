import { $, argv, cd, chalk, fs, question } from 'zx'
import { ssh } from '../src/utils/ssh.js'
import pack from '../package.json' with { type: "json" }
import { config } from '../src/data/Config.js';

const defaults = config.defaults

// Add commandline option to print the version of the script
const { version } = pack
if (argv.v || argv.version) {
  console.log(`Version: ${version}`);
  process.exit(0);
}

// Add commandline option to print the help of the script
if (argv.h || argv.help) {
  console.log(`
  Usage: ./sync-engine.ts [options] [engineName1] [engineName2] ...

  Synchronizes the local codebase to one or more remote engines.

  Arguments:
        engineName      The logical name of the engine to sync to (e.g., "engine-1").
                        The script will connect to "<engineName>.local".

  Options:
    -u, --user <user>            Username to use for SSH connection (uses ${defaults.user} if not provided)
    -c, --clear-store            Clear the store-data directory on the remote engine after syncing.
    -v, --version                Print the version
    -h, --help                   Print the help
  `);
  process.exit(0);
}

const targets = argv._;
if (targets.length === 0) {
  console.error(chalk.red('Error: No engine names provided. Please specify at least one engine to sync to.'));
  console.log('Usage: ./sync-engine [options] [engineName1] [engineName2] ...');
  process.exit(1);
}

// Now override the default configuration using the command line
const user = argv.u || argv.user || defaults.user
const clearStore = argv.c || argv['clear-store'];
const enginePath = config.defaults.enginePath
const storeDataFolder = config.settings.storeDataFolder


// Sync the assets folder to the remote machine
const syncEngine = async () => {
  // First stop all engines
  for (const targetName of targets) {
    const machine = `${targetName}.local`;
    console.log(chalk.green(`\n--- Stopping engine on ${machine} ---`));
    const user = config.defaults.user;
    const $$ = ssh(`${user}@${machine}`);
    try {
      await $$`command -v pm2`;
      await $$`sudo pm2 delete engine` || true;
    } catch (e) {
      console.log(chalk.yellow(`pm2 not found on ${machine}, skipping stop. This is expected on a fresh install.`));
    }
  }
  // Now sync all engines
  for (const targetName of targets) {
    const machine = `${targetName}.local`;
    console.log(chalk.green(`\n--- Syncing to ${machine} ---`));
    const $$ = ssh(`${user}@${machine}`);
    try {
      // Ensure the engine directory exists and has the correct permissions
      console.log(chalk.blue(`Ensuring engine directory exists on ${machine}...`));
      await $$`sudo mkdir -p ${enginePath}`;
      await $$`sudo chown -R ${user}:${user} ${enginePath}`;

      //await $`sshpass -p ${password} rsync -av build_image_assets/ ${user}@${machine}:~/tmp/build_image_assets`;;
      // Warn the user he should stop the engine manually if it is running
      // console.log(chalk.yellow(`Make sure that the engine is not running on the remote machine ${machine} before proceeding!`));

      //console.log(chalk.blue(`Syncing the engine to user ${user} on remote machine ${machine}`))
      //console.log(chalk.blue(`Using command rsync -av --chmod=Du=rwx,Dg=rx,Do=rx,Fu=rw,Fg=r,Fo=r --perms --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='scratchpad' --exclude='.vscode' --exclude='.pnpm-store' --exclude='yjs-db' --exclude='${storeDataFolder}' ./ ${user}@${machine}:${enginePath}`))
      await $`rsync -av --chmod=Du=rwx,Dg=rx,Do=rx,Fu=rw,Fg=r,Fo=r --perms --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='scratchpad' --exclude='.vscode' --exclude='.pnpm-store' --exclude='yjs-db' --exclude='${storeDataFolder}' ./ ${user}@${machine}:${enginePath}`
      //await $`rsync -av --chmod=Du=rwx,Dg=rx,Do=rx,Fu=rw,Fg=r,Fo=r --perms --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='scratchpad' --exclude='.vscode' --exclude='.pnpm-store' --exclude='yjs-db' ./ ${user}@${machine}:${enginePath}`
      // Install the dependencies on the remote machine 
      //console.log(chalk.blue(`Installing dependencies on remote machine`));
      //await $$`cd ${enginePath} && pnpm install`
      console.log(chalk.blue(`Installing dependencies on remote machine`));
      await $$`cd ${enginePath} && pnpm install`
      // Set isDev to false in config.yaml on the remote machine
      console.log(chalk.blue(`Setting isDev to false in config.yaml on remote machine`));
      await $$`sed -i 's/isDev: true/isDev: false/' ${enginePath}/config.yaml`
      // Make scripts executable on the remote machine
      console.log(chalk.blue(`Setting script permissions on remote machine...`));
      await $$`chmod +x ${enginePath}/build-app-instance`;
      await $$`chmod +x ${enginePath}/build-engine`;
      await $$`chmod +x ${enginePath}/build-service`;
      await $$`chmod +x ${enginePath}/check-ws`;
      await $$`chmod +x ${enginePath}/client`;
      await $$`chmod +x ${enginePath}/reset-engine`;
      await $$`chmod +x ${enginePath}/sync-engine`;


      // Now pnpm build and pm2 start engine 
      //await $$`cd ${enginePath} && pnpm build`
      //await $$`cd ${enginePath} && pm2 start engine`
      console.log(chalk.blue(`Building the engine on machine ${machine}`));
      await $$`cd ${enginePath} && sudo pnpm build`;
      if (clearStore) {
        console.log(chalk.yellow(`Clearing store data directory on ${machine}...`));
        await $$`sudo rm -rf ${enginePath}/${storeDataFolder}/*`;
      }
      // Flush the logs
      console.log(chalk.blue(`Flushing the engine logs on machine ${machine}`));
      try {
        await $$`command -v pm2`;
        await $$`sudo pm2 flush engine`;
      } catch (e) {
        console.log(chalk.yellow(`pm2 not found on ${machine}, skipping log flush.`));
      }

      console.log(chalk.green(`--- Successfully synced ${machine} ---`));


    } catch (e) {
      console.error(chalk.red(`--- Failed to sync ${machine} ---`));
      console.error(e);
    }
  }
  // Finally start all engines
  for (const targetName of targets) {
    const machine = `${targetName}.local`;
    console.log(chalk.green(`\n--- Starting engine on ${machine} ---`));
    const user = config.defaults.user;
    const $$ = ssh(`${user}@${machine}`);
    try {
      await $$`command -v pm2`;
      await $$`cd ${enginePath} && sudo pm2 start pm2.config.cjs`;
      await $$`sudo pm2 save`;
    } catch (e) {
      console.log(chalk.yellow(`pm2 not found on ${machine}, skipping start. The build script will handle this.`));
    }
  }
}



await syncEngine()
