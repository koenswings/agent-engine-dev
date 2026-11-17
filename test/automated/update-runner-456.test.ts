/**
 * update-runner-456.test.ts — engine#456: updateApp runs x-app.update prepare / verify / work /
 * settle (design comment 6942066196, Steve's decisions §8, Console contract §9, answers §10).
 *
 *  (A) the step contract at Check (UPDATE_CONTRACT_INVALID, UPDATE_STAGES_UNSUPPORTED, 1 s – 6 h)
 *      with Kid's real NC 2.0 block (test/fixtures/update-456)
 *  (B) the runner (UpdateStepRunner.ts) against a fake docker CLI: exact argv, the prepare
 *      override, IDEA_UPDATE_FROM / IDEA_UPDATE_TO, notes, 126/127, TERM then KILL on a timeout
 *  (C) updateApp end to end with injected Docker: the 12 steps, rollback before the point of no
 *      return, MIGRATIONS_PENDING / SETTLE_FAILED after it, updatePending, the temporary backup,
 *      the update-in-flight marker, ROLLBACK_START_FAILED, Resume, offers and boot recovery
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os, YAML, $ } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { updateApp, UpdateDeps, UpdateProgress, recoverInterruptedUpdates, refreshUpdateAvailable, readComposeServices } from '../../src/data/UpdateApp.js'
import {
    checkUpdate, parseUpdateContract, offerable, UPDATE_STEPS, CheckFacts, UpdateStepSpec,
    ROLLBACK_START_FAILED_PREFIX, UpdateAppError,
} from '../../src/data/UpdateAppPolicy.js'
import {
    runUpdateStep, StepContext, StepRun, stepNote, prepareArgs, execArgs, prepareOverride, describeStepRun,
    stepFailureText, STEP_NOTE_MAX, EXEC_WRAPPER,
} from '../../src/data/UpdateStepRunner.js'
import { UPDATE_IN_FLIGHT_FILE, updateInFlightRefusal, writeUpdateInFlight, clearUpdateInFlight } from '../../src/data/UpdateInFlight.js'
import { createOperation, updateOperation } from '../../src/data/Operations.js'

const ME = String(localEngineId)
const FIX = path.join(process.cwd(), 'test', 'fixtures', 'update-456')
const ncCompose = () => YAML.parse(fs.readFileSync(path.join(FIX, 'compose-nextcloud-2.0.yaml'), 'utf8'))
const ncUpdate = () => ncCompose()['x-app'].update
const NC_SERVICES = ['nextcloud-app', 'nextcloud-db', 'code']

describe('(A) step contract at Check', () => {
    const facts = (over: Partial<CheckFacts> = {}): CheckFacts => ({
        diskDocked: true, busy: false, currentAppId: 'nextcloud-1.8-31.0.14', newAppId: 'nextcloud-2.0-32.0.15',
        sourcePresent: true, sumsValid: true, allowMajor: true, backupAgeMs: 1000, shortDisks: [], updatesFrom: [1],
        newServices: NC_SERVICES, ...over,
    })

    it("accepts Kid's real NC 2.0 block (600 / 120 / 3600 / 60+3600 s, users 0 and 33)", () => {
        const r = parseUpdateContract(ncUpdate(), NC_SERVICES)
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.contract.prepare).toEqual({ service: 'nextcloud-app', user: '0', command: '/idea/hooks/prep-custom-apps-for-upgrade.sh', timeout: 600 })
        expect(r.contract.verify).toEqual({ service: 'nextcloud-app', user: '33', command: '/idea/hooks/verify-update.sh', timeout: 120 })
        expect(r.contract.work).toEqual({ service: 'nextcloud-app', user: '33', command: '/idea/hooks/work-update.sh', timeout: 3600 })
        expect(r.contract.settle).toEqual({ service: 'nextcloud-app', user: '33', command: '/idea/hooks/settle-update.sh', interval: 60, timeout: 3600 })
        expect(checkUpdate(facts({ xAppUpdate: ncUpdate() }))).toBeNull()
    })

    it('absent, null and {} have no steps (today\'s path)', () => {
        for (const u of [undefined, null, {}]) expect(parseUpdateContract(u, NC_SERVICES)).toEqual({ ok: true, contract: {} })
        expect(checkUpdate(facts({ xAppUpdate: {} }))).toBeNull()
    })

    it('refuses UPDATE_CONTRACT_INVALID before anything stops, for each wrong shape', () => {
        const base = ncUpdate()
        const bad: [string, unknown][] = [
            ['service not in the new compose', { ...base, verify: { ...base.verify, service: 'nextcloud' } }],
            ['service missing', { ...base, work: { command: '/x', timeout: 10 } }],
            ['command not absolute', { ...base, prepare: { ...base.prepare, command: 'idea/hooks/prep.sh' } }],
            ['command with arguments', { ...base, prepare: { ...base.prepare, command: '/idea/hooks/prep.sh --force' } }],
            ['command with ..', { ...base, prepare: { ...base.prepare, command: '/idea/../etc/x' } }],
            ['command as a list', { ...base, prepare: { ...base.prepare, command: ['/bin/sh', '-c', 'x'] } }],
            ['timeout missing', { ...base, verify: { service: 'nextcloud-app', command: '/x' } }],
            ['timeout 0', { ...base, verify: { ...base.verify, timeout: 0 } }],
            ['timeout above 6 h', { ...base, work: { ...base.work, timeout: 6 * 3600 + 1 } }],
            ['timeout as a string', { ...base, work: { ...base.work, timeout: '3600' } }],
            ['timeout not whole', { ...base, work: { ...base.work, timeout: 1.5 } }],
            ['settle interval missing', { ...base, settle: { ...base.settle, interval: undefined } }],
            ['settle interval above timeout', { ...base, settle: { ...base.settle, interval: 4000 } }],
            ['interval on a non-settle step', { ...base, work: { ...base.work, interval: 60 } }],
            ['unknown step field', { ...base, verify: { ...base.verify, env: { A: '1' } } }],
            ['bad user', { ...base, verify: { ...base.verify, user: 'www data' } }],
            ['step not a map', { ...base, verify: '/idea/hooks/verify-update.sh' }],
            ['update not a map', ['prepare']],
        ]
        for (const [why, u] of bad) {
            const e = checkUpdate(facts({ xAppUpdate: u }))
            expect(e?.code, why).toBe('UPDATE_CONTRACT_INVALID')
            expect(e?.message, why).toMatch(/^UPDATE_CONTRACT_INVALID: x-app\.update .*; nothing was stopped or changed$/)
        }
    })

    it('bounds are inclusive: 1 s and 6 h are accepted', () => {
        const base = ncUpdate()
        expect(parseUpdateContract({ verify: { ...base.verify, timeout: 1 }, settle: { ...base.settle, interval: 1, timeout: 21600 } }, NC_SERVICES).ok).toBe(true)
    })

    it('an unknown stage key stays UPDATE_STAGES_UNSUPPORTED', () => {
        const e = checkUpdate(facts({ xAppUpdate: { ...ncUpdate(), migrate: { service: 'nextcloud-app', command: '/x', timeout: 5 } } }))
        expect(e?.code).toBe('UPDATE_STAGES_UNSUPPORTED')
        expect(e?.message).toMatch(/stage migrate/)
    })

    it('staged bundles are offered again (the interim #463 refusal is gone)', () => {
        expect(offerable({ currentAppId: 'nextcloud-1.8-31.0.14', newAppId: 'nextcloud-2.0-32.0.15', sumsValid: true, updatesFrom: [1], xAppUpdate: ncUpdate() })).toBe(true)
    })

    it('UPDATE_STEPS is the agreed 12-step list (Console contract, Pixel)', () => {
        expect(UPDATE_STEPS).toEqual(['Fetch', 'Check', 'Backup', 'Snapshot', 'Swap', 'LoadImages', 'Prepare', 'Start', 'Health', 'Verify', 'Work', 'Settle'])
    })

    it("Kid's fixture tarballs: the old idea_usage tree is max-version 31, the new one 31–32", async () => {
        const info = async (f: string) => (await $`tar -xzOf ${path.join(FIX, f)} --wildcards ${'*/appinfo/info.xml'}`.quiet()).stdout
        expect(await info('idea_usage-v1.0.0-nc31.tar.gz')).toMatch(/<nextcloud min-version="31" max-version="31"\/>/)
        expect(await info('idea_usage-v1.0.0-nc31-32.tar.gz')).toMatch(/<nextcloud min-version="31" max-version="32"\/>/)
        expect(await readComposeServices(path.join(FIX, 'compose-nextcloud-2.0.yaml'))).toEqual(NC_SERVICES)
    })
})

