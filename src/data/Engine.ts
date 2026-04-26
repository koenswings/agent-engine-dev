import { $, chalk, os, question, YAML, fs, path, sleep } from 'zx';

$.verbose = false;
import { deepPrint, log, uuid } from '../utils/utils.js';
import { readMetaUpdateId, DiskMeta, addMeta, readRemoteDiskId } from './Meta.js';
import { Version, Command, Hostname, Timestamp, DiskID, EngineID } from './CommonTypes.js';
import { Store, getAppsOfEngine, getDisksOfEngine, getInstancesOfEngine } from './Store.js';
import { DocHandle } from '@automerge/automerge-repo';

export interface Engine {
  id: EngineID,
  hostname: Hostname;
  version: Version;
  hostOS: string;
  created: Timestamp;
  lastBooted: Timestamp;
  lastRun: Timestamp;
  lastHalted: Timestamp | null;
  commands: Command[];
}

import { config } from './Config.js';

const getLocalEngineId = async (): Promise<EngineID> => {
  log(`Getting local engine id`)
  try {
    const meta: DiskMeta = await readMetaUpdateId()
    return createEngineIdFromDiskId(meta.diskId)
  } catch (error) {
    console.error(`Error getting local engine id: ${error}`)
    process.exit(1)
  }
}

export const createEngineIdFromDiskId = (diskId: DiskID): EngineID => {
  return "ENGINE_" + diskId as EngineID
}

export const initialiseLocalEngine = async (): Promise<Engine> => {
  try {
    const meta: DiskMeta = await readMetaUpdateId()
    const localEngine: Engine = {
      id: createEngineIdFromDiskId(meta.diskId),
      hostname: os.hostname() as Hostname,
      version: meta.version ? meta.version : "0.0.1" as Version,
      hostOS: os.type(),
      created: meta.created,
      lastBooted: (new Date()).getTime() as Timestamp,
      lastRun: (new Date()).getTime() as Timestamp,
      lastHalted: null,
      commands: []
    }
    return localEngine
  } catch (e) {
    console.error(`Error initializing local engine: ${e}`)
    process.exit(1)
  }
}

export const createOrUpdateEngine = async (storeHandle: DocHandle<Store>, engineId: EngineID): Promise<Engine | undefined> => {
  const newEngine: Engine = await initialiseLocalEngine()
  let engine: Engine
  try {
    storeHandle.change(doc => {
      const storedEngine: Engine | undefined = doc.engineDB[engineId]
      if (!storedEngine) {
        log(`Creating new engine object for local engine ${engineId}`)
        engine = newEngine
        doc.engineDB[engineId] = engine    
      } else {
        log(`Granularly updating existing engine object ${engineId}`)
        engine = doc.engineDB[engineId]
        engine.hostname = os.hostname() as Hostname
        engine.lastBooted = (new Date()).getTime() as Timestamp
        engine.lastRun = (new Date()).getTime() as Timestamp
      }
    })
  return engine!
  } catch (e) {
    log(chalk.red(`Error initializing engine ${engineId}`))
    console.error(e)
    return undefined
  }
}

export const localEngineId = await getLocalEngineId()

export const rebootEngine = async (storeHandle: DocHandle<Store>, engine: Engine) => {
  log(`Gracefully rebooting engine ${engine.hostname}`);
  storeHandle.change(doc => {
    const eng = doc.engineDB[engine.id];
    if (eng) {
      eng.lastRun = new Date().getTime() as Timestamp;
      eng.lastHalted = new Date().getTime() as Timestamp;
    }
  });

  log('Waiting 5 seconds for state to sync before rebooting...');
  await sleep(5000);

  log(`Executing reboot command for ${engine.hostname}`);
  $`sudo reboot now`;
}
export const inspectEngine = (store: Store, engine: Engine) => {
  log(chalk.bgGray(`Engine: ${deepPrint(engine)}`))
  const disks = getDisksOfEngine(store, engine)
  log(chalk.bgGray(`Disks: ${deepPrint(disks)}`))
  const apps = getAppsOfEngine(store, engine)
  log(chalk.bgGray(`Apps: ${deepPrint(apps)}`))
  const instances = getInstancesOfEngine(store, engine)
  log(chalk.bgGray(`Instances: ${deepPrint(instances)}`))
}

