import { $, argv, chalk, fs, question } from 'zx';
import { ssh } from '../src/utils/ssh.js'

$.verbose = false;
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import pack from '../package.json' with { type: "json" };
import { realStickerNameDeps, resolveStickerName, stickerText, writeStickerFile } from '../src/install/stickerName.js';
import { config } from '../src/data/Config.js';
import { buildEngine, setHostname, syncEngine } from '../src/data/Engine.js';
import { addMeta } from '../src/data/Meta.js';
import { parseBoolFlag, parseModel, resolveGadget } from '../src/utils/cliFlags.js';
import { judgeSource, setKeys, SourceState } from '../src/install/deploymentRecord.js';

const defaults = config.defaults;

/** Read the source state of the local checkout this build syncs from (idea#322). */
const readSourceState = async (repo: string): Promise<SourceState> => {
    const q = async (cmd: string[]) => (await $({ cwd: repo, nothrow: true })`git ${cmd}`).stdout.trim()
    await $({ cwd: repo, nothrow: true })`git fetch -q origin main --tags`
    const commit = await q(['rev-parse', 'HEAD'])
    const tags = (await q(['tag', '--points-at', 'HEAD'])).split('\n').filter(Boolean)
    const dirty = (await q(['status', '--porcelain', '--untracked-files=no'])) !== ''
    const onMain = (await $({ cwd: repo, nothrow: true })`git merge-base --is-ancestor HEAD origin/main`).exitCode === 0
    return { commit, tags, dirty, onMain }
}

/**
 * Capture the deployment record on the target (read-only script) and copy it into
 * the idea repo checkout at <ideaRepo>/deployments/engines/<hostname>/<label>/
 * (schema idea-deployment-record/1, idea deployments/README.md), with the build's
 * source verdict and non-secret build options appended (idea#322). Without an
 * idea checkout it stays in /tmp on this machine and the path is printed.
 */
const captureDeploymentRecord = async (exec: any, enginePath: string, repo: string, isLocalMode: boolean,
                                       user: string, machine: string, hostname: string, ideaRepo: string | undefined,
                                       batch: string, extra: string[]) => {
    const label = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    const remoteOut = `/tmp/idea-record-${hostname}-${label}`
    await exec`bash ${enginePath}/script/capture-engine-record.sh --engine-dir ${enginePath} --out ${remoteOut} --label ${label} --batch ${batch}`
    const haveIdea = !!ideaRepo && fs.existsSync(`${ideaRepo}/deployments`)
    if (!haveIdea) console.log(chalk.yellow(`No idea repo checkout with deployments/ (--idea-repo / IDEA_REPO_DIR); keeping the record in /tmp`))
    const dest = haveIdea ? `${ideaRepo}/deployments/engines/${hostname}/${label}` : `/tmp/idea-deployment-${hostname}-${label}`
    await fs.mkdirp(dest)
    if (isLocalMode) await $`cp -r ${remoteOut}/. ${dest}/`
    else await $`rsync -a ${user}@${machine}:${remoteOut}/ ${dest}/`
    await fs.writeFile(`${dest}/record.txt`, setKeys(await fs.readFile(`${dest}/record.txt`, 'utf8'), extra))
    const check = await $({ cwd: repo, nothrow: true })`npx tsx script/engine-record.ts check-secrets ${dest}`
    if (check.exitCode !== 0) {
        console.log(chalk.red(`Deployment record ${dest} looks like it contains a secret; do not commit it:\n${check.stdout}`))
    } else {
        console.log(chalk.green(`Deployment record written to ${dest} (commit it in the idea repo; see docs/REPRODUCIBLE_BUILDS.md)`))
    }
}



