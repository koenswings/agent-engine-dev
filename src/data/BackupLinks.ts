/**
 * BackupLinks.ts — addBackupLink / removeBackupLink (idea#451)
 *
 * Edit one link in a docked Backup Disk's BACKUP.yaml without rewriting the others.
 * Agreed approach: idea#451 issue body plus Steve's decisions
 * (https://github.com/koenswings/idea/issues/451#issuecomment-6847233193).
 *
 *  - Only the `links` list changes. `mode`, every other link (with its own
 *    lastBackup), the order and any unknown keys (for example a future `schedule`)
 *    pass through untouched: the file is edited as a YAML document, not rebuilt.
 *  - The write is atomic: a temp file in the same folder, fsync, then rename.
 *  - Disk.backupConfig.links in the store is edited in place (push / splice).
 *  - No processDisk and no backup trigger, even in `immediate` mode.
 *  - removeBackupLink never touches backups/<id>/ (the repo stays).
 *  - Both commands take the Backup Disk lock (diskKey) while they edit.
 *
 * Refusals throw with a leading result code, so the command trace closes as error:
 * NOT_DOCKED, AMBIGUOUS, SYSTEM_DISK, NOT_A_BACKUP_DISK, BAD_BACKUP_YAML,
 * INSTANCE_NOT_FOUND, ALREADY_LINKED, NOT_LINKED, BUSY, BACKUP_IN_PROGRESS.
 * requireBackupTarget (BackupVerify.ts) is deliberately not reused: its messages
 * stay uncoded in this PR (Steve, decision 4).
 */

import { YAML, chalk, fs } from 'zx'
import { promises as fsp } from 'fs'
import { DocHandle } from '@automerge/automerge-repo'
import { log, print } from '../utils/utils.js'
import { disksRoot } from './Config.js'
import { Disk, isSystemDiskRecord } from './Disk.js'
import { Store, getLocalEngine } from './Store.js'
import { lookupDiskArg } from './DiskArg.js'
import { lookupInstanceArg, lookupLocalInstanceArg, describeInstanceCandidates } from './InstanceArg.js'
import { BackupMode, InstanceID } from './CommonTypes.js'
import { localEngineId } from './Engine.js'
import { attachTraceResult } from './SummariseDisk.js'
import { resourceLock, diskKey } from '../utils/ResourceLock.js'
import { backupYamlIo, writeBackupDocumentAtomic } from './BackupYamlDoc.js'
import { runningBackupOnDisk, BACKUP_IN_PROGRESS, hasBackupStaleLock } from '../monitors/backupMonitor.js'

export const BACKUP_LINK_NEXT_BACKUP_NOTE = 'next backup on the next dock / backupApp'

export type BackupLinkRefusal =
    | 'NOT_DOCKED' | 'AMBIGUOUS' | 'SYSTEM_DISK' | 'NOT_A_BACKUP_DISK' | 'BAD_BACKUP_YAML'
    | 'INSTANCE_NOT_FOUND' | 'ALREADY_LINKED' | 'NOT_LINKED' | 'BUSY' | 'BACKUP_IN_PROGRESS'

const refuse = (code: BackupLinkRefusal, command: string, why: string): Error =>
    new Error(`${code}: ${command}: ${why}`)

/** File operations of the atomic write (shared with BackupYamlDoc.ts; tests replace `rename`). */
export const backupLinkIo = backupYamlIo

const yamlPathFor = (device: string): string => `${disksRoot()}/${device}/BACKUP.yaml`
const repoPathFor = (device: string, instanceId: string): string => `${disksRoot()}/${device}/backups/${instanceId}`

interface ParsedBackupYaml {
    doc: ReturnType<typeof YAML.parseDocument>
    links: any
    mode: BackupMode
    ids: string[]
}

/** Read BACKUP.yaml as a document. Refuses BAD_BACKUP_YAML unless it is `{mode, links[]}`. */
const readBackupDocument = async (device: string, command: string): Promise<ParsedBackupYaml> => {
    const path = yamlPathFor(device)
    let raw: string
    try {
        raw = await fs.readFile(path, 'utf-8')
    } catch (e: any) {
        throw refuse('BAD_BACKUP_YAML', command, `cannot read ${path}: ${e?.code ?? e?.message ?? e}`)
    }
    const doc = YAML.parseDocument(raw)
    if (doc.errors.length) throw refuse('BAD_BACKUP_YAML', command, `${path} does not parse: ${doc.errors[0].message}`)
    if (!YAML.isMap(doc.contents)) throw refuse('BAD_BACKUP_YAML', command, `${path} is not a mapping`)
    const mode = doc.get('mode')
    if (typeof mode !== 'string' || !mode) throw refuse('BAD_BACKUP_YAML', command, `${path} has no mode`)
    const links = doc.get('links')
    if (!YAML.isSeq(links)) throw refuse('BAD_BACKUP_YAML', command, `${path} has no links list`)
    const ids: string[] = []
    for (const item of links.items) {
        const id = YAML.isMap(item) ? item.get('instanceId') : undefined
        if ((typeof id !== 'string' && typeof id !== 'number') || String(id) === '') {
            throw refuse('BAD_BACKUP_YAML', command, `${path} has a link without an instanceId`)
        }
        ids.push(String(id))
    }
    return { doc, links, mode: mode as BackupMode, ids }
}

