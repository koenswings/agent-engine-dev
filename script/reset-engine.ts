import { $, argv, chalk, path, cd } from 'zx';
import { ssh } from '../src/utils/ssh.js'
import { config } from '../src/data/Config.js';
import pack from '../package.json' with { type: "json" };
import { addMeta } from '../src/data/Meta.js';

// 1. Handle help and version flags
if (argv.h || argv.help) {
    console.log(`
  Usage: ./reset-engine [options] [engineName1] [engineName2] ...
  
  Resets the data store for one or more engines.

  Arguments:
    engineName      The logical name of the engine to reset (e.g., "engine-1"). 
                    The script will connect to "<engineName>.local".
                    If no engine names are provided, it resets the local machine.

  Options:
    -d, --data          Reset the Automerge data store.
    -i, --identity      Reset the Automerge identity (UUIDs).
    -m, --meta          Reset the META.yaml file (Engine Identity).
    -c, --code          Update to the latest code from GitHub (Hard Reset).
    -a, --all           Perform all of the above.
    -v, --version       Print the version
    -h, --help          Print this help message
  `);
    process.exit(0);
}

if (argv.v || argv.version) {
    console.log(`Version: ${pack.version}`);
    process.exit(0);
}

// 2. Get targets and options
const targets = argv._;

const all = argv.a || argv.all || false;

const options = {
    data: argv.d || argv.data || all || false,
    identity: argv.i || argv.identity || all || false,
    meta: argv.m || argv.meta || all || false,
    code: argv.c || argv.code || all || false
};

if (!options.data && !options.identity && !options.meta && !options.code) {
    console.log(chalk.yellow("No reset options provided. Nothing to do."));
    console.log("Use -h for help to see available options.");
    process.exit(0);
}

// The actual cleanup logic, for a real engine, either local or remote
const cleanup = async (exec: any, target: string, enginePath: string, opts: typeof options) => {
    try {
        if (opts.code) {
            console.log(chalk.blue(`  - Performing full code reset (re-clone) on ${target}...`));
            
            const enginePathClean = enginePath.replace(/\/$/, '');
            const parentDir = path.dirname(enginePathClean);
            const backupDir = `${parentDir}/engine-backup-${Date.now()}`;
            const gitUrl = `https://github.com/${config.defaults.gitAccount}/engine.git`;

            console.log(chalk.blue(`  - Stopping and deleting engine process...`));
            await exec`sudo pm2 delete engine || true`;

            // If running locally, change CWD to parent directory to avoid ENOENT when the current directory is moved
            if (target === 'local engine') {
                console.log(chalk.blue(`  - Changing CWD to ${parentDir} to allow self-move...`));
                cd(parentDir);
            }

            const user = config.defaults.user;

            console.log(chalk.blue(`  - Backing up current engine to ${backupDir}...`));
            await exec`sudo mv ${enginePath} ${backupDir}`;
            await exec`sudo chown -R ${user}:${user} ${backupDir}`;

            console.log(chalk.blue(`  - Cloning fresh repository...`));
            await exec`cd ${parentDir} && sudo git clone ${gitUrl}`;

            console.log(chalk.blue(`  - Setting ownership to ${user}:${user}...`));
            await exec`sudo chown -R ${user}:${user} ${enginePath}`;

            console.log(chalk.blue(`  - Restoring configuration...`));
            await exec`cp ${backupDir}/config.yaml ${enginePath}/`;

            if (!opts.data) {
                console.log(chalk.blue(`  - Restoring store data...`));
                await exec`cp -r ${backupDir}/store-data ${enginePath}/`;
            }
            if (!opts.identity) {
                console.log(chalk.blue(`  - Restoring store identity...`));
                await exec`cp -r ${backupDir}/store-identity ${enginePath}/`;
            }

            if (opts.meta) {
                 console.log(chalk.yellow(`  - Regenerating META file at /META.yaml...`));
                 const hostname = (await exec`hostname`).stdout.trim();
                 await addMeta(exec, hostname, pack.version);
            }

            console.log(chalk.blue(`  - Installing dependencies...`));
            await exec`cd ${enginePath} && pnpm install`;

            console.log(chalk.blue(`  - Building engine...`));
            await exec`cd ${enginePath} && pnpm build`;

            console.log(chalk.blue(`  - Registering and starting engine with PM2...`));
            await exec`cd ${enginePath} && sudo pm2 start pm2.config.cjs`;
            await exec`sudo pm2 save`;

        } else {
            // Standard cleanup (no code reset)
            console.log(chalk.blue(`  - Stopping engine on ${target}...`));
            await exec`sudo pm2 stop engine || true`;

            if (opts.data) await exec`sudo rm -rf ${enginePath}/store-data/*`;
            if (opts.identity) await exec`sudo rm -rf ${enginePath}/store-identity/*`;
            if (opts.meta) {
                 console.log(chalk.yellow(`  - Regenerating META file at /META.yaml...`));
                 const hostname = (await exec`hostname`).stdout.trim();
                 await addMeta(exec, hostname, pack.version);
            }

            console.log(chalk.blue(`  - Rebuilding engine on ${target}...`));
            await exec`cd ${enginePath} && sudo pnpm build`;

            console.log(chalk.blue(`  - Flushing logs on ${target}...`));
            await exec`sudo pm2 flush engine`;
            
            console.log(chalk.blue(`  - Restarting engine on ${target}...`));
            await exec`cd ${enginePath} && sudo pm2 start pm2.config.cjs`;
        }
    } catch (e: any) {
        console.error(chalk.red(`Cleanup failed for ${target}: ${e.message}`));
        throw e;
    }
}

