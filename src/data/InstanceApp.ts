/**
 * InstanceApp.ts: find the App record of an instance (idea#392)
 *
 * Instance.instanceOf is built from the instance compose's x-app.name and
 * x-app.version, but appDB keys come from the apps/<folder> name on the disk.
 * When the two differ (Disk B fixture: instanceOf nextcloud-1.0-smoke, folder
 * apps/nextcloud-1.0), store.appDB[instance.instanceOf] misses and every
 * filesMount / usbMount path skips without a word.
 *
 * resolveInstanceApp (async) falls back to the apps/ folder on the instance's
 * disk whose compose x-app name+version gives the same id, warns once naming
 * both ids, and remembers the alias. appForInstance (sync) is the one lookup
 * callers use: appDB[instanceOf], else the remembered alias.
 */

import { YAML, chalk, fs } from 'zx'
import { Store } from './Store.js'
import type { App } from './App.js'
import type { Instance } from './Instance.js'
import { AppID, InstanceID } from './CommonTypes.js'
import { diskMountRoot, joinMountRoot } from './Disk.js'
import { print } from '../utils/utils.js'

/** instance id → App folder id found by the fallback. */
const aliases = new Map<InstanceID, AppID>()

/** Tests only: forget remembered aliases. */
export const resetInstanceAppAliasesForTests = (): void => { aliases.clear() }

/** Sync lookup: the App by instanceOf, else by the folder alias resolveInstanceApp found. */
export const appForInstance = (store: Store, instance: Instance): App | undefined => {
    const direct = store.appDB?.[instance.instanceOf]
    if (direct) return direct
    const alias = aliases.get(instance.id)
    return alias ? store.appDB?.[alias] : undefined
}

/**
 * Async lookup with the folder fallback. Returns undefined (clean skip) when
 * neither instanceOf nor any apps/ folder on the instance's disk matches.
 */
export const resolveInstanceApp = async (store: Store, instance: Instance): Promise<App | undefined> => {
    const known = appForInstance(store, instance)
    if (known) return known
    const disk = instance.storedOn ? store.diskDB?.[instance.storedOn] : undefined
    if (!disk?.device) return undefined
    let appsDir: string
    let folders: string[]
    try {
        appsDir = joinMountRoot(await diskMountRoot(disk), 'apps')
        folders = await fs.readdir(appsDir)
    } catch {
        return undefined
    }
    for (const folder of folders.sort()) {
        if (!store.appDB?.[folder as AppID]) continue
        try {
            const c = YAML.parse(await fs.readFile(`${appsDir}/${folder}/compose.yaml`, 'utf8'))
            const x = c?.['x-app']
            if (!x?.name || x.version === undefined) continue
            if (`${x.name}-${x.version}` !== String(instance.instanceOf)) continue
        } catch {
            continue
        }
        aliases.set(instance.id, folder as AppID)
        print(chalk.yellow(`WARNING: instance ${instance.id}: no App '${instance.instanceOf}' (instanceOf from x-app); using App '${folder}' from its apps/ folder on disk ${disk.id} (idea#392)`))
        return store.appDB[folder as AppID]
    }
    return undefined
}

/** Resolve (and remember) the App of every instance on a docked disk; for sync callers. */
export const resolveAllInstanceApps = async (store: Store): Promise<void> => {
    for (const inst of Object.values(store.instanceDB ?? {})) {
        if (!store.appDB?.[inst.instanceOf]) await resolveInstanceApp(store, inst)
    }
}