// ── (B) runner against a fake docker CLI ────────────────────────────────────────────────
const FAKE_DOCKER = `#!/usr/bin/env bash
# fake docker for update-runner-456.test.ts; FAKE_DIR holds the argv log and the step pid
echo "$*" >> "$FAKE_DIR/argv"
for a in "$@"; do case "$a" in IDEA_UPDATE_FROM=*|IDEA_UPDATE_TO=*) echo "$a" >> "$FAKE_DIR/env" ;; esac; done
sig=""
case "$*" in *"--signal TERM"*|*"kill -TERM"*) sig=TERM ;; *"--signal KILL"*|*"kill -KILL"*) sig=KILL ;; esac
if [ -n "$sig" ]; then echo "signal $sig" >> "$FAKE_DIR/signals"; kill -"$sig" "$(cat "$FAKE_DIR/pid")" 2>/dev/null; exit 0; fi
case "$1" in container) exit 1 ;; rm) echo "rm $*" >> "$FAKE_DIR/signals"; exit 0 ;; esac
echo $$ > "$FAKE_DIR/pid"
mode=$(cat "$FAKE_DIR/mode")
case "$mode" in
  ok) echo "hop 1.8-31.0.14 -> 2.0-32.0.15"; echo "already at 1.0.0 skip" >&2; exit 0 ;;
  fail) echo "ERROR: early [x]"; echo "more output"; echo "ERROR: status.php unreachable [idea-verify-update]" >&2; echo "trailing"; exit 1 ;;
  notyet) echo "not yet: 2 background jobs pending [idea-settle-update]"; exit 3 ;;
  missing) echo "exec: /idea/hooks/x.sh: not found" >&2; exit 127 ;;
  hang) trap 'echo "ERROR: interrupted by SIGTERM [idea-work-update]"; exit 143' TERM; while :; do sleep 0.05 >/dev/null 2>&1 </dev/null; done ;;
  stubborn) trap '' TERM; while :; do sleep 0.05 >/dev/null 2>&1 </dev/null; done ;;
esac
`