const cleanupDev = async (exec: any, target: string, storePath: string, opts: typeof options) => {
    try {
        if (opts.code) {
            console.log(chalk.yellow("Code reset is not supported in local development mode. Skipping code update."));
        }
        if (opts.data) {
            console.log(chalk.blue(`  - Clearing store data on the local development machine...`));
            await exec`rm -rf ${storePath}/*`;
        }
        if (opts.identity) {
            console.log(chalk.blue(`  - Clearing store identity on the local development machine...`));
            // Assuming identity is in a sibling folder or similar, but for dev we usually just clear data
            // If storeIdentityFolder is defined in config, we could clear it.
            // For now, we'll just log.
        }
        if (opts.meta) {
            console.log(chalk.yellow(`  - Ignoring --meta flag for local development machine (no /META.yaml).`));
        }
        console.log(chalk.blue(`  - Rebuilding engine on ${target}...`));
        await exec`pnpm build`;
    } catch (e: any) {
        console.error(chalk.red(`Cleanup failed for local development machine: ${e.message}`));
    }
}


// Main execution logic
const main = async () => {
    const isDev = config.settings.isDev; // Get isDev from config

    if (targets.length === 0) {
        // Local reset
        // For a local dev machine, NEVER delete the META file.
        // For a local real engine, respect the flag.
        if (isDev) {
            console.log(chalk.green('Performing reset on local development machine...'));
            await cleanupDev($, 'localhost', './store-data', options);
        } else {
            console.log(chalk.green('Performing reset on local engine...'));
            const machine = 'local engine';
            const enginePath = config.defaults.enginePath;
            await cleanup($, machine, enginePath, options);
        }
    } else {
        // Remote reset
        for (const targetName of targets) {
            const machine = `${targetName}.local`;
            console.log(chalk.green(`Performing remote reset on ${machine}...`));
            const user = config.defaults.user;
            const exec = ssh(`${user}@${machine}`);
            const enginePath = config.defaults.enginePath;
            await cleanup(exec, machine, enginePath, options);
        }
    }
    console.log(chalk.green('\nReset script finished.'));
}

main();