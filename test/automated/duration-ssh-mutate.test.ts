/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * r66 FAIL@60: a mutating stage2-dock undock to idea03 got "Connection reset by 100.126.117.80 port 22"
 * after the Engine ejects. r67: warm ControlMaster + start gate; retry only provable pre-start failures;
 * a drop after the start is decided read-only (verify), never re-run blind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sshMutate, gatedRemote, GATE_TOKEN, GATE_NO_GO_EXIT, failedBeforeStart, type GatedResult, type MutateIo } from '../duration/sshMutate.js'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { Stage2FleetOps } from '../duration/stage2FleetOps.js'
import { withSshRetry, sshRetryPolicy } from '../duration/sshRetry.js'

const RESET = 'Connection reset by 100.126.117.80 port 22\r\n'
const ok = (stdout = '{"ok":true}'): GatedResult => ({ code: 0, stdout: `${GATE_TOKEN}\n${stdout}`, stderr: '', sentGo: true })
const resetAfterGo: GatedResult = { code: 255, stdout: `${GATE_TOKEN}\n`, stderr: RESET, sentGo: true }
const resetBeforeGo: GatedResult = { code: 255, stdout: '', stderr: RESET, sentGo: false }
const io = (results: GatedResult[]) => {
    let t = 0
    const runs: string[] = []
    const logs: string[] = []
    const m: MutateIo & { runs: string[]; logs: string[]; masters: number } = {
        runs, logs, masters: 0,
        ensureMaster: async () => { m.masters++ },
        runGated: async (_h, g) => { runs.push(g); const r = results.shift(); if (!r) throw new Error('unexpected extra run'); return r },
        sleep: async ms => { t += ms }, now: () => t, log: l => logs.push(l), env: {},
    }
    return m
}

describe('sshMutate (pure)', () => {
    it('gate: the command runs only after GO; stdin closed for the command', () => {
        const g = gatedRemote('sudo stage2-dock.sh undock --disk x', 60)
        expect(g).toMatch(new RegExp(`^printf '%s\\\\n' ${GATE_TOKEN}; IFS= read -r -t 60 g; \\[ "\\$g" = GO \\] \\|\\| exit ${GATE_NO_GO_EXIT}; \\( sudo stage2-dock\\.sh undock --disk x \\) </dev/null$`))
    })
    it('r66 replay: reset AFTER the command started → verify shows done → continue, NO second run', async () => {
        const m = io([resetAfterGo])
        const verify = vi.fn(async () => 'done' as const)
        const r = await sshMutate('100.126.117.80', 'undock', { verb: 'stage2-dock undock duration-kolibri-grade5a-001', idempotent: true, verify }, m)
        expect(r).toMatchObject({ recoveredByVerify: true, reissued: false })
        expect(m.runs).toHaveLength(1)
        expect(verify).toHaveBeenCalledTimes(1)
        expect(m.logs.some(l => /"event":"ssh_mutate_recovered".*"how":"recovered-by-verify"/.test(l))).toBe(true)
    })
    it('reset BEFORE the command started (no GO sent / remote exit 97) → retried, then runs once', async () => {
        const m = io([resetBeforeGo, { code: GATE_NO_GO_EXIT, stdout: GATE_TOKEN, stderr: '', sentGo: true }, ok('{"ok":true,"x":1}')])
        const r = await sshMutate('h', 'undock', { verb: 'undock', idempotent: false }, m)
        expect(r).toMatchObject({ stdout: '{"ok":true,"x":1}', recoveredByVerify: false, preStartRetries: 2 })
        expect(m.runs).toHaveLength(3)
        expect(m.logs.filter(l => /"event":"ssh_mutate_retry".*"before_start":true/.test(l))).toHaveLength(2)
        expect(failedBeforeStart(resetBeforeGo)).toBe(true)
        expect(failedBeforeStart(resetAfterGo)).toBe(false)
    })
    it('pre-start failures past the deadline → fail, and the command was NOT run', async () => {
        const m = io(Array.from({ length: 100 }, () => resetBeforeGo))
        m.env = { DURATION_SSH_RETRY_DEADLINE_MS: '60000' }
        await expect(sshMutate('h', 'undock', { verb: 'undock', idempotent: true }, m)).rejects.toThrow(/never reached the command start .*NOT run/)
    })
    it('verify not done → fails loud, never re-run (single-shot, any verb)', async () => {
        for (const idempotent of [false, true]) {
            const m = io([resetAfterGo])
            await expect(sshMutate('h', 'undock', { verb: 'stage2-dock undock', idempotent, verify: async () => 'not_done' }, m))
                .rejects.toThrow(/dropped after the command may have started .*status re-check says not_done\. Single-shot: not re-run/)
            expect(m.runs).toHaveLength(1)
        }
    })
    it('no verify (unknown) → fails loud', async () => {
        const m = io([resetAfterGo])
        await expect(sshMutate('h', 'import', { verb: 'import', idempotent: false }, m)).rejects.toThrow(/status re-check says unknown/)
    })
    it('a remote command that ran and exited non-zero is never retried', async () => {
        const m = io([{ code: 3, stdout: GATE_TOKEN, stderr: 'partx: failed', sentGo: true }])
        await expect(sshMutate('h', 'undock', { verb: 'undock', idempotent: true, verify: async () => 'not_done' }, m)).rejects.toThrow(/remote exit 3: partx: failed/)
        expect(m.runs).toHaveLength(1)
    })
})