// Main execution logic
const main = async () => {
    // Command line argument parsing
    const user = argv.u || argv.user || defaults.user;
    const machine = argv.m || argv.machine || defaults.machine;
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
        console.log(`  --hostname <string>     the hostname to set (default: a generated two-word sticker name, e.g. brave-otter,`)
        console.log(`                          unique on the LAN, in the network database and on the tailnet; kept on re-runs, idea#184)`)
        console.log(`  --peer <host[,host]>    Engine(s) whose network database to check the generated name against (default: Engines found via mDNS)`)
        console.log(`  -l, --language <string> the locale language to set (default: ${defaults.language})`)
        console.log(`  -k, --keyboard <string> the keyboard layout to set (default: ${defaults.keyboard})`)
        console.log(`  -t, --timezone <string> the timezone to set (default: ${defaults.timezone})`)
        console.log(`  --model <pi4|pi5>       the Pi model; pi5 forces gadget mode off (default: not set)`)
        console.log(`  --upgrade               whether to perform a system upgrade (default: ${defaults.upgrade})`)
        console.log(`  --argon                 whether to install Argon One support (default: ${defaults.argon})`)
        console.log(`  --zerotier              whether to install ZeroTier (default: ${defaults.zerotier})`)
        console.log(`  --raspap                whether to install RaspAP (default: ${defaults.raspap})`)
        console.log(`  --gadget                whether to enable USB gadget mode, Pi 4 only (default: ${defaults.gadget})`)
        console.log(`  --temperature           whether to enable temperature monitoring (default: ${defaults.temperature})`)
        console.log(`                          Every on/off option can be turned off with --no-<option> or --<option>=false,`)
        console.log(`                          e.g. --no-argon --no-gadget (idea#146).`)
        console.log(`  --prod                  whether to build in production mode (default: false)`)
        console.log(`  --dry-run               print the resolved build options and exit without changing anything`)
        console.log(`  --allow-untagged        build from a commit that is not a clean, tagged commit on main (flagged in the record, idea#322)`)
        console.log(`  --idea-repo <path>      idea repo checkout for the record (default: $IDEA_REPO_DIR); written to deployments/engines/<hostname>/<label>/`)
        console.log(`  --batch <name>          deployment batch for the record, e.g. zimbabwe-2026-10 (default: UNKNOWN)`)
        console.log(`  --no-record             skip the deployment record (default: write it, idea#322)`)
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

    const model = parseModel(argv.model);

    // Source gate (idea#322): only a clean, tagged commit on main, unless --allow-untagged.
    const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const source = await readSourceState(repoRoot);
    const verdict = judgeSource(source, parseBoolFlag(argv['allow-untagged'], false));
    if (verdict.reasons.length) {
        console.log(chalk.yellow(`Source ${source.commit}: ${verdict.reasons.join('; ')}`));
        if (!verdict.ok && !argv['dry-run'] && !argv.personalize) {
            console.log(chalk.red(`Refusing to build: tag a clean commit on main with engine-vYYYY.MM.DD[-N], or pass --allow-untagged (idea#322).`));
            process.exit(1);
        }
    } else {
        console.log(chalk.green(`Source ${source.commit} (tag ${verdict.tag})`));
    }

    // Sticker name (idea#184): explicit --hostname, else the name persisted by an
    // earlier run, else a new two-word name not taken on the LAN or in the store.
    // --dry-run never generates or persists anything.
    let hostname: string = argv.hostname || '<generated at install>';
    let nameSource = argv.hostname ? 'explicit' : 'generated';
    if (!argv['dry-run']) {
        const peers = argv.peer ? String(argv.peer).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;
        const r = await resolveStickerName(argv.hostname, realStickerNameDeps(exec, { peers }));
        hostname = r.name;
        nameSource = r.source;
        console.log(chalk.green(`Hostname: ${hostname} (${r.source}${r.source === 'generated' ? `, checked against LAN${r.storeChecked ? ', network database' : ''}${r.tailnetChecked ? ', tailnet' : ''}` : ''})`));
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
        // parseBoolFlag: --no-<flag> / --<flag>=false turn off a default of true (idea#146)
        upgrade: parseBoolFlag(argv.upgrade, defaults.upgrade),
        argon: parseBoolFlag(argv.argon, defaults.argon),
        zerotier: parseBoolFlag(argv.zerotier, defaults.zerotier),
        raspap: parseBoolFlag(argv.raspap, defaults.raspap),
        gadget: resolveGadget(argv.gadget, defaults.gadget, model),
        temperature: parseBoolFlag(argv.temperature, defaults.temperature),
        version: version,
        productionMode: parseBoolFlag(argv.prod, false),
    };

    const { exec: _exec, ...shown } = buildArgs;
    console.log(chalk.green(`Build options: ${JSON.stringify({ model: model ?? null, nameSource, ...shown })}`));
    if (argv['dry-run']) {
        // Print the resolved options only (used to check flag handling, idea#146)
        process.exit(0);
    }

    // Execute the appropriate function based on flags
    if (argv.personalize) {
        await setHostname(exec, hostname);
        await addMeta(exec, hostname, version);
    } else {
        if (!isLocalMode) {
            await syncEngine(user, machine);
        }
        await buildEngine(buildArgs);
        if (parseBoolFlag(argv.record, true)) {
            await captureDeploymentRecord(exec, enginePath, repoRoot, isLocalMode, user, machine, hostname,
                argv['idea-repo'] || process.env.IDEA_REPO_DIR, String(argv.batch || 'UNKNOWN'), [
                `buildSourceCommit=${source.commit}`,
                `packageArchive=${verdict.tag ? `GitHub release ${verdict.tag} on koenswings/agent-engine-dev` : 'none (untagged build)'}`,
                `buildSourceTag=${verdict.tag ?? ''}`,
                `buildSourceFlags=${verdict.reasons.join('; ') || 'clean-tagged-main'}`,
                `buildOptions=${JSON.stringify({ model: model ?? null, ...shown })}`,
            ]);
        }
    }
    
    const sticker = stickerText(hostname, config.settings.httpPort ?? 80);
    await writeStickerFile(exec, sticker);
    console.log(chalk.bold.green(`\nWrite this name on the sticker on the case (also saved in /home/pi/STICKER.txt):\n${sticker}\n`));
    console.log(chalk.green(`Script completed successfully.`));
    process.exit(0);
}

await main();
