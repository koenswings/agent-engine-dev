import { $, argv, chalk, fs, question } from 'zx';
import { ssh } from '../src/utils/ssh.js'

$.verbose = false;
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import pack from '../package.json' with { type: "json" };
import { generateHostName } from '../src/utils/nameGenerator.js';
import { config } from '../src/data/Config.js';
import { buildEngine, setHostname, syncEngine } from '../src/data/Engine.js';
import { addMeta } from '../src/data/Meta.js';

const defaults = config.defaults;



// Main execution logic
const main = async () => {
    // Command line argument parsing
    const user = argv.u || argv.user || defaults.user;
    const machine = argv.m || argv.machine || defaults.machine;
    const hostname = argv.hostname || generateHostName();
    const { version } = pack;

    // Help and version flags
    if (argv.v || argv.version) {
        console.log(`Version: ${version}`);
        process.exit(0);
    }
    if (argv.h || argv.help) {
        console.log(`Builds and provisions a new Raspberry Pi Engine.`)
        console.log(`Usage: ./build-engine [options]`)
        console.log(`Options:`)
        console.log(`  -h, --help              display help for command`)
        console.log(`  -v, --version           output the version number`)
        console.log(`  -u, --user <string>     the SSH user to connect as (default: ${defaults.user})`)
        console.log(`  -m, --machine <string>  the machine hostname or IP address (default: local bootstrap mode)`) // Corrected to reference the local bootstrap mode as default
        console.log(`  --hostname <string>     the hostname to set for the new engine (default: randomly generated)`)
        console.log(`  -l, --language <string> the locale language to set (default: ${defaults.language})`)
        console.log(`  -k, --keyboard <string> the keyboard layout to set (default: ${defaults.keyboard})`)
        console.log(`  -t, --timezone <string> the timezone to set (default: ${defaults.timezone})`)
        console.log(`  --upgrade               whether to perform a system upgrade (default: ${defaults.upgrade})`)
        console.log(`  --argon                 whether to install Argon One support (default: ${defaults.argon})`)
        console.log(`  --zerotier              whether to install ZeroTier (default: ${defaults.zerotier})`)
        console.log(`  --raspap                whether to install RaspAP (default: ${defaults.raspap})`)
        console.log(`  --gadget                whether to enable USB gadget mode (default: ${defaults.gadget})`)
        console.log(`  --temperature           whether to enable temperature monitoring (default: ${defaults.temperature})`)
        console.log(`  --prod                  whether to build in production mode (default: false)`)
        console.log(`  --personalize           only set the hostname and add meta information without building the engine`)
        console.log(``)
        process.exit(0);
    }

    // Mode detection
    let exec: any;
    let enginePath: string;
    const isLocalMode = !argv.machine;

    if (isLocalMode) {
        console.log(chalk.green('Running in Local (Bootstrap) Mode...'));
        exec = $;
        const __filename = fileURLToPath(import.meta.url);
        enginePath = dirname(dirname(__filename)); // Resolves to the project root
    } else {
        console.log(chalk.green(`Running in Remote Mode for ${machine}...`));
        exec = ssh(`${user}@${machine}`);
        enginePath = config.defaults.enginePath;
    }

    // Assemble arguments for the core buildEngine function
    const buildArgs = {
        exec,
        enginePath,
        isLocalMode,
        user,
        machine,
        hostname,
        language: argv.l || argv.language || defaults.language,
        keyboard: argv.k || argv.keyboard || defaults.keyboard,
        timezone: argv.t || argv.timezone || defaults.timezone,
        upgrade: argv.upgrade || defaults.upgrade,
        argon: argv.argon || defaults.argon,
        zerotier: argv.zerotier || defaults.zerotier,
        raspap: argv.raspap || defaults.raspap,
        gadget: argv.gadget || defaults.gadget,
        temperature: argv.temperature || defaults.temperature,
        version: version,
        productionMode: argv.prod || false,
    };

    // Execute the appropriate function based on flags
    if (argv.personalize) {
        await setHostname(exec, hostname);
        await addMeta(exec, hostname, version);
    } else {
        if (!isLocalMode) {
            await syncEngine(user, machine);
        }
        await buildEngine(buildArgs);
    }
    
    console.log(chalk.green(`Script completed successfully.`));
    process.exit(0);
}

await main();