/** Disk argument checks shared by both commands: docked here, not the system disk, a Backup Disk. */
const resolveBackupLinkDisk = async (store: Store, arg: string, command: string): Promise<Disk & { device: string }> => {
    const engineId = getLocalEngine(store)?.id
    const r = lookupDiskArg(store, engineId, arg)
    if (!r.ok) {
        throw refuse(/ambiguous/.test(r.message) ? 'AMBIGUOUS' : 'NOT_DOCKED', command, r.message)
    }
    const disk = r.disk as Disk
    if (r.byName) {
        console.warn(`${command}: disk '${disk.name}' was given by name; use the disk id ${disk.id} (names are deprecated, idea#128).`)
    }
    if (await isSystemDiskRecord(disk)) {
        throw refuse('SYSTEM_DISK', command, `${disk.name} (${disk.id}) is this Pi's system disk and cannot be a Backup Disk`)
    }
    if (!disk.device) throw refuse('NOT_DOCKED', command, `disk '${disk.id}' is not currently docked`)
    if (!(disk.diskTypes ?? []).includes('backup')) {
        throw refuse('NOT_A_BACKUP_DISK', command, `disk '${disk.id}' is not a Backup Disk (no BACKUP.yaml role)`)
    }
    return disk as Disk & { device: string }
}

/** BUSY when the disk lock is held or a backupApp to this disk is Pending/Running. */
const busyReason = (store: Store, diskId: string): string | null => {
    const held = resourceLock.getLockInfo(diskKey(diskId))
    if (resourceLock.isLocked(diskKey(diskId))) return `the Backup Disk is locked${held ? ` by '${held.kind}'` : ''}`
    const op = runningBackupOnDisk(store, diskId)
    if (op) return `a backupApp of instance ${op.args?.instanceId ?? ''} to this disk is ${op.status}`
    return null
}

const takeDiskLock = (store: Store, diskId: string, command: string): void => {
    const busy = busyReason(store, diskId)
    if (busy) throw refuse('BUSY', command, busy)
    if (!resourceLock.acquireAll([diskKey(diskId)], command)) {
        const held = resourceLock.getLockInfo(diskKey(diskId))
        throw refuse('BUSY', command, `the Backup Disk is locked${held ? ` by '${held.kind}'` : ''}`)
    }
}

export interface AddBackupLinkResult {
    backupDiskId: string
    instanceId: string
    links: string[]
    added: true
    note: string
}

/**
 * addBackupLink <instanceIdOrName> <backupDiskIdOrName> (idea#451). Local-only:
 * the instance resolves like createBackupDisk (resolveLocalInstanceArg rules).
 * Appends {instanceId, lastBackup: 0}; refuses only on BUSY for a busy disk
 * (a recorded stale lock does not block an add, Steve decision 5).
 */
export const addBackupLink = async (
    storeHandle: DocHandle<Store>,
    instanceArg: string,
    backupDiskArg: string,
): Promise<AddBackupLinkResult> => {
    const command = 'addBackupLink'
    if (!storeHandle) throw new Error('Store is not available. Please connect first.')
    const store = storeHandle.doc()
    const disk = await resolveBackupLinkDisk(store, String(backupDiskArg), command)

    const engineId = String(getLocalEngine(store)?.id ?? localEngineId)
    const inst = lookupLocalInstanceArg(store, String(instanceArg), engineId)
    if (!inst.ok) {
        if (inst.reason === 'ambiguous') {
            throw refuse('AMBIGUOUS', command, `instance name '${instanceArg}' is ambiguous on this Engine: ${describeInstanceCandidates(inst.candidates)}. Use the instance id.`)
        }
        if (inst.reason === 'not-local') {
            throw refuse('INSTANCE_NOT_FOUND', command, `instance ${instanceArg} is not on this Engine (stored on disk ${inst.instance.storedOn ?? 'none'}, not docked here)`)
        }
        throw refuse('INSTANCE_NOT_FOUND', command, `instance '${instanceArg}' not found on this Engine`)
    }
    const instanceId = String(inst.instance.id)

    takeDiskLock(store, disk.id, command)
    try {
        const parsed = await readBackupDocument(disk.device, command)
        if (parsed.ids.includes(instanceId)) {
            throw refuse('ALREADY_LINKED', command, `instance ${instanceId} is already linked to Backup Disk ${disk.id}`)
        }
        if (parsed.links.items.length === 0) parsed.links.flow = false
        parsed.links.add(parsed.doc.createNode({ instanceId, lastBackup: 0 }))
        await writeBackupDocumentAtomic(disk.device, parsed.doc.toString())
        const links = [...parsed.ids, instanceId]

        storeHandle.change(doc => {
            const d = doc.diskDB[disk.id]
            if (!d) return
            if (!d.backupConfig) {
                d.backupConfig = { mode: parsed.mode, links: links as InstanceID[] }
                return
            }
            if (!d.backupConfig.links.some(l => String(l) === instanceId)) d.backupConfig.links.push(instanceId as InstanceID)
        })

        const result: AddBackupLinkResult = { backupDiskId: disk.id, instanceId, links, added: true, note: BACKUP_LINK_NEXT_BACKUP_NOTE }
        attachTraceResult(result)
        log(`addBackupLink: linked ${instanceId} to Backup Disk ${disk.id} (mode ${parsed.mode}; ${BACKUP_LINK_NEXT_BACKUP_NOTE})`)
        print(chalk.green(`addBackupLink: ${instanceId} linked to Backup Disk ${disk.id}; ${BACKUP_LINK_NEXT_BACKUP_NOTE}`))
        return result
    } finally {
        resourceLock.releaseAll([diskKey(disk.id)])
    }
}

