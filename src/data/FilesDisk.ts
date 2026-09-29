/**
 * FilesDisk.ts: the Files Disk role (idea#131, Files Disk step 1)
 *
 * A Files Disk is recognised by FILES.yaml in the disk root (proposals/files-disk.md
 * §6, §7.2). The role can be combined with the App and Backup roles on the same
 * disk. The shared content lives in files/; mounting it into Apps is step 2.
 *
 * FILES.yaml (version 1):
 *   version: 1               format version
 *   created: <ms>            when the disk became a Files Disk
 *   createdBy: <engineId>    Engine that ran createFilesDisk (informational)
 *   shareName: School Files  name Apps show for this disk
 *   readOnly: false          reserved, ignored in v1
 *   password: null           reserved; non-null → not mounted, filesConfig.error set
 *
 * The password never goes into the store.
 */

import { YAML, fs } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from './Store.js'
import { DiskID, EngineID, Timestamp } from './CommonTypes.js'
import { log } from '../utils/utils.js'

export const FILES_YAML = 'FILES.yaml'
export const FILES_DIR = 'files'
export const FILES_YAML_VERSION = 1
export const DEFAULT_SHARE_NAME = 'School Files'
export const FILES_PASSWORD_ERROR = 'password-protected Files Disks are not supported yet'

/** Disk.filesConfig (§7.5). error is only used for a password-protected disk. */
export interface FilesConfig {
    shareName: string
    readOnly: boolean
    passwordProtected: boolean
    error: string | null
}

export interface FilesYaml {
    version: number
    created: Timestamp
    createdBy: EngineID | null
    shareName: string
    readOnly: boolean
    password: string | null
}

/**
 * Share name rule (§7.1, E6): 1 to 16 bytes of A–Z a–z 0–9, space, hyphen,
 * underscore and parentheses (ASCII only, so bytes = characters), no leading
 * or trailing space. Never used as a filesystem label.
 */
export const SHARE_NAME_PATTERN = /^[A-Za-z0-9 _()-]{1,16}$/
export const validateShareName = (name: string): string | null => {
    if (!SHARE_NAME_PATTERN.test(name)) {
        return `Share name '${name}' is not allowed: use at most 16 characters from A–Z, a–z, 0–9, space, hyphen, underscore and parentheses.`
    }
    if (name !== name.trim()) return `Share name '${name}' must not start or end with a space.`
    return null
}

export const hasFilesYaml = async (mountRoot: string): Promise<boolean> =>
    fs.pathExists(`${mountRoot}/${FILES_YAML}`)

/**
 * Read FILES.yaml and turn it into a filesConfig. Throws when the file can't be
 * read or isn't a YAML mapping. A missing shareName falls back to the disk name.
 */
export const readFilesConfig = async (mountRoot: string, diskName: string): Promise<FilesConfig> => {
    const text = await fs.readFile(`${mountRoot}/${FILES_YAML}`, 'utf-8')
    let parsed: any
    try {
        parsed = YAML.parse(text)
    } catch (e: any) {
        throw new Error(`${FILES_YAML} is not valid YAML: ${e.message ?? e}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${FILES_YAML} is not a YAML mapping`)
    }
    const shareName = typeof parsed.shareName === 'string' && parsed.shareName.trim() !== '' ? parsed.shareName : diskName
    const passwordProtected = parsed.password !== undefined && parsed.password !== null
    return {
        shareName,
        readOnly: parsed.readOnly === true,
        passwordProtected,
        error: passwordProtected ? FILES_PASSWORD_ERROR : null,
    }
}

/**
 * processFilesDisk (§7.2): read FILES.yaml and set disk.filesConfig. On a
 * read error filesConfig is cleared and the error is thrown, so processDisk can
 * record it and go on with the App and Backup roles.
 */
export const processFilesDisk = async (storeHandle: DocHandle<Store>, diskId: DiskID, diskName: string, mountRoot: string): Promise<void> => {
    let filesConfig: FilesConfig
    try {
        filesConfig = await readFilesConfig(mountRoot, diskName)
    } catch (e) {
        storeHandle.change(doc => {
            const d = doc.diskDB[diskId]
            if (d) d.filesConfig = null
        })
        throw e
    }
    storeHandle.change(doc => {
        const d = doc.diskDB[diskId]
        if (d) d.filesConfig = filesConfig
    })
    if (filesConfig.passwordProtected) log(`Files Disk ${diskId}: ${FILES_PASSWORD_ERROR}; not mounted`)
    else log(`Files Disk ${diskId}: share '${filesConfig.shareName}'`)
}

export const filesYamlFor = (shareName: string, createdBy: EngineID | null, created: Timestamp): FilesYaml => ({
    version: FILES_YAML_VERSION,
    created,
    createdBy,
    shareName,
    readOnly: false,
    password: null,
})