describe('RealFleetOps ControlMaster', () => {
    const fleet = (checkCodes: number[]) => {
        const f = Object.create(RealFleetOps.prototype) as any
        const calls: string[][] = []
        Object.assign(f, {
            sshUser: 'pi', masterStats: { started: 0, reused: 0 },
            runLocal: vi.fn(async (_c: string, args: string[]) => {
                calls.push(args)
                if (args.includes('-O')) return { code: checkCodes.shift() ?? 0, stdout: '', stderr: '', timedOut: false }
                return { code: 0, stdout: '', stderr: '', timedOut: false }
            }),
        })
        return { f, calls }
    }
    beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
    afterEach(() => vi.restoreAllMocks())
    it('first call starts a master (-fN ControlMaster=yes, ControlPersist); later calls reuse it (-O check ok)', async () => {
        const { f, calls } = fleet([255, 0, 0])
        await f.ensureMaster('100.126.117.80')
        await f.ensureMaster('100.126.117.80')
        await f.ensureMaster('100.126.117.80')
        expect(f.masterStats).toEqual({ started: 1, reused: 2 })
        const start = calls.find(a => a.includes('-fN'))!
        expect(start).toEqual(expect.arrayContaining(['ControlMaster=yes', 'ControlPersist=600', 'pi@100.126.117.80']))
        expect(start.some(a => a.startsWith('ControlPath='))).toBe(true)
        expect(calls.filter(a => a.includes('-fN'))).toHaveLength(1)
    })
})

describe('Stage2FleetOps wiring', () => {
    const s2 = () => {
        const f = Object.create(Stage2FleetOps.prototype) as any
        Object.assign(f, {
            dockScript: '/home/pi/idea/stage2-dock.sh', dockLog: [], ssdOffline: new Set(), s2host: () => '100.126.117.80',
            sshMutate: vi.fn(async () => ({ stdout: '', recoveredByVerify: true, reissued: false, preStartRetries: 0 })),
            sshRead: vi.fn(async () => '{"ok":true}'), ssh: vi.fn(async () => { throw new Error('plain ssh must not be used for verbs') }),
        })
        return f
    }
    it('r66 replay at the Stage 2 layer: undock recovered-by-verify returns ok, logged in dockLog; status stays a retried read', async () => {
        const f = s2()
        const r = await f['rawCall']('idea03', 'undock', { diskId: 'duration-nextcloud-grade5a-001' })
        expect(r).toMatchObject({ ok: true, recoveredByVerify: true })
        expect(f.sshMutate).toHaveBeenCalledTimes(1)
        expect(f.dockLog.join()).toMatch(/undock duration-nextcloud-grade5a-001 recovered-by-verify/)
        await f['rawCall']('idea03', 'status', {})
        expect(f.sshRead).toHaveBeenCalled()
        expect(f.ssh).not.toHaveBeenCalled()
    })
    it('mutate specs: undock/dock/eject-ssd/dock-ssd idempotent with verify; reset/export/import/yank not', () => {
        const f = s2()
        for (const v of ['undock', 'dock', 'eject-ssd', 'dock-ssd'] as const) {
            const sp = f.stage2MutateSpec('idea03', v, { diskId: 'duration-nextcloud-grade5a-001' })
            expect(sp.idempotent).toBe(true); expect(typeof sp.verify).toBe('function')
        }
        for (const v of ['reset', 'export', 'import', 'yank'] as const) {
            const sp = f.stage2MutateSpec('idea03', v, { diskId: 'duration-nextcloud-grade5a-001' })
            expect(sp.idempotent).toBe(false); expect(sp.verify).toBeUndefined()
        }
    })
    it('undock verify reads stage2-dock status: partition gone → done, present → not_done', async () => {
        const f = s2()
        f.stage2Status = vi.fn(async () => ({ fixtures: [] }))
        f.partitionWith = vi.fn(() => undefined)
        expect(await f.stage2MutateSpec('idea03', 'undock', { diskId: 'duration-nextcloud-grade5a-001' }).verify!()).toBe('done')
        f.partitionWith = vi.fn(() => ({ present: true }))
        expect(await f.stage2MutateSpec('idea03', 'undock', { diskId: 'duration-nextcloud-grade5a-001' }).verify!()).toBe('not_done')
    })
})

describe('r62-style read retries unchanged', () => {
    it('one reset then success → passes with one logged retry', async () => {
        let n = 0
        const logs: string[] = []
        const out = await withSshRetry('100.126.117.80', 'verifySidecarOwner', async () => {
            if (n++ === 0) throw Object.assign(new Error('reset'), { exitCode: 255, stderr: RESET })
            return 'ok'
        }, sshRetryPolicy({}), { sleep: async () => {}, log: l => logs.push(l) })
        expect(out).toBe('ok')
        expect(logs.filter(l => /"event":"ssh_retry"/.test(l))).toHaveLength(1)
    })
    it('a killed read attempt counts as a transport failure (r66 @39: 903 s hang)', async () => {
        const f = Object.create(RealFleetOps.prototype) as any
        Object.assign(f, { sshUser: 'pi' })
        // 10.255.255.1 never answers; ConnectTimeout=10 > the 300 ms attempt limit → killed → exit 255 "Timeout … not responding".
        await expect(f.sshOnce('10.255.255.1', 'true', 300)).rejects.toMatchObject({ exitCode: 255, stderr: expect.stringMatching(/Timeout, server 10\.255\.255\.1 not responding \(walker killed the ssh process group after 300ms\)/) })
    })
})
