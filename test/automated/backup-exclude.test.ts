/**
 * backup-exclude.test.ts (idea#443)
 *
 * x-app.backup.exclude parsing/validation, and backupInstance fail-closed
 * behaviour when the helper is too old to honour the list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, os, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { config } from '../../src/data/Config.js'
import { backupInstance } from '../../src/monitors/backupMonitor.js'
import { borgPresence } from '../../src/utils/appDataHelper.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
import {
    normalizeBackupExclude, parseBackupExcludeList, excludeStaysInside, BACKUP_EXCLUDE_HELPER_MIN,
    parseSnapshotExcludeList, parseSnapshotExcludeTokens, normalizeSnapshotExclude, isSnapshotExcludePath,
    SNAPSHOT_EXCLUDE_MAX, SNAPSHOT_EXCLUDE_MAX_LEN,
} from '../../src/utils/backupExclude.js'

describe('normalizeBackupExclude / parseBackupExcludeList', () => {
    it('maps usage-dashboard short names under data/, and is idempotent for data/ paths', () => {
        expect(normalizeBackupExclude('keys')).toBe('data/keys')
        expect(normalizeBackupExclude('tailscale')).toBe('data/tailscale')
        expect(normalizeBackupExclude('tailscale-run')).toBe('data/tailscale-run')
        expect(normalizeBackupExclude('data/keys')).toBe('data/keys')
        expect(normalizeBackupExclude('./data/keys')).toBe('data/keys')
        expect(normalizeBackupExclude('data/keys/')).toBe('data/keys')
        expect(normalizeBackupExclude('data')).toBe('data')
        expect(normalizeBackupExclude('data/kolibri/content')).toBe('data/kolibri/content')
        expect(normalizeBackupExclude('data/backup/daily')).toBe('data/backup/daily')
        expect(normalizeBackupExclude('data/backup/daily/')).toBe('data/backup/daily')
        expect(normalizeBackupExclude('./data/backup/daily')).toBe('data/backup/daily')
        // a slash already present is not prefixed, so write data/backup/daily not backup/daily
        expect(normalizeBackupExclude('backup/daily')).toBe('backup/daily')
        expect(normalizeBackupExclude('.env')).toBe('.env')
    })

    it('rejects absolute paths, escapes, options, globs and empty values', () => {
        for (const bad of ['/etc/passwd', '../etc', 'data/../../etc', 'data/foo/..', 'foo//bar', '', '   ', '.', './', '-rf', 'data/*', 'data/key?', 'data/foo[0]', 'foo bar']) {
            expect(() => normalizeBackupExclude(bad), bad).toThrow(/exclude/)
        }
        expect(() => normalizeBackupExclude('keys\0secret')).toThrow(/NUL/)
        expect(() => normalizeBackupExclude(1 as any)).toThrow(/must be strings/)
    })

    it('parses the compose x-app.backup.exclude list, drops duplicates, fails closed on a bad list', () => {
        expect(parseBackupExcludeList(undefined)).toEqual([])
        expect(parseBackupExcludeList({})).toEqual([])
        expect(parseBackupExcludeList({ backup: {} })).toEqual([])
        expect(parseBackupExcludeList({ backup: { method: 'stop' } })).toEqual([])
        expect(parseBackupExcludeList({
            backup: { exclude: ['keys', 'tailscale', './data/keys', 'tailscale-run'] },
        })).toEqual(['data/keys', 'data/tailscale', 'data/tailscale-run'])
        expect(() => parseBackupExcludeList({ backup: { exclude: 'keys' } })).toThrow(/must be a list/)
        expect(() => parseBackupExcludeList({ backup: { exclude: [12] } })).toThrow(/must be strings/)
        expect(() => parseBackupExcludeList({ backup: [] })).toThrow(/not a mapping/)
        expect(excludeStaysInside('/disks/sdb1/instances/inst1', 'data/keys')).toBe(true)
        expect(BACKUP_EXCLUDE_HELPER_MIN).toBe(8)
    })
})

const INST = 'inst-excl-1' as InstanceID

const FAKE_SUDO = `#!/usr/bin/env bash
[[ "$1" == -n && "$2" == /usr/local/sbin/idea-app-data ]] || exec /usr/bin/sudo "$@"
shift 2
echo "$*" >> "$FAKE_BORG_LOG"
case "$1" in
  version) echo "idea-app-data \${FAKE_HELPER_VERSION:-8}" ;;
  borg-init) mkdir -p "$IDEA_DISKS_ROOT/$2/backups/$3" && echo '[repository]' > "$IDEA_DISKS_ROOT/$2/backups/$3/config" ;;
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

describe('backupInstance honours x-app.backup.exclude (idea#443)', () => {
    let appDevice: string
    let backupDevice: string
    let binDir: string
    let borgLog: string
    const saved = { testMode: config.settings.testMode, skipBorg: config.settings.skipBorg, path: process.env.PATH, log: process.env.FAKE_BORG_LOG, ver: process.env.FAKE_HELPER_VERSION }

    const writeCompose = async (excludes: string[] | null) => {
        const instDir = `${DISKS_ROOT}/${appDevice}/instances/${INST}`
        await fs.ensureDir(`${instDir}/data/keys`)
        await fs.ensureDir(`${instDir}/data/tailscale`)
        if (excludes) {
            await fs.writeFile(`${instDir}/compose.yaml`, YAML.stringify({
                'x-app': { name: 'usage-dashboard', backup: { exclude: excludes } },
                services: {},
            }))
        }
        return instDir
    }

    beforeEach(async () => {
        borgPresence.exists = () => true
        appDevice = uniqueTestDevice()
        do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
        await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`, `mode: on-demand\nlinks:\n  - instanceId: ${INST}\n    lastBackup: 0\n`)
        binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-sudo-excl-'))
        borgLog = path.join(binDir, 'calls.log')
        await fs.writeFile(path.join(binDir, 'sudo'), FAKE_SUDO, { mode: 0o755 })
        process.env.PATH = `${binDir}:${saved.path}`
        process.env.FAKE_BORG_LOG = borgLog
        config.settings.testMode = true
        config.settings.skipBorg = false
        vi.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(async () => {
        borgPresence.exists = (p) => fs.existsSync(p)
        vi.restoreAllMocks()
        config.settings.testMode = saved.testMode
        config.settings.skipBorg = saved.skipBorg
        process.env.PATH = saved.path
        if (saved.log === undefined) delete process.env.FAKE_BORG_LOG
        else process.env.FAKE_BORG_LOG = saved.log
        if (saved.ver === undefined) delete process.env.FAKE_HELPER_VERSION
        else process.env.FAKE_HELPER_VERSION = saved.ver
        await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
        await fs.remove(binDir)
    })

    const calls = async (): Promise<string[]> =>
        (await fs.pathExists(borgLog)) ? (await fs.readFile(borgLog, 'utf8')).split('\n').filter(Boolean) : []

    const runBackup = async (status: 'Stopped' | 'Running' = 'Stopped') => {
        const h = await createMinimalStore()
        const appDisk = makeDisk('excl-ad', appDevice, false)
        const backupDisk = makeDisk('excl-bd', backupDevice, true)
        h.change(doc => {
            doc.diskDB[appDisk.id] = appDisk
            doc.diskDB[backupDisk.id] = backupDisk
            doc.instanceDB[INST] = {
                id: INST, instanceOf: 'usage-dashboard' as any, name: INST as any, status: status as any,
                port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
                lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: appDisk.id,
                currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            } as any
        })
        try {
            await backupInstance(h, INST, backupDisk)
        } catch {
            // console-command traces aside, a thrown refusal is also in the operation
        }
        return h
    }

    it('HELPER_OUTDATED on helper v7 when excludes are declared: no borg-create, no stop, no lastBackup', async () => {
        process.env.FAKE_HELPER_VERSION = '7'
        await writeCompose(['keys', 'tailscale', 'tailscale-run'])
        const h = await runBackup('Running')
        const op = Object.values(h.doc()!.operationDB ?? {}).find((o: any) => o.kind === 'backupApp') as any
        expect(op?.status).toBe('Failed')
        expect(op?.error).toMatch(/^HELPER_OUTDATED:.*v8 or later/)
        expect(h.doc()!.instanceDB[INST].status).toBe('Running')
        expect(h.doc()!.instanceDB[INST].lastBackup).toBeNull()
        const log = await calls()
        expect(log.some(l => l.startsWith('borg-create'))).toBe(false)
        expect(log.some(l => l.startsWith('borg-init'))).toBe(false)
        expect(log.filter(l => l === 'version' || l.startsWith('version '))).toEqual(['version'])
    })

    it('helper v8 passes normalised excludes through to borg-create', async () => {
        process.env.FAKE_HELPER_VERSION = '8'
        await writeCompose(['keys', 'tailscale', 'tailscale-run'])
        const h = await runBackup('Stopped')
        const op = Object.values(h.doc()!.operationDB ?? {}).find((o: any) => o.kind === 'backupApp') as any
        expect(op?.status, op?.error).toBe('Done')
        expect(h.doc()!.instanceDB[INST].lastBackup).not.toBeNull()
        const log = await calls()
        const create = log.find(l => l.startsWith('borg-create '))
        expect(create).toMatch(new RegExp(`^borg-create ${backupDevice} ${INST} \\d{4}-\\d{2}-\\d{2}T[0-9-]+Z ${appDevice} data/keys data/tailscale data/tailscale-run$`))
    })

    it('no compose.yaml (no excludes) still runs on helper v7', async () => {
        process.env.FAKE_HELPER_VERSION = '7'
        const h = await runBackup('Stopped')
        const op = Object.values(h.doc()!.operationDB ?? {}).find((o: any) => o.kind === 'backupApp') as any
        expect(op?.status, op?.error).toBe('Done')
        const log = await calls()
        expect(log.some(l => l === 'version' || l.startsWith('version '))).toBe(false)
        expect(log.find(l => l.startsWith('borg-create '))).toMatch(new RegExp(`^borg-create ${backupDevice} ${INST} \\d{4}-\\d{2}-\\d{2}T[0-9-]+Z ${appDevice}$`))
    })
})


describe('snapshot / estimate excludes (idea#396, helper v14)', () => {
    it('a bare name becomes data/<name>; only data or data/<rel> is allowed', () => {
        expect(normalizeSnapshotExclude('keys')).toBe('data/keys')
        expect(normalizeSnapshotExclude('data/keys')).toBe('data/keys')
        expect(normalizeSnapshotExclude('data')).toBe('data')
        expect(isSnapshotExcludePath('data/keys')).toBe(true)
        expect(isSnapshotExcludePath('.env')).toBe(false)
        expect(() => normalizeSnapshotExclude('.env')).toThrow(/must be data or a path under data/)
        expect(() => normalizeSnapshotExclude('volumes/db')).toThrow(/must be data or a path under data/)
        expect(() => normalizeSnapshotExclude('backup/daily')).toThrow(/must be data or a path under data/)
        expect(() => normalizeSnapshotExclude('../etc')).toThrow()
        expect(() => normalizeSnapshotExclude('-rf')).toThrow(/option/)
    })

    it('limits are 256 characters after trim and 32 unique entries', () => {
        expect(SNAPSHOT_EXCLUDE_MAX).toBe(32)
        expect(SNAPSHOT_EXCLUDE_MAX_LEN).toBe(256)
        expect(() => normalizeSnapshotExclude('x'.repeat(257))).toThrow(/longer than 256/)
        expect(normalizeSnapshotExclude('  ' + 'k'.repeat(250) + '  ')).toBe(`data/${'k'.repeat(250)}`)
        const many = Array.from({ length: 33 }, (_, i) => `p${i}`)
        expect(() => parseSnapshotExcludeTokens(many)).toThrow(/more than 32 entries/)
        const thirtyTwo = Array.from({ length: 32 }, (_, i) => `p${i}`)
        expect(parseSnapshotExcludeTokens(thirtyTwo)).toHaveLength(32)
        // de-duplication is first-occurrence; duplicates do not count toward the cap
        expect(parseSnapshotExcludeTokens([...thirtyTwo, 'p0', 'p1'])).toHaveLength(32)
    })

    it('reads top-level x-app.snapshotExclude, not backup.exclude, and fails closed', () => {
        expect(parseSnapshotExcludeList(undefined)).toEqual([])
        expect(parseSnapshotExcludeList({})).toEqual([])
        expect(parseSnapshotExcludeList({ backup: { exclude: ['keys'] } })).toEqual([])
        expect(parseSnapshotExcludeList({ snapshotExclude: ['cache', './data/cache', 'tmp'] })).toEqual(['data/cache', 'data/tmp'])
        expect(() => parseSnapshotExcludeList({ snapshotExclude: 'cache' })).toThrow(/must be a list/)
        expect(() => parseSnapshotExcludeList({ snapshotExclude: [1] })).toThrow(/must be strings/)
        expect(() => parseSnapshotExcludeList({ snapshotExclude: ['volumes/x'] })).toThrow(/must be data or a path under data/)
    })
})