// ##################################################################################################
// Installation and system setup functions (formerly in build-engine.ts)
// ##################################################################################################

export const syncEngine = async (user: string, machine: string) => {
  console.log(chalk.blue('Syncing the engine to the remote machine'))
  try {
    if (!fs.existsSync('./script/build_image_assets/gh_token.txt')) {
      const githubToken = await question('Enter the GitHub token: ');
      fs.writeFileSync('./script/build_image_assets/gh_token.txt', githubToken);
    }
    const targetName = machine.endsWith('.local') ? machine.slice(0, -6) : machine;
    await $`./sync-engine --user ${user} ${targetName}`;
  } catch (e) {
    console.log(chalk.red('Failed to sync the engine to the remote machine'));
    console.error(e);
    process.exit(1);
  }
}

export const buildEngine = async (args: any) => {
  const {
    exec, enginePath, isLocalMode, user, machine, hostname, language, keyboard, timezone,
    upgrade, argon, zerotier, raspap, gadget, temperature, version, productionMode
  } = args;

  // Clear known_hosts entry for the target machine to prevent SSH errors
  if (machine) {
    await clearKnownHost(machine);
  }

  await updateSystem(exec);
  if (upgrade) await upgradeSystem(exec);

  await setHostname(exec, hostname);
  await installAvahi(exec);
  await localiseSystem(exec, enginePath, language, keyboard, timezone);
  await installCrontabs(exec, enginePath);

  if (argon) await installArgonFanScript(exec, enginePath);
  if (temperature) await installTemperature(exec);

  await installUdev(exec, enginePath);
  await installVarious(exec);
  await installVarious2(exec);
  await installChromium(exec);
  await installGh(exec);

  await installDocker(exec, enginePath, user);
  await buildDockerInfrastructure(exec);
  await buildAppsInfrastructure(exec);

  if (raspap) await installRaspAP(exec, enginePath);
  await installTailscale(exec, enginePath)
  if (zerotier) await installZerotier(exec, enginePath);

  await addMeta(exec, hostname, version);

  //await installEngineNode(exec);
  await installBaseNpm(exec);
  await configurePnpm(exec);
  await installPm2(exec, enginePath);
  await installEnginePM2(exec, enginePath);
  await buildEnginePM2(exec, enginePath);

  if (isLocalMode) {
    const permanentEnginePath = config.defaults.enginePath;
    console.log(chalk.blue(`Copying engine to permanent location: ${permanentEnginePath}`));
    await exec`sudo mkdir -p ${permanentEnginePath}`;
    await exec`sudo rsync -a --delete ${enginePath}/ ${permanentEnginePath}/`;
    await exec`sudo chown -R pi:pi ${permanentEnginePath}`;
  }

  await startEnginePM2(exec, enginePath, config.defaults.enginePath, productionMode);
  await grantNetBindCapability(exec);

  if (gadget) await usbGadget(exec, enginePath);

  await rebootSystem(exec);
}

export const clearKnownHost = async (machine: string) => {
  console.log(chalk.yellow(`  - Clearing known_hosts entry for ${machine}...`));
  const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');
  try {
    await $`ssh-keygen -R ${machine}`;
    console.log(chalk.green(`    - Entry for ${machine} removed from ${knownHostsPath}.`));
  } catch (e: any) {
    console.log(chalk.yellow(`    - Host not found in known_hosts or an error occurred. Continuing...`));
  }
}