export interface RemoveBackupLinkResult {
    backupDiskId: string
    instanceId: string
    links: string[]
    removed: true
    repoLeft: string | null
}

/**
 * removeBackupLink <instanceIdOrRawId> <backupDiskIdOrName> (idea#451). A raw id that
 * is linked works even when the instance is gone from instanceDB. Never touches
 * backups/<id>/; refuses BACKUP_IN_PROGRESS while a lock file or a recorded stale
 * lock exists for the instance (clearBackupLock first).
 */
export const removeBackupLink = async (
    storeHandle: DocHandle<Store>,
    instanceArg: string,
    backupDiskArg: string,
): Promise<RemoveBackupLinkResult> => {
    const command = 'removeBackupLink'
    if (!storeHandle) throw new Error('Store is not available. Please connect first.')
    const store = storeHandle.doc()
    const disk = await resolveBackupLinkDisk(store, String(backupDiskArg), command)

    takeDiskLock(store, disk.id, command)
    try {
        const parsed = await readBackupDocument(disk.device, command)
        const arg = String(instanceArg)
        let instanceId: string | null = parsed.ids.includes(arg) ? arg : null
        if (!instanceId) {
            const r = lookupInstanceArg(store, arg)
            if (!r.ok && r.reason === 'ambiguous') {
                throw refuse('AMBIGUOUS', command, `instance name '${arg}' is ambiguous: ${describeInstanceCandidates(r.candidates)}. Use the instance id.`)
            }
            if (r.ok && parsed.ids.includes(String(r.instance.id))) instanceId = String(r.instance.id)
        }
        if (!instanceId) {
            throw refuse('NOT_LINKED', command, `'${arg}' is not linked to Backup Disk ${disk.id}`)
        }

        const repo = repoPathFor(disk.device, instanceId)
        if (await fs.pathExists(`${repo}/${BACKUP_IN_PROGRESS}`)) {
            throw refuse('BACKUP_IN_PROGRESS', command, `${repo}/${BACKUP_IN_PROGRESS} exists; run clearBackupLock first`)
        }
        if (hasBackupStaleLock(storeHandle.doc().diskDB[disk.id] ?? disk, instanceId)) {
            throw refuse('BACKUP_IN_PROGRESS', command, `a stale backup lock for ${instanceId} is recorded on this disk; run clearBackupLock first`)
        }

        for (let i = parsed.links.items.length - 1; i >= 0; i--) {
            if (parsed.ids[i] === instanceId) parsed.links.delete(i)
        }
        await writeBackupDocumentAtomic(disk.device, parsed.doc.toString())
        const links = parsed.ids.filter(id => id !== instanceId)

        storeHandle.change(doc => {
            const d = doc.diskDB[disk.id]
            if (!d?.backupConfig) return
            for (let i = d.backupConfig.links.length - 1; i >= 0; i--) {
                if (String(d.backupConfig.links[i]) === instanceId) d.backupConfig.links.splice(i, 1)
            }
        })

        const repoLeft = await fs.pathExists(repo) ? repo : null
        const result: RemoveBackupLinkResult = { backupDiskId: disk.id, instanceId, links, removed: true, repoLeft }
        attachTraceResult(result)
        log(`removeBackupLink: unlinked ${instanceId} from Backup Disk ${disk.id}${repoLeft ? `; repository left at ${repoLeft}` : ''}`)
        print(chalk.green(`removeBackupLink: ${instanceId} unlinked from Backup Disk ${disk.id}${repoLeft ? ` (repository kept at ${repoLeft})` : ''}`))
        return result
    } finally {
        resourceLock.releaseAll([diskKey(disk.id)])
    }
}
