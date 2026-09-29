/**
 * CreateFilesDisk.ts: createFilesDisk <diskId> [<shareName…>] (idea#131, Files Disk step 1)
 *
 * Adds the Files role to an empty disk or an App and/or Backup Disk: writes
 * META.yaml if it is missing (the disk ID is always kept), FILES.yaml and an
 * empty files/ folder, then runs processDisk, which adds 'files' to diskTypes.
 * Nothing else on the disk is touched, and the filesystem label never changes.
 *
 * Checks, each throwing so the command trace ends as `error` (proposals/files-disk.md §7.1):
 *   0. share name rule (default "School Files"); not while an erase of this disk runs
 *   1. found here: disk ID only (no name fallback), docked to this engine, has a device
 *   2. not the system disk
 *   3. roles: ['empty'], or only 'app' and/or 'backup'; not already a Files Disk,
 *      not an Upgrade Disk
 *   4. no non-IDEA entries in the disk root (a stray files/ counts)
 *   5. ext4
 *   6. not busy (disk lock, running backup), checked before anything changes, and
 *      the disk lock is held from here until the files are written
 *   7. owner: if pi can't write the root, record the previous uid:gid and mode in
 *      the trace, then run exactly `sudo /usr/bin/chown -h pi:pi /disks/<device>`
 *      (11-engine-files; root folder only, not recursive, -h never follows a symlink)
 *   8. writable by pi
 * createFilesDisk is the only place that changes a disk root's owner.
 */

import { $, YAML, fs } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store, getLocalEngine } from './Store.js'
import { Disk, diskMountRoot, isSystemDiskRecord, processDisk } from './Disk.js'
import { lookupDiskById } from './DiskArg.js'
import { DEFAULT_SHARE_NAME, FILES_DIR, FILES_YAML, filesYamlFor, validateShareName } from './FilesDisk.js'
import { writeMetaFile, DiskMeta } from './Meta.js'
import { DiskName, EngineID, Timestamp } from './CommonTypes.js'
import { resourceLock, diskKey } from '../utils/ResourceLock.js'
import { runningBackupOnDisk } from '../monitors/backupMonitor.js'
import { log, print } from '../utils/utils.js'

/** The one chown the Engine runs as root, and the mount points it may run on (11-engine-files). */
export const SUDO_CHOWN = '/usr/bin/chown'
export const SUDO_CHOWN_ROOT = /^\/disks\/sd[a-z][12]$/
export const chownRootCommand = (mountPoint: string): string => `${SUDO_CHOWN} -h pi:pi ${mountPoint}`

export const MISSING_PERMISSION_MESSAGE =
    'this Engine is missing a permission update; ask Ops to install the new 11-engine-files sudoers file'

/**
 * Runs `sudo -n /usr/bin/chown -h pi:pi <mountPoint>`. sudo sees exactly
 * "/usr/bin/chown -h pi:pi /disks/<device>", which is what the 11-engine-files
 * entry matches; -n makes a missing entry fail at once instead of waiting for a
 * password. Refuses any path outside /disks/sd[a-z][12].
 */
export const runSudoChownRoot = async (mountPoint: string): Promise<void> => {
    if (!SUDO_CHOWN_ROOT.test(mountPoint)) {
        throw new Error(`${mountPoint} is not an Engine disk mount point (/disks/sd[a-z][12]); its owner is never changed`)
    }
    await $`sudo -n ${SUDO_CHOWN} -h pi:pi ${mountPoint}`
}

/** The filesystem and root-folder operations createFilesDisk uses; replaced in tests. */
export interface FilesDiskOps {
    fsType: (mountPoint: string) => Promise<string>
    rootOwner: (mountPoint: string) => Promise<{ uid: number, gid: number, mode: number }>
    canWrite: (mountPoint: string) => Promise<boolean>
    chownRoot: (mountPoint: string) => Promise<void>
}

export const defaultFilesDiskOps: FilesDiskOps = {
    fsType: async (mountPoint) => (await $`findmnt -no FSTYPE ${mountPoint}`.nothrow()).stdout.trim(),
    rootOwner: async (mountPoint) => {
        const st = await fs.lstat(mountPoint)
        return { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 }
    },
    canWrite: async (mountPoint) => fs.access(mountPoint, fs.constants.W_OK).then(() => true, () => false),
    chownRoot: runSudoChownRoot,
}

let ops: FilesDiskOps = defaultFilesDiskOps
/** Tests only: replace some of the operations (null: back to the real ones). */
export const setFilesDiskOpsForTests = (o: Partial<FilesDiskOps> | null): void => {
    ops = o ? { ...defaultFilesDiskOps, ...o } : defaultFilesDiskOps
}

/** Root entries each role may have; META.yaml and lost+found are always allowed. */
const ROLE_ROOT_ENTRIES: Record<string, string[]> = {
    app: ['apps', 'services', 'instances'],
    backup: ['BACKUP.yaml', 'backups'],
}

