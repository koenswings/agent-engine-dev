import { $, chalk, os, YAML, fs, path, sleep } from 'zx';

$.verbose = false;
import { deepPrint, log, uuid, print } from '../utils/utils.js';
import { APP_DATA_HELPER } from '../utils/appDataHelper.js';
import { PEER_GATE, PEER_AUTHORIZED_KEYS, PEER_KNOWN_HOSTS } from '../utils/peerSsh.js';
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
  /** What this Engine build supports (idea#128); rewritten as a whole list at every startup */
  capabilities?: string[];
  /** The lastBooted of the startup that wrote `capabilities` (idea#128) */
  capabilitiesBootedAt?: Timestamp;
  /** Set by eraseDisk for its whole run (Files Disk step 3, not built yet); createFilesDisk refuses that disk meanwhile (idea#131) */
  eraseInProgress?: EraseInProgress | null;
  /** Whole non-system disks without ext4 (idea#134); rebuilt on dock/undock and at startup */
  unformattedDisks?: UnformattedDiskPublic[];
  /**
   * This Engine's own ssh key and host key for Engine-to-Engine copies (per-Pi
   * Engine keys, data/PeerAccess.ts). Written by this Engine only, at every start
   * and repaired on the heartbeat; null (or absent) when peer access is off here.
   */
  peerAccess?: PeerAccess | null;
}

/** Engine.peerAccess (design-per-pi-engine-key.md) */
export interface PeerAccess {
  /** 'ssh-ed25519 <base64>' of /home/pi/.ssh/idea_engine_ed25519.pub (no comment) */
  sshKey: string;
  /** 'ssh-ed25519 <base64>' of /etc/ssh/ssh_host_ed25519_key.pub, pinned by peers under this Engine's id */
  hostKey: string;
  /** When sshKey/hostKey were last (re)published */
  publishedAt: Timestamp;
  /**
   * The peers this Engine has written into its authorized_keys and known_hosts
   * (idea-app-data sync-peers), as '<engineId> <sshKey fingerprint> <hostKey fingerprint>'.
   * A peer may copy to this Engine once its entry (with its CURRENT keys) is listed here.
   */
  authorized: string[];
}

export interface UnformattedDiskPublic {
  candidateId: string
  device: string
  sizeBytes: number
  model: string | null
  fsType: string | null
  label: string
  serial?: string | null
}


/** Engine.eraseInProgress (proposals/files-disk.md §7.5); written by eraseDisk (step 3). */
export interface EraseInProgress {
  targetId: string;
  label: string;
  step: 'checking' | 'stopping and unmounting' | 'partitioning' | 'creating filesystem' | 'mounting';
}

/**
 * Capabilities this Engine build advertises (idea#128, Files Disk step 0b).
 *   diskIdArgs: installApp, createBackupDisk and ejectDisk take disk ids.
 *   filesDisk:  the Files Disk role and createFilesDisk <diskId> [<shareName…>] (idea#131).
 *   filesMount: Files Disk binds into opted-in Apps (x-app.filesMount, idea#133).
 *   eraseDisk:  summariseDisk + eraseDisk (idea#134).
 *   instanceIdArgs: startInstance, runInstance, stopInstance, copyApp, moveApp,
 *               backupApp and restoreApp take an instance id (idea#168); a name
 *               still works when it is unambiguous.
 * Written at every startup as a whole new list, with capabilitiesBootedAt set
 * to that startup's lastBooted. A Console counts a capability only when
 * capabilities includes it AND capabilitiesBootedAt === lastBooted of the same
 * Engine record: an older (rolled-back) Engine rewrites lastBooted but not the
 * stamp, so it is treated as old at once.
 */
export const ENGINE_CAPABILITIES: readonly string[] = ['diskIdArgs', 'filesDisk', 'filesMount', 'eraseDisk', 'instanceIdArgs']

import { config } from './Config.js';

