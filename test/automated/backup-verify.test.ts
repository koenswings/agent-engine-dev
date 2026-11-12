/**
 * backup-verify.test.ts (idea#446)
 *
 * Engine-side listBackup / verifyBackup / clearBackupLock / removeBackupRole,
 * path-check parsing, stale-lock recording, and helper-v9 argv gating.
 * The helper is mocked (fake sudo on PATH). This file does not edit idea-app-data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, os, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { config } from '../../src/data/Config.js'
import { commands } from '../../src/data/Commands.js'
import { processBackupDisk, backupInstance, isBackupActive } from '../../src/monitors/backupMonitor.js'
import {
    listBackup, verifyBackup, clearBackupLock, removeBackupRole,
    parseBorgListInventory, parseBorgMemberList, instanceRelativeMember,
    memberMatchesPath, pathsFoundInMembers, newestArchive, BACKUP_VERIFY_HELPER_MIN,
} from '../../src/data/BackupVerify.js'
import { parseBackupVerifyLists, parseBackupExcludeList } from '../../src/utils/backupExclude.js'
import { resourceLock, diskKey, instanceKey } from '../../src/utils/ResourceLock.js'
import { APP_DATA_HELPER_VERSION, borgPresence } from '../../src/utils/appDataHelper.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const INST = 'inst-ver-1' as InstanceID
const ARCHIVE = '2026-11-11T23-18-06-123Z'
const OLDER = '2026-11-10T10-00-00-000Z'

const FAKE_SUDO = `#!/usr/bin/env bash
[[ "$1" == -n && "$2" == /usr/local/sbin/idea-app-data ]] || exec /usr/bin/sudo "$@"
shift 2
echo "$*" >> "$FAKE_BORG_LOG"
case "$1" in
  version) echo "idea-app-data \${FAKE_HELPER_VERSION:-10}" ;;
  borg-list)
    bdev="$2"; id="$3"; archive="$4"
    if [ -n "\$archive" ]; then
      if [ -f "$IDEA_DISKS_ROOT/\$bdev/.idea-members/\$id/\$archive" ]; then
        cat "$IDEA_DISKS_ROOT/\$bdev/.idea-members/\$id/\$archive"
      fi
    else
      cat "$IDEA_DISKS_ROOT/\$bdev/.idea-inventory/\$id.json"
    fi
    ;;
  borg-extract-verify)
    bdev="$2"; id="$3"; archive="$4"; stamp="$5"
    dest="$IDEA_DISKS_ROOT/\$bdev/.idea-verify/\$id-\$stamp"
    mkdir -p "\$dest"
    src="$IDEA_DISKS_ROOT/\$bdev/.idea-verify-src/\$id/\$archive"
    if [ -d "\$src" ]; then cp -a "\$src/." "\$dest/"; fi
    echo "\$dest"
    ;;
  quarantine-backups)
    bdev="$2"
    stamp=\$(date -u +%Y%m%dT%H%M%SZ)
    dest="$IDEA_DISKS_ROOT/\$bdev/.idea-quarantine/backups-\$stamp"
    mkdir -p "$IDEA_DISKS_ROOT/\$bdev/.idea-quarantine"
    mv "$IDEA_DISKS_ROOT/\$bdev/backups" "\$dest"
    echo "\$dest"
    ;;
esac
exit 0
`

const createMinimalStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const storeHandle = repo.create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as unknown as Store)
    await storeHandle.whenReady()
    await createOrUpdateEngine(storeHandle, localEngineId)
    return storeHandle
}

const makeDisk = (id: string, device: string | null, types: Array<'app' | 'backup' | 'files' | 'system'>): Disk => ({
    id: id as DiskID,
    name: `${id}-name` as DiskName,
    device: device as any,
    dockedTo: localEngineId as EngineID,
    created: Date.now() as Timestamp,
    lastDocked: Date.now() as Timestamp,
    diskTypes: types,
    backupConfig: types.includes('backup') ? { mode: 'on-demand', links: [INST] } : null,
    freeBytes: 10 * 1024 * 1024 * 1024,
} as Disk)

const addInstance = (h: DocHandle<Store>, diskId: string, status: 'Stopped' | 'Running' = 'Running') => {
    h.change(doc => {
        doc.instanceDB[INST] = {
            id: INST, instanceOf: 'usage-dashboard' as any, name: 'dashboard' as any, status: status as any,
            port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
            lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: diskId as DiskID,
            currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })
}

describe('parse helpers (idea#446)', () => {
    it('parses borg inventory JSON and picks the newest archive', () => {
        const archives = parseBorgListInventory(JSON.stringify({
            archives: [
                { name: OLDER, start: '2026-11-10T10:00:00.000000', stats: { original_size: 100, compressed_size: 40 } },
                { name: ARCHIVE, start: '2026-11-11T23:18:06.123000', stats: { original_size: 200, compressed_size: 80 } },
            ],
        }))
        expect(archives).toHaveLength(2)
        expect(newestArchive(archives).name).toBe(ARCHIVE)
        expect(newestArchive([{ name: OLDER }, { name: ARCHIVE }]).name).toBe(ARCHIVE)
    })

    it('parses member lists (plain and json-lines) and matches instance-relative paths', () => {
        const members = parseBorgMemberList([
            `disks/sdb1/instances/${INST}/compose.yaml`,
            JSON.stringify({ path: `disks/sdb1/instances/${INST}/data/hello.txt` }),
            `disks/sdb1/instances/${INST}/data/keys/secret`,
        ].join('\n'))
        expect(members).toHaveLength(3)
        expect(instanceRelativeMember(members[0], INST)).toBe('compose.yaml')
        expect(instanceRelativeMember(members[2], INST)).toBe('data/keys/secret')
        expect(memberMatchesPath('data/keys/secret', 'data/keys')).toBe(true)
        expect(memberMatchesPath('data/keys', 'data/keys')).toBe(true)
        expect(memberMatchesPath('data/keystone', 'data/keys')).toBe(false)
        expect(pathsFoundInMembers(members, INST, 'data/keys')).toBe(true)
        expect(pathsFoundInMembers(members, INST, 'data/missing')).toBe(false)
    })

    it('parses optional x-app.backup.verify.present/absent with the same path rules as exclude', () => {
        expect(parseBackupVerifyLists(undefined)).toEqual({ present: [], absent: [] })
        expect(parseBackupVerifyLists({ backup: { exclude: ['keys'] } })).toEqual({ present: [], absent: [] })
        expect(parseBackupVerifyLists({
            backup: { exclude: ['keys'], verify: { present: ['.env', 'data/hello.txt'], absent: ['keys', 'data/tmp'] } },
        })).toEqual({ present: ['.env', 'data/hello.txt'], absent: ['data/keys', 'data/tmp'] })
        expect(() => parseBackupVerifyLists({ backup: { verify: ['compose.yaml'] } })).toThrow(/not a mapping/)
        expect(() => parseBackupVerifyLists({ backup: { verify: { present: 'compose.yaml' } } })).toThrow(/must be a list/)
        expect(parseBackupExcludeList({ backup: { exclude: ['keys'] } })).toEqual(['data/keys'])
    })

    it('registers the four commands and the backupVerify capability; Engine speaks helper v11', () => {
        expect(BACKUP_VERIFY_HELPER_MIN).toBe(10)
        expect(APP_DATA_HELPER_VERSION).toBe('11')
        expect(ENGINE_CAPABILITIES).toContain('backupVerify')
        for (const name of ['listBackup', 'verifyBackup', 'clearBackupLock', 'removeBackupRole']) {
            expect(commands.find(c => c.name === name), name).toBeTruthy()
        }
    })
})

describe('listBackup / verifyBackup / clearBackupLock / removeBackupRole (mocked helper)', () => {
    let appDevice: string
    let backupDevice: string
    let binDir: string
    let borgLog: string
    const saved = {
        testMode: config.settings.testMode, skipBorg: config.settings.skipBorg,
        path: process.env.PATH, log: process.env.FAKE_BORG_LOG, ver: process.env.FAKE_HELPER_VERSION,
    }

    const inventory = (original = 1000, compressed = 400) => JSON.stringify({
        archives: [
            { name: OLDER, start: '2026-11-10T10:00:00.000000', stats: { original_size: 10, compressed_size: 4 } },
            { name: ARCHIVE, start: '2026-11-11T23:18:06.123000', stats: { original_size: original, compressed_size: compressed } },
        ],
    })

    const seedRepo = async (opts?: { members?: string[]; extract?: Record<string, string>; compose?: any }) => {
        const instDir = `${DISKS_ROOT}/${appDevice}/instances/${INST}`
        await fs.ensureDir(`${instDir}/data`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`, '[repository]\nid = fake\n')
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`, `mode: on-demand\nlinks:\n  - instanceId: ${INST}\n    lastBackup: 0\n`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/apps`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/.idea-inventory`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/.idea-inventory/${INST}.json`, inventory())
        const members = opts?.members ?? [
            `disks/${backupDevice}/instances/${INST}/compose.yaml`,
            `disks/${backupDevice}/instances/${INST}/data/hello.txt`,
            `disks/${backupDevice}/instances/${INST}/.env`,
        ]
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/.idea-members/${INST}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/.idea-members/${INST}/${ARCHIVE}`, members.join('\n') + '\n')
        const extract = opts?.extract ?? { 'compose.yaml': 'services: {}\n', 'data/hello.txt': 'hi\n', '.env': 'X=1\n' }
        const src = `${DISKS_ROOT}/${backupDevice}/.idea-verify-src/${INST}/${ARCHIVE}`
        for (const [rel, body] of Object.entries(extract)) {
            await fs.ensureDir(path.join(src, path.dirname(rel)))
            await fs.writeFile(path.join(src, rel), body)
        }
        const compose = opts?.compose ?? {
            'x-app': { name: 'usage-dashboard', backup: { exclude: ['keys'], verify: { present: ['.env', 'data/hello.txt'], absent: ['data/tmp'] } } },
            services: {},
        }
        await fs.writeFile(`${instDir}/compose.yaml`, YAML.stringify(compose))
    }

    const storeWithDisks = async () => {
        const h = await createMinimalStore()
        const appDisk = makeDisk('ver-ad', appDevice, ['app'])
        const backupDisk = makeDisk('ver-bd', backupDevice, ['backup', 'app'])
        h.change(doc => { doc.diskDB[appDisk.id] = appDisk; doc.diskDB[backupDisk.id] = backupDisk })
        addInstance(h, appDisk.id, 'Running')
        return { h, appDisk, backupDisk }
    }

    beforeEach(async () => {
        appDevice = uniqueTestDevice()
        do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
        await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}`)
        binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-sudo-verify-'))
        borgLog = path.join(binDir, 'calls.log')
        await fs.writeFile(path.join(binDir, 'sudo'), FAKE_SUDO, { mode: 0o755 })
        process.env.PATH = `${binDir}:${saved.path}`
        process.env.FAKE_BORG_LOG = borgLog
        process.env.FAKE_HELPER_VERSION = '10'
        process.env.IDEA_DISKS_ROOT = DISKS_ROOT
        config.settings.testMode = true
        config.settings.skipBorg = false
        vi.spyOn(console, 'info').mockImplementation(() => {})
        vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        config.settings.testMode = saved.testMode
        config.settings.skipBorg = saved.skipBorg
        process.env.PATH = saved.path
        if (saved.log === undefined) delete process.env.FAKE_BORG_LOG
        else process.env.FAKE_BORG_LOG = saved.log
        if (saved.ver === undefined) delete process.env.FAKE_HELPER_VERSION
        else process.env.FAKE_HELPER_VERSION = saved.ver
        resourceLock.releaseAll([diskKey('ver-bd'), instanceKey(INST)])
        await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
        await fs.remove(binDir)
    })

    const calls = async (): Promise<string[]> =>
        (await fs.pathExists(borgLog)) ? (await fs.readFile(borgLog, 'utf8')).split('\n').filter(Boolean) : []

    it('listBackup returns archives; with an archive name it also lists members', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        const listed = await listBackup(h, INST, 'ver-bd')
        expect(listed.archives).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: ARCHIVE, originalSize: 1000 }),
            expect.objectContaining({ name: OLDER }),
        ]))
        expect(listed.lock).toBeNull()
        const withMembers = await listBackup(h, INST, 'ver-bd', ARCHIVE)
        expect(withMembers.archive).toBe(ARCHIVE)
        expect(withMembers.memberCount).toBe(3)
        expect(withMembers.partial).toBe(false)
        expect(withMembers.members).toEqual(expect.arrayContaining([
            expect.stringContaining('compose.yaml'),
            expect.stringContaining('data/hello.txt'),
        ]))
        // live instance is Running and was not stopped
        expect(h.doc()!.instanceDB[INST].status).toBe('Running')
        expect(resourceLock.isLocked(instanceKey(INST))).toBe(false)
    })

    it('listBackup reports a present lock file and refuses skipBorg, helper v8, system disks and a missing repo', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        const lockPath = `${DISKS_ROOT}/${backupDevice}/backups/${INST}/.backup-in-progress`
        await fs.writeFile(lockPath, JSON.stringify({ instanceId: INST, startedAt: 123 }))
        const listed = await listBackup(h, INST, 'ver-bd')
        expect((listed.lock as any).startedAt).toBe(123)

        config.settings.skipBorg = true
        await expect(listBackup(h, INST, 'ver-bd')).rejects.toThrow(/skipBorg/)
        config.settings.skipBorg = false

        process.env.FAKE_HELPER_VERSION = '9'   // idea#450: v9's borg-list is broken on real borg
        await expect(listBackup(h, INST, 'ver-bd')).rejects.toThrow(/HELPER_OUTDATED/)
        process.env.FAKE_HELPER_VERSION = '10'

        h.change(doc => { doc.diskDB['sys' as DiskID] = makeDisk('sys', backupDevice, ['system', 'backup']) as any })
        await expect(listBackup(h, INST, 'sys')).rejects.toThrow(/system disk/)

        await fs.remove(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`)
        await expect(listBackup(h, INST, 'ver-bd')).rejects.toThrow(/no docked Backup Disk repository/)
    })

    it('verifyBackup extracts into .idea-verify, checks exclude + verify paths, reports size, and does not touch instances/<id>', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        const instDir = `${DISKS_ROOT}/${appDevice}/instances/${INST}`
        const before = await fs.readFile(`${instDir}/compose.yaml`, 'utf8')
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.ok).toBe(true)
        expect(result.archive).toBe(ARCHIVE)
        expect(result.scratchPath).toMatch(new RegExp(`\\.idea-verify/${INST}-\\d{8}T\\d{6,15}Z$`))
        expect(await fs.pathExists(result.scratchPath)).toBe(true)
        expect(result.archiveOriginalBytes).toBe(1000)
        expect(result.archiveCompressedBytes).toBe(400)
        expect(result.neededBytes).toBe(Math.ceil(1000 * 1.1))
        expect(result.freeBytes).toBeGreaterThan(result.neededBytes)
        expect(result.scratchBytes).toBeGreaterThan(0)
        expect(result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'data/keys', expect: 'absent', source: 'exclude', ok: true }),
            expect.objectContaining({ path: '.env', expect: 'present', source: 'verify.present', ok: true }),
            expect.objectContaining({ path: 'data/hello.txt', expect: 'present', source: 'verify.present', ok: true }),
            expect.objectContaining({ path: 'data/tmp', expect: 'absent', source: 'verify.absent', ok: true }),
        ]))
        expect(await fs.readFile(`${instDir}/compose.yaml`, 'utf8')).toBe(before)
        expect(h.doc()!.instanceDB[INST].status).toBe('Running')
        expect(resourceLock.isLocked(diskKey('ver-bd'))).toBe(false)
        expect(resourceLock.isLocked(instanceKey(INST))).toBe(false)
        const log = await calls()
        expect(log.some(l => l.startsWith('borg-extract '))).toBe(false)
        expect(log.some(l => l.startsWith(`borg-extract-verify ${backupDevice} ${INST} ${ARCHIVE} `))).toBe(true)
    })

    it('verifyBackup fails path checks when an excluded path is present, and refuses NO_SPACE / a running backup / a held disk lock', async () => {
        await seedRepo({
            members: [
                `disks/${backupDevice}/instances/${INST}/compose.yaml`,
                `disks/${backupDevice}/instances/${INST}/data/keys/secret`,
            ],
            extract: { 'compose.yaml': 'x\n', 'data/keys/secret': 'nope\n' },
            compose: { 'x-app': { backup: { exclude: ['keys'] } }, services: {} },
        })
        const { h, backupDisk } = await storeWithDisks()
        const failed = await verifyBackup(h, INST, 'ver-bd') as any
        expect(failed.ok).toBe(false)
        expect(failed.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'data/keys', expect: 'absent', source: 'exclude', ok: false }),
        ]))
        expect(await fs.pathExists(failed.scratchPath)).toBe(true)

        h.change(doc => { doc.diskDB[backupDisk.id].freeBytes = 10 })
        await expect(verifyBackup(h, INST, 'ver-bd')).rejects.toThrow(/NO_SPACE/)

        h.change(doc => { doc.diskDB[backupDisk.id].freeBytes = 10 * 1024 * 1024 * 1024 })
        h.change(doc => {
            (doc.operationDB as any)['op-1'] = {
                id: 'op-1', kind: 'backupApp', status: 'Running',
                args: { instanceId: INST, backupDiskId: backupDisk.id },
            }
        })
        await expect(verifyBackup(h, INST, 'ver-bd')).rejects.toThrow(/backupApp/)

        h.change(doc => { delete (doc.operationDB as any)['op-1'] })
        expect(resourceLock.acquireAll([diskKey(backupDisk.id)], 'ejectDisk')).toBe(true)
        await expect(verifyBackup(h, INST, 'ver-bd')).rejects.toThrow(/locked/)
        resourceLock.releaseAll([diskKey(backupDisk.id)])
    })

    it('clearBackupLock removes only the lock file and the stale-lock entry, and never starts a backup', async () => {
        await seedRepo()
        const { h, backupDisk } = await storeWithDisks()
        const startedAt = Date.now() - 60000
        const lockPath = `${DISKS_ROOT}/${backupDevice}/backups/${INST}/.backup-in-progress`
        await fs.writeFile(lockPath, JSON.stringify({ instanceId: INST, startedAt }))
        await processBackupDisk(h, backupDisk)
        expect((h.doc()!.diskDB[backupDisk.id].backupStaleLocks ?? []).map(l => l.instanceId)).toEqual([INST])

        const result = await clearBackupLock(h, INST, 'ver-bd') as any
        expect(result.cleared).toBe(true)
        expect(result.startedAt).toBe(startedAt)
        expect(await fs.pathExists(lockPath)).toBe(false)
        expect(h.doc()!.diskDB[backupDisk.id].backupStaleLocks).toEqual([])
        expect(h.doc()!.instanceDB[INST].lastBackup).toBeNull()
        const log = await calls()
        expect(log.some(l => l.startsWith('borg-create'))).toBe(false)

        // Nothing left to clear: still a refusal (cleared: false) but not an error
        const empty = await clearBackupLock(h, INST, 'ver-bd') as any
        expect(empty.cleared).toBe(false)
        expect(empty.lockFileRemoved).toBe(false)
        expect(empty.message).toBe(`no backup lock to clear for ${INST}`)
        expect(h.doc()!.diskDB[backupDisk.id].backupStaleLocks).toEqual([])
        expect(await fs.pathExists(lockPath)).toBe(false)
    })

    it('clearBackupLock is refused while a backup of that instance is already in progress, and leaves the lock file and store entry untouched', async () => {
        await seedRepo()
        const { h, backupDisk } = await storeWithDisks()
        // Stopped so backupInstance does not try to stop containers.
        h.change(doc => { doc.instanceDB[INST].status = 'Stopped' as any })
        const startedAt = Date.now() - 60000
        const lockPath = `${DISKS_ROOT}/${backupDevice}/backups/${INST}/.backup-in-progress`
        await fs.writeFile(lockPath, JSON.stringify({ instanceId: INST, startedAt }))
        await processBackupDisk(h, backupDisk)
        const staleBefore = JSON.parse(JSON.stringify(h.doc()!.diskDB[backupDisk.id].backupStaleLocks ?? []))
        expect(staleBefore.map((l: any) => l.instanceId)).toEqual([INST])

        const prevBorgExists = borgPresence.exists
        borgPresence.exists = () => true

        const hold = path.join(binDir, 'hold-create')
        await fs.writeFile(hold, '')
        process.env.FAKE_BORG_HOLD = hold
        await fs.writeFile(path.join(binDir, 'sudo'), `#!/usr/bin/env bash
[[ "$1" == -n && "$2" == /usr/local/sbin/idea-app-data ]] || exec /usr/bin/sudo "$@"
shift 2
echo "$*" >> "$FAKE_BORG_LOG"
case "$1" in
  version) echo "idea-app-data \${FAKE_HELPER_VERSION:-10}" ;;
  borg-init) mkdir -p "$IDEA_DISKS_ROOT/$2/backups/$3" && echo '[repository]' > "$IDEA_DISKS_ROOT/$2/backups/$3/config" ;;
  borg-create)
    while [ -f "$FAKE_BORG_HOLD" ]; do sleep 0.05; done
    ;;
esac
exit 0
`, { mode: 0o755 })

        const running = backupInstance(h, INST, backupDisk, undefined, 'console-command')
        const deadline = Date.now() + 5000
        // Wait until the mutex is held and backupInstance has written its lock
        // (it overwrites the pre-seeded file), so the snapshot is stable.
        while (Date.now() < deadline) {
            if (isBackupActive(INST) && await fs.pathExists(lockPath)) {
                try {
                    const raw = JSON.parse(await fs.readFile(lockPath, 'utf8'))
                    if (Number(raw?.startedAt) > startedAt) break
                } catch { /* lock being rewritten */ }
            }
            await new Promise(r => setTimeout(r, 20))
        }
        try {
            if (!isBackupActive(INST)) {
                const settled = await Promise.race([
                    running.then(() => 'resolved', (e: any) => `rejected: ${e?.message ?? e}`),
                    new Promise<string>(r => setTimeout(() => r('still pending'), 20)),
                ])
                throw new Error(`backupInstance did not hold the in-memory mutex (promise ${settled})`)
            }
            expect(isBackupActive(INST)).toBe(true)
            expect(await fs.pathExists(lockPath)).toBe(true)
            const lockBefore = await fs.readFile(lockPath, 'utf8')
            const staleAtCheck = JSON.parse(JSON.stringify(h.doc()!.diskDB[backupDisk.id].backupStaleLocks ?? []))

            await expect(clearBackupLock(h, INST, 'ver-bd')).rejects.toThrow(
                `clearBackupLock: a backup of instance ${INST} is already in progress`,
            )
            expect(await fs.readFile(lockPath, 'utf8')).toBe(lockBefore)
            expect(JSON.parse(JSON.stringify(h.doc()!.diskDB[backupDisk.id].backupStaleLocks ?? []))).toEqual(staleAtCheck)
        } finally {
            await fs.remove(hold)
            delete process.env.FAKE_BORG_HOLD
            borgPresence.exists = prevBorgExists
            await running
        }
    })

    it('removeBackupRole quarantines backups/, drops BACKUP.yaml, and leaves the App role', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        const result = await removeBackupRole(h, 'ver-bd') as any
        expect(result.diskId).toBe('ver-bd')
        expect(result.quarantinePath).toMatch(/\.idea-quarantine\/backups-/)
        expect(await fs.pathExists(`${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`)).toBe(false)
        expect(await fs.pathExists(`${DISKS_ROOT}/${backupDevice}/backups`)).toBe(false)
        expect(await fs.pathExists(result.quarantinePath)).toBe(true)
        expect(await fs.pathExists(`${result.quarantinePath}/${INST}/config`)).toBe(true)
        expect(result.diskTypes).not.toContain('backup')
        expect(result.diskTypes).toContain('app')
        expect(h.doc()!.diskDB['ver-bd' as DiskID].backupConfig).toBeNull()
        expect(h.doc()!.diskDB['ver-bd' as DiskID].backupStaleLocks).toBeNull()
    })

    it('removeBackupRole refuses while a stale lock is still present', async () => {
        await seedRepo()
        const { h, backupDisk } = await storeWithDisks()
        await fs.writeFile(
            `${DISKS_ROOT}/${backupDevice}/backups/${INST}/.backup-in-progress`,
            JSON.stringify({ instanceId: INST, startedAt: Date.now() }),
        )
        await processBackupDisk(h, backupDisk)
        await expect(removeBackupRole(h, 'ver-bd')).rejects.toThrow(/lock is still present|stale backup locks/)
        expect(await fs.pathExists(`${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`)).toBe(true)
        expect(await fs.pathExists(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`)).toBe(true)
    })

    it('clearBackupLock with no lock file but a stale store entry drops the entry instead of refusing, then removeBackupRole proceeds (idea#454)', async () => {
        await seedRepo()
        const { h, backupDisk } = await storeWithDisks()
        const startedAt = Date.now() - 60000
        const lockPath = `${DISKS_ROOT}/${backupDevice}/backups/${INST}/.backup-in-progress`
        await fs.writeFile(lockPath, JSON.stringify({ instanceId: INST, startedAt }))
        await processBackupDisk(h, backupDisk)
        // The lock file goes (an older Engine's backup, or by hand); the store entry stays
        await fs.remove(lockPath)
        expect((h.doc()!.diskDB[backupDisk.id].backupStaleLocks ?? []).map(l => l.instanceId)).toEqual([INST])
        await expect(removeBackupRole(h, 'ver-bd')).rejects.toThrow(/stale backup locks/)

        const result = await clearBackupLock(h, INST, 'ver-bd') as any
        expect(result.cleared).toBe(true)
        expect(result.lockFileRemoved).toBe(false)
        expect(result.startedAt).toBe(startedAt)
        expect(h.doc()!.diskDB[backupDisk.id].backupStaleLocks).toEqual([])
        expect(await fs.pathExists(lockPath)).toBe(false)
        expect((await calls()).some(l => l.startsWith('borg-create'))).toBe(false)
        // Nothing left to clear: still a refusal (cleared: false) but not an error
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
        let empty: any
        try {
            empty = await clearBackupLock(h, INST, 'ver-bd') as any
            expect(infoSpy.mock.calls.some(c => String(c[0]) === `no backup lock to clear for ${INST}`)).toBe(true)
        } finally {
            infoSpy.mockRestore()
        }
        expect(empty.cleared).toBe(false)
        expect(empty.lockFileRemoved).toBe(false)
        expect(empty.message).toBe(`no backup lock to clear for ${INST}`)
        expect(h.doc()!.diskDB[backupDisk.id].backupStaleLocks).toEqual([])

        const removed = await removeBackupRole(h, 'ver-bd') as any
        expect(removed.diskTypes).not.toContain('backup')
    })

    it('a Console backupApp over a stale lock leaves no stale entry, so clearBackupLock has nothing to clear and removeBackupRole is not blocked (idea#454)', async () => {
        await seedRepo()
        const { h, backupDisk } = await storeWithDisks()
        const lockPath = `${DISKS_ROOT}/${backupDevice}/backups/${INST}/.backup-in-progress`
        await fs.writeFile(lockPath, JSON.stringify({ instanceId: INST, startedAt: Date.now() - 60000 }))
        await processBackupDisk(h, backupDisk)
        expect((h.doc()!.diskDB[backupDisk.id].backupStaleLocks ?? []).map(l => l.instanceId)).toEqual([INST])
        config.settings.skipBorg = true
        h.change(doc => { doc.instanceDB[INST as InstanceID].status = 'Stopped' as any })
        await backupInstance(h, INST as InstanceID, h.doc()!.diskDB[backupDisk.id] as Disk)
        expect(await fs.pathExists(lockPath)).toBe(false)
        expect(h.doc()!.instanceDB[INST as InstanceID].lastBackup).toBeGreaterThan(0)
        expect(h.doc()!.diskDB[backupDisk.id].backupStaleLocks).toEqual([])
        const empty = await clearBackupLock(h, INST, 'ver-bd') as any
        expect(empty.cleared).toBe(false)
        expect(empty.lockFileRemoved).toBe(false)
        expect(empty.message).toBe(`no backup lock to clear for ${INST}`)
        const removed = await removeBackupRole(h, 'ver-bd') as any
        expect(removed.diskTypes).not.toContain('backup')
    })
})