export const createFilesDisk = async (storeHandle: DocHandle<Store>, diskId: string, shareNameArg?: string): Promise<Disk> => {
    // 0. Share name and erase check
    const shareName = shareNameArg === undefined || shareNameArg === '' ? DEFAULT_SHARE_NAME : shareNameArg
    const nameError = validateShareName(shareName)
    if (nameError) throw new Error(nameError)
    const store = storeHandle.doc()
    const engine = getLocalEngine(store)
    const erase = engine.eraseInProgress
    if (erase && String(erase.targetId) === String(diskId)) {
        throw new Error(`Disk ${diskId} is being erased (${erase.step}). Try again when the erase has finished.`)
    }

    // 1. Found here, by disk ID only
    const found = lookupDiskById(store, engine.id, diskId)
    if (!found.ok) throw new Error(found.message)
    const disk = found.disk
    const name = disk.name

    // 2. Not the system disk
    if (await isSystemDiskRecord(disk)) throw new Error(`${name} is this Pi's system disk; it can't become a Files Disk.`)

    // 3. Allowed roles
    const root = await diskMountRoot(disk)
    const types = [...(disk.diskTypes ?? [])]
    if (types.includes('files') || await fs.pathExists(`${root}/${FILES_YAML}`)) throw new Error(`${name} is already a Files Disk.`)
    if (types.includes('upgrade')) throw new Error(`${name} is an Upgrade Disk; it can't also be a Files Disk.`)
    const emptyDisk = types.length === 1 && types[0] === 'empty'
    const appOrBackup = types.length > 0 && types.every(t => t === 'app' || t === 'backup')
    if (!emptyDisk && !appOrBackup) {
        throw new Error(types.length === 0
            ? `${name} has not been processed yet. Try again in a moment.`
            : `${name} can't become a Files Disk (disk types: ${types.join(', ')}).`)
    }

    // 4. No non-IDEA entries in the root
    const allowed = new Set(['META.yaml', 'lost+found', ...types.flatMap(t => ROLE_ROOT_ENTRIES[t] ?? [])])
    const others = (await fs.readdir(root)).filter(e => !allowed.has(e)).sort()
    if (others.length > 0) {
        const shown = others.slice(0, 5).join(', ') + (others.length > 5 ? `, … (${others.length} in all)` : '')
        throw new Error(`${name} has other files on it (${shown}). Use Make this a Files Disk to erase it, or empty it on another computer.`)
    }

    // 5. ext4
    const fsType = await ops.fsType(root)
    if (fsType !== 'ext4') {
        throw new Error(`${name} is not an ext4 disk (filesystem: ${fsType || 'unknown'}). Use Make this a Files Disk to erase it first.`)
    }

    // 6. Not busy. Checked before anything on the disk changes; the disk lock is
    // held until FILES.yaml and files/ are written.
    const backup = runningBackupOnDisk(store, disk.id)
    if (backup) throw new Error(`${name} is in use by a running backup of instance ${backup.args.instanceId}. Try again when it has finished.`)
    if (!resourceLock.acquire(diskKey(disk.id), 'createFilesDisk')) {
        const info = resourceLock.getLockInfo(diskKey(disk.id))
        throw new Error(`${name} is locked by an active '${info?.kind}' operation. Try again when it has finished.`)
    }
    try {
        // 7. Owner: only when pi can't write the root
        if (!(await ops.canWrite(root))) {
            const before = await ops.rootOwner(root)
            const mode = before.mode.toString(8).padStart(4, '0')
            print(`createFilesDisk: the root folder ${root} of ${name} (${disk.id}) is not writable by the Engine. Previous owner uid:gid ${before.uid}:${before.gid}, mode ${mode}. Running: sudo ${chownRootCommand(root)}`)
            try {
                await ops.chownRoot(root)
            } catch (e: any) {
                throw new Error(`${name}: could not change the owner of the disk root: ${MISSING_PERMISSION_MESSAGE} (${(e.stderr || e.message || String(e)).trim()}). Nothing was written to the disk.`)
            }
            print(`createFilesDisk: ${root} is now owned by pi:pi (was ${before.uid}:${before.gid}, mode ${mode})`)
        }

        // 8. Writable
        if (!(await ops.canWrite(root))) throw new Error(`${name}: the disk root is not writable by the Engine. Nothing was written to the disk.`)

        // META.yaml if missing: the store's disk ID is kept
        if (!(await fs.pathExists(`${root}/META.yaml`))) {
            const meta: DiskMeta = {
                diskId: disk.id,
                isHardwareId: false,
                diskName: name as DiskName,
                created: disk.created,
                lastDocked: disk.lastDocked,
            }
            await writeMetaFile(meta, `${root}/META.yaml`)
            log(`createFilesDisk: wrote META.yaml with the existing disk ID ${disk.id}`)
        }

        // files/ as pi, then FILES.yaml (written to a temporary name and renamed,
        // so a half-written FILES.yaml never marks the disk). files/ is removed
        // again if FILES.yaml can't be written, so a retry isn't refused.
        const filesDir = `${root}/${FILES_DIR}`
        await fs.mkdir(filesDir)
        try {
            const yaml = filesYamlFor(shareName, engine.id as EngineID, Date.now() as Timestamp)
            const tmp = `${root}/.${FILES_YAML}.tmp`
            await fs.writeFile(tmp, YAML.stringify(yaml))
            await fs.rename(tmp, `${root}/${FILES_YAML}`)
        } catch (e) {
            await fs.rmdir(filesDir).catch(() => {})
            await fs.remove(`${root}/.${FILES_YAML}.tmp`).catch(() => {})
            throw e
        }
        print(`createFilesDisk: wrote ${FILES_YAML} (share '${shareName}') and ${FILES_DIR}/ on ${name} (${disk.id})`)
    } finally {
        resourceLock.release(diskKey(disk.id))
    }

    // processDisk adds 'files' next to the existing roles; existing instances keep running
    const current = storeHandle.doc().diskDB[disk.id]
    await processDisk(storeHandle, current)
    const after = storeHandle.doc().diskDB[disk.id]
    if (!after?.diskTypes?.includes('files')) {
        throw new Error(`${name}: FILES.yaml was written but the disk was not detected as a Files Disk.`)
    }
    return after
}
