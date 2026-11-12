/**
 * backup-cleanup.test.ts (idea#401, helper v9)
 *
 * Parse/pick helpers, and backupInstance cleanup: helper < 9 skips delete
 * and compact (backup still Done); Engine picks the oldest archive that is
 * not in the newest 3; round-robin across two instances; BACKUP_DISK_FULL
 * when the estimate does not fit after cleanup; compact only after a
 * successful delete.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, os, path } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { config } from '../../src/data/Config.js'
import { backupInstance } from '../../src/monitors/backupMonitor.js'
import { borgPresence } from '../../src/utils/appDataHelper.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
import {
    parseBorgListJson, eligibleArchives, pickRoundRobinDeletion, estimateNextBackupBytes,
    backupCleanupIO, BACKUP_KEEP_MIN, BackupArchiveInfo,
} from '../../src/utils/backupCleanup.js'

const arch = (name: string, compressed = 10): BackupArchiveInfo =>
    ({ name, time: name, originalSize: compressed * 2, compressedSize: compressed })

describe('backup cleanup pick/parse helpers (idea#401)', () => {
    it('parseBorgListJson reads borg info --json and sorts oldest first', () => {
        const parsed = parseBorgListJson(JSON.stringify({
            archives: [
                { name: '2026-01-03T00-00-00-000Z', start: '2026-01-03T00:00:00', stats: { original_size: 30, compressed_size: 12 } },
                { name: '2026-01-01T00-00-00-000Z', start: '2026-01-01T00:00:00', stats: { original_size: 10, compressed_size: 4 } },
                { name: '2026-01-02T00-00-00-000Z', start: '2026-01-02T00:00:00', stats: { original_size: 20, compressed_size: 8 } },
            ],
        }))
        expect(parsed.map(a => a.name)).toEqual([
            '2026-01-01T00-00-00-000Z',
            '2026-01-02T00-00-00-000Z',
            '2026-01-03T00-00-00-000Z',
        ])
        expect(parsed[0].compressedSize).toBe(4)
        expect(estimateNextBackupBytes(parsed)).toBe(12)
    })

    it('eligibleArchives drops the newest keepMin; pick never returns a newest-3 archive', () => {
        const names = [
            '2026-01-01T00-00-00-000Z',
            '2026-01-02T00-00-00-000Z',
            '2026-01-03T00-00-00-000Z',
            '2026-01-04T00-00-00-000Z',
            '2026-01-05T00-00-00-000Z',
        ]
        const list = names.map(n => arch(n))
        expect(eligibleArchives(list).map(a => a.name)).toEqual(names.slice(0, 2))
        expect(eligibleArchives(list.slice(0, BACKUP_KEEP_MIN))).toEqual([])
        const byInstance = new Map([['inst-a', list]])
        const first = pickRoundRobinDeletion(byInstance, new Map())
        expect(first?.archive.name).toBe(names[0])
        expect(names.slice(-3)).not.toContain(first?.archive.name)
    })

    it('round-robin across two instances, oldest first, never a newest-3', () => {
        const a = ['2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z', '2026-01-03T00-00-00-000Z', '2026-01-04T00-00-00-000Z']
        const b = ['2026-02-01T00-00-00-000Z', '2026-02-02T00-00-00-000Z', '2026-02-03T00-00-00-000Z', '2026-02-04T00-00-00-000Z']
        const byInstance = new Map<string, BackupArchiveInfo[]>([
            ['inst-b', b.map(n => arch(n))],
            ['inst-a', a.map(n => arch(n))],
        ])
        const deleted = new Map<string, number>()
        const order: string[] = []
        for (let i = 0; i < 4; i++) {
            const next = pickRoundRobinDeletion(byInstance, deleted)
            if (!next) break
            order.push(`${next.instanceId}:${next.archive.name}`)
            deleted.set(next.instanceId, (deleted.get(next.instanceId) ?? 0) + 1)
            byInstance.set(next.instanceId, (byInstance.get(next.instanceId) ?? []).filter(x => x.name !== next.archive.name))
        }
        expect(order).toEqual([
            `inst-a:${a[0]}`,
            `inst-b:${b[0]}`,
        ])
        expect(pickRoundRobinDeletion(byInstance, deleted)).toBeNull()
    })
})

const INST = 'inst-clean-1' as InstanceID
const INST_B = 'inst-clean-2' as InstanceID

const FAKE_SUDO = `#!/usr/bin/env bash
[[ "$1" == -n && "$2" == /usr/local/sbin/idea-app-data ]] || exec /usr/bin/sudo "$@"
shift 2
echo "$*" >> "$FAKE_BORG_LOG"
case "$1" in
  version) echo "idea-app-data \${FAKE_HELPER_VERSION:-9}" ;;
  borg-init)
    mkdir -p "$IDEA_DISKS_ROOT/$2/backups/$3"
    echo '[repository]' > "$IDEA_DISKS_ROOT/$2/backups/$3/config"
    ;;
  borg-list)
    id="$3"
    f="\${FAKE_BORG_LIST_DIR}/$id.json"
    if [[ -f "$f" ]]; then cat "$f"; else echo '{"archives":[]}'; fi
    ;;
  borg-delete)
    id="$3"
    name="$4"
    f="\${FAKE_BORG_LIST_DIR}/$id.json"
    if [[ -f "$f" ]]; then
      ${process.execPath} -e 'const fs=require("fs"); const f=process.argv[1]; const n=process.argv[2]; const j=JSON.parse(fs.readFileSync(f,"utf8")); j.archives=(j.archives||[]).filter(a=>a.name!==n); fs.writeFileSync(f, JSON.stringify(j));' "$f" "$name"
    fi
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

const makeDisk = (id: string, device: string, backup: boolean): Disk => ({
    id: id as DiskID,
    name: (backup ? 'Backup Disk' : 'App Disk') as DiskName,
    device: device as any,
    dockedTo: localEngineId as EngineID,
    created: Date.now() as Timestamp,
    lastDocked: Date.now() as Timestamp,
    diskTypes: backup ? ['backup'] : ['app'],
    backupConfig: null,
} as Disk)

const writeArchives = async (dir: string, id: string, names: string[], compressed = 10) => {
    await fs.ensureDir(dir)
    const archives = names.map((name, i) => ({
        name,
        start: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000000`,
        stats: { original_size: compressed * 2, compressed_size: compressed },
    }))
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ archives }))
}

describe('backupInstance cleanup (idea#401)', () => {
    let appDevice: string
    let backupDevice: string
    let binDir: string
    let borgLog: string
    let listDir: string
    const saved = {
        testMode: config.settings.testMode, skipBorg: config.settings.skipBorg,
        path: process.env.PATH, log: process.env.FAKE_BORG_LOG, ver: process.env.FAKE_HELPER_VERSION,
        listDir: process.env.FAKE_BORG_LIST_DIR,
        enableInTests: backupCleanupIO.enableInTests,
        readUsage: backupCleanupIO.readUsage,
    }

    beforeEach(async () => {
        borgPresence.exists = () => true
        appDevice = uniqueTestDevice()
        do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
        await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`, `mode: on-demand\nlinks:\n  - instanceId: ${INST}\n    lastBackup: 0\n`)
        binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-sudo-clean-'))
        borgLog = path.join(binDir, 'calls.log')
        listDir = path.join(binDir, 'lists')
        await fs.ensureDir(listDir)
        await fs.writeFile(path.join(binDir, 'sudo'), FAKE_SUDO, { mode: 0o755 })
        process.env.PATH = `${binDir}:${saved.path}`
        process.env.FAKE_BORG_LOG = borgLog
        process.env.FAKE_BORG_LIST_DIR = listDir
        process.env.FAKE_HELPER_VERSION = '9'
        config.settings.testMode = true
        config.settings.skipBorg = false
        backupCleanupIO.enableInTests = true
        backupCleanupIO.readUsage = async () => ({ totalBytes: 1000, freeBytes: 100 })
        vi.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(async () => {
        borgPresence.exists = (p) => fs.existsSync(p)
        vi.restoreAllMocks()
        config.settings.testMode = saved.testMode
        config.settings.skipBorg = saved.skipBorg
        backupCleanupIO.enableInTests = saved.enableInTests
        backupCleanupIO.readUsage = saved.readUsage
        process.env.PATH = saved.path
        if (saved.log === undefined) delete process.env.FAKE_BORG_LOG
        else process.env.FAKE_BORG_LOG = saved.log
        if (saved.ver === undefined) delete process.env.FAKE_HELPER_VERSION
        else process.env.FAKE_HELPER_VERSION = saved.ver
        if (saved.listDir === undefined) delete process.env.FAKE_BORG_LIST_DIR
        else process.env.FAKE_BORG_LIST_DIR = saved.listDir
        await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
        await fs.remove(binDir)
    })

    const calls = async (): Promise<string[]> =>
        (await fs.pathExists(borgLog)) ? (await fs.readFile(borgLog, 'utf8')).split('\n').filter(Boolean) : []

    const seedRepo = async (id: string = INST) => {
        const repo = `${DISKS_ROOT}/${backupDevice}/backups/${id}`
        await fs.ensureDir(repo)
        await fs.writeFile(`${repo}/config`, '[repository]\n')
        return repo
    }

    const runBackup = async (ids: InstanceID[] = [INST]) => {
        const h = await createMinimalStore()
        const appDisk = makeDisk('clean-ad', appDevice, false)
        const backupDisk = makeDisk('clean-bd', backupDevice, true)
        h.change(doc => {
            doc.diskDB[appDisk.id] = appDisk
            doc.diskDB[backupDisk.id] = backupDisk
            for (const id of ids) {
                doc.instanceDB[id] = {
                    id, instanceOf: 'usage-dashboard' as any, name: id as any, status: 'Stopped' as any,
                    port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
                    lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: appDisk.id,
                    currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
                } as any
            }
        })
        try {
            await backupInstance(h, ids[0], backupDisk)
        } catch {
            // operation records the outcome
        }
        return h
    }

    const opOf = (h: DocHandle<Store>) =>
        Object.values(h.doc()!.operationDB ?? {}).find((o: any) => o.kind === 'backupApp') as any

    it('helper older than v9: no borg-delete or borg-compact, backup still Done, HELPER_OUTDATED recorded', async () => {
        process.env.FAKE_HELPER_VERSION = '8'
        await seedRepo()
        await writeArchives(listDir, INST, [
            '2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z',
            '2026-01-03T00-00-00-000Z', '2026-01-04T00-00-00-000Z',
            '2026-01-05T00-00-00-000Z',
        ])
        const h = await runBackup()
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.cleanup).toMatch(/^HELPER_OUTDATED:/)
        expect(h.doc()!.instanceDB[INST].lastBackup).not.toBeNull()
        const log = await calls()
        expect(log.some(l => l.startsWith('borg-create '))).toBe(true)
        expect(log.some(l => l.startsWith('borg-delete '))).toBe(false)
        expect(log.some(l => l.startsWith('borg-compact '))).toBe(false)
        expect(log.some(l => l.startsWith('borg-list '))).toBe(false)
    })

    it('picks the oldest archive that is not in the newest 3, then compact', async () => {
        const names = [
            '2026-01-01T00-00-00-000Z',
            '2026-01-02T00-00-00-000Z',
            '2026-01-03T00-00-00-000Z',
            '2026-01-04T00-00-00-000Z',
            '2026-01-05T00-00-00-000Z',
        ]
        await seedRepo()
        await writeArchives(listDir, INST, names, 200)
        // after cleanup, pretend compact gave the space back so the backup is not refused
        let reads = 0
        backupCleanupIO.readUsage = async () => {
            reads += 1
            return reads === 1 ? { totalBytes: 1000, freeBytes: 100 } : { totalBytes: 1000, freeBytes: 400 }
        }
        const h = await runBackup()
        expect(opOf(h)?.status, opOf(h)?.error).toBe('Done')
        const log = await calls()
        const deletes = log.filter(l => l.startsWith('borg-delete '))
        expect(deletes[0]).toBe(`borg-delete ${backupDevice} ${INST} ${names[0]}`)
        expect(deletes.every(l => !l.includes(names[2]) && !l.includes(names[3]) && !l.includes(names[4]))).toBe(true)
        const firstDelete = log.findIndex(l => l.startsWith('borg-delete '))
        const firstCompact = log.findIndex(l => l.startsWith('borg-compact '))
        expect(firstDelete).toBeGreaterThanOrEqual(0)
        expect(firstCompact).toBeGreaterThan(firstDelete)
        expect(log[firstCompact]).toBe(`borg-compact ${backupDevice} ${INST}`)
    })

    it('round-robin deletes across two instances, oldest first', async () => {
        const a = ['2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z', '2026-01-03T00-00-00-000Z', '2026-01-04T00-00-00-000Z']
        const b = ['2026-02-01T00-00-00-000Z', '2026-02-02T00-00-00-000Z', '2026-02-03T00-00-00-000Z', '2026-02-04T00-00-00-000Z']
        await seedRepo(INST)
        await seedRepo(INST_B)
        await writeArchives(listDir, INST, a, 80)
        await writeArchives(listDir, INST_B, b, 80)
        let reads = 0
        backupCleanupIO.readUsage = async () => {
            reads += 1
            return reads === 1 ? { totalBytes: 1000, freeBytes: 100 } : { totalBytes: 1000, freeBytes: 400 }
        }
        const h = await runBackup([INST, INST_B])
        expect(opOf(h)?.status, opOf(h)?.error).toBe('Done')
        const deletes = (await calls()).filter(l => l.startsWith('borg-delete '))
        expect(deletes[0]).toBe(`borg-delete ${backupDevice} ${INST} ${a[0]}`)
        expect(deletes[1]).toBe(`borg-delete ${backupDevice} ${INST_B} ${b[0]}`)
    })

    it('BACKUP_DISK_FULL when the estimate does not fit after cleanup', async () => {
        // only 3 archives: none eligible. Last (newest) compressed size 500 > free 100.
        const names = ['2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z', '2026-01-03T00-00-00-000Z']
        await seedRepo()
        await writeArchives(listDir, INST, names, 500)
        backupCleanupIO.readUsage = async () => ({ totalBytes: 1000, freeBytes: 100 })
        const h = await runBackup()
        const op = opOf(h)
        expect(op?.status).toBe('Failed')
        expect(op?.error).toMatch(/^BACKUP_DISK_FULL: Backup Disk full: add a bigger disk/)
        expect(h.doc()!.instanceDB[INST].lastBackup).toBeNull()
        const log = await calls()
        expect(log.some(l => l.startsWith('borg-create '))).toBe(false)
        expect(log.some(l => l.startsWith('borg-delete '))).toBe(false)
    })

    it('does not compact when nothing was deleted', async () => {
        await seedRepo()
        await writeArchives(listDir, INST, [
            '2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z', '2026-01-03T00-00-00-000Z',
        ], 10)
        backupCleanupIO.readUsage = async () => ({ totalBytes: 1000, freeBytes: 400 })
        const h = await runBackup()
        expect(opOf(h)?.status, opOf(h)?.error).toBe('Done')
        const log = await calls()
        expect(log.some(l => l.startsWith('borg-delete '))).toBe(false)
        expect(log.some(l => l.startsWith('borg-compact '))).toBe(false)
        expect(log.some(l => l.startsWith('borg-create '))).toBe(true)
    })
})