export const copyAsset = async (exec: any, enginePath: string, asset: string, destination: string, executable: boolean = false, chmod: string | null = "0644", chown: string | null = "0:0") => {
  console.log(chalk.blue(`Copying asset ${asset} to ${destination}`));
  try {
    await exec`sudo cp ${enginePath}/script/build_image_assets/${asset} ${destination}`;
    await exec`sudo chmod ${chmod} ${destination}/${asset}`;
    await exec`sudo chown ${chown} ${destination}/${asset}`;
    if (executable) {
      await exec`sudo chmod +x ${destination}/${asset}`;
    }
  } catch (e) {
    console.log(chalk.red(`Error copying asset ${asset} to ${destination}`));
    console.error(e);
    process.exit(1);
  }
}

export const createDir = async (exec: any, dir: string, chmod: string | null = "0755", chown: string | null = "0:0") => {
  console.log(chalk.blue(`Creating directory ${dir}`));
  try {
    await exec`sudo mkdir -p ${dir}`;
    await exec`sudo chmod ${chmod} ${dir}`;
    await exec`sudo chown ${chown} ${dir}`;
  } catch (e) {
    console.log(chalk.red(`Error creating directory ${dir}`));
    console.error(e);
    process.exit(1);
  }
}

export const updateSystem = async (exec: any) => {
  console.log(chalk.blue('Updating package list...'));
  try {
    await exec`sudo apt update -y`;
  } catch (e) {
    console.log(chalk.red('Error updating package list'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Package list updated'));
}

export const upgradeSystem = async (exec: any) => {
  console.log(chalk.blue('Upgrading packages...'));
  try {
    await exec`sudo DEBIAN_FRONTEND="noninteractive" apt-get upgrade -y`;
  } catch (e) {
    console.log(chalk.red('Error upgrading packages'));
    console.error(e);
    process.exit(1);
  }
}

export const localiseSystem = async (exec: any, enginePath: string, language: string, keyboard: string, timezone: string) => {
  console.log(chalk.blue('Localising the system...'));
  try {
    await copyAsset(exec, enginePath, 'locale.gen', '/etc')
    await exec`sudo locale-gen`;
    
    // Set all locale environment variables
    const localeConfig = [
        `LANG=${language}`,
        `LANGUAGE=${language}`,
        `LC_ALL=${language}`,
        `LC_CTYPE=${language}`
    ].join('\\n');
    await exec`echo -e '${localeConfig}' | sudo tee /etc/default/locale`;
    
    await exec`sudo raspi-config nonint do_configure_keyboard ${keyboard}`
    await exec`sudo timedatectl set-timezone ${timezone}`
  } catch (e) {
    console.log(chalk.red('Error localising the system'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('System localised'));
}

export const installCrontabs = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Installing crontabs...'));
  try {
    await copyAsset(exec, enginePath, 'boot.sh', '/usr/local/bin', true)
    await exec`sudo sed -i "s|/home/pi/projects/engine|${config.defaults.enginePath}|g" /usr/local/bin/boot.sh`
    await exec`sudo crontab ${enginePath}/script/build_image_assets/crondefs`
  } catch (e) {
    console.log(chalk.red('Error installing crontabs'));
    console.error(e);
    process.exit(1);
  }
}

export const installTemperature = async (exec: any) => {
  console.log(chalk.blue('Installing lm-sensors...'));
  try {
    await exec`sudo apt install lm-sensors -y`;
  } catch (e) {
    console.log(chalk.red('Error installing lm-sensors'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('lm-sensors installed'));

  console.log(chalk.blue('Running sensors...'));
  try {
    const ret = await exec`sensors`
    console.log(ret.stdout)
  } catch (e) {
    console.log(chalk.red('Error running sensors'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Sensors run'));
}

export const setHostname = async (exec: any, hostname: string) => {
  console.log(chalk.blue(`Setting hostname to ${hostname}`));
  try {
    // 1. First, ensure /etc/hosts has the correct entry for the new hostname
    // This helps sudo resolve the hostname before hostnamectl sets it.
    // Robustly replace the line starting with 127.0.1.1, or add it if missing.
    await exec`sudo sed -i 's/^127\\.0\\.1\\.1.*/127.0.1.1\\t${hostname}/' /etc/hosts`;

    // Robustly update the 127.0.0.1 line to ensure 'localhost' and the new hostname are present.
    // This handles cases where only 'localhost' is present, or an old hostname exists.
    await exec`sudo sed -i 's/^127\\.0\\.0\\.1\s*.*/127.0.0.1\\tlocalhost ${hostname}/' /etc/hosts`;

    // 2. Set the new hostname using hostnamectl
    await exec`sudo hostnamectl set-hostname ${hostname}`;

    // 3. Ensure /etc/hostname is updated directly for persistence across reboots
    await exec`echo "${hostname}" | sudo tee /etc/hostname > /dev/null`;

  } catch (e) {
    console.log(chalk.red('Error setting hostname'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Hostname set'));
  console.log(hostname); // Print hostname for capture
}

export const installAvahi = async (exec: any) => {
  console.log(chalk.blue('Installing Avahi for .local mDNS discovery...'));
  try {
    await exec`sudo apt install avahi-daemon libnss-mdns -y`;
    await exec`sudo systemctl enable avahi-daemon`;
    await exec`sudo systemctl start avahi-daemon`;
  } catch (e) {
    console.log(chalk.red('Error installing Avahi'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Avahi installed and enabled'));
}

export const installArgonFanScript = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Installing argon_fan_script.sh...'));
  try {
    await copyAsset(exec, enginePath, 'argon_fan_script.sh', '/usr/local/bin', true, "0755")
  } catch (e) {
    console.log(chalk.red('Error installing argon_fan_script.sh'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Argon fan script installed'));

  console.log(chalk.blue('Executing argon_fan_script.sh...'));
  try {
    await exec`sudo /usr/local/bin/argon_fan_script.sh`;
  } catch (e) {
    console.log(chalk.red('Error executing argon_fan_script.sh'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Argon fan script executed'));
}

export const installGh = async (exec: any) => {
  console.log(chalk.blue('Installing gh...'));
  try {
    await exec`curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg`
    await exec`sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg`
    await exec`echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null`
    await exec`sudo apt update`
    await exec`sudo apt install gh -y`

  } catch (e) {
    console.log(chalk.red('Error installing gh'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('gh installed'));
}

export const cloneRepo = async (exec: any, enginePath: string, engineParentPath: string, githubToken: string) => {
  console.log(chalk.blue('Cloning the engine repo...'));
  try {
    await exec`git config --global user.email "koen@swings.be"`;
    await exec`git config --global user.name "Koen Swings"`;
    await exec`gh auth login --with-token < ${enginePath}/script/build_image_assets/gh_token.txt`;
    await exec`if [ -d ${enginePath} ]; then sudo rm -rf ${enginePath}; fi`;
    await exec`cd ${engineParentPath} && git clone https://koenswings:${githubToken}@github.com/koenswings/engine.git`;
  } catch (e) {
    console.log(chalk.red('Error cloning the engine repo'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Engine repo cloned'));
}

export const installUdev = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Installing udev and udev rules...'));
  try {
    await exec`sudo apt install udev -y`;
    await copyAsset(exec, enginePath, '90-docking.rules', '/etc/udev/rules.d')
    await createDir(exec, '/disks', "0755", "0:0")

    // Configure /dev/engine ownership so the pi user can write sentinel files.
    // udev creates /dev/engine as root:root; we use systemd-tmpfiles with 'd'
    // (create if absent AND always apply mode/ownership) to ensure pi:pi 0775
    // survives every reboot — not just the first provisioning run.
    console.log(chalk.blue('  - Configuring /dev/engine ownership via tmpfiles.d...'))
    await exec`sudo tee /etc/tmpfiles.d/idea-engine.conf > /dev/null << 'EOF'
# /dev/engine is created by udev for the IDEA Engine disk sentinel mechanism.
# 'd' creates the directory if absent and always applies mode/ownership.
d /dev/engine 0775 pi pi -
EOF`
    await exec`sudo systemd-tmpfiles --create /etc/tmpfiles.d/idea-engine.conf`
  } catch (e) {
    console.log(chalk.red('Error installing udev and udev rules'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Udev and udev rules installed'));
}

export const rebootSystem = async (exec: any) => {
  console.log(chalk.blue('Rebooting the system...'));
  try {
    await exec`sudo reboot`;
  } catch (e) {
    console.log(chalk.red('Error rebooting the system'));
    console.error(e);
    process.exit(1);
  }
}

export const usbGadget = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Running the rpi4-usb script...'));
  try {
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/rpi4-usb.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/rpi4-usb.sh`;
  } catch (e) {
    console.log(chalk.red('Error running the rpi4-usb script'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('rpi4-usb script run'));
}

export const installRaspAP = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Installing RaspAP...'));
  try {
    const raspap_version = "2.8.5"
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/install-raspap.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/install-raspap.sh -b ${raspap_version} -y -o 0 -a 0`;
  } catch (e) {
    console.log(chalk.red('Error installing RaspAP'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('RaspAP installed'));
}

/**
 * Install Tailscale on a newly provisioned Pi.
 *
 * Design: design/tailscale-remote-management.md
 *
 * Tailscale is installed in "latent" mode:
 *   - Binaries present, systemd service DISABLED and NOT started
 *   - Auth key stored at /etc/tailscale/debug-authkey (600, root)
 *   - Activation script installed at /usr/local/bin/tailscale-debug-activate.sh
 *
 * The Pi remains fully offline during normal operation.
 * A coordinator activates debug mode by running the activation script over SSH.
 *
 * Auth key source (in priority order):
 *   1. TAILSCALE_AUTHKEY env var (set on the management Pi running buildEngine)
 *   2. /home/pi/openclaw/secrets/tailscale_authkey.txt (Atlas's secrets dir on this Pi)
 */
export const installTailscale = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Installing Tailscale (latent debug mode)...'))

  // Resolve auth key
  const authKey = process.env.TAILSCALE_AUTHKEY
    ?? (fs.existsSync('/home/pi/openclaw/secrets/tailscale_authkey.txt')
        ? fs.readFileSync('/home/pi/openclaw/secrets/tailscale_authkey.txt', 'utf-8').trim()
        : null)

  if (!authKey) {
    console.error(chalk.red('installTailscale: no auth key found. Set TAILSCALE_AUTHKEY env var or ensure /home/pi/openclaw/secrets/tailscale_authkey.txt exists.'))
    process.exit(1)
  }

  try {
    // 1. Download and install Tailscale static binaries (arm64)
    // curl-installs the official static tarball so no package manager changes are needed.
    // The service is NOT enabled after installation.
    // Shell command uses $TSVER which must not be interpolated by TypeScript.
    // We pass it as a regular string argument to avoid template literal interpolation.
    await exec(['bash', '-c',
      'TSVER=$(curl -sL https://pkgs.tailscale.com/stable/ | grep -oP \'tailscale_\\K[\\d.]+(?=_arm64.tgz)\' | head -1)' +
      ' && curl -sL "https://pkgs.tailscale.com/stable/tailscale_${TSVER}_arm64.tgz"' +
      ' | sudo tar -xz --strip-components=1 -C /usr/sbin' +
      ' "tailscale_${TSVER}_arm64/tailscale" "tailscale_${TSVER}_arm64/tailscaled"'
    ])

    // 2. Install systemd service (disabled — does not start on boot)
    await exec`sudo cp ${enginePath}/script/build_image_assets/tailscaled.service /etc/systemd/system/tailscaled.service`
    await exec`sudo systemctl daemon-reload`
    // explicitly do NOT enable: tailscale must be activated manually

    // 3. Store auth key (root-only, 600)
    await exec`sudo mkdir -p /etc/tailscale`
    await exec`echo ${authKey} | sudo tee /etc/tailscale/debug-authkey > /dev/null`
    await exec`sudo chmod 600 /etc/tailscale/debug-authkey`
    await exec`sudo chown root:root /etc/tailscale/debug-authkey`

    // 4. Install activation script
    await exec`sudo cp ${enginePath}/script/build_image_assets/tailscale-debug-activate.sh /usr/local/bin/tailscale-debug-activate.sh`
    await exec`sudo chmod 755 /usr/local/bin/tailscale-debug-activate.sh`

    console.log(chalk.green('Tailscale installed (service disabled — latent debug mode ready)'))
  } catch (e) {
    console.log(chalk.red('Error installing Tailscale'))
    console.error(e)
    process.exit(1)
  }
}

export const installZerotier = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Installing Zerotier...'));
  try {
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/install-zerotier.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/install-zerotier.sh`;
  } catch (e) {
    console.log(chalk.red('Error installing Zerotier'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Zerotier installed'));
}

export const installRSync = async (exec: any) => {
  console.log(chalk.blue('Installing rsync...'));
  try {
    await exec`sudo apt install rsync -y`;
  } catch (e) {
    console.log(chalk.red('Error installing rsync'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('rsync installed'));
}

export const installBaseNpm = async (exec: any) => {
  console.log(chalk.blue('Installing base node, n, npm and pnpm for script execution...'));
  try {
    await exec`sudo apt install npm -y`
    await exec`sudo npm install -g -y n pnpm`
    await exec`sudo n 22.20.0`
  } catch (e) {
    console.log(chalk.red('Error installing base node, n, npm and pnpm...'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Base node, n, npm and pnpm installed'));
}

export const installEngineNode = async (exec: any) => {
  console.log(chalk.blue('Installing node version for engine...'));
  try {
    await exec`sudo n 22.20.0`
  } catch (e) {
    console.log(chalk.red('Error installing engine node version...'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Engine node version installed'));
}

export const configurePnpm = async (exec: any) => {
  console.log(chalk.blue('Setting up pnpm...'));
  try {
    await exec`sudo pnpm setup`
  } catch (e) {
    console.log(chalk.red('Error setting up pnpm...'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('pnpm set up'));
}


export const installPm2 = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Installing pm2...'));
  try {
    await exec`sudo npm install -g pm2`
    await exec`cd ${enginePath}`
    console.log(chalk.blue('Installing pm2-logrotate...'))
    await exec`cd ${enginePath} && sudo pm2 install pm2-logrotate`
  } catch (e) {
    console.log(chalk.red('Error installing pm2'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('pm2 installed'));
}

export const installEnginePM2 = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Installing the engine...'))
  await exec`cd ${enginePath} && sudo pnpm install_packages`
}

export const buildEnginePM2 = async (exec: any, enginePath: string) => {
  console.log(chalk.blue('Building the engine with tsc...'))
  await exec`cd ${enginePath} && sudo pnpm build`
}

export const startEnginePM2 = async (exec: any, enginePath: string, permanentEnginePath: string, productionMode: boolean) => {
  console.log(chalk.blue('Starting the engine with pm2...'));
  try {
    try {
      // We require idempotency - check if the engine has already started before starting and persisting it
      await exec`pm2 show engine`
    } catch (e) {
      console.log(chalk.blue(`Starting a ${productionMode ? "production" : "dev"} mode engine with pm2...`))
      if (enginePath !== permanentEnginePath) {
        await exec`sudo cp ${enginePath}/pm2.config.cjs ${permanentEnginePath}/`
        await exec`sudo chown pi:pi ${permanentEnginePath}/pm2.config.cjs`
      }

      // Run pm2 as the pi user (no sudo) so the engine process is owned by pi.
      if (productionMode) {
        await exec`cd ${permanentEnginePath} && pm2 start pm2.config.cjs --env production`
      } else {
        await exec`cd ${permanentEnginePath} && pm2 start pm2.config.cjs --env development`
      }
      console.log(chalk.blue('Saving the pm2 process list...'))
      await exec`pm2 save`
      console.log(chalk.blue('Enabling pm2 to start on boot...'))
      // Generate the startup command for the pi user and run it with sudo.
      // pm2 startup outputs a line beginning with 'sudo env PATH=...' — extract and execute it.
      const startupOutput = (await exec`pm2 startup systemd -u pi --hp /home/pi`).stdout
      const startupCmd = startupOutput.split('\n').find((l: string) => l.trimStart().startsWith('sudo env PATH='))
      if (startupCmd) {
        await exec`${startupCmd.trim()}`
      } else {
        console.log(chalk.yellow('Could not extract pm2 startup command from output — run manually if needed'))
        console.log(startupOutput)
      }
    }
  } catch (e) {
    console.log(chalk.red('Error starting the engine with pm2'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Engine started with pm2'))
}

/**
 * Grants the Node.js binary the capability to bind to privileged ports (< 1024),
 * e.g. port 80 for the Console HTTP server.
 *
 * This allows the Engine to serve on port 80 without running as root.
 * Must be re-applied after any Node.js binary update.
 */
export const grantNetBindCapability = async (exec: any) => {
  console.log(chalk.blue('Granting node cap_net_bind_service (port 80 access)...'))
  try {
    await exec`sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))`
    console.log(chalk.green('cap_net_bind_service granted to node'))
  } catch (e) {
    console.log(chalk.red('Error granting cap_net_bind_service — port 80 may not work as non-root'))
    console.error(e)
  }
}

export const installVarious = async (exec: any) => {
  console.log(chalk.blue('Installing tcpdump, vim and hdparm...'));
  try {
    await exec`sudo apt install tcpdump vim tmux hdparm -y`;
  } catch (e) {
    console.log(chalk.red('Error installing tcpdump, vim and hdparm'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('tcpdump, vim and hdparm installed'));
}

export const installVarious2 = async (exec: any) => {
  // Install the git, dnsutlis, tree, lshw and cloud-guest-utils packages
  console.log(chalk.blue('Installing lm-sensors, git, dnsutils, tree, lshw and cloud-guest-utils...'));
  try {
    await exec`sudo apt install git dnsutils tree lshw cloud-guest-utils -y`;
  } catch (e) {
    console.log(chalk.red('Error installing git, dnsutils, tree, lshw and cloud-guest-utils'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('git, dnsutils, tree, lshw and cloud-guest-utils installed'));
}

export const installChromium = async (exec: any) => {
  console.log(chalk.blue('Installing Chromium (required for md-to-pdf headless PDF generation)...'));
  try {
    await exec`sudo apt install chromium -y`;
  } catch (e) {
    console.log(chalk.red('Error installing Chromium'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Chromium installed'));
}


export const buildAppsInfrastructure = async (exec: any) => {
  // Create the /apps, /apps/catalog, and /apps/instances directories 
  console.log(chalk.blue('Creating the /services, /apps, and /instances directories'))
  try {
    await createDir(exec, '/services')
    await createDir(exec, '/apps')
    await createDir(exec, '/instances')
  } catch (e) {
    console.log(chalk.red('Error creating the /services, /apps, and /instances directories'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('The /services, /apps, and /instances directories have been created'));
}


const installDocker = async (exec, enginePath, user) => {

  // Run the install-docker.sh script
  console.log(chalk.blue('Installing Docker'))
  try {
    // Make the script executable
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/install-docker.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/install-docker.sh`;
  } catch (e) {
    console.log(chalk.red('Error installing Docker'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Docker installed'));

  // Add the docker group if it does not already exist
  console.log(chalk.blue('Adding the docker group'))
  try {
    // Check if the docker group already exists
    if (await exec`getent group docker`) {
      console.log(chalk.blue('The docker group already exists'));
    } else {
      await exec`sudo groupadd docker`;
    }
  } catch (e) {
    console.log(chalk.red('Error adding the docker group'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Docker group added'));


  // Add the ssh user to the docker group
  console.log(chalk.blue('Adding the ssh user to the docker group'))
  try {
    await exec`sudo usermod -aG docker ${user}`;
  } catch (e) {
    console.log(chalk.red('Error adding the ssh user to the docker group'));
    console.error(e);
    process.exit(1);
  }

  // Copy the daemon.json asset to /etc/docker
  console.log(chalk.blue('Configuring Docker'))
  try {
    await copyAsset(exec, enginePath, 'daemon.json', '/etc/docker', false, "0644")
  } catch (e) {
    console.log(chalk.red('Error configuring Docker'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Docker configured'));


  // Restart the Docker service
  console.log(chalk.blue('Restarting the Docker service'))
  try {
    await exec`sudo systemctl restart docker`;
  } catch (e) {
    console.log(chalk.red('Error restarting the Docker service'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Docker service restarted'));


  // Print the Docker Compose, the Docker version and the Docker info
  console.log(chalk.blue('Docker info'))
  try {
    // (use sudo because the docker group has not been added yet - requires a reboot)
    let ret = await exec`sudo docker compose version`
    console.log(ret.stdout)
    ret = await exec`sudo docker version`
    console.log(ret.stdout)
    ret = await exec`sudo docker info`
    console.log(ret.stdout)
  } catch (e) {
    console.log(chalk.red('Error printing the Docker info'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Docker info printed'));
}

const buildDockerInfrastructure = async (exec: any) => {

  // Create the internal docker networks frontend and backend if they do not already exist
  console.log(chalk.blue('Creating the frontend network'))
  try {
    // Check if the frontend network already exists
    // (use sudo because the docker group has not been added yet - requires a reboot)
    if (await exec`sudo docker network ls --filter name=frontend`) {
      console.log(chalk.blue('The frontend network already exists'));
    } else {
      await exec`sudo docker network create --internal frontend`;
    }
    // Check if the backend network already exists
    if (await exec`sudo docker network ls --filter name=backend`) {
      console.log(chalk.blue('The backend network already exists'));
    } else {
      await exec`sudo docker network create --internal backend`;
    }
  } catch (e) {
    console.log(chalk.red('Error creating the frontend or backend network'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Frontend and backend networks created'));
}


// ##################################################################################################
// Obsolete functions
// To be kept for reference only
// ##################################################################################################


const startDockerEngine = async (exec: any, enginePath: string, productionMode: boolean) => {
  // Build the engine image
  console.log(chalk.blue(`Building a ${productionMode ? "production" : "dev"} mode engine image...`))
  try {
    // Compose build
    // (use sudo because the docker group has not been added yet - requires a reboot)
    if (productionMode) {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-prod.yaml build`;
    } else {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-dev.yaml build`;
    }
  } catch (e) {
    console.log(chalk.red('Error building the engine image'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Engine image built'));

  // Start the engine
  console.log(chalk.blue('Composing up the engine...'));
  try {
    // Compose up 
    // (use sudo because the docker group has not been added yet - requires a reboot)
    if (productionMode) {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-prod.yaml up -d`;
    } else {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-dev.yaml up -d`;
    }
  } catch (e) {
    console.log(chalk.red('Error composing up the engine'));
    console.error(e);
    process.exit(1);
  }
  console.log(chalk.green('Engine composed up'));
}
