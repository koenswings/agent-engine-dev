import { $, YAML, chalk } from 'zx';
import { Version, URL, AppID, AppName, Hostname, DeviceName, DiskName, DiskID } from './CommonTypes.js';
import { log } from '../utils/utils.js';
import { Store } from './Store.js';
import { Disk } from './Disk.js';
import { DocHandle } from '@automerge/automerge-repo';

export interface App {
    id: AppID;
    name: AppName;
    version: Version;
    title: string;
    description: string | null;
    url: URL | null;
    category: AppCategory;
    icon: URL | null;
    author: string | null;
}

type AppCategory = 'Productivity' | 'Utilities' | 'Games' | 'education' | 'office' | 'it' | string;

export const createAppId = (appName: AppName, version: Version): AppID => {
    return appName + "-" + version as AppID
}

export const extractAppName = (appId: AppID): AppName => {
    return appId.split('-')[0] as AppName
}

export const extractAppVersion = (appId: AppID): Version => {
    return appId.split('-')[1] as Version
}

/**
 * Returns the major version number from an appId (e.g. 'sample-1.0' → 1).
 * Major-only comparison is sufficient for current apps: all versions use
 * integer-major style (1.x, 2.x). No 0.x or pre-release versions in use.
 */
export const extractMajorVersion = (appId: AppID): number => {
    const version = extractAppVersion(appId)   // e.g. "1.0"
    return parseInt(version.split('.')[0], 10)
}

/**
 * Returns true if docking newAppId onto a disk that already has an instance
 * of oldAppId represents a major (breaking) version change.
 *
 * Major upgrade (1.x → 2.x): engine blocks instance startup — the operator
 * must explicitly migrate data before the new version can run.
 *
 * Minor upgrade (1.0 → 1.1): allowed — engine restarts the instance with the
 * new version automatically.
 */
export const isMajorUpgrade = (oldAppId: AppID, newAppId: AppID): boolean => {
    if (oldAppId === newAppId) return false
    return extractMajorVersion(oldAppId) !== extractMajorVersion(newAppId)
}

export const createOrUpdateApp = async (storeHandle: DocHandle<Store>, appId: AppID, disk: Disk) => {
    const store: Store = storeHandle.doc()
    const device: DeviceName = disk.device as DeviceName;
    const diskID: DiskID = disk.id as DiskID;
    let app: App;
    try {
        // The full name of the app is <appName>-<version>
        const appName = extractAppName(appId)
        const appVersion = extractAppVersion(appId)

        // Read the compose.yaml file in the app folder
        const appComposeFile = await $`cat /disks/${device}/apps/${appId}/compose.yaml`
        const appCompose = YAML.parse(appComposeFile.stdout)
        storeHandle.change(doc => {
            const storedApp: App | undefined = doc.appDB[appId]
            // Automerge rejects undefined — use null for absent optional fields
            const xapp = appCompose['x-app']
            if (!storedApp) {
                // Create a new app object
                log(chalk.green(`Creating new app ${appId} on disk ${diskID}`))
                app = {
                    id: appId as AppID,
                    name: appName,
                    version: appVersion,
                    title: xapp.title,
                    description: xapp.description ?? null,
                    url: xapp.url ?? null,
                    category: xapp.category,
                    icon: xapp.icon ?? null,
                    author: xapp.author ?? null
                }
                // Store the new app object in the store
                doc.appDB[appId] = app
            } else {
                // Granularly update the existing app object
                log(chalk.green(`Granularly updating existing app ${appId} on disk ${diskID}`))
                app = storedApp
                app.name = appName
                app.version = appVersion
                app.title = xapp.title
                app.description = xapp.description ?? null
                app.url = xapp.url ?? null
                app.category = xapp.category
                app.icon = xapp.icon ?? null
                app.author = xapp.author ?? null
            }
        })
    return app!
    } catch (e) {
        log(chalk.red(`Error initializing instance ${appId} on disk ${disk.id}`))
        console.error(e)
        return undefined
    }
}
