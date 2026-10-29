/**
 * RestoreAppFiles.ts (#189): a restore onto another disk brings only the instance
 * data from the Backup Disk. The app master (apps/<appId>) and the service image
 * tars (services/*.tar) stay where the instance was, so the restored instance
 * could not load its images and moveApp/copyApp refused ("App master not found").
 * Copy them onto the target from a docked disk that has them, the previous disk
 * first, the same way moveApp/copyApp sync them.
 */

import { fs } from 'zx'
import { log } from '../utils/utils.js'
import { rsyncDirectory } from '../utils/rsync.js'
import { Disk, diskMountRoot } from './Disk.js'

export interface RestoreAppFilesResult {
    appMasterFrom: string | null
    servicesCopied: string[]
    servicesMissing: string[]
}

export const serviceTarName = (serviceImage: string): string => serviceImage.replace(/\//g, '_') + '.tar'

/**
 * Make `target` hold apps/<appId> and the service tars of `serviceImages`.
 * `candidates` are docked local disks in order of preference (previous disk first).
 * Missing pieces are logged, never thrown: the instance data is already restored.
 */
export const ensureAppFilesOnTarget = async (
    appId: string,
    serviceImages: string[],
    target: Disk,
    candidates: Disk[],
): Promise<RestoreAppFilesResult> => {
    const targetRoot = await diskMountRoot(target)
    const roots: string[] = []
    for (const d of candidates) {
        if (!d?.device || String(d.id) === String(target.id)) continue
        const r = await diskMountRoot(d)
        if (r !== targetRoot && !roots.includes(r)) roots.push(r)
    }
    const res: RestoreAppFilesResult = { appMasterFrom: null, servicesCopied: [], servicesMissing: [] }

    const masterDest = `${targetRoot}/apps/${appId}`
    if (await fs.pathExists(masterDest)) {
        res.appMasterFrom = masterDest
    } else {
        const from = await firstExisting(roots.map(r => `${r}/apps/${appId}`))
        if (from) {
            log(`restoreApp: copying app master ${from} → ${masterDest} (#189)`)
            await fs.ensureDir(`${targetRoot}/apps`)
            await rsyncDirectory(from, masterDest)
            res.appMasterFrom = from
        } else {
            log(`restoreApp: no docked disk has apps/${appId}; the restored instance cannot be moved or copied until it is installed again`)
        }
    }

    for (const image of serviceImages) {
        const tar = serviceTarName(image)
        const dest = `${targetRoot}/services/${tar}`
        if (await fs.pathExists(dest)) continue
        const from = await firstExisting(roots.map(r => `${r}/services/${tar}`))
        if (!from) { res.servicesMissing.push(tar); log(`restoreApp: service image ${tar} not found on any docked disk`); continue }
        log(`restoreApp: copying service image ${from} → ${dest} (#189)`)
        await fs.ensureDir(`${targetRoot}/services`)
        await fs.copy(from, dest, { preserveTimestamps: true })
        res.servicesCopied.push(tar)
    }
    return res
}

const firstExisting = async (paths: string[]): Promise<string | null> => {
    for (const p of paths) if (await fs.pathExists(p)) return p
    return null
}
