/**
 * backup-hook.test.ts (idea#444)
 *
 * x-app.backup.method hook: parse/validate, no-stop happy path, preHook
 * timeout/failure with fallback stop|fail, postHook always runs, postHook
 * failure is a warning on a successful backup, injection refusals, and the
 * exclude / HELPER_OUTDATED regression (no hook, no stop, no lastBackup).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, os, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { config } from '../../src/data/Config.js'
import { backupInstance, backupLifecycle, BACKUP_STALE_LOCK } from '../../src/monitors/backupMonitor.js'
import { resourceLock, instanceKey } from '../../src/utils/ResourceLock.js'
import { borgPresence } from '../../src/utils/appDataHelper.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
import { drainDataBytesQueue } from '../harness/drainDataBytes.js'
import {
    parseBackupSpec, parseBackupHookDecl, parseBackupHookList, backupHookArgv, backupHookRunner,
    defaultBackupSpec, DEFAULT_HOOK_TIMEOUT_S,
    assertHookServicesExist,
} from '../../src/utils/backupMethod.js'
import { parseBackupHookExcludeList, parseBackupExcludeList, mergeBackupExcludeLists } from '../../src/utils/backupExclude.js'

describe('parseBackupSpec / parseBackupHookDecl / backupHookArgv', () => {
    it('defaults to method stop, fallback stop, timeout 300, no hooks', () => {
        expect(parseBackupSpec(undefined)).toEqual(defaultBackupSpec())
        expect(parseBackupSpec({})).toEqual(defaultBackupSpec())
        expect(parseBackupSpec({ backup: {} })).toEqual(defaultBackupSpec())
        expect(parseBackupSpec({ backup: { exclude: ['keys'] } })).toEqual(defaultBackupSpec())
        expect(DEFAULT_HOOK_TIMEOUT_S).toBe(300)
        expect(parseBackupSpec({ backup: { method: 'stop' } }).method).toBe('stop')
    })

    it('parses a usage-dashboard hook block', () => {
        const spec = parseBackupSpec({
            backup: {
                method: 'hook',
                fallback: 'stop',
                hookTimeout: 300,
                preHook: { service: 'collector', command: '/app/scripts/backup-snapshot.sh' },
                postHook: { service: 'collector', command: ['/app/scripts/backup-snapshot-cleanup.sh'] },
                exclude: ['keys'],
            },
        })
        expect(spec.method).toBe('hook')
        expect(spec.fallback).toBe('stop')
        expect(spec.hookTimeout).toBe(300)
        // idea#403: a single mapping is a list of one
        expect(spec.preHook).toEqual([{ service: 'collector', command: ['/app/scripts/backup-snapshot.sh'] }])
        expect(spec.postHook).toEqual([{ service: 'collector', command: ['/app/scripts/backup-snapshot-cleanup.sh'] }])
    })

    it('defaults fallback to stop and accepts fallback fail', () => {
        expect(parseBackupSpec({
            backup: {
                method: 'hook',
                preHook: { service: 'collector', command: '/app/snap.sh' },
            },
        }).fallback).toBe('stop')
        expect(parseBackupSpec({
            backup: {
                method: 'hook',
                fallback: 'fail',
                preHook: { service: 'collector', command: '/app/snap.sh' },
            },
        }).fallback).toBe('fail')
    })

    it('fails closed on live, and on unknown method/fallback', () => {
        expect(() => parseBackupSpec({ backup: { method: 'live' } })).toThrow(/not implemented \(idea#444\)/)
        expect(() => parseBackupSpec({ backup: { method: 'snapshot' } })).toThrow(/not allowed/)
        expect(() => parseBackupSpec({ backup: { fallback: 'retry' } })).toThrow(/fallback/)
        expect(() => parseBackupSpec({
            backup: { method: 'hook' },
        })).toThrow(/preHook is missing/)
    })

    it('idea#403 accepts method none (no hooks needed)', () => {
        const spec = parseBackupSpec({ backup: { method: 'none' } })
        expect(spec.method).toBe('none')
        expect(spec.preHook).toEqual([])
        expect(spec.postHook).toEqual([])
    })

    it('idea#403 preHook and postHook accept ordered lists of {service, command, user}', () => {
        const spec = parseBackupSpec({
            backup: {
                method: 'hook',
                preHook: [
                    { service: 'app', command: ['php', 'occ', 'maintenance:mode', '--on'], user: 33 },
                    { service: 'db', command: ['/backup/dump.sh'] },
                ],
                postHook: [
                    { service: 'db', command: '/backup/cleanup.sh' },
                    { service: 'app', command: ['php', 'occ', 'maintenance:mode', '--off'], user: '33' },
                ],
            },
        })
        expect(spec.preHook).toEqual([
            { service: 'app', command: ['php', 'occ', 'maintenance:mode', '--on'], user: '33' },
            { service: 'db', command: ['/backup/dump.sh'] },
        ])
        expect(spec.postHook).toEqual([
            { service: 'db', command: ['/backup/cleanup.sh'] },
            { service: 'app', command: ['php', 'occ', 'maintenance:mode', '--off'], user: '33' },
        ])
        expect(parseBackupHookList(undefined, 'postHook')).toEqual([])
        expect(parseBackupHookList({ service: 'app', command: 'x' }, 'postHook')).toEqual([{ service: 'app', command: ['x'] }])
    })

    it('idea#403 refuses an empty hook list and names the bad step', () => {
        expect(() => parseBackupSpec({ backup: { method: 'hook', preHook: [] } })).toThrow(/preHook is an empty list/)
        expect(() => parseBackupSpec({
            backup: { method: 'hook', preHook: { service: 'app', command: 'x' }, postHook: [] },
        })).toThrow(/postHook is an empty list/)
        expect(() => parseBackupSpec({
            backup: { method: 'hook', preHook: [{ service: 'app', command: 'x' }, { service: '-T', command: 'y' }] },
        })).toThrow(/preHook\[1\]\.service/)
        expect(() => parseBackupSpec({
            backup: { method: 'hook', preHook: [{ service: 'app', command: 'x' }, 'not-a-mapping'] },
        })).toThrow(/preHook\[1\] is not a mapping/)
    })

    it('idea#403 assertHookServicesExist checks every step of both lists', () => {
        const spec = parseBackupSpec({
            backup: {
                method: 'hook',
                preHook: [{ service: 'app', command: 'x' }],
                postHook: [{ service: 'app', command: 'y' }, { service: 'db', command: 'z' }],
            },
        })
        expect(() => assertHookServicesExist({ services: { app: {} } }, spec)).toThrow(/hook service 'db'/)
        expect(() => assertHookServicesExist({ services: { app: {}, db: {} } }, spec)).not.toThrow()
    })

    it('rejects a bad hookTimeout', () => {
        expect(() => parseBackupSpec({ backup: { hookTimeout: 0 } })).toThrow(/hookTimeout/)
        expect(() => parseBackupSpec({ backup: { hookTimeout: -1 } })).toThrow(/hookTimeout/)
        expect(() => parseBackupSpec({ backup: { hookTimeout: 1.5 } })).toThrow(/hookTimeout/)
        expect(() => parseBackupSpec({ backup: { hookTimeout: 86401 } })).toThrow(/hookTimeout/)
    })

    it('refuses injection in service, user and command', () => {
        const badServices = ['-T', ';rm', 'foo bar', 'foo;rm', '../x', 'foo/bar', 'foo$(x)']
        for (const service of badServices) {
            expect(() => parseBackupHookDecl({ service, command: '/app/snap.sh' }, 'preHook'), service).toThrow(/service/)
        }
        const badUsers = ['-u', 'foo;rm', 'foo bar', '../x', 'foo$(x)']
        for (const user of badUsers) {
            expect(() => parseBackupHookDecl({ service: 'collector', command: '/app/snap.sh', user }, 'preHook'), String(user)).toThrow(/user/)
        }
        expect(() => parseBackupHookDecl({ service: 'collector', command: 'snap\0.sh' }, 'preHook')).toThrow(/NUL/)
        expect(() => parseBackupHookDecl({ service: 'collector', command: 'snap\n.sh' }, 'preHook')).toThrow(/newline/)
        expect(() => parseBackupHookDecl({ service: 'collector', command: [''] }, 'preHook')).toThrow(/empty/)
        expect(() => parseBackupHookDecl({ service: 'collector', command: 12 }, 'preHook')).toThrow(/command/)
    })

    it('accepts optional numeric user and a command argv list', () => {
        expect(parseBackupHookDecl({ service: 'collector', command: ['python3', '/app/snap.py'], user: 0 }, 'preHook'))
            .toEqual({ service: 'collector', command: ['python3', '/app/snap.py'], user: '0' })
    })

    it('builds docker compose exec argv without a shell, with optional --user', () => {
        expect(backupHookArgv({
            cwd: '/instances/demo', timeoutS: 300, service: 'collector',
            command: ['/app/scripts/backup-snapshot.sh'],
        })).toEqual([
            'timeout', '--signal=TERM', '--kill-after=10s', '300',
            'docker', 'compose', 'exec', '-T',
            '--', 'collector', '/app/scripts/backup-snapshot.sh',
        ])
        expect(backupHookArgv({
            cwd: '/instances/demo', timeoutS: 12, service: 'collector', user: '0',
            command: ['python3', '/app/snap.py'],
        })).toEqual([
            'timeout', '--signal=TERM', '--kill-after=10s', '12',
            'docker', 'compose', 'exec', '-T', '--user', '0',
            '--', 'collector', 'python3', '/app/snap.py',
        ])
    })

    it('idea#448: a hook from the new bundle runs against the live project (-p, --project-directory, -f)', () => {
        expect(backupHookArgv({
            cwd: '/instances/demo', timeoutS: 30, service: 'collector', command: ['/app/snap.sh'],
            compose: { project: 'demo', projectDir: '/instances/demo', file: '/apps/usage-dashboard-1.1/compose.yaml' },
        })).toEqual([
            'timeout', '--signal=TERM', '--kill-after=10s', '30',
            'docker', 'compose', '-p', 'demo', '--project-directory', '/instances/demo', '-f', '/apps/usage-dashboard-1.1/compose.yaml',
            'exec', '-T', '--', 'collector', '/app/snap.sh',
        ])
    })

    it('assertHookServicesExist fails closed when the service is missing', () => {
        const spec = parseBackupSpec({
            backup: {
                method: 'hook',
                preHook: { service: 'collector', command: '/app/snap.sh' },
            },
        })
        expect(() => assertHookServicesExist({ services: { web: {} } }, spec)).toThrow(/not a compose service/)
        expect(() => assertHookServicesExist({ services: { collector: {} } }, spec)).not.toThrow()
    })
})


describe('parseBackupHookExcludeList', () => {
    it('uses the same path rules as exclude and keeps the two lists separate', () => {
        expect(parseBackupHookExcludeList(undefined)).toEqual([])
        expect(parseBackupHookExcludeList({ backup: {} })).toEqual([])
        expect(parseBackupHookExcludeList({
            backup: {
                exclude: ['keys'],
                hookExclude: ['usage.sqlite', 'usage.sqlite-wal', './data/usage.sqlite-shm'],
            },
        })).toEqual(['data/usage.sqlite', 'data/usage.sqlite-wal', 'data/usage.sqlite-shm'])
        expect(parseBackupExcludeList({
            backup: { exclude: ['keys'], hookExclude: ['usage.sqlite'] },
        })).toEqual(['data/keys'])
        expect(mergeBackupExcludeLists(
            ['data/keys', 'data/tailscale'],
            ['data/usage.sqlite', 'data/keys'],
        )).toEqual(['data/keys', 'data/tailscale', 'data/usage.sqlite'])
        expect(() => parseBackupHookExcludeList({ backup: { hookExclude: '../etc' } })).toThrow(/hookExclude/)
        expect(() => parseBackupHookExcludeList({ backup: { hookExclude: 'keys' } })).toThrow(/must be a list/)
        expect(parseBackupHookExcludeList({ backup: { hookExclude: ['keys'] } })).toEqual(['data/keys'])
    })

    it('accepts a multi-segment directory path such as data/backup/daily on both lists', () => {
        expect(parseBackupExcludeList({
            backup: { exclude: ['keys', 'data/backup/daily'], hookExclude: ['usage.sqlite'] },
        })).toEqual(['data/keys', 'data/backup/daily'])
        expect(parseBackupHookExcludeList({
            backup: { exclude: ['keys'], hookExclude: ['data/backup/daily', 'usage.sqlite'] },
        })).toEqual(['data/backup/daily', 'data/usage.sqlite'])
        expect(parseBackupExcludeList({
            backup: { exclude: ['./data/backup/daily/'] },
        })).toEqual(['data/backup/daily'])
    })
})

const INST = 'inst-hook-1' as InstanceID

const FAKE_SUDO = `#!/usr/bin/env bash
[[ "$1" == -n && "$2" == /usr/local/sbin/idea-app-data ]] || exec /usr/bin/sudo "$@"
shift 2
echo "$*" >> "$FAKE_BORG_LOG"
case "$1" in
  version) echo "idea-app-data \${FAKE_HELPER_VERSION:-8}" ;;
  borg-init) mkdir -p "$IDEA_DISKS_ROOT/$2/backups/$3" && echo '[repository]' > "$IDEA_DISKS_ROOT/$2/backups/$3/config" ;;
  borg-create) [[ -n "\${FAKE_BORG_CREATE_FAIL:-}" ]] && { echo 'borg create failed' >&2; exit 2; } ;;
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

type HookOutcome = { code: number, timedOut?: boolean, stderr?: string }

describe('backupInstance method hook (idea#444)', () => {
    let appDevice: string
    let backupDevice: string
    let binDir: string
    let borgLog: string
    const hookCalls: { which: string, cwd: string, timeoutS: number, service: string, command: string[], user?: string, compose?: { project: string, projectDir: string, file: string } }[] = []
    let preOutcome: HookOutcome = { code: 0 }
    let postOutcome: HookOutcome = { code: 0 }
    /** idea#403: outcome per command (first word), overriding preOutcome/postOutcome. */
    let outcomeByCmd: Record<string, HookOutcome> = {}
    let stopCount = 0
    let startCount = 0
    const saved = {
        testMode: config.settings.testMode, skipBorg: config.settings.skipBorg,
        path: process.env.PATH, log: process.env.FAKE_BORG_LOG, ver: process.env.FAKE_HELPER_VERSION,
        stop: backupLifecycle.stopInstance, start: backupLifecycle.startInstance, run: backupHookRunner.run,
    }

    const writeCompose = async (backup: Record<string, unknown>, services: Record<string, unknown> = { collector: {}, tailscale: {} }) => {
        const instDir = `${DISKS_ROOT}/${appDevice}/instances/${INST}`
        await fs.ensureDir(`${instDir}/data`)
        await fs.writeFile(`${instDir}/compose.yaml`, YAML.stringify({
            'x-app': { name: 'usage-dashboard', backup },
            services,
        }))
        return instDir
    }

    const hookBlock = (extra: Record<string, unknown> = {}) => ({
        method: 'hook',
        preHook: { service: 'collector', command: '/app/scripts/backup-snapshot.sh' },
        postHook: { service: 'collector', command: '/app/scripts/backup-snapshot-cleanup.sh' },
        exclude: ['keys', 'tailscale', 'tailscale-run', 'data/backup/daily'],
        hookExclude: ['usage.sqlite', 'usage.sqlite-wal', 'usage.sqlite-shm'],
        ...extra,
    })

    beforeEach(async () => {
        borgPresence.exists = () => true
        appDevice = uniqueTestDevice()
        do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
        await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`, `mode: on-demand\nlinks:\n  - instanceId: ${INST}\n    lastBackup: 0\n`)
        binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-sudo-hook-'))
        borgLog = path.join(binDir, 'calls.log')
        await fs.writeFile(path.join(binDir, 'sudo'), FAKE_SUDO, { mode: 0o755 })
        process.env.PATH = `${binDir}:${saved.path}`
        process.env.FAKE_BORG_LOG = borgLog
        process.env.FAKE_HELPER_VERSION = '8'
        config.settings.testMode = true
        config.settings.skipBorg = false
        hookCalls.length = 0
        preOutcome = { code: 0 }
        postOutcome = { code: 0 }
        outcomeByCmd = {}
        delete process.env.FAKE_BORG_CREATE_FAIL
        stopCount = 0
        startCount = 0
        backupLifecycle.stopInstance = (async () => { stopCount += 1 }) as typeof backupLifecycle.stopInstance
        backupLifecycle.startInstance = (async () => { startCount += 1 }) as typeof backupLifecycle.startInstance
        backupHookRunner.run = async (spec) => {
            const which = spec.command[0]?.includes('cleanup') ? 'postHook' : 'preHook'
            hookCalls.push({ which, cwd: spec.cwd, timeoutS: spec.timeoutS, service: spec.service, command: [...spec.command], user: spec.user, compose: spec.compose })
            const out = outcomeByCmd[spec.command[0]] ?? (which === 'postHook' ? postOutcome : preOutcome)
            return { code: out.code, timedOut: !!out.timedOut, stderr: out.stderr ?? '' }
        }
        vi.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(async () => {
        // engine#430 follow-up: wait for the background size measurement before
        // removing the fake sudo dir (it appends to calls.log in binDir).
        await drainDataBytesQueue()
        borgPresence.exists = (p) => fs.existsSync(p)
        vi.restoreAllMocks()
        backupLifecycle.stopInstance = saved.stop
        backupLifecycle.startInstance = saved.start
        backupHookRunner.run = saved.run
        config.settings.testMode = saved.testMode
        config.settings.skipBorg = saved.skipBorg
        process.env.PATH = saved.path
        if (saved.log === undefined) delete process.env.FAKE_BORG_LOG
        else process.env.FAKE_BORG_LOG = saved.log
        delete process.env.FAKE_BORG_CREATE_FAIL
        if (saved.ver === undefined) delete process.env.FAKE_HELPER_VERSION
        else process.env.FAKE_HELPER_VERSION = saved.ver
        await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
        await fs.remove(binDir)
    })

    const calls = async (): Promise<string[]> =>
        (await fs.pathExists(borgLog)) ? (await fs.readFile(borgLog, 'utf8')).split('\n').filter(Boolean) : []

    const runBackup = async (status: 'Stopped' | 'Running' | 'Starting' = 'Running') => {
        const h = await createMinimalStore()
        const appDisk = makeDisk('hook-ad', appDevice, false)
        const backupDisk = makeDisk('hook-bd', backupDevice, true)
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
            // trace wrapper may swallow; the operation records the outcome
        }
        return h
    }

    const opOf = (h: DocHandle<Store>) =>
        Object.values(h.doc()!.operationDB ?? {}).find((o: any) => o.kind === 'backupApp') as any

    it('happy path: no stop/start, preHook then borg-create then postHook', async () => {
        const instDir = await writeCompose(hookBlock())
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.hookResult).toBe('hook')
        expect(op?.args?.warning).toBeUndefined()
        expect(h.doc()!.instanceDB[INST].lastBackup).not.toBeNull()
        expect(stopCount).toBe(0)
        expect(startCount).toBe(0)
        expect(hookCalls.map(c => c.which)).toEqual(['preHook', 'postHook'])
        expect(hookCalls[0].cwd).toBe(instDir)
        expect(hookCalls[0].timeoutS).toBe(300)
        expect(hookCalls[0].service).toBe('collector')
        expect(hookCalls[0].command).toEqual(['/app/scripts/backup-snapshot.sh'])
        const log = await calls()
        const create = log.find(l => l.startsWith('borg-create '))
        expect(create).toMatch(new RegExp(
            `^borg-create ${backupDevice} ${INST} \\d{4}-\\d{2}-\\d{2}T[0-9-]+Z ${appDevice} data/keys data/tailscale data/tailscale-run data/backup/daily data/usage\\.sqlite data/usage\\.sqlite-wal data/usage\\.sqlite-shm$`,
        ))
        const createIdx = log.findIndex(l => l.startsWith('borg-create '))
        expect(createIdx).toBeGreaterThanOrEqual(0)
        expect(hookCalls[0].which).toBe('preHook')
        expect(hookCalls[1].which).toBe('postHook')
    })

    it('preHook failure with fallback fail: postHook runs, no stop, no borg-create, no lastBackup', async () => {
        preOutcome = { code: 3, stderr: 'vacuum failed' }
        await writeCompose(hookBlock({ fallback: 'fail' }))
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status).toBe('Failed')
        expect(op?.error).toMatch(/^HOOK_FAILED: preHook exited 3/)
        expect(h.doc()!.instanceDB[INST].lastBackup).toBeNull()
        expect(h.doc()!.instanceDB[INST].status).toBe('Running')
        expect(stopCount).toBe(0)
        expect(startCount).toBe(0)
        expect(hookCalls.map(c => c.which)).toEqual(['preHook', 'postHook'])
        const log = await calls()
        expect(log.some(l => l.startsWith('borg-create'))).toBe(false)
    })

    it('preHook timeout with fallback fail: treated as failure, postHook still runs', async () => {
        preOutcome = { code: 124, timedOut: true, stderr: 'timeout' }
        await writeCompose(hookBlock({ fallback: 'fail', hookTimeout: 12 }))
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status).toBe('Failed')
        expect(op?.error).toMatch(/^HOOK_FAILED: preHook timed out/)
        expect(hookCalls.map(c => `${c.which}@${c.timeoutS}`)).toEqual(['preHook@12', 'postHook@12'])
        expect(stopCount).toBe(0)
        expect((await calls()).some(l => l.startsWith('borg-create'))).toBe(false)
    })

    it('preHook failure with fallback stop (default): HOOK_FALLBACK, stop then borg then start, postHook first', async () => {
        preOutcome = { code: 1, stderr: 'no dump' }
        await writeCompose(hookBlock())
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.hookResult).toBe('HOOK_FALLBACK')
        expect(h.doc()!.instanceDB[INST].lastBackup).not.toBeNull()
        expect(stopCount).toBe(1)
        expect(startCount).toBe(1)
        expect(hookCalls.map(c => c.which)).toEqual(['preHook', 'postHook'])
        const create = (await calls()).find(l => l.startsWith('borg-create '))
        expect(create).toBeTruthy()
        expect(create).toMatch(new RegExp(` data/keys data/tailscale data/tailscale-run data/backup/daily$`))
        expect(create).not.toMatch(/usage\.sqlite/)
    })

    it('successful hook archive excludes hookExclude live DB; always-exclude keys stay out', async () => {
        await writeCompose(hookBlock())
        const h = await runBackup('Running')
        expect(opOf(h)?.args?.hookResult).toBe('hook')
        const create = (await calls()).find(l => l.startsWith('borg-create ')) ?? ''
        expect(create).toContain(' data/keys ')
        expect(create).toContain(' data/tailscale ')
        expect(create).toContain(' data/tailscale-run ')
        expect(create).toContain(' data/backup/daily ')
        expect(create).toContain(' data/usage.sqlite ')
        expect(create).toContain(' data/usage.sqlite-wal ')
        expect(create).toMatch(/data\/usage\.sqlite-shm$/)
        expect(stopCount).toBe(0)
    })

    it('preHook timeout with fallback stop: HOOK_FALLBACK and postHook still runs', async () => {
        preOutcome = { code: 124, timedOut: true }
        await writeCompose(hookBlock({ fallback: 'stop' }))
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.hookResult).toBe('HOOK_FALLBACK')
        expect(hookCalls.map(c => c.which)).toEqual(['preHook', 'postHook'])
        expect(stopCount).toBe(1)
        expect(startCount).toBe(1)
    })

    it('postHook failure after a good borg create: backup succeeds with HOOK_POST_WARNING', async () => {
        postOutcome = { code: 2, stderr: 'cleanup failed' }
        await writeCompose(hookBlock())
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.hookResult).toBe('hook')
        expect(op?.args?.warning).toMatch(/^HOOK_POST_WARNING: postHook exited 2/)
        expect(h.doc()!.instanceDB[INST].lastBackup).not.toBeNull()
        expect(stopCount).toBe(0)
        expect(startCount).toBe(0)
        expect(hookCalls.map(c => c.which)).toEqual(['preHook', 'postHook'])
    })

    it('HELPER_OUTDATED on helper v7 with excludes: no hook, no stop, no borg-create, no lastBackup', async () => {
        process.env.FAKE_HELPER_VERSION = '7'
        await writeCompose(hookBlock())
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status).toBe('Failed')
        expect(op?.error).toMatch(/^HELPER_OUTDATED:.*v8 or later/)
        expect(h.doc()!.instanceDB[INST].lastBackup).toBeNull()
        expect(h.doc()!.instanceDB[INST].status).toBe('Running')
        expect(stopCount).toBe(0)
        expect(startCount).toBe(0)
        expect(hookCalls).toEqual([])
        const log = await calls()
        expect(log.some(l => l.startsWith('borg-create'))).toBe(false)
        expect(log.some(l => l.startsWith('borg-init'))).toBe(false)
    })

    it('method live fails closed before any hook or stop', async () => {
        await writeCompose({ method: 'live', exclude: ['keys'] })
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status).toBe('Failed')
        expect(op?.error).toMatch(/invalid x-app\.backup.*not implemented \(idea#444\)/)
        expect(stopCount).toBe(0)
        expect(hookCalls).toEqual([])
        expect(h.doc()!.instanceDB[INST].lastBackup).toBeNull()
    })

    it('unknown hook service fails closed before any hook or stop', async () => {
        await writeCompose(hookBlock(), { web: {} })
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status).toBe('Failed')
        expect(op?.error).toMatch(/not a compose service/)
        expect(stopCount).toBe(0)
        expect(hookCalls).toEqual([])
    })

    // ── idea#403: ordered hook lists, method none, stopped instances ──────────
    const listBlock = (extra: Record<string, unknown> = {}) => hookBlock({
        preHook: [
            { service: 'collector', command: '/app/pre-1.sh' },
            { service: 'collector', command: '/app/pre-2.sh' },
            { service: 'collector', command: '/app/pre-3.sh' },
        ],
        postHook: [
            { service: 'collector', command: '/app/cleanup-1.sh' },
            { service: 'collector', command: '/app/cleanup-2.sh' },
        ],
        ...extra,
    })
    const cmds = () => hookCalls.map(c => c.command[0])
    const lastResultOf = (h: DocHandle<Store>) => (h.doc()!.instanceDB[INST] as any).lastResult

    it('idea#403 list: pre steps in order, borg, then every post step in order; no stop', async () => {
        await writeCompose(listBlock())
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.hookResult).toBe('hook')
        expect(cmds()).toEqual(['/app/pre-1.sh', '/app/pre-2.sh', '/app/pre-3.sh', '/app/cleanup-1.sh', '/app/cleanup-2.sh'])
        expect(stopCount).toBe(0)
        expect((await calls()).some(l => l.startsWith('borg-create '))).toBe(true)
        expect(lastResultOf(h)).toMatchObject({ method: 'hook', result: 'OK' })
    })

    it('idea#403 list: a failed pre step stops the later pre steps, every post step still runs, then HOOK_FALLBACK', async () => {
        outcomeByCmd = { '/app/pre-2.sh': { code: 4, stderr: 'dump failed' } }
        await writeCompose(listBlock())
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.hookResult).toBe('HOOK_FALLBACK')
        expect(cmds()).toEqual(['/app/pre-1.sh', '/app/pre-2.sh', '/app/cleanup-1.sh', '/app/cleanup-2.sh'])
        expect(stopCount).toBe(1)
        expect(startCount).toBe(1)
        expect(lastResultOf(h)).toMatchObject({ method: 'hook', result: 'HOOK_FALLBACK' })
    })

    it('idea#403 list with fallback fail: HOOK_FAILED names the step; every post step runs; no borg', async () => {
        outcomeByCmd = { '/app/pre-1.sh': { code: 9, stderr: 'occ down' } }
        await writeCompose(listBlock({ fallback: 'fail' }))
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status).toBe('Failed')
        expect(op?.error).toMatch(/^HOOK_FAILED: preHook\[0\] exited 9: occ down \(2 later preHook step\(s\) not run\)/)
        expect(cmds()).toEqual(['/app/pre-1.sh', '/app/cleanup-1.sh', '/app/cleanup-2.sh'])
        expect(stopCount).toBe(0)
        expect((await calls()).some(l => l.startsWith('borg-create'))).toBe(false)
    })

    it('idea#403 list: a failed post step does not stop the later post steps; HOOK_POST_WARNING names it', async () => {
        outcomeByCmd = { '/app/cleanup-1.sh': { code: 5, stderr: 'rm failed' } }
        await writeCompose(listBlock())
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.warning).toMatch(/^HOOK_POST_WARNING: postHook\[0\] exited 5: rm failed$/)
        expect(cmds()).toEqual(['/app/pre-1.sh', '/app/pre-2.sh', '/app/pre-3.sh', '/app/cleanup-1.sh', '/app/cleanup-2.sh'])
        expect(lastResultOf(h)).toMatchObject({ method: 'hook', result: 'HOOK_POST_WARNING' })
    })

    it('idea#403 a failed borg run still runs every post step, then the backup fails (no lastBackup)', async () => {
        process.env.FAKE_BORG_CREATE_FAIL = '1'
        await writeCompose(listBlock())
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status).toBe('Failed')
        expect(cmds()).toEqual(['/app/pre-1.sh', '/app/pre-2.sh', '/app/pre-3.sh', '/app/cleanup-1.sh', '/app/cleanup-2.sh'])
        expect((await calls()).some(l => l.startsWith('borg-create '))).toBe(true)
        expect(h.doc()!.instanceDB[INST].lastBackup).toBeNull()
        expect(stopCount).toBe(0)
        expect(lastResultOf(h)).toMatchObject({ method: 'hook', result: 'FAILED' })
    })

    it('idea#403 a failed borg run with a single postHook still runs it', async () => {
        process.env.FAKE_BORG_CREATE_FAIL = '1'
        await writeCompose(hookBlock())
        const h = await runBackup('Running')
        expect(opOf(h)?.status).toBe('Failed')
        expect(hookCalls.map(c => c.which)).toEqual(['preHook', 'postHook'])
    })

    it('idea#403 method none: nothing copied (no borg, no lock, no hook, no stop, no lastBackup); recorded as none / OK', async () => {
        borgPresence.exists = () => false   // none never needs borg
        await writeCompose({ method: 'none', exclude: ['keys'] })
        const h = await runBackup('Running')
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.hookResult).toBe('none')
        expect(lastResultOf(h)).toMatchObject({ method: 'none', result: 'OK' })
        expect(h.doc()!.instanceDB[INST].lastBackup).toBeNull()
        expect(hookCalls).toEqual([])
        expect(stopCount).toBe(0)
        expect(startCount).toBe(0)
        expect(await calls()).toEqual([])
        expect(await fs.pathExists(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)).toBe(false)
    })

    it('idea#403 stopped instance with method hook: hooks skipped, backed up cold (only exclude; hookExclude paths stay IN the archive), not HOOK_FALLBACK', async () => {
        await writeCompose(listBlock())
        const h = await runBackup('Stopped')
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.hookResult).toBe('cold')
        expect(hookCalls).toEqual([])
        expect(stopCount).toBe(0)
        expect(startCount).toBe(0)
        const create = (await calls()).find(l => l.startsWith('borg-create '))
        expect(create).toMatch(/ data\/keys data\/tailscale data\/tailscale-run data\/backup\/daily$/)
        // no hook copies were made, so the live dbs that hookExclude lists must be packed (e.g. Kolibri)
        expect(create).not.toMatch(/usage\.sqlite/)
        expect(h.doc()!.instanceDB[INST].lastBackup).not.toBeNull()
        expect(lastResultOf(h)).toMatchObject({ method: 'hook', result: 'OK' })
    })

    it('idea#403 a Starting instance still runs its hooks (not cold)', async () => {
        await writeCompose(hookBlock())
        const h = await runBackup('Starting')
        expect(opOf(h)?.args?.hookResult).toBe('hook')
        expect(hookCalls.map(c => c.which)).toEqual(['preHook', 'postHook'])
    })

    // ── engine#401: the archive name carries the backup mode ─────────────────
    const createdArchive = async () => (await calls()).find(l => l.startsWith('borg-create '))?.split(' ')[3] ?? ''

    it('engine#401 helper v16: a hook backup is named <ts>-hook and recorded in op.args.archive', async () => {
        process.env.FAKE_HELPER_VERSION = '16'
        await writeCompose(hookBlock())
        const h = await runBackup('Running')
        const name = await createdArchive()
        expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9-]+Z-hook$/)
        expect(opOf(h)?.args?.archive).toBe(name)
    })

    it('engine#401 helper v16: a HOOK_FALLBACK backup is named <ts>-stop', async () => {
        process.env.FAKE_HELPER_VERSION = '16'
        preOutcome = { code: 1, stderr: 'no dump' }
        await writeCompose(hookBlock())
        const h = await runBackup('Running')
        expect(opOf(h)?.args?.hookResult).toBe('HOOK_FALLBACK')
        expect(await createdArchive()).toMatch(/Z-stop$/)
    })

    it('engine#401 helper v16: a stopped hook instance is named <ts>-cold; method stop is <ts>-stop', async () => {
        process.env.FAKE_HELPER_VERSION = '16'
        await writeCompose(hookBlock())
        await runBackup('Stopped')
        expect(await createdArchive()).toMatch(/Z-cold$/)
        await fs.remove(borgLog)
        await writeCompose({ exclude: ['keys'] })
        await runBackup('Running')
        expect(await createdArchive()).toMatch(/Z-stop$/)
    })

    it('engine#401 an older helper (v8) gets today\'s untagged name', async () => {
        await writeCompose(hookBlock())
        const h = await runBackup('Running')
        const name = await createdArchive()
        expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9-]+Z$/)
        expect(opOf(h)?.args?.archive).toBe(name)
    })

    // ── idea#448: the pre-update backup updateApp takes itself ────────────────
    const newBundleCompose = async (backup: Record<string, unknown>, services: Record<string, unknown> = { collector: {}, tailscale: {} }) => {
        const dir = `${DISKS_ROOT}/${appDevice}/apps/usage-dashboard-1.1`
        await fs.ensureDir(dir)
        await fs.writeFile(`${dir}/compose.yaml`, YAML.stringify({ 'x-app': { name: 'usage-dashboard', version: '1.1', backup }, services }))
        return `${dir}/compose.yaml`
    }
    /** As updateApp calls it: the caller holds the instance lock; errors are thrown. */
    const runPreUpdate = async (instanceStopped: boolean, status: 'Running' | 'Starting' | 'Stopped' = 'Running') => {
        const h = await createMinimalStore()
        const appDisk = makeDisk('hook-ad', appDevice, false)
        const backupDisk = makeDisk('hook-bd', backupDevice, true)
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
        expect(resourceLock.acquire(instanceKey(INST), 'updateApp')).toBe(true)
        let error: string | null = null
        try {
            await backupInstance(h, INST, backupDisk, undefined, 'console-command', { instanceStopped })
        } catch (e) {
            error = String((e as Error).message)
        } finally {
            resourceLock.release(instanceKey(INST))
        }
        return { h, error }
    }
    const lockFile = () => `${DISKS_ROOT}/${backupDevice}/backups/${INST}/.backup-in-progress`

    it('idea#458 pre-update hook: runs the CURRENT compose hook against the live project, its excludes, no stop, under the caller\'s instance lock', async () => {
        const instDir = await writeCompose(hookBlock())   // live compose: hook
        const composePath = `${instDir}/compose.yaml`
        await newBundleCompose(hookBlock({ preHook: { service: 'collector', command: '/app/scripts/NEW-only.sh' } }))
        const { h, error } = await runPreUpdate(false)
        expect(error).toBeNull()
        const op = opOf(h)
        expect(op?.status, op?.error).toBe('Done')
        expect(op?.args?.reason).toBe('pre-update')
        expect(op?.args?.hookResult).toBe('hook')
        expect(stopCount).toBe(0)
        expect(startCount).toBe(0)
        expect(hookCalls.map(c => c.which)).toEqual(['preHook', 'postHook'])
        expect(hookCalls[0].compose).toEqual({ project: INST, projectDir: instDir, file: composePath })
        expect(hookCalls[0].command).toEqual(['/app/scripts/backup-snapshot.sh'])   // the old version's hook, not NEW-only.sh
        const create = (await calls()).find(l => l.startsWith('borg-create '))
        expect(create).toMatch(/ data\/keys data\/tailscale data\/tailscale-run data\/backup\/daily data\/usage\.sqlite data\/usage\.sqlite-wal data\/usage\.sqlite-shm$/)
        expect(h.doc()!.instanceDB[INST].lastBackup).not.toBeNull()
        expect(await fs.pathExists(lockFile())).toBe(false)
    })

    it('idea#458 pre-update hook: a failed CURRENT-compose preHook with fallback stop refuses HOOK_FAILED (no fallback); no stop, no borg, no lastBackup, own lock cleared', async () => {
        preOutcome = { code: 2, stderr: 'db locked' }
        await writeCompose(hookBlock({ fallback: 'stop' }))
        await newBundleCompose(hookBlock())
        const { h, error } = await runPreUpdate(false)
        expect(error).toMatch(/^HOOK_FAILED: preHook exited 2: db locked/)
        expect(stopCount).toBe(0)
        expect(startCount).toBe(0)
        expect((await calls()).some(l => l.startsWith('borg-create '))).toBe(false)
        expect(hookCalls.filter(c => c.which === 'preHook')).toHaveLength(1)   // no retry, no fallback
        expect(h.doc()!.instanceDB[INST].lastBackup).toBeNull()
        expect(h.doc()!.instanceDB[INST].status).toBe('Running')
        expect(await fs.pathExists(lockFile())).toBe(false)
    })

    it('idea#448 inside the snapshot stop: Borg only (exclude, no hookExclude), no hook, no stop or start', async () => {
        await writeCompose(hookBlock())
        const { h, error } = await runPreUpdate(true, 'Stopped')
        expect(error).toBeNull()
        expect(hookCalls).toEqual([])
        expect(stopCount).toBe(0)
        expect(startCount).toBe(0)
        const create = (await calls()).find(l => l.startsWith('borg-create '))
        expect(create).toMatch(/ data\/keys data\/tailscale data\/tailscale-run data\/backup\/daily$/)
        expect(h.doc()!.instanceDB[INST].lastBackup).not.toBeNull()
    })

    it('idea#403 pre-update backup of a method none instance copies nothing and does not fail', async () => {
        await writeCompose({ method: 'none' })
        const { h, error } = await runPreUpdate(true, 'Stopped')
        expect(error).toBeNull()
        expect(opOf(h)?.args?.hookResult).toBe('none')
        expect(await calls()).toEqual([])
        expect(await fs.pathExists(lockFile())).toBe(false)
    })

    it('idea#458 a stop-mode CURRENT compose while the instance runs is refused, even when the new bundle has a hook (updateApp must take it inside its stop)', async () => {
        await writeCompose({ exclude: ['keys'] })
        await newBundleCompose(hookBlock())
        const { error } = await runPreUpdate(false)
        expect(error).toMatch(/needs method 'hook' in the current compose while the instance runs/)
        expect(stopCount).toBe(0)
        expect(hookCalls).toEqual([])
        expect((await calls()).some(l => l.startsWith('borg-create '))).toBe(false)
    })

    it('idea#448 a stale .backup-in-progress refuses the pre-update backup and is left alone (no auto-retry)', async () => {
        await writeCompose(hookBlock())
        await fs.outputFile(lockFile(), '{"instanceId":"x","startedAt":1}')
        const { error } = await runPreUpdate(false)
        expect(error).toMatch(new RegExp(`^${BACKUP_STALE_LOCK}: `))
        expect(hookCalls).toEqual([])
        expect(await fs.readFile(lockFile(), 'utf8')).toBe('{"instanceId":"x","startedAt":1}')
    })

    it('idea#458 a missing or invalid CURRENT compose fails closed before any hook (a valid new bundle does not stand in)', async () => {
        await newBundleCompose(hookBlock())
        const missing = await runPreUpdate(false)
        expect(missing.error).toMatch(/the instance's .*instances\/.*compose\.yaml is missing/)
        await writeCompose({ exclude: ['../etc'] })
        expect((await runPreUpdate(false)).error).toMatch(/invalid x-app.backup.exclude/)
        expect(hookCalls).toEqual([])
    })

})