describe('(B) the step runner', () => {
    let dir: string, docker: string
    const ctx = (): StepContext => ({ instanceDir: path.join(dir, 'instances', 'nc1'), project: 'nc1', extraComposeFiles: ['/var/lib/idea/nc1.override.yaml'], fromVersion: '1.8-31.0.14', toVersion: '2.0-32.0.15' })
    const spec = (k: 'prepare' | 'verify' | 'work' | 'settle'): UpdateStepSpec => (parseUpdateContract(ncUpdate(), NC_SERVICES) as any).contract[k]
    const run = async (mode: string, k: 'prepare' | 'verify' | 'work' | 'settle', timeoutS?: number) => {
        await fs.writeFile(path.join(dir, 'mode'), mode)
        return runUpdateStep(k, spec(k), ctx(), timeoutS ? { timeoutS } : {}, { dockerBin: docker, killGraceMs: 300, tmpDir: () => dir })
    }
    const argv = async () => (await fs.readFile(path.join(dir, 'argv'), 'utf8')).trim().split('\n')
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-runner-'))
        process.env.FAKE_DIR = dir
        docker = path.join(dir, 'docker')
        await fs.writeFile(docker, FAKE_DOCKER, { mode: 0o755 })
        await fs.mkdirp(path.join(dir, 'instances', 'nc1'))
    })
    afterEach(async () => { delete process.env.FAKE_DIR; await fs.remove(dir) })

    it('prepare: compose run --rm --no-deps --no-TTY --pull never --user 0, override entrypoint [command], no ports', async () => {
        const r = await run('ok', 'prepare')
        expect(r).toMatchObject({ exitCode: 0, timedOut: false, note: null })
        const lines = await argv()
        const main = lines.find(l => l.includes(' run '))!
        expect(main).toMatch(/^compose -p nc1 -f \S+\/instances\/nc1\/compose\.yaml -f \/var\/lib\/idea\/nc1\.override\.yaml -f \S+\.yaml run --rm --no-deps --no-TTY --pull never --name nc1-idea-update-prepare --user 0 -e IDEA_UPDATE_FROM=1\.8-31\.0\.14 -e IDEA_UPDATE_TO=2\.0-32\.0\.15 nextcloud-app$/)
        expect(main).not.toMatch(/service-ports|--publish|-p \d/)
        expect(YAML.parse(prepareOverride(spec('prepare')))).toEqual({ services: { 'nextcloud-app': { entrypoint: ['/idea/hooks/prep-custom-apps-for-upgrade.sh'], command: [] } } })
        // the generated override is removed again
        expect((await fs.readdir(dir)).filter(f => f.startsWith('idea-update-'))).toEqual([])
        expect(r.lines).toEqual(['hop 1.8-31.0.14 -> 2.0-32.0.15', 'already at 1.0.0 skip'])
    })

    it('verify / work / settle: compose exec -T -u 33 with the pid wrapper; argv ends with exactly [command]', async () => {
        await run('ok', 'verify')
        const a = execArgs('verify', spec('verify'), ctx())
        expect(a.slice(a.indexOf('exec'))).toEqual(['exec', '-T', '-u', '33', '-e', 'IDEA_UPDATE_FROM=1.8-31.0.14', '-e', 'IDEA_UPDATE_TO=2.0-32.0.15',
            'nextcloud-app', 'sh', '-c', EXEC_WRAPPER, 'idea-update-step', '/tmp/.idea-update-verify.pid', '/idea/hooks/verify-update.sh'])
        expect((await argv())[0]).toBe(a.join(' '))
        expect(prepareArgs({ service: 's', command: '/c', timeout: 5 }, ctx(), '/o.yaml')).not.toContain('--user')   // user absent: image default
    })

    it('IDEA_UPDATE_FROM / IDEA_UPDATE_TO are x-app.version values; the Engine adds no other -e', async () => {
        await run('ok', 'work')
        expect((await fs.readFile(path.join(dir, 'env'), 'utf8')).trim().split('\n')).toEqual(['IDEA_UPDATE_FROM=1.8-31.0.14', 'IDEA_UPDATE_TO=2.0-32.0.15'])
        const a = execArgs('work', spec('work'), ctx())
        expect(a.filter(x => x === '-e').length).toBe(2)
    })

    it('the note is the LAST line that starts with ERROR: (stdout and stderr), cut to 200 characters', async () => {
        const r = await run('fail', 'verify')
        expect(r.exitCode).toBe(1)
        expect(r.note).toBe('ERROR: status.php unreachable [idea-verify-update]')
        expect(stepFailureText('verify', spec('verify'), r)).toBe('verify /idea/hooks/verify-update.sh exited 1: ERROR: status.php unreachable [idea-verify-update]')
        expect(stepNote(['  ERROR: indented is not a note', 'x ERROR: nor this'])).toBeNull()
        expect(stepNote([`not yet: ${'x'.repeat(400)}`])!.length).toBe(STEP_NOTE_MAX)
    })

    it('settle exit 3 carries its not yet: line', async () => {
        const r = await run('notyet', 'settle')
        expect(r).toMatchObject({ exitCode: 3, note: 'not yet: 2 background jobs pending [idea-settle-update]' })
    })

    it('126 / 127 read "command not found or not executable in container"', async () => {
        const r = await run('missing', 'verify')
        expect(describeStepRun(r)).toBe('command not found or not executable in container (exit 127)')
        expect(describeStepRun({ exitCode: 126, timedOut: false, durationMs: 1 })).toBe('command not found or not executable in container (exit 126)')
    })

    it('timeout: SIGTERM to the in-container pid; a TERM-safe step ends; logged as "timed out after N s", never "exited N"', async () => {
        const r = await run('hang', 'work', 1)
        expect(r.timedOut).toBe(true)
        expect(r.exitCode).toBeNull()
        expect((await fs.readFile(path.join(dir, 'signals'), 'utf8')).trim().split('\n')).toEqual(['signal TERM'])
        expect(r.note).toBe('ERROR: interrupted by SIGTERM [idea-work-update]')
        expect(stepFailureText('work', spec('work'), r, 1)).toBe('work /idea/hooks/work-update.sh timed out after 1 s: ERROR: interrupted by SIGTERM [idea-work-update]')
        // the signal goes through exec as the same user, by the recorded pid
        expect((await argv()).some(l => /exec -T -u 33 nextcloud-app sh -c p=\$\(cat \/tmp\/\.idea-update-work\.pid/.test(l))).toBe(true)
    }, 20_000)

    it('timeout: a step that ignores TERM gets SIGKILL after the grace; prepare\'s container is removed', async () => {
        const r = await run('stubborn', 'prepare', 1)
        expect(r.timedOut).toBe(true)
        const sig = (await fs.readFile(path.join(dir, 'signals'), 'utf8')).trim().split('\n')
        expect(sig[0]).toBe('signal TERM')
        expect(sig[1]).toBe('signal KILL')
        expect(sig[2]).toMatch(/^rm rm -f nc1-idea-update-prepare$/)
        expect(describeStepRun({ ...r, timeoutS: 1 })).toBe('timed out after 1 s')
    }, 20_000)
})