const getLocalEngineId = async (): Promise<EngineID> => {
  log(`Getting local engine id`)
  try {
    const meta: DiskMeta = await readMetaUpdateId()
    return createEngineIdFromDiskId(meta.diskId)
  } catch (error) {
    // Readable reason for the exit instead of a bare import-time crash (idea#145):
    // ensureSystemMeta's errors say how to fix a missing /META.yaml.
    console.error(`Cannot start the Engine: could not determine the local Engine id: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

export const createEngineIdFromDiskId = (diskId: DiskID): EngineID => {
  return "ENGINE_" + diskId as EngineID
}

export const initialiseLocalEngine = async (): Promise<Engine> => {
  try {
    const meta: DiskMeta = await readMetaUpdateId()
    const booted = (new Date()).getTime() as Timestamp
    const localEngine: Engine = {
      id: createEngineIdFromDiskId(meta.diskId),
      hostname: os.hostname() as Hostname,
      // Always string: META YAML may have parsed version as a number (e.g. 1.0 → 1).
      version: (meta.version != null ? String(meta.version) : "0.0.1") as Version,
      hostOS: os.type(),
      created: meta.created,
      lastBooted: booted,
      lastRun: booted,
      lastHalted: null,
      commands: [],
      capabilities: [...ENGINE_CAPABILITIES],
      capabilitiesBootedAt: booted,
      eraseInProgress: null,
      unformattedDisks: [],
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
        engine.version = newEngine.version
        // One timestamp for lastBooted and the capability stamp (idea#128)
        const booted = (new Date()).getTime() as Timestamp
        engine.lastBooted = booted
        engine.lastRun = booted
        // Whole new list, never appended: a stale or extra entry disappears
        engine.capabilities = [...ENGINE_CAPABILITIES]
        engine.capabilitiesBootedAt = booted
        if (engine.unformattedDisks === undefined) engine.unformattedDisks = []
        if (engine.eraseInProgress === undefined) engine.eraseInProgress = null
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

/**
 * Remove phantom engine entries from the shared CRDT store.
 *
 * A "phantom" engine is any engineDB entry that:
 *   - has the same hostname as this machine, but a different id (stale IDs
 *     generated before the sudo-hdparm fix caused a new UUID on every boot), OR
 *   - has an id that is not its own map key (internal id/key mismatch)
 *
 * An "orphan" disk is any diskDB entry whose dockedTo field points to an
 * engine that no longer exists in engineDB.
 *
 * Both are deleted in a single storeHandle.change() call so the Automerge
 * tombstone has the current vector clock and permanently wins over the old
 * inserts when it propagates to peer engines on the next sync.
 *
 * Called once at startup, after createOrUpdateEngine() and before any
 * monitors are started (so there is no racing writer).
 */
export const cleanupPhantomEngines = (storeHandle: DocHandle<Store>): void => {
  const store = storeHandle.doc()
  const localHostname = os.hostname() as Hostname
  const validEngineIds = new Set(Object.keys(store.engineDB))

  // Engines with this hostname but a different id than localEngineId
  const phantomEngineKeys = Object.keys(store.engineDB).filter(key => {
    const eng = store.engineDB[key]
    return (
      (eng.hostname === localHostname && key !== String(localEngineId)) ||
      (eng.id && String(eng.id) !== key)   // key/id mismatch — CRDT anomaly
    )
  })

  // Disks whose dockedTo points to an engine key that no longer exists
  const orphanDiskKeys = Object.keys(store.diskDB).filter(key => {
    const disk = store.diskDB[key]
    return disk.dockedTo && !validEngineIds.has(String(disk.dockedTo))
  })

  if (phantomEngineKeys.length === 0 && orphanDiskKeys.length === 0) {
    log('[cleanup] No phantom engines or orphan disks found — store is clean')
    return
  }

  log(chalk.yellow(`[cleanup] Removing ${phantomEngineKeys.length} phantom engine(s) and ${orphanDiskKeys.length} orphan disk(s) from store`))
  for (const k of phantomEngineKeys) log(chalk.yellow(`  phantom engine: ${k} (hostname=${store.engineDB[k].hostname}, id=${store.engineDB[k].id})`))
  for (const k of orphanDiskKeys) log(chalk.yellow(`  orphan disk: ${k} (dockedTo=${store.diskDB[k].dockedTo})`))

  storeHandle.change(doc => {
    for (const k of phantomEngineKeys) {
      delete (doc.engineDB as any)[k]
    }
    for (const k of orphanDiskKeys) {
      delete (doc.diskDB as any)[k]
    }
  })

  log(chalk.green('[cleanup] Phantom cleanup complete — tombstones will propagate to peers on next sync'))
}

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
  // Explicit systemctl path with pinned arguments: on Pi OS /usr/sbin/reboot is a
  // symlink to systemctl and sudo matches by inode, so a `reboot` sudoers entry
  // would grant all of systemctl (see 10-engine.sudoers).
  $`sudo /usr/bin/systemctl reboot`;
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
  print(chalk.blue('Syncing the engine to the remote machine'))
  try {
    const targetName = machine.endsWith('.local') ? machine.slice(0, -6) : machine;
    await $`./sync-engine --user ${user} ${targetName}`;
  } catch (e) {
    print(chalk.red('Failed to sync the engine to the remote machine'));
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
    print(chalk.blue(`Copying engine to permanent location: ${permanentEnginePath}`));
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
  print(chalk.yellow(`  - Clearing known_hosts entry for ${machine}...`));
  const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');
  try {
    await $`ssh-keygen -R ${machine}`;
    print(chalk.green(`    - Entry for ${machine} removed from ${knownHostsPath}.`));
  } catch (e: any) {
    print(chalk.yellow(`    - Host not found in known_hosts or an error occurred. Continuing...`));
  }
}

export const copyAsset = async (exec: any, enginePath: string, asset: string, destination: string, executable: boolean = false, chmod: string | null = "0644", chown: string | null = "0:0", destName: string = asset) => {
  print(chalk.blue(`Copying asset ${asset} to ${destination}/${destName}`));
  try {
    await exec`sudo cp ${enginePath}/script/build_image_assets/${asset} ${destination}/${destName}`;
    await exec`sudo chmod ${chmod} ${destination}/${destName}`;
    await exec`sudo chown ${chown} ${destination}/${destName}`;
    if (executable) {
      await exec`sudo chmod +x ${destination}/${destName}`;
    }
  } catch (e) {
    print(chalk.red(`Error copying asset ${asset} to ${destination}`));
    console.error(e);
    process.exit(1);
  }
}

export const createDir = async (exec: any, dir: string, chmod: string | null = "0755", chown: string | null = "0:0") => {
  print(chalk.blue(`Creating directory ${dir}`));
  try {
    await exec`sudo mkdir -p ${dir}`;
    await exec`sudo chmod ${chmod} ${dir}`;
    await exec`sudo chown ${chown} ${dir}`;
  } catch (e) {
    print(chalk.red(`Error creating directory ${dir}`));
    console.error(e);
    process.exit(1);
  }
}

export const updateSystem = async (exec: any) => {
  print(chalk.blue('Updating package list...'));
  try {
    await exec`sudo apt update -y`;
  } catch (e) {
    print(chalk.red('Error updating package list'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Package list updated'));
}

export const upgradeSystem = async (exec: any) => {
  print(chalk.blue('Upgrading packages...'));
  try {
    await exec`sudo DEBIAN_FRONTEND="noninteractive" apt-get upgrade -y`;
  } catch (e) {
    print(chalk.red('Error upgrading packages'));
    console.error(e);
    process.exit(1);
  }
}

export const localiseSystem = async (exec: any, enginePath: string, language: string, keyboard: string, timezone: string) => {
  print(chalk.blue('Localising the system...'));
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
    print(chalk.red('Error localising the system'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('System localised'));
}

export const installCrontabs = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing crontabs...'));
  try {
    await copyAsset(exec, enginePath, 'boot.sh', '/usr/local/bin', true)
    await exec`sudo sed -i "s|/home/pi/idea/agents/agent-engine-dev|${config.defaults.enginePath}|g" /usr/local/bin/boot.sh`
    await exec`sudo crontab ${enginePath}/script/build_image_assets/crondefs`
  } catch (e) {
    print(chalk.red('Error installing crontabs'));
    console.error(e);
    process.exit(1);
  }
}

export const installTemperature = async (exec: any) => {
  print(chalk.blue('Installing lm-sensors...'));
  try {
    await exec`sudo apt install lm-sensors -y`;
  } catch (e) {
    print(chalk.red('Error installing lm-sensors'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('lm-sensors installed'));

  print(chalk.blue('Running sensors (best-effort — may show no data on first boot)...'));
  try {
    const ret = await exec`sensors`
    print(ret.stdout)
  } catch (e) {
    // sensors-detect hasn’t been run yet on a fresh Pi — not fatal
    print(chalk.yellow('sensors returned no data (run sensors-detect manually to configure modules)'));
  }
  print(chalk.green('lm-sensors ready'));
}

export const setHostname = async (exec: any, hostname: string) => {
  print(chalk.blue(`Setting hostname to ${hostname}`));
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
    print(chalk.red('Error setting hostname'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Hostname set'));
  print(hostname); // Print hostname for capture
}

export const installAvahi = async (exec: any) => {
  print(chalk.blue('Installing Avahi for .local mDNS discovery...'));
  try {
    await exec`sudo apt install avahi-daemon libnss-mdns -y`;
    await exec`sudo systemctl enable avahi-daemon`;
    await exec`sudo systemctl start avahi-daemon`;
  } catch (e) {
    print(chalk.red('Error installing Avahi'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Avahi installed and enabled'));
}

export const installArgonFanScript = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing argon_fan_script.sh...'));
  try {
    await copyAsset(exec, enginePath, 'argon_fan_script.sh', '/usr/local/bin', true, "0755")
  } catch (e) {
    print(chalk.red('Error installing argon_fan_script.sh'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Argon fan script installed'));

  print(chalk.blue('Executing argon_fan_script.sh...'));
  try {
    await exec`sudo /usr/local/bin/argon_fan_script.sh`;
  } catch (e) {
    print(chalk.red('Error executing argon_fan_script.sh'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Argon fan script executed'));
}

export const installGh = async (exec: any) => {
  print(chalk.blue('Installing gh...'));
  try {
    await exec`curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg`
    await exec`sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg`
    await exec`echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null`
    await exec`sudo apt update`
    await exec`sudo apt install gh -y`

  } catch (e) {
    print(chalk.red('Error installing gh'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('gh installed'));
}

export const installUdev = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing udev and udev rules...'));
  try {
    await exec`sudo apt install udev -y`;
    await copyAsset(exec, enginePath, '90-docking.rules', '/etc/udev/rules.d')
    await installEngineSudoers(exec, enginePath)
    // idea-erase-disk: root-owned COPY in /usr/local/sbin (never a symlink) (idea#134)
    print(chalk.blue('  - Installing idea-erase-disk...'))
    await exec`sudo install -o root -g root -m 0755 ${enginePath}/script/build_image_assets/idea-erase-disk /usr/local/sbin/idea-erase-disk`
    print(chalk.green('  - /usr/local/sbin/idea-erase-disk installed'))
    // idea-app-data: the app-data root helper (idea#168), same rules: root-owned COPY,
    // 0755, in /usr/local/sbin; its sudoers line is in 11-engine-files (visudo -cf above).
    // It runs rsync/rrsync, borg, runuser and ssh by absolute path.
    print(chalk.blue('  - Installing idea-app-data...'))
    await exec`sudo apt install rsync borgbackup -y`
    await exec`sudo install -o root -g root -m 0755 ${enginePath}/script/build_image_assets/idea-app-data ${APP_DATA_HELPER}`
    print(chalk.green(`  - ${APP_DATA_HELPER} installed`))
    // Per-Pi Engine keys: the forced command for peer keys and the sshd drop-in
    await installPeerAccess(exec, enginePath)
    await createDir(exec, '/disks', "0755", "0:0")

    // Configure /dev/engine ownership so the pi user can write sentinel files.
    // udev creates /dev/engine as root:root; we use systemd-tmpfiles with 'd'
    // (create if absent AND always apply mode/ownership) to ensure pi:pi 0775
    // survives every reboot — not just the first provisioning run.
    print(chalk.blue('  - Configuring /dev/engine ownership via tmpfiles.d...'))
    await exec`sudo tee /etc/tmpfiles.d/idea-engine.conf > /dev/null << 'EOF'
# /dev/engine is created by udev for the IDEA Engine disk sentinel mechanism.
# 'd' creates the directory if absent and always applies mode/ownership.
d /dev/engine 0775 pi pi -
EOF`
    await exec`sudo systemd-tmpfiles --create /etc/tmpfiles.d/idea-engine.conf`

    // Apply the docking rules now, not only after the final reboot (idea#146): if
    // the build stops early, the Engine's disk self-check otherwise fails with
    // "no /dev/engine entry for sda" until the next reboot. Replaying "add" for
    // block devices is what udev does at boot.
    print(chalk.blue('  - Reloading udev rules and replaying block devices...'))
    await exec`sudo udevadm control --reload-rules`
    await exec`sudo udevadm trigger --subsystem-match=block --action=add`
    await exec`sudo udevadm settle --timeout=30`
  } catch (e) {
    print(chalk.red('Error installing udev and udev rules'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Udev and udev rules installed'));
}

/** The sshd drop-in that adds the root-owned peer key file (per-Pi Engine keys). */
export const PEER_SSHD_DROPIN = '/etc/ssh/sshd_config.d/10-idea-peer.conf'
/** The helper's ledger of folders a peer's receive created (LEDGER_DIR in idea-app-data). */
export const PEER_LEDGER_DIR = '/var/lib/idea-app-data'

/**
 * Per-Pi Engine keys (design-per-pi-engine-key.md), the root-owned parts. No key
 * is installed here: each Engine makes its own at first start and the helper's
 * sync-peers writes the peer files.
 *   - /usr/local/sbin/idea-peer-gate: root-owned COPY, 0755 (the forced command of
 *     every peer key line)
 *   - /etc/ssh/idea_authorized_keys and /etc/idea: root 0755 (sync-peers writes
 *     idea_authorized_keys/pi and /etc/idea/peer_known_hosts there)
 *   - /var/lib/idea-app-data: root 0700 (the helper's receive ledger)
 *   - /etc/ssh/sshd_config.d/10-idea-peer.conf: adds idea_authorized_keys/%u to
 *     AuthorizedKeysFile. Checked with `sshd -t` (on failure it is removed again
 *     and the build stops), then `sshd -T` must show it in effect, then sshd is
 *     reloaded (open sessions stay).
 */
export const installPeerAccess = async (exec: any, enginePath: string) => {
  print(chalk.blue('  - Installing idea-peer-gate and the sshd drop-in for peer Engine keys...'))
  await exec`sudo install -o root -g root -m 0755 ${enginePath}/script/build_image_assets/idea-peer-gate ${PEER_GATE}`
  await exec`sudo install -d -o root -g root -m 0755 ${path.dirname(PEER_AUTHORIZED_KEYS)} ${path.dirname(PEER_KNOWN_HOSTS)}`
  await exec`sudo install -d -o root -g root -m 0700 ${PEER_LEDGER_DIR}`
  await exec`sudo install -o root -g root -m 0644 ${enginePath}/script/build_image_assets/10-idea-peer.conf ${PEER_SSHD_DROPIN}`
  try {
    await exec`sudo /usr/sbin/sshd -t`
  } catch (e) {
    await exec`sudo rm -f ${PEER_SSHD_DROPIN}`
    throw new Error(`sshd -t rejected the configuration with ${PEER_SSHD_DROPIN}; removed it again (peer Engine keys will not work): ${e}`)
  }
  const effective = await exec`sudo /usr/sbin/sshd -T -C user=pi,host=localhost,addr=127.0.0.1`
  if (!/^authorizedkeysfile .*\/etc\/ssh\/idea_authorized_keys\/%u/m.test(String(effective?.stdout ?? ''))) {
    print(chalk.red(`  - WARNING: sshd does not use /etc/ssh/idea_authorized_keys/%u: an earlier drop-in or sshd_config sets AuthorizedKeysFile first. Peer Engine keys will not work until it is fixed.`))
  }
  try {
    await exec`sudo systemctl reload ssh`
  } catch {
    await exec`sudo systemctl reload sshd`
  }
  print(chalk.green(`  - ${PEER_GATE} and ${PEER_SSHD_DROPIN} installed; sshd reloaded`))
}

/**
 * The Engine's sudoers files (asset in script/build_image_assets -> installed file).
 *   - 10-engine: the narrow list of root commands the Engine (running as pi)
 *     needs (idea#80, proposals/run-architecture.md)
 *   - 11-engine-files: files and folders the Engine writes, removes or re-owns
 *     as root under /disks, e.g. META.yaml on the first dock (idea#121) and the
 *     disk root owner for createFilesDisk (chown -h, idea#131)
 * Installed names have no '.' in them: sudo skips files in /etc/sudoers.d whose
 * name contains a '.'.
 */
export const ENGINE_SUDOERS_FILES: { asset: string, installed: string }[] = [
  { asset: '10-engine.sudoers', installed: '/etc/sudoers.d/10-engine' },
  { asset: '11-engine-files.sudoers', installed: '/etc/sudoers.d/11-engine-files' },
]

/**
 * Installs every file in ENGINE_SUDOERS_FILES (0440, owner 0:0).
 *
 * Each asset is validated with `visudo -cf` before it is copied, because a broken
 * sudoers file can lock sudo out. After copying, the whole sudoers configuration
 * is checked again; on failure that file is removed.
 */
export const installEngineSudoers = async (exec: any, enginePath: string) => {
  for (const { asset, installed } of ENGINE_SUDOERS_FILES) {
    print(chalk.blue(`Validating ${asset} with visudo...`))
    try {
      await exec`sudo visudo -cf ${enginePath}/script/build_image_assets/${asset}`
    } catch (e) {
      print(chalk.red(`${asset} failed visudo validation; not installing it`))
      console.error(e)
      process.exit(1)
    }
    await copyAsset(exec, enginePath, asset, path.dirname(installed), false, '0440', '0:0', path.basename(installed))
    try {
      await exec`sudo visudo -c`
    } catch (e) {
      print(chalk.red(`sudoers check failed after installing ${installed}; removing it`))
      await exec`sudo rm -f ${installed}`
      console.error(e)
      process.exit(1)
    }
    print(chalk.green(`${installed} installed`))
  }
}

export const rebootSystem = async (exec: any) => {
  print(chalk.blue('Rebooting the system...'));
  try {
    await exec`sudo reboot`;
  } catch (e) {
    print(chalk.red('Error rebooting the system'));
    console.error(e);
    process.exit(1);
  }
}

export const usbGadget = async (exec: any, enginePath: string) => {
  print(chalk.blue('Running the rpi4-usb script...'));
  try {
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/rpi4-usb.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/rpi4-usb.sh`;
  } catch (e) {
    print(chalk.red('Error running the rpi4-usb script'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('rpi4-usb script run'));
}

export const installRaspAP = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing RaspAP...'));
  try {
    const raspap_version = "2.8.5"
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/install-raspap.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/install-raspap.sh -b ${raspap_version} -y -o 0 -a 0`;
  } catch (e) {
    print(chalk.red('Error installing RaspAP'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('RaspAP installed'));
}

/** Where installTailscale stores the auth key on the Pi (root-only, 0600). */
export const TAILSCALE_AUTHKEY_PATH = '/etc/tailscale/debug-authkey'
const TAILSCALE_AUTHKEY_DIR = '/etc/tailscale'
const TAILSCALE_AUTHKEY_SECRETS_FILE = '/home/pi/openclaw/secrets/tailscale_authkey.txt'

/** TAILSCALE_AUTHKEY env var first, then the secrets file on the management Pi. */
export const resolveTailscaleAuthKey = (): string | null => {
  const fromEnv = process.env.TAILSCALE_AUTHKEY?.trim()
  if (fromEnv) return fromEnv
  return fs.existsSync(TAILSCALE_AUTHKEY_SECRETS_FILE)
    ? fs.readFileSync(TAILSCALE_AUTHKEY_SECRETS_FILE, 'utf-8').trim() || null
    : null
}

/**
 * Store the Tailscale auth key on the Pi without it ever being a command-line
 * argument (idea#115). The key goes over the command's stdin (through ssh when
 * `exec` is the ssh() helper, whose arguments are shellQuote'd) into `sudo tee`,
 * under umask 077 inside a root-only (0700) folder, so the file is created as
 * root with mode 0600 and nobody else can read it at any point. `tee` reads fd 0
 * directly (`install /dev/stdin` fails when stdin is a socket, as with Node child
 * processes). Before idea#115 it was `echo <key> | sudo tee …`, so the key was in
 * the ssh and remote shell arguments, visible with `ps`.
 */
export const storeTailscaleAuthKey = async (exec: any, authKey: string): Promise<void> => {
  await exec`sudo install -d -m 700 -o root -g root ${TAILSCALE_AUTHKEY_DIR}`
  const write = exec`umask 077 && sudo tee ${TAILSCALE_AUTHKEY_PATH} > /dev/null`
  write.stdin.end(authKey + '\n')
  await write
  // An existing file keeps its old mode and owner under tee: set them explicitly.
  await exec`sudo chmod 600 ${TAILSCALE_AUTHKEY_PATH}`
  await exec`sudo chown root:root ${TAILSCALE_AUTHKEY_PATH}`
}

/**
 * Install Tailscale on a newly provisioned Pi.
 *
 * Design: design/tailscale-remote-management.md
 *
 * Tailscale is installed in "latent" mode:
 *   - Binaries present, systemd service DISABLED and NOT started
 *   - Auth key stored at /etc/tailscale/debug-authkey (600, root), see storeTailscaleAuthKey
 *   - Activation script installed at /usr/local/bin/tailscale-debug-activate.sh; it
 *     passes the key to `tailscale up` as `--auth-key=file:<path>`, never the key itself
 *
 * The Pi remains fully offline during normal operation.
 * A coordinator activates debug mode by running the activation script over SSH.
 *
 * Auth key source (in priority order), see resolveTailscaleAuthKey:
 *   1. TAILSCALE_AUTHKEY env var (set on the management Pi running buildEngine)
 *   2. /home/pi/openclaw/secrets/tailscale_authkey.txt (Atlas's secrets dir on this Pi)
 * Use a short-lived, single-use key (docs/PI_FLEET.md). The key is never logged
 * and never passed as a command argument (idea#115).
 */
export const installTailscale = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing Tailscale (latent debug mode)...'))

  const authKey = resolveTailscaleAuthKey()

  if (!authKey) {
    console.error(chalk.red(`installTailscale: no auth key found. Set TAILSCALE_AUTHKEY env var or ensure ${TAILSCALE_AUTHKEY_SECRETS_FILE} exists.`))
    process.exit(1)
  }

  try {
    // 1. Download and install Tailscale static binaries (arm64)
    // curl-installs the official static tarball so no package manager changes are needed.
    // The service is NOT enabled after installation.
    // The script is one interpolated (quoted) argument, so $TSVER is expanded by
    // the bash on the Pi, not by TypeScript or the local shell.
    const downloadScript =
      'TSVER=$(curl -sL https://pkgs.tailscale.com/stable/ | grep -oP \'tailscale_\\K[\\d.]+(?=_arm64.tgz)\' | head -1)' +
      ' && curl -sL "https://pkgs.tailscale.com/stable/tailscale_${TSVER}_arm64.tgz"' +
      ' | sudo tar -xz --strip-components=1 -C /usr/sbin' +
      ' "tailscale_${TSVER}_arm64/tailscale" "tailscale_${TSVER}_arm64/tailscaled"'
    await exec`bash -c ${downloadScript}`

    // 2. Install systemd service (disabled — does not start on boot)
    await exec`sudo cp ${enginePath}/script/build_image_assets/tailscaled.service /etc/systemd/system/tailscaled.service`
    await exec`sudo systemctl daemon-reload`
    // explicitly do NOT enable: tailscale must be activated manually

    // 3. Store auth key (root-only, 600) — over stdin, never as an argument
    await storeTailscaleAuthKey(exec, authKey)

    // 4. Install activation script
    await exec`sudo cp ${enginePath}/script/build_image_assets/tailscale-debug-activate.sh /usr/local/bin/tailscale-debug-activate.sh`
    await exec`sudo chmod 755 /usr/local/bin/tailscale-debug-activate.sh`

    print(chalk.green('Tailscale installed (service disabled — latent debug mode ready)'))
  } catch (e) {
    print(chalk.red('Error installing Tailscale'))
    // Error text holds stderr only; strip the key anyway in case a tool echoes it.
    console.error(String(e).split(authKey).join('[redacted]'))
    process.exit(1)
  }
}

export const installZerotier = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing Zerotier...'));
  try {
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/install-zerotier.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/install-zerotier.sh`;
  } catch (e) {
    print(chalk.red('Error installing Zerotier'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Zerotier installed'));
}

export const installRSync = async (exec: any) => {
  print(chalk.blue('Installing rsync...'));
  try {
    await exec`sudo apt install rsync -y`;
  } catch (e) {
    print(chalk.red('Error installing rsync'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('rsync installed'));
}

/**
 * The pnpm version every Engine install uses (idea#146). It must equal the
 * `packageManager` field in package.json (a test checks this). Never install the
 * latest pnpm: pnpm 12 rejects our lockfile settings and refuses `sudo pnpm setup`.
 */
export const PNPM_VERSION = '10.33.0'
/** The Node.js version `n` installs for the Engine. */
export const NODE_VERSION = '22.20.0'

export const installBaseNpm = async (exec: any) => {
  print(chalk.blue(`Installing base node ${NODE_VERSION}, n, npm and pnpm ${PNPM_VERSION} for script execution...`));
  try {
    await exec`sudo apt install npm -y`
    // Pinned pnpm, never latest (idea#146)
    await exec`sudo npm install -g -y n pnpm@${PNPM_VERSION}`
    await exec`sudo n ${NODE_VERSION}`
  } catch (e) {
    print(chalk.red('Error installing base node, n, npm and pnpm...'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Base node, n, npm and pnpm installed'));
}

export const installEngineNode = async (exec: any) => {
  print(chalk.blue('Installing node version for engine...'));
  try {
    await exec`sudo n ${NODE_VERSION}`
  } catch (e) {
    print(chalk.red('Error installing engine node version...'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Engine node version installed'));
}

/**
 * Check the pinned pnpm is the one on PATH, then run `pnpm setup` as the build
 * user (pi), not with sudo (idea#146). `sudo pnpm setup` only configured root's
 * home, and pnpm 12 refuses it outright (ERR_PNPM_SUDO_NOT_SUPPORTED), which used
 * to abort the build before the Engine was installed and before the final reboot.
 * `pnpm setup` only adds PNPM_HOME to the user's shell profile; nothing later in
 * the build needs it, so a failure there is a warning, not a stop.
 */
export const configurePnpm = async (exec: any) => {
  print(chalk.blue('Setting up pnpm...'));
  let installed = ''
  try {
    const out = await exec`pnpm --version`
    installed = String(out.stdout ?? out).trim()
  } catch (e) {
    print(chalk.red('pnpm is not on PATH after installBaseNpm'));
    console.error(e);
    process.exit(1);
  }
  if (installed !== PNPM_VERSION) {
    print(chalk.red(`pnpm ${installed} is installed, but the Engine needs pnpm ${PNPM_VERSION} (idea#146)`));
    process.exit(1);
  }
  try {
    await exec`pnpm setup`
  } catch (e) {
    print(chalk.yellow('pnpm setup failed; continuing (only the shell profile is affected)'));
    console.error(e);
  }
  print(chalk.green(`pnpm ${PNPM_VERSION} set up`));
}


export const installPm2 = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing pm2...'));
  try {
    await exec`sudo npm install -g pm2`
    await exec`cd ${enginePath}`
    print(chalk.blue('Installing pm2-logrotate...'))
    // Install into pi's pm2 (no sudo), the same process list startEnginePM2 uses (idea#80).
    await exec`cd ${enginePath} && pm2 install pm2-logrotate`
  } catch (e) {
    print(chalk.red('Error installing pm2'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('pm2 installed'));
}

export const installEnginePM2 = async (exec: any, enginePath: string) => {
  print(chalk.blue('Installing the engine...'))
  await exec`cd ${enginePath} && pnpm install_packages`
}

export const buildEnginePM2 = async (exec: any, enginePath: string) => {
  print(chalk.blue('Building the engine with tsc...'))
  await exec`cd ${enginePath} && pnpm build`
}

export const startEnginePM2 = async (exec: any, enginePath: string, permanentEnginePath: string, productionMode: boolean) => {
  print(chalk.blue('Starting the engine with pm2...'));
  try {
    try {
      // We require idempotency - check if the engine has already started before starting and persisting it
      await exec`pm2 show engine`
    } catch (e) {
      print(chalk.blue(`Starting a ${productionMode ? "production" : "dev"} mode engine with pm2...`))
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
      print(chalk.blue('Saving the pm2 process list...'))
      await exec`pm2 save`
      print(chalk.blue('Enabling pm2 to start on boot...'))
      // Generate the startup command for the pi user and run it with sudo.
      // pm2 startup outputs a line beginning with 'sudo env PATH=...' — extract and execute it.
      const startupOutput = (await exec`pm2 startup systemd -u pi --hp /home/pi`).stdout
      const startupCmd = startupOutput.split('\n').find((l: string) => l.trimStart().startsWith('sudo env PATH='))
      if (startupCmd) {
        await exec`${startupCmd.trim()}`
      } else {
        print(chalk.yellow('Could not extract pm2 startup command from output — run manually if needed'))
        print(startupOutput)
      }
    }
  } catch (e) {
    print(chalk.red('Error starting the engine with pm2'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Engine started with pm2'))
}

/**
 * Grants the Node.js binary the capability to bind to privileged ports (< 1024),
 * e.g. port 80 for the Console HTTP server.
 *
 * This allows the Engine to serve on port 80 without running as root.
 * Must be re-applied after any Node.js binary update.
 */
export const grantNetBindCapability = async (exec: any) => {
  print(chalk.blue('Granting node cap_net_bind_service (port 80 access)...'))
  try {
    await exec`sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))`
    print(chalk.green('cap_net_bind_service granted to node'))
  } catch (e) {
    print(chalk.red('Error granting cap_net_bind_service — port 80 may not work as non-root'))
    console.error(e)
  }
}

export const installVarious = async (exec: any) => {
  print(chalk.blue('Installing tcpdump, vim and hdparm...'));
  try {
    await exec`sudo apt install tcpdump vim tmux hdparm -y`;
  } catch (e) {
    print(chalk.red('Error installing tcpdump, vim and hdparm'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('tcpdump, vim and hdparm installed'));
}

export const installVarious2 = async (exec: any) => {
  // Install the git, dnsutlis, tree, lshw and cloud-guest-utils packages
  print(chalk.blue('Installing lm-sensors, git, dnsutils, tree, lshw and cloud-guest-utils...'));
  try {
    await exec`sudo apt install git dnsutils tree lshw cloud-guest-utils -y`;
  } catch (e) {
    print(chalk.red('Error installing git, dnsutils, tree, lshw and cloud-guest-utils'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('git, dnsutils, tree, lshw and cloud-guest-utils installed'));
}

export const installChromium = async (exec: any) => {
  print(chalk.blue('Installing Chromium (required for md-to-pdf headless PDF generation)...'));
  try {
    await exec`sudo apt install chromium -y`;
  } catch (e) {
    print(chalk.red('Error installing Chromium'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Chromium installed'));
}


export const buildAppsInfrastructure = async (exec: any) => {
  // Create the /apps, /apps/catalog, and /apps/instances directories 
  print(chalk.blue('Creating the /services, /apps, and /instances directories'))
  try {
    await createDir(exec, '/services')
    await createDir(exec, '/apps')
    await createDir(exec, '/instances')
  } catch (e) {
    print(chalk.red('Error creating the /services, /apps, and /instances directories'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('The /services, /apps, and /instances directories have been created'));
}


const installDocker = async (exec, enginePath, user) => {

  // Run the install-docker.sh script
  print(chalk.blue('Installing Docker'))
  try {
    // Make the script executable
    await exec`sudo chmod +x ${enginePath}/script/build_image_assets/install-docker.sh`;
    await exec`sudo ${enginePath}/script/build_image_assets/install-docker.sh`;
  } catch (e) {
    print(chalk.red('Error installing Docker'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker installed'));

  // Add the docker group if it does not already exist
  print(chalk.blue('Adding the docker group'))
  try {
    // Check if the docker group already exists
    if (await exec`getent group docker`) {
      print(chalk.blue('The docker group already exists'));
    } else {
      await exec`sudo groupadd docker`;
    }
  } catch (e) {
    print(chalk.red('Error adding the docker group'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker group added'));


  // Add the ssh user to the docker group
  print(chalk.blue('Adding the ssh user to the docker group'))
  try {
    await exec`sudo usermod -aG docker ${user}`;
  } catch (e) {
    print(chalk.red('Error adding the ssh user to the docker group'));
    console.error(e);
    process.exit(1);
  }

  // Copy the daemon.json asset to /etc/docker
  print(chalk.blue('Configuring Docker'))
  try {
    await copyAsset(exec, enginePath, 'daemon.json', '/etc/docker', false, "0644")
  } catch (e) {
    print(chalk.red('Error configuring Docker'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker configured'));


  // Restart the Docker service
  print(chalk.blue('Restarting the Docker service'))
  try {
    await exec`sudo systemctl restart docker`;
  } catch (e) {
    print(chalk.red('Error restarting the Docker service'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker service restarted'));


  // Print the Docker Compose, the Docker version and the Docker info
  print(chalk.blue('Docker info'))
  try {
    // (use sudo because the docker group has not been added yet - requires a reboot)
    let ret = await exec`sudo docker compose version`
    print(ret.stdout)
    ret = await exec`sudo docker version`
    print(ret.stdout)
    ret = await exec`sudo docker info`
    print(ret.stdout)
  } catch (e) {
    print(chalk.red('Error printing the Docker info'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Docker info printed'));
}

const buildDockerInfrastructure = async (exec: any) => {

  // Create the internal docker networks frontend and backend if they do not already exist
  print(chalk.blue('Creating the frontend network'))
  try {
    // Check if the frontend network already exists
    // (use sudo because the docker group has not been added yet - requires a reboot)
    if (await exec`sudo docker network ls --filter name=frontend`) {
      print(chalk.blue('The frontend network already exists'));
    } else {
      await exec`sudo docker network create --internal frontend`;
    }
    // Check if the backend network already exists
    if (await exec`sudo docker network ls --filter name=backend`) {
      print(chalk.blue('The backend network already exists'));
    } else {
      await exec`sudo docker network create --internal backend`;
    }
  } catch (e) {
    print(chalk.red('Error creating the frontend or backend network'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Frontend and backend networks created'));
}


// ##################################################################################################
// Obsolete functions
// To be kept for reference only
// ##################################################################################################


const startDockerEngine = async (exec: any, enginePath: string, productionMode: boolean) => {
  // Build the engine image
  print(chalk.blue(`Building a ${productionMode ? "production" : "dev"} mode engine image...`))
  try {
    // Compose build
    // (use sudo because the docker group has not been added yet - requires a reboot)
    if (productionMode) {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-prod.yaml build`;
    } else {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-dev.yaml build`;
    }
  } catch (e) {
    print(chalk.red('Error building the engine image'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Engine image built'));

  // Start the engine
  print(chalk.blue('Composing up the engine...'));
  try {
    // Compose up 
    // (use sudo because the docker group has not been added yet - requires a reboot)
    if (productionMode) {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-prod.yaml up -d`;
    } else {
      await exec`cd ${enginePath} && sudo docker compose -f compose-engine-dev.yaml up -d`;
    }
  } catch (e) {
    print(chalk.red('Error composing up the engine'));
    console.error(e);
    process.exit(1);
  }
  print(chalk.green('Engine composed up'));
}
