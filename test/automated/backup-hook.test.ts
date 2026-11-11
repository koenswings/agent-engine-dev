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
import { backupInstance, backupLifecycle } from '../../src/monitors/backupMonitor.js'
import { borgPresence } from '../../src/utils/appDataHelper.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'
import {
    parseBackupSpec, parseBackupHookDecl, backupHookArgv, backupHookRunner,
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
        expect(spec.preHook).toEqual({ service: 'collector', command: ['/app/scripts/backup-snapshot.sh'] })
        expect(spec.postHook).toEqual({ service: 'collector', command: ['/app/scripts/backup-snapshot-cleanup.sh'] })
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

    it('fails closed on live and none, and on unknown method/fallback', () => {
        expect(() => parseBackupSpec({ backup: { method: 'live' } })).toThrow(/not implemented \(idea#444\)/)
        expect(() => parseBackupSpec({ backup: { method: 'none' } })).toThrow(/not implemented \(idea#444\)/)
        expect(() => parseBackupSpec({ backup: { method: 'snapshot' } })).toThrow(/not allowed/)
        expect(() => parseBackupSpec({ backup: { fallback: 'retry' } })).toThrow(/fallback/)
        expect(() => parseBackupSpec({
            backup: { method: 'hook' },
        })).toThrow(/preHook is missing/)
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
})

const INST = 'inst-hook-1' as InstanceID

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

type HookOutcome = { code: number, timedOut?: boolean, stderr?: string }

describe('backupInstance method hook (idea#444)', () => {
    let appDevice: string
    let backupDevice: string
    let binDir: string
    let borgLog: string
    const hookCalls: { which: string, cwd: string, timeoutS: number, service: string, command: string[], user?: string }[] = []
    let preOutcome: HookOutcome = { code: 0 }
    let postOutcome: HookOutcome = { code: 0 }
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
        exclude: ['keys', 'tailscale', 'tailscale-run'],
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
        stopCount = 0
        startCount = 0
        backupLifecycle.stopInstance = (async () => { stopCount += 1 }) as typeof backupLifecycle.stopInstance
        backupLifecycle.startInstance = (async () => { startCount += 1 }) as typeof backupLifecycle.startInstance
        backupHookRunner.run = async (spec) => {
            const which = spec.command[0]?.includes('cleanup') ? 'postHook' : 'preHook'
            hookCalls.push({ which, cwd: spec.cwd, timeoutS: spec.timeoutS, service: spec.service, command: [...spec.command], user: spec.user })
            const out = which === 'postHook' ? postOutcome : preOutcome
            return { code: out.code, timedOut: !!out.timedOut, stderr: out.stderr ?? '' }
        }
        vi.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(async () => {
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
        if (saved.ver === undefined) delete process.env.FAKE_HELPER_VERSION
        else process.env.FAKE_HELPER_VERSION = saved.ver
        await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
        await fs.remove(binDir)
    })

    const calls = async (): Promise<string[]> =>
        (await fs.pathExists(borgLog)) ? (await fs.readFile(borgLog, 'utf8')).split('\n').filter(Boolean) : []

    const runBackup = async (status: 'Stopped' | 'Running' = 'Running') => {
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
            `^borg-create ${backupDevice} ${INST} \\d{4}-\\d{2}-\\d{2}T[0-9-]+Z ${appDevice} data/keys data/tailscale data/tailscale-run data/usage\\.sqlite data/usage\\.sqlite-wal data/usage\\.sqlite-shm$`,
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
        expect(create).toMatch(new RegExp(` data/keys data/tailscale data/tailscale-run$`))
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
})