// ── (C) updateApp end to end with injected Docker ─────────────────────────────────────
const NC_SPECS = () => (parseUpdateContract(ncUpdate(), NC_SERVICES) as any).contract

describe('(C) updateApp with x-app.update', () => {
    let h: DocHandle<Store>, tmp: string, calls: string[], health: string[], msgs: UpdateProgress[]
    /** per step kind, the results to return in order (default: exit 0) */
    let script: Record<string, Partial<StepRun>[]>
    let clock: number

    const ncYaml = (version: string, withUpdate: boolean) => {
        const c = ncCompose()
        c['x-app'].version = version
        c['x-app'].instanceName = 'Old'
        delete c['x-app'].healthCheck
        if (!withUpdate) delete c['x-app'].update
        if (version.startsWith('1.')) delete c['x-app'].updatesFrom
        return YAML.stringify(c)
    }
    const inst = () => h.doc().instanceDB['nc1' as any] as any
    const op = () => Object.values(h.doc().operationDB).filter(o => o.kind === 'updateApp').sort((a, b) => Number(b.startedAt) - Number(a.startedAt))[0]!
    const instDir = () => `${tmp}/instances/nc1`
    const marker = () => fs.pathExists(`${instDir()}/${UPDATE_IN_FLIGHT_FILE}`)
    const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message) } }
    const ok = (): StepRun => ({ exitCode: 0, timedOut: false, note: null, lines: [], durationMs: 5 })

    const deps = (over: Partial<UpdateDeps> = {}): Partial<UpdateDeps> => ({
        helperProblem: async () => null,
        mountRoot: async () => tmp,
        verifySums: async () => true,
        fetch: async () => { throw new Error('no fetch expected') },
        estimate: async () => ({ folderBytes: 1000, volumeBytes: 0, freeBytes: 50 * 1024 ** 3 }),
        dirBytes: async () => 10,
        stop: async () => { calls.push('stop'); h.change(d => { (d.instanceDB['nc1' as any] as any).status = 'Stopped' }) },
        containerIds: async () => [],
        composeDown: async () => { calls.push('down') },
        snapshot: async () => { calls.push('snapshot'); return { path: `${tmp}/.pre-update/nc1`, sizeBytes: 4096, previousQuarantinedAt: null, volumes: [] } },
        restoreSnapshot: async () => {
            calls.push('restore')
            // like restore-snapshot --delete --backup: the folder matches the snapshot again (marker moved aside)
            await fs.writeFile(`${instDir()}/compose.yaml`, ncYaml('1.8-31.0.14', false))
            await fs.remove(`${instDir()}/${UPDATE_IN_FLIGHT_FILE}`)
            return `${tmp}/.idea-quarantine/nc1-before-restore-x`
        },
        backup: async () => { calls.push('backup') },
        listSnapshots: async () => ({ snapshots: [{ instanceId: 'nc1' as any, sizeBytes: 4096, complete: true }], preUpdateBytes: 4096, quarantineBytes: 0 }),
        reread: async () => {
            calls.push('reread')
            const v = YAML.parse(await fs.readFile(`${instDir()}/compose.yaml`, 'utf8'))['x-app'].version
            h.change(d => { (d.instanceDB['nc1' as any] as any).instanceOf = `nextcloud-${v}` })
        },
        start: async (_i, _d, o) => {
            const refusal = await updateInFlightRefusal(instDir(), 'nc1', o?.updateOpId)
            if (refusal) throw new Error(refusal)
            calls.push(`start${o?.imagesLoaded ? ':imagesLoaded' : ''}${o?.updateOpId ? ':owner' : ''}`)
            h.change(d => { (d.instanceDB['nc1' as any] as any).status = 'Running' })
        },
        health: async () => ({ state: (health.shift() ?? 'healthy') as any, restartCount: 0 }),
        probe: async () => ({ status: 200, body: 'ok' }),
        broadcast: (m) => { msgs.push(m) },
        now: () => clock,
        sleep: async (ms) => { clock += ms },
        stopWaitMs: 1000, pollMs: 1,
        tempBackupProblem: async () => null,
        tempBackupEstimate: async () => ({ netBytes: 1024, freeBytes: 50 * 1024 ** 3, sameFilesystem: false }),
        tempBackupCreate: async (_d, id, stamp) => { calls.push('tempCreate'); return { path: `/.idea-temp-backups/${id}/${stamp}`, sizeBytes: 1 } },
        tempBackupDelete: async () => { calls.push('tempDelete') },
        tempBackupRestore: async () => { calls.push('tempRestore'); return 'none' },
        loadImages: async (_dir, _root, strict) => { calls.push(`loadImages${strict ? ':strict' : ''}`) },
        stepComposeFiles: async (_i, _d, writeEnv) => { calls.push(writeEnv ? 'env' : 'files'); return [] },
        runStep: async (kind, spec, ctx, o) => {
            calls.push(kind)
            expect(ctx).toMatchObject({ instanceDir: instDir(), project: 'nc1', fromVersion: '1.8-31.0.14', toVersion: '2.0-32.0.15' })
            if (kind === 'prepare' || kind === 'verify') expect(await marker()).toBe(true)
            if (kind === 'work' || kind === 'settle') expect(await marker()).toBe(false)
            if (kind === 'settle') expect(o?.timeoutS).toBeLessThanOrEqual(spec.timeout)
            const next = script[kind]?.shift()
            clock += 1000
            return { ...ok(), ...(next ?? {}) }
        },
        ...over,
    })

    beforeEach(async () => {
        calls = []; health = []; msgs = []; script = {}; clock = 1_700_000_000_000
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-456r-'))
        await fs.outputFile(`${instDir()}/compose.yaml`, ncYaml('1.8-31.0.14', false))
        await fs.outputFile(`${instDir()}/.env`, 'port=50001\n')
        await fs.outputFile(`${tmp}/apps/nextcloud-2.0-32.0.15/compose.yaml`, ncYaml('2.0-32.0.15', true))
        await fs.outputFile(`${tmp}/apps/nextcloud-1.9-31.0.15/compose.yaml`, ncYaml('1.9-31.0.15', false))
        h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, localEngineId)
        h.change(doc => {
            doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
            doc.instanceDB['nc1' as any] = {
                id: 'nc1', name: 'Old', storedOn: 'd1', instanceOf: 'nextcloud-1.8-31.0.14', status: 'Running',
                port: 50001, lastBackup: null, statusCondition: null,
            } as any
        })
    })
    afterEach(async () => { await fs.remove(tmp) })
    const update = (over: Partial<UpdateDeps> = {}, target = 'nextcloud-2.0-32.0.15', o: { allowMajor?: boolean, sourceDiskId?: string } = { allowMajor: true }) =>
        updateApp(h, 'nc1', target, ME, o, deps(over))

    it('full success: the 12-step order, marker from Swap to verify, temp backup deleted only after settle, updatePending cleared', async () => {
        const r = await update()
        expect(r.steps).toEqual(['Fetch', 'Check', 'Snapshot', 'Swap', 'LoadImages', 'Prepare', 'Start', 'Health', 'Verify', 'Work', 'Settle'])
        expect(calls).toEqual(['stop', 'tempCreate', 'snapshot', 'reread', 'loadImages:strict', 'env', 'prepare', 'start:imagesLoaded:owner',
            'files', 'verify', 'files', 'work', 'files', 'settle', 'tempDelete'])
        expect(await marker()).toBe(false)
        expect(inst().updatePending).toBeUndefined()
        expect(inst().instanceOf).toBe('nextcloud-2.0-32.0.15')
        expect(inst().previousAppId).toBe('nextcloud-1.8-31.0.14')
        expect(op().status).toBe('Done')
        expect(op().args).toMatchObject({ committed: 'true', fromVersion: '1.8-31.0.14', toVersion: '2.0-32.0.15', tempBackupState: 'deleted' })
        // a settled op clears its step fields (Operation.ts), so the order is read from the broadcasts
        expect(UPDATE_STEPS).toHaveLength(12)
        const seen = msgs.map(m => m.step)
        const idx = seen.map(st => UPDATE_STEPS.indexOf(st))
        expect(idx.every((v, i) => v >= 0 && (i === 0 || v >= idx[i - 1]))).toBe(true)
        expect(seen.indexOf('Backup')).toBeLessThan(seen.indexOf('Snapshot'))
        expect(r.tempBackup?.deleted).toBe(true)
    })

    it('an App without x-app.update keeps today\'s path: no marker, no steps, LoadImages not strict', async () => {
        h.change(d => { (d.instanceDB['nc1' as any] as any).lastBackup = clock })
        const r = await update({}, 'nextcloud-1.9-31.0.15', {})
        expect(r.steps).toEqual(['Fetch', 'Check', 'Snapshot', 'Swap', 'LoadImages', 'Start', 'Health'])
        expect(calls).toEqual(['stop', 'snapshot', 'reread', 'loadImages', 'start:imagesLoaded'])
        expect(inst().updatePending).toBeUndefined()
        expect(op().status).toBe('Done')
    })

    it('prepare fails: PREPARE_FAILED, snapshot restored, old version restarted (ROLLED BACK); marker gone; temp backup kept', async () => {
        script.prepare = [{ exitCode: 1, note: 'ERROR: sha256 mismatch for richdocuments [idea-prep]' }]
        const m = await codeOf(update())
        expect(m).toMatch(/^ROLLED BACK: Prepare failed: PREPARE_FAILED: prepare \/idea\/hooks\/prep-custom-apps-for-upgrade\.sh exited 1: ERROR: sha256 mismatch for richdocuments \[idea-prep\]\. nextcloud-1\.8-31\.0\.14 and its data were restored from .*; the temporary pre-update backup is kept at /)
        expect(calls).not.toContain('verify')
        expect(calls.slice(-4)).toEqual(['down', 'restore', 'reread', 'start:owner'])
        expect(inst().instanceOf).toBe('nextcloud-1.8-31.0.14')
        expect(await marker()).toBe(false)
        expect(op().args).toMatchObject({ phaseNote: 'ERROR: sha256 mismatch for richdocuments [idea-prep]', tempBackupState: 'kept' })
        expect(op().args.committed).toBeUndefined()
        expect(msgs.some(x => x.phaseNote === 'ERROR: sha256 mismatch for richdocuments [idea-prep]')).toBe(true)
    })

    it('LoadImages fails (missing / stale image): PREPARE_FAILED and a rollback, never a pull', async () => {
        const m = await codeOf(update({ loadImages: async () => { throw new Error('Service image nextcloud:32.0.15-apache@sha256:db18 is not present') } }))
        expect(m).toMatch(/^ROLLED BACK: LoadImages failed: PREPARE_FAILED: the service images could not be loaded from the disk: Service image .* is not present\. /)
        expect(calls).not.toContain('prepare')
        expect(calls).toContain('restore')
    })

    it('a prepare timeout is reported as "timed out after N s" and rolls back', async () => {
        script.prepare = [{ exitCode: null, timedOut: true }]
        expect(await codeOf(update())).toMatch(/^ROLLED BACK: Prepare failed: PREPARE_FAILED: prepare \S+ timed out after 600 s\./)
    })

    it('Health fails: verify never runs; rollback as today', async () => {
        health = ['exited']
        expect(await codeOf(update())).toMatch(/^ROLLED BACK: Health failed/)
        expect(calls).not.toContain('verify')
        expect(calls).toContain('restore')
    })

    it('verify fails: VERIFY_FAILED, rollback; no point of no return', async () => {
        script.verify = [{ exitCode: 1, note: 'ERROR: richdocuments not enabled [idea-verify-update]' }]
        const m = await codeOf(update())
        expect(m).toMatch(/^ROLLED BACK: Verify failed: VERIFY_FAILED: verify \/idea\/hooks\/verify-update\.sh exited 1: ERROR: richdocuments not enabled/)
        expect(calls).not.toContain('work')
        expect(inst().updatePending).toBeUndefined()
        expect(inst().previousAppId).toBeUndefined()
    })

    it('ROLLBACK_START_FAILED: data restored but the old version does not start → Stopped, "ROLLBACK START FAILED:"', async () => {
        script.verify = [{ exitCode: 1 }]
        let starts = 0
        const m = await codeOf(update({
            start: async () => { starts++; h.change(d => { const i = d.instanceDB['nc1' as any] as any; i.status = starts === 1 ? 'Running' : 'Error'; if (starts > 1) i.statusCondition = 'PORT_NOT_READY: no answer' }) },
        }))
        expect(m.startsWith(`${ROLLBACK_START_FAILED_PREFIX} Verify failed: VERIFY_FAILED: `)).toBe(true)
        expect(m).toMatch(/nextcloud-1\.8-31\.0\.14 and its data were restored from .*; the old version did not start: PORT_NOT_READY: no answer/)
        expect(inst().status).toBe('Stopped')
        expect(inst().statusCondition.startsWith(ROLLBACK_START_FAILED_PREFIX)).toBe(true)
        expect(op().status).toBe('Failed')
    })

    it('work fails: MIGRATIONS_PENDING, no rollback, App Running on the new major, updatePending set, temp backup kept', async () => {
        script.work = [{ exitCode: 1, note: 'ERROR: occ db:add-missing-indices failed [idea-work-update]' }]
        const m = await codeOf(update())
        expect(m).toMatch(/^MIGRATIONS_PENDING: work \/idea\/hooks\/work-update\.sh exited 1: ERROR: occ db:add-missing-indices failed \[idea-work-update\]; nextcloud-2\.0-32\.0\.15 keeps running; send updateApp nc1 nextcloud-2\.0-32\.0\.15 to finish the update; the temporary pre-update backup is kept at /)
        expect(calls).not.toContain('restore')
        expect(calls).not.toContain('settle')
        expect(calls).not.toContain('tempDelete')
        expect(inst()).toMatchObject({ status: 'Running', updatePending: true, instanceOf: 'nextcloud-2.0-32.0.15', previousAppId: 'nextcloud-1.8-31.0.14' })
        // the only offer while pending is Resume (same version), never the next major
        expect(inst().updateAvailable).toEqual({ appId: 'nextcloud-2.0-32.0.15', fromVersion: '2.0-32.0.15', toVersion: '2.0-32.0.15', major: false })
        expect(op()).toMatchObject({ status: 'Failed' })
        expect(op().error).toBe(m)
        expect(op().args.tempBackupState).toBe('kept')
    })

    it('work exits 3 (not yet after 3 cron runs) or times out: MIGRATIONS_PENDING', async () => {
        script.work = [{ exitCode: null, timedOut: true }]
        expect(await codeOf(update())).toMatch(/^MIGRATIONS_PENDING: work \S+ timed out after 3600 s; /)
    })

    it('settle: exit 3 every interval until its timeout → MIGRATIONS_PENDING with the not yet: note', async () => {
        script.settle = Array.from({ length: 200 }, () => ({ exitCode: 3, note: 'not yet: 4 background jobs pending [idea-settle-update]' }))
        const m = await codeOf(update())
        expect(m).toMatch(/^MIGRATIONS_PENDING: settle \/idea\/hooks\/settle-update\.sh still reported not yet after 3600 s \(\d+ runs\): not yet: 4 background jobs pending/)
        const runs = calls.filter(c => c === 'settle').length
        expect(runs).toBeGreaterThan(30)        // every 60 s within 3600 s
        expect(runs).toBeLessThanOrEqual(60)
        expect(inst().updatePending).toBe(true)
        expect(op().args.phaseNote).toBe('not yet: 4 background jobs pending [idea-settle-update]')
    })

    it('settle: exit 3 then 0 → Done, updatePending cleared', async () => {
        script.settle = [{ exitCode: 3, note: 'not yet: 1 job' }, { exitCode: 3 }, { exitCode: 0 }]
        await update()
        expect(calls.filter(c => c === 'settle').length).toBe(3)
        expect(op().status).toBe('Done')
        expect(inst().updatePending).toBeUndefined()
    })

    it('settle: any other exit → SETTLE_FAILED, no rollback, App Running, updatePending kept', async () => {
        script.settle = [{ exitCode: 2, note: 'ERROR: status.php unreachable [idea-settle-update]' }]
        const m = await codeOf(update())
        expect(m).toMatch(/^SETTLE_FAILED: settle \S+ exited 2: ERROR: status\.php unreachable \[idea-settle-update\]; nextcloud-2\.0-32\.0\.15 keeps running; /)
        expect(calls).not.toContain('restore')
        expect(inst()).toMatchObject({ status: 'Running', updatePending: true })
    })

    it('while updatePending: another version is refused UPDATE_PENDING; offers show only Resume', async () => {
        script.work = [{ exitCode: 1 }]
        await codeOf(update())
        await fs.outputFile(`${tmp}/apps/nextcloud-3.0-33.0.11/compose.yaml`, ncYaml('3.0-33.0.11', true).replace('updatesFrom:\n    - 1', 'updatesFrom:\n    - 2'))
        calls = []
        const m = await codeOf(update({}, 'nextcloud-3.0-33.0.11'))
        expect(m).toMatch(/^UPDATE_PENDING: finish the current update first/)
        expect(await codeOf(update({}, 'nextcloud-2.0-32.0.15', { allowMajor: true }))).toMatch(/^UPDATE_PENDING: finish the current update first/)
        expect(await codeOf(update({}, 'nextcloud-2.0-32.0.15', { sourceDiskId: 'd1' }))).toMatch(/^UPDATE_PENDING: /)
        expect(calls).toEqual([])
        const SUM = 'a'.repeat(64) + '  compose.yaml\n'
        await refreshUpdateAvailable(h, ME, { mountRoot: async () => tmp, readSums: async () => SUM, dataBytes: async () => 1 })
        expect(inst().updateAvailable).toEqual({ appId: 'nextcloud-2.0-32.0.15', fromVersion: '2.0-32.0.15', toVersion: '2.0-32.0.15', major: false })
    })

    it('Resume: plain updateApp <id> <current version> runs only work and settle, then clears updatePending and deletes the temp backup', async () => {
        script.work = [{ exitCode: 1 }]
        await codeOf(update())
        const first = op()
        calls = []
        const r = await updateApp(h, 'nc1', '2.0-32.0.15', ME, {}, deps())
        expect(r.resumed).toBe(true)
        expect(r.steps).toEqual(['Work', 'Settle'])
        expect(calls).toEqual(['files', 'work', 'files', 'settle', 'tempDelete'])
        expect(inst().updatePending).toBeUndefined()
        const resumed = op()
        expect(resumed.id).not.toBe(first.id)
        expect(resumed.args).toMatchObject({ resume: 'true', resumeOf: first.id, committed: 'true', fromVersion: '1.8-31.0.14', toVersion: '2.0-32.0.15', tempBackupState: 'deleted' })
        expect(h.doc().operationDB[first.id].args.tempBackupState).toBe('deleted')
        expect(resumed.status).toBe('Done')
        // once settled, the plain form is an ordinary NOT_NEWER again
        expect(await codeOf(updateApp(h, 'nc1', 'nextcloud-2.0-32.0.15', ME, {}, deps()))).toMatch(/^NOT_NEWER/)
    })

    it('Resume while the App is not running is refused, nothing runs', async () => {
        script.work = [{ exitCode: 1 }]
        await codeOf(update())
        h.change(d => { (d.instanceDB['nc1' as any] as any).status = 'Stopped' })
        calls = []
        expect(await codeOf(updateApp(h, 'nc1', 'nextcloud-2.0-32.0.15', ME, {}, deps()))).toMatch(/^UPDATE_PENDING: nextcloud-2\.0-32\.0\.15 is Stopped; start it, then send updateApp nc1 nextcloud-2\.0-32\.0\.15 again/)
        expect(calls).toEqual([])
    })

    it('the update-in-flight marker blocks any other start of the folder (another Engine after a crash) until recovery', async () => {
        await writeUpdateInFlight(instDir(), 'op-x', 'engine-a')
        expect(await updateInFlightRefusal(instDir(), 'nc1')).toBe('UPDATE_IN_FLIGHT: instances/nc1 is in the middle of an update (operation op-x of Engine engine-a); it is not started until that Engine recovers it (engine#456)')
        expect(await updateInFlightRefusal(instDir(), 'nc1', 'op-y')).toMatch(/^UPDATE_IN_FLIGHT/)
        expect(await updateInFlightRefusal(instDir(), 'nc1', 'op-x')).toBeNull()
        expect(await clearUpdateInFlight(instDir(), 'op-y')).toBe(false)     // another op's marker stays
        expect(await marker()).toBe(true)
        expect(await clearUpdateInFlight(instDir(), 'op-x')).toBe(true)
        expect(await updateInFlightRefusal(instDir(), 'nc1')).toBeNull()
    })

    it('boot recovery before the point of no return (crash in prepare): rolled back, marker gone', async () => {
        const opId = createOperation(h, 'updateApp', { instanceId: 'nc1', diskId: 'd1', fromAppId: 'nextcloud-1.8-31.0.14', toAppId: 'nextcloud-2.0-32.0.15' }, 'console-command', { type: 'instance', id: 'nc1' as any })
        updateOperation(h, opId, { status: 'Running', currentStep: UPDATE_STEPS.indexOf('Prepare'), totalSteps: 12, stepLabel: 'Prepare' })
        await fs.writeFile(`${instDir()}/compose.yaml`, ncYaml('2.0-32.0.15', true))
        await writeUpdateInFlight(instDir(), opId, ME)
        const out = await recoverInterruptedUpdates(h, ME, deps())
        expect(out[0]).toMatch(/^nc1: ROLLED BACK: Prepare failed: the Engine restarted during the update\. nextcloud-1\.8-31\.0\.14 and its data were restored/)
        expect(calls).toContain('restore')
        expect(await marker()).toBe(false)
        expect(h.doc().operationDB[opId].error).toMatch(/^INTERRUPTED: ROLLED BACK:/)
    })

    it('boot recovery after the point of no return (crash in work): never rolled back; MIGRATIONS_PENDING; queued command dropped', async () => {
        const opId = createOperation(h, 'updateApp', { instanceId: 'nc1', diskId: 'd1', fromAppId: 'nextcloud-1.8-31.0.14', toAppId: 'nextcloud-2.0-32.0.15', committed: 'true', tempBackup: '/.idea-temp-backups/nc1/s1', tempBackupStamp: 's1', tempBackupState: 'created' }, 'console-command', { type: 'instance', id: 'nc1' as any })
        updateOperation(h, opId, { status: 'Running', currentStep: UPDATE_STEPS.indexOf('Work'), totalSteps: 12, stepLabel: 'Work' })
        h.change(d => { (d.instanceDB['nc1' as any] as any).instanceOf = 'nextcloud-2.0-32.0.15'; (d.engineDB[ME as any] as any).commands = ['updateApp nc1 nextcloud-2.0-32.0.15 --allow-major'] })
        await fs.writeFile(`${instDir()}/compose.yaml`, ncYaml('2.0-32.0.15', true))
        const out = await recoverInterruptedUpdates(h, ME, deps())
        expect(out[0]).toMatch(/^nc1: MIGRATIONS_PENDING: the Engine restarted during Work, after verify passed \(interrupted\); nextcloud-2\.0-32\.0\.15 starts normally; send updateApp nc1 nextcloud-2\.0-32\.0\.15 to finish the update; the temporary pre-update backup is kept at \/\.idea-temp-backups\/nc1\/s1$/)
        expect(calls).not.toContain('restore')
        expect(calls).not.toContain('tempDelete')
        expect(inst().updatePending).toBe(true)
        expect(h.doc().operationDB[opId]).toMatchObject({ status: 'Failed' })
        expect(h.doc().operationDB[opId].args.tempBackupState).toBe('kept')
        expect([...((h.doc().engineDB[ME as any] as any).commands ?? [])]).toEqual([])
    })

    it('legacy 6-step operations (written before #456) are still read with the old indices at boot', async () => {
        const opId = createOperation(h, 'updateApp', { instanceId: 'nc1', diskId: 'd1', fromAppId: 'nextcloud-1.8-31.0.14', toAppId: 'nextcloud-1.9-31.0.15' }, 'console-command', { type: 'instance', id: 'nc1' as any })
        updateOperation(h, opId, { status: 'Running', currentStep: 4, totalSteps: 6, stepLabel: 'Start' })
        const out = await recoverInterruptedUpdates(h, ME, deps())
        expect(out[0]).toMatch(/^nc1: ROLLED BACK: Start failed: /)
    })

    it('UpdateAppError keeps the console#168 prefixes and adds ROLLBACK START FAILED:', () => {
        expect(new UpdateAppError('ROLLBACK_START_FAILED', 'x').message).toBe('ROLLBACK START FAILED: x')
        expect(new UpdateAppError('MIGRATIONS_PENDING', 'x').message).toBe('MIGRATIONS_PENDING: x')
        expect(new UpdateAppError('SETTLE_FAILED', 'x').message).toBe('SETTLE_FAILED: x')
    })
})
