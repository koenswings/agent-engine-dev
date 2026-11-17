/**
 * backup-verify.test.ts (idea#446)
 *
 * Engine-side listBackup / verifyBackup / clearBackupLock / removeBackupRole,
 * path-check parsing, stale-lock recording, and helper-v9 argv gating.
 * The helper is mocked (fake sudo on PATH). This file does not edit idea-app-data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, os, path, YAML, $ } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { config } from '../../src/data/Config.js'
import { commands } from '../../src/data/Commands.js'
import { backupInstance, isBackupActive } from '../../src/monitors/backupMonitor.js'
import {
    listBackup, verifyBackup, clearBackupLock, removeBackupRole,
    parseBorgListInventory, parseBorgMemberList, instanceRelativeMember,
    memberMatchesPath, pathsFoundInMembers, newestArchive, BACKUP_VERIFY_HELPER_MIN,
    parseScratchBytes,
} from '../../src/data/BackupVerify.js'
import { parseBackupVerifyLists, parseBackupExcludeList, parseBackupVerifyModeLists } from '../../src/utils/backupExclude.js'
import { parseArchiveName, backupArchiveName } from '../../src/utils/backupArchiveName.js'
import { resourceLock, diskKey, instanceKey } from '../../src/utils/ResourceLock.js'
import { APP_DATA_HELPER_VERSION, borgPresence } from '../../src/utils/appDataHelper.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
import { drainDataBytesQueue } from '../harness/drainDataBytes.js'

const INST = 'inst-ver-1' as InstanceID
const ARCHIVE = '2026-11-11T23-18-06-123Z'
const OLDER = '2026-11-10T10-00-00-000Z'

const FAKE_SUDO = `#!/usr/bin/env bash
[[ "$1" == -n && "$2" == /usr/local/sbin/idea-app-data ]] || exec /usr/bin/sudo "$@"
shift 2
echo "$*" >> "$FAKE_BORG_LOG"
case "$1" in
  version) echo "idea-app-data \${FAKE_HELPER_VERSION:-13}" ;;
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
    if [ "\${FAKE_EXTRACT_FAIL:-}" = 1 ]; then echo "borg extract failed" >&2; exit 1; fi
    if [ "\${FAKE_OMIT_SCRATCH_BYTES:-}" = 1 ]; then
      :
    elif [ -n "\${FAKE_SCRATCH_BYTES:-}" ]; then
      echo "scratchBytes=\$FAKE_SCRATCH_BYTES"
    else
      bytes=\$(du -sb -- "\$dest" 2>/dev/null | awk '{print \$1}')
      [ -n "\$bytes" ] && echo "scratchBytes=\$bytes"
    fi
    ;;
  clean-verify)
    [ -n "\${FAKE_CLEAN_STDERR:-}" ] && echo "\$FAKE_CLEAN_STDERR" >&2
    [ -n "\${FAKE_CLEAN_OUT:-}" ] && printf '%b\\n' "\$FAKE_CLEAN_OUT"
    exit "\${FAKE_CLEAN_EXIT:-0}"
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

describe('archive mode in the name (engine#401)', () => {
    it('backupArchiveName tags the mode; parseArchiveName reads tagged and untagged names', () => {
        const at = new Date('2026-11-14T21:45:01.234Z')
        expect(backupArchiveName(at, null)).toBe('2026-11-14T21-45-01-234Z')
        expect(backupArchiveName(at, 'hook')).toBe('2026-11-14T21-45-01-234Z-hook')
        expect(backupArchiveName(at, 'stop')).toBe('2026-11-14T21-45-01-234Z-stop')
        expect(backupArchiveName(at, 'cold')).toBe('2026-11-14T21-45-01-234Z-cold')
        expect(parseArchiveName('2026-11-14T21-45-01-234Z')).toEqual({ timestamp: '2026-11-14T21-45-01-234Z', mode: null })
        expect(parseArchiveName('2026-11-14T21-45-01-234Z-cold')).toEqual({ timestamp: '2026-11-14T21-45-01-234Z', mode: 'cold' })
        expect(parseArchiveName('not-an-engine-archive')).toEqual({ timestamp: 'not-an-engine-archive', mode: null })
        expect(parseArchiveName('2026-11-14T21-45-01-234Z-live').mode).toBeNull()
    })

    it('inventory carries the mode (null for untagged) and newestArchive ignores the suffix', () => {
        const archives = parseBorgListInventory(JSON.stringify({
            archives: [{ name: OLDER }, { name: '2026-11-12T01-00-00-000Z-stop' }, { name: '2026-11-11T23-18-06-123Z-hook' }],
        }))
        expect(archives.map(a => a.mode)).toEqual([null, 'stop', 'hook'])
        expect(newestArchive(archives).name).toBe('2026-11-12T01-00-00-000Z-stop')
        expect(newestArchive([{ name: '2026-11-12T01-00-00-000Z' }, { name: '2026-11-11T23-00-00-000Z-hook' }]).name).toBe('2026-11-12T01-00-00-000Z')
    })

    it('parseBackupVerifyModeLists reads verify.hook / stop / cold next to the flat lists; fails closed on a bad block', () => {
        const xapp = { backup: { verify: {
            present: ['.env'],
            hook: { present: ['data/backup/db.sqlite3'] },
            stop: { absent: ['data/backup/db.sqlite3'] },
        } } }
        expect(parseBackupVerifyLists(xapp)).toEqual({ present: ['.env'], absent: [] })
        expect(parseBackupVerifyModeLists(xapp)).toEqual({
            hook: { present: ['data/backup/db.sqlite3'], absent: [] },
            stop: { present: [], absent: ['data/backup/db.sqlite3'] },
        })
        expect(parseBackupVerifyModeLists(undefined)).toEqual({})
        expect(parseBackupVerifyModeLists({ backup: { verify: { present: ['x'] } } })).toEqual({})
        expect(() => parseBackupVerifyModeLists({ backup: { verify: { hook: ['x'] } } })).toThrow(/verify\.hook is not a mapping/)
        expect(() => parseBackupVerifyModeLists({ backup: { verify: { cold: { present: 'x' } } } })).toThrow(/verify\.cold\.present must be a list/)
        expect(() => parseBackupVerifyModeLists({ backup: { verify: { hook: { present: ['../etc'] } } } })).toThrow()
    })
})

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

    it('parseScratchBytes reads the last scratchBytes=<n> line and returns null when missing (idea#460)', () => {
        expect(parseScratchBytes('')).toBeNull()
        expect(parseScratchBytes('ok\n')).toBeNull()
        expect(parseScratchBytes('/disks/sdb1/.idea-verify/inst-1-20261112T000000Z\n')).toBeNull()
        expect(parseScratchBytes('scratchBytes=11766739\n')).toBe(11766739)
        expect(parseScratchBytes('scratchBytes=0\n')).toBe(0)
        expect(parseScratchBytes('note\nscratchBytes=12\nscratchBytes=99\n')).toBe(99)
        expect(parseScratchBytes('scratchBytes=12 extra\n')).toBeNull()
        expect(parseScratchBytes('scratchBytes=not-a-number\n')).toBeNull()
        expect(parseScratchBytes('scratchBytes=9007199254740992\n')).toBeNull() // > MAX_SAFE_INTEGER
    })

    it('registers the four commands and the backupVerify capability; Engine speaks helper v25 (engine#497 a; v24 engine#506; v21 engine#503; v20 engine#497; v19 engine#468; v18 engine#469; v17 engine#415), verify min stays v10', () => {
        expect(BACKUP_VERIFY_HELPER_MIN).toBe(10)
        expect(APP_DATA_HELPER_VERSION).toBe('25')
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

    const inventory = (original = 1000, compressed = 400, newest = ARCHIVE) => JSON.stringify({
        archives: [
            { name: OLDER, start: '2026-11-10T10:00:00.000000', stats: { original_size: 10, compressed_size: 4 } },
            { name: newest, start: '2026-11-11T23:18:06.123000', stats: { original_size: original, compressed_size: compressed } },
        ],
    })

    const seedRepo = async (opts?: { members?: string[]; extract?: Record<string, string>; compose?: any; archive?: string }) => {
        const A = opts?.archive ?? ARCHIVE
        const instDir = `${DISKS_ROOT}/${appDevice}/instances/${INST}`
        await fs.ensureDir(`${instDir}/data`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`, '[repository]\nid = fake\n')
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`, `mode: on-demand\nlinks:\n  - instanceId: ${INST}\n    lastBackup: 0\n`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/apps`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/.idea-inventory`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/.idea-inventory/${INST}.json`, inventory(1000, 400, A))
        const members = opts?.members ?? [
            `disks/${backupDevice}/instances/${INST}/compose.yaml`,
            `disks/${backupDevice}/instances/${INST}/data/hello.txt`,
            `disks/${backupDevice}/instances/${INST}/.env`,
        ]
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/.idea-members/${INST}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/.idea-members/${INST}/${A}`, members.join('\n') + '\n')
        const extract = opts?.extract ?? { 'compose.yaml': 'services: {}\n', 'data/hello.txt': 'hi\n', '.env': 'X=1\n' }
        const src = `${DISKS_ROOT}/${backupDevice}/.idea-verify-src/${INST}/${A}`
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
        process.env.FAKE_HELPER_VERSION = '12'
        process.env.IDEA_DISKS_ROOT = DISKS_ROOT
        config.settings.testMode = true
        config.settings.skipBorg = false
        vi.spyOn(console, 'info').mockImplementation(() => {})
        vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(async () => {
        // engine#430 follow-up: wait for the background size measurement before
        // removing the fake sudo dir (it appends to calls.log in binDir).
        await drainDataBytesQueue()
        vi.restoreAllMocks()
        config.settings.testMode = saved.testMode
        config.settings.skipBorg = saved.skipBorg
        process.env.PATH = saved.path
        if (saved.log === undefined) delete process.env.FAKE_BORG_LOG
        else process.env.FAKE_BORG_LOG = saved.log
        if (saved.ver === undefined) delete process.env.FAKE_HELPER_VERSION
        else process.env.FAKE_HELPER_VERSION = saved.ver
        delete process.env.FAKE_SCRATCH_BYTES
        delete process.env.FAKE_OMIT_SCRATCH_BYTES
        for (const k of ['FAKE_EXTRACT_FAIL', 'FAKE_CLEAN_OUT', 'FAKE_CLEAN_EXIT', 'FAKE_CLEAN_STDERR']) delete process.env[k]
        resourceLock.releaseAll([diskKey('ver-bd'), instanceKey(INST)])
        await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
        await fs.remove(binDir)
    })

    // engine#414: a method-none app (Kiwix) has no repo by design; say so instead of
    // "no docked Backup Disk repository". Still an error; other methods unchanged.
    const composeOnly = async (xapp: unknown) => {
        const instDir = `${DISKS_ROOT}/${appDevice}/instances/${INST}`
        await fs.ensureDir(instDir)
        await fs.writeFile(`${instDir}/compose.yaml`, YAML.stringify({ 'x-app': xapp, services: {} }))
    }
    it('method none and no repo: listBackup and verifyBackup say nothing is stored (engine#414), and never call borg', async () => {
        await composeOnly({ name: 'kiwix', backup: { method: 'none' } })
        const { h } = await storeWithDisks()
        const none = `instance ${INST} uses x-app.backup.method none: nothing is stored on the Backup Disk`
        await expect(listBackup(h, INST, 'ver-bd')).rejects.toThrow(`listBackup: ${none}`)
        await expect(verifyBackup(h, INST, 'ver-bd')).rejects.toThrow(`verifyBackup: ${none}`)
        await expect(listBackup(h, INST, 'ver-bd')).rejects.not.toThrow(/no docked Backup Disk repository/)
        const log = (await fs.pathExists(borgLog)) ? await fs.readFile(borgLog, 'utf8') : ''
        expect(log).not.toMatch(/borg-/)
    })
    it('method hook, stop or default with no repo keeps the existing repo error (engine#414)', async () => {
        for (const xapp of [
            { name: 'nc', backup: { method: 'hook', preHook: [{ service: 'app', command: ['true'] }] } },
            { name: 'kolibri', backup: { method: 'stop' } },
            { name: 'plain' },
        ]) {
            await composeOnly(xapp)
            const { h } = await storeWithDisks()
            await expect(listBackup(h, INST, 'ver-bd'), JSON.stringify(xapp)).rejects.toThrow(`listBackup: no docked Backup Disk repository for instance ${INST}`)
            await expect(verifyBackup(h, INST, 'ver-bd'), JSON.stringify(xapp)).rejects.toThrow(`verifyBackup: no docked Backup Disk repository for instance ${INST}`)
        }
    })
    it('a bad x-app.backup fails closed before the repo check (engine#414)', async () => {
        for (const xapp of [{ backup: { method: 'live' } }, { backup: { method: 'bogus' } }, { backup: 'stop' }]) {
            await composeOnly(xapp)
            const { h } = await storeWithDisks()
            await expect(listBackup(h, INST, 'ver-bd')).rejects.toThrow(/^listBackup: invalid x-app\.backup on the instance compose/)
            await expect(verifyBackup(h, INST, 'ver-bd')).rejects.toThrow(/^verifyBackup: invalid x-app\.backup on the instance compose/)
        }
    })
    it('method none with a repo left from an earlier method still lists it (engine#414)', async () => {
        await seedRepo({ compose: { 'x-app': { name: 'kiwix', backup: { method: 'none' } }, services: {} } })
        const { h } = await storeWithDisks()
        const r = await listBackup(h, INST, 'ver-bd')
        expect((r.archives as any[]).map(a => a.name)).toEqual([OLDER, ARCHIVE])
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
        const duOut = (await $`du -sb -- ${result.scratchPath}`).stdout.trim()
        const duBytes = Number(duOut.split(/\s+/)[0])
        expect(result.scratchBytes).toBe(duBytes)
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

    // ── engine#415: keep-latest (Koen's decision (b)) ────────────────────────
    it('engine#415 after a successful verify (helper v17) calls clean-verify with the same stamp, after the checks, and reports what it removed', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        process.env.FAKE_HELPER_VERSION = '17'
        const older = `${DISKS_ROOT}/${backupDevice}/.idea-verify/${INST}-20261101T000000000Z`
        process.env.FAKE_CLEAN_OUT = `removed ${older}\\nkept x`
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.ok).toBe(true)
        expect(result.cleanup).toEqual({ removed: [older], warning: null })
        const log = await calls()
        const stamp = result.scratchPath.match(/-(\d{8}T\d{6,15}Z)$/)[1]
        const ex = log.findIndex(l => l.startsWith(`borg-extract-verify ${backupDevice} ${INST} ${ARCHIVE} ${stamp}`))
        const members = log.findIndex((l, i) => i > ex && l === `borg-list ${backupDevice} ${INST} ${ARCHIVE}`)
        const clean = log.indexOf(`clean-verify ${backupDevice} ${INST} ${stamp}`)
        expect(ex).toBeGreaterThanOrEqual(0)
        expect(clean).toBeGreaterThan(members)
        expect(log.filter(l => l.startsWith('clean-verify'))).toHaveLength(1)
        expect(await fs.pathExists(result.scratchPath)).toBe(true)
    })

    it('engine#415 failed path-checks still clean older copies (checks recorded first)', async () => {
        await seedRepo({
            members: [`disks/${backupDevice}/instances/${INST}/data/keys/secret`],
            extract: { 'data/keys/secret': 'nope\n' },
            compose: { 'x-app': { backup: { exclude: ['keys'] } }, services: {} },
        })
        const { h } = await storeWithDisks()
        process.env.FAKE_HELPER_VERSION = '17'
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.ok).toBe(false)
        expect(result.cleanup).toEqual({ removed: [], warning: null })
        expect((await calls()).some(l => l.startsWith(`clean-verify ${backupDevice} ${INST} `))).toBe(true)
    })

    it('engine#415 a failed extract never calls clean-verify and leaves its tree in place', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        process.env.FAKE_HELPER_VERSION = '17'
        process.env.FAKE_EXTRACT_FAIL = '1'
        await expect(verifyBackup(h, INST, 'ver-bd')).rejects.toThrow()
        const log = await calls()
        expect(log.some(l => l.startsWith('borg-extract-verify'))).toBe(true)
        expect(log.some(l => l.startsWith('clean-verify'))).toBe(false)
        const left = (await fs.readdir(`${DISKS_ROOT}/${backupDevice}/.idea-verify`)).filter(n => n.startsWith(`${INST}-`))
        expect(left).toHaveLength(1)
        expect(resourceLock.isLocked(diskKey('ver-bd'))).toBe(false)
    })

    it('engine#415 a helper older than v17 (no clean-verify) only warns; verify still succeeds and the verb is not called', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        process.env.FAKE_HELPER_VERSION = '16'
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.ok).toBe(true)
        expect(result.cleanup.removed).toEqual([])
        expect(result.cleanup.warning).toMatch(/older verify copies were not removed: .*v17 or later.*idea-app-data 16/)
        expect((await calls()).some(l => l.startsWith('clean-verify'))).toBe(false)
    })

    it('engine#415 a clean-verify that fails (unknown verb or a refusal) only warns; verify still succeeds', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        process.env.FAKE_HELPER_VERSION = '17'
        process.env.FAKE_CLEAN_EXIT = '2'
        process.env.FAKE_CLEAN_STDERR = "refused: unknown subcommand 'clean-verify'"
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.ok).toBe(true)
        expect(result.cleanup.removed).toEqual([])
        expect(result.cleanup.warning).toMatch(/^older verify copies were not removed: clean-verify failed/)
        expect(resourceLock.isLocked(diskKey('ver-bd'))).toBe(false)
    })

    // ── engine#401: per-mode verify lists ─────────────────────────────────────
    const modeCompose = {
        'x-app': { name: 'kolibri', backup: { exclude: ['keys'], verify: {
            present: ['.env'],
            hook: { present: ['data/backup/db.sqlite3'] },
            stop: { absent: ['data/backup/db.sqlite3'] },
        } } },
        services: {},
    }
    const membersWith = (extra: string[]) => [
        `disks/${backupDevice}/instances/${INST}/compose.yaml`,
        `disks/${backupDevice}/instances/${INST}/.env`,
        ...extra.map(e => `disks/${backupDevice}/instances/${INST}/${e}`),
    ]

    it('engine#401 a -hook archive without the db copy fails its verify.hook list; the stop list does not apply', async () => {
        const A = '2026-11-11T23-18-06-123Z-hook'
        await seedRepo({ archive: A, compose: modeCompose, members: membersWith([]) })
        const { h } = await storeWithDisks()
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.archive).toBe(A)
        expect(result.mode).toBe('hook')
        expect(result.ok).toBe(false)
        expect(result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: '.env', source: 'verify.present', ok: true }),
            expect.objectContaining({ path: 'data/backup/db.sqlite3', expect: 'present', source: 'verify.hook.present', ok: false }),
        ]))
        expect(result.checks.some((c: any) => c.source.startsWith('verify.stop'))).toBe(false)
    })

    it('engine#401 a -hook archive with the db copy passes', async () => {
        const A = '2026-11-11T23-18-06-123Z-hook'
        await seedRepo({ archive: A, compose: modeCompose, members: membersWith(['data/backup/db.sqlite3']) })
        const { h } = await storeWithDisks()
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.ok).toBe(true)
        expect(result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'data/backup/db.sqlite3', source: 'verify.hook.present', ok: true }),
        ]))
    })

    it('engine#401 a -stop archive uses verify.stop (no db copy expected)', async () => {
        const A = '2026-11-11T23-18-06-123Z-stop'
        await seedRepo({ archive: A, compose: modeCompose, members: membersWith([]) })
        const { h } = await storeWithDisks()
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.mode).toBe('stop')
        expect(result.ok).toBe(true)
        expect(result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'data/backup/db.sqlite3', expect: 'absent', source: 'verify.stop.absent', ok: true }),
        ]))
    })

    it('engine#401 a -cold archive with no verify.cold block gets the flat lists only', async () => {
        await seedRepo({ archive: '2026-11-11T23-18-06-123Z-cold', compose: modeCompose, members: membersWith([]) })
        const { h } = await storeWithDisks()
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.mode).toBe('cold')
        expect(result.ok).toBe(true)
        expect(result.checks.map((c: any) => c.source).sort()).toEqual(['exclude', 'verify.present'])
    })

    it('engine#401 an untagged (older) archive verifies exactly as before: flat lists only, mode null', async () => {
        await seedRepo({ compose: modeCompose, members: membersWith([]) })
        const { h } = await storeWithDisks()
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.archive).toBe(ARCHIVE)
        expect(result.mode).toBeNull()
        expect(result.ok).toBe(true)
        expect(result.checks.map((c: any) => c.source).sort()).toEqual(['exclude', 'verify.present'])
    })

    it('engine#401 listBackup reports each archive\'s mode and accepts a tagged archive name', async () => {
        const A = '2026-11-11T23-18-06-123Z-hook'
        await seedRepo({ archive: A })
        const { h } = await storeWithDisks()
        const listed = await listBackup(h, INST, 'ver-bd', A) as any
        expect(listed.archives).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: A, mode: 'hook' }),
            expect.objectContaining({ name: OLDER, mode: null }),
        ]))
        expect(listed.archive).toBe(A)
        expect(listed.memberCount).toBe(3)
    })

    it('verifyBackup uses the helper scratchBytes count, even when it differs from a local walk', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        process.env.FAKE_SCRATCH_BYTES = '11766739'
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.ok).toBe(true)
        expect(result.scratchBytes).toBe(11766739)
        delete process.env.FAKE_SCRATCH_BYTES
    })

    it('verifyBackup still succeeds on helper v10 with scratchBytes null (idea#460 backward compat)', async () => {
        await seedRepo()
        const { h } = await storeWithDisks()
        process.env.FAKE_HELPER_VERSION = '10'
        process.env.FAKE_OMIT_SCRATCH_BYTES = '1'
        const result = await verifyBackup(h, INST, 'ver-bd') as any
        expect(result.ok).toBe(true)
        expect(result.scratchBytes).toBeNull()
        expect(await fs.pathExists(result.scratchPath)).toBe(true)
        delete process.env.FAKE_OMIT_SCRATCH_BYTES
        process.env.FAKE_HELPER_VERSION = '12'
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
        h.change(doc => {
            doc.diskDB[backupDisk.id].backupStaleLocks = [
                { instanceId: INST, startedAt: startedAt as any, detectedAt: Date.now() as any },
            ]
        })
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
        h.change(doc => {
            doc.diskDB[backupDisk.id].backupStaleLocks = [
                { instanceId: INST, startedAt: startedAt as any, detectedAt: Date.now() as any },
            ]
        })
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
  version) echo "idea-app-data \${FAKE_HELPER_VERSION:-13}" ;;
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
        const startedAt = Date.now()
        await fs.writeFile(
            `${DISKS_ROOT}/${backupDevice}/backups/${INST}/.backup-in-progress`,
            JSON.stringify({ instanceId: INST, startedAt }),
        )
        h.change(doc => {
            doc.diskDB[backupDisk.id].backupStaleLocks = [
                { instanceId: INST, startedAt: startedAt as any, detectedAt: Date.now() as any },
            ]
        })
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
        h.change(doc => {
            doc.diskDB[backupDisk.id].backupStaleLocks = [
                { instanceId: INST, startedAt: startedAt as any, detectedAt: Date.now() as any },
            ]
        })
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
        h.change(doc => {
            doc.diskDB[backupDisk.id].backupStaleLocks = [
                { instanceId: INST, startedAt: (Date.now() - 60000) as any, detectedAt: Date.now() as any },
            ]
        })
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
