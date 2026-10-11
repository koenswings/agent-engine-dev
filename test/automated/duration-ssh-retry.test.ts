/**
 * r62 FAIL@32 (browse_folders): the read-only post-step verifySidecarOwner ssh to idea03 got
 * "Connection reset by 100.126.117.80 port 22" (exit 255) once; RealFleetOps.ssh had no retry.
 * r63: read-only probes (sshRead) retry TRANSPORT failures only, with logged backoff and a hard budget;
 * mutating calls are never auto-retried; a remote non-zero exit is never retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    backoffFor, isSshTransportFailure, sshRetryPolicy, sshStderrLine, withSshRetry,
} from '../duration/sshRetry.js'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { Stage2FleetOps } from '../duration/stage2FleetOps.js'

const HOSTS = { idea01: '10.0.0.1', idea03: '100.126.117.80', idea04: '10.0.0.4' }
const fail = (exitCode: number, stderr: string) => Object.assign(new Error(`exit code: ${exitCode}`), { exitCode, stderr })
const R62 = fail(255, "Warning: Permanently added '100.126.117.80' (ED25519) to the list of known hosts.\r\nConnection reset by 100.126.117.80 port 22\r\n")
/** The r62 NC owner probe output (bridge publish :61820). */
const NC_OWNER = '@@C nextcloud-grade5a-001-nextcloud-app-1 nextcloud_backend\n@@P nextcloud-grade5a-001-nextcloud-app-1 80/tcp -> 0.0.0.0:61820\n@@L LISTEN 0 4096 0.0.0.0:61820 0.0.0.0:* users:(("docker-proxy",pid=12575,fd=7))'

const withOnce = <T extends RealFleetOps>(o: T, seq: (Error | string)[]) => {
    const calls: { host: string; cmd: string }[] = []
    ;(o as unknown as { sshOnce: (h: string, c: string) => Promise<string> }).sshOnce = async (host, cmd) => {
        calls.push({ host, cmd })
        const next = seq.length > 1 ? seq.shift()! : seq[0]!
        if (next instanceof Error) throw next
        return next
    }
    return calls
}
let logs: string[] = []
beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => { logs.push(String(l)) })
    process.env.DURATION_SSH_RETRY_BACKOFF_MS = '1,1,1'
    process.env.DURATION_SSH_RETRY_DEADLINE_MS = '40'
})
afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.DURATION_SSH_RETRY_BACKOFF_MS
    delete process.env.DURATION_SSH_RETRY_DEADLINE_MS
})

describe('transport classification', () => {
    it('exit 255 + reset/refused/closed/timed out/kex/Broken pipe/resolve → transport; stderr line skips the known-hosts warning', () => {
        expect(isSshTransportFailure(R62)).toBe(true)
        expect(sshStderrLine(R62)).toBe('Connection reset by 100.126.117.80 port 22')
        for (const s of ['ssh: connect to host 1.2.3.4 port 22: Connection refused', 'Connection closed by 1.2.3.4 port 22',
            'ssh: connect to host x port 22: Connection timed out', 'kex_exchange_identification: read: Connection reset by peer',
            'client_loop: send disconnect: Broken pipe', 'ssh: Could not resolve hostname idea03: Name or service not known']) {
            expect(isSshTransportFailure(fail(255, s))).toBe(true)
        }
    })
    it('a remote command that ran and failed is NOT transport (non-255, or 255 without a transport stderr)', () => {
        expect(isSshTransportFailure(fail(1, 'Connection reset by peer'))).toBe(false) // remote's own exit code
        expect(isSshTransportFailure(fail(2, ''))).toBe(false)
        expect(isSshTransportFailure(fail(255, 'stage2-dock: refused'))).toBe(false)
        expect(isSshTransportFailure(new Error('boom'))).toBe(false)
    })
})

describe('policy and backoff timing (r62: ~6 min relay outage → 8 min deadline)', () => {
    it('defaults: 2/4/8/16/30 s capped at 30 s, deadline 480 s; env overrides', () => {
        delete process.env.DURATION_SSH_RETRY_BACKOFF_MS
        const d = sshRetryPolicy({})
        expect(d).toEqual({ deadlineMs: 480_000, backoffMs: [2000, 4000, 8000, 16000, 30000], capMs: 30_000 })
        expect([0, 1, 2, 3, 4, 5, 9].map(i => backoffFor(d, i))).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000])
        const p = sshRetryPolicy({ DURATION_SSH_RETRY_DEADLINE_MS: '60000', DURATION_SSH_RETRY_BACKOFF_MS: '100, 300, 90000', DURATION_SSH_RETRY_CAP_MS: '500' })
        expect(p.deadlineMs).toBe(60_000)
        expect([0, 1, 2, 3].map(i => backoffFor(p, i))).toEqual([100, 300, 500, 500])
    })
    it('rides out a 6-minute outage (r62 22:37:50–22:43:51): backoff 2,4,8,16,30,30… and success with elapsed logged', async () => {
        let t = 0
        const sleeps: number[] = [], log: string[] = []
        const outageEnd = 361_000
        const out = await withSshRetry('100.126.117.80', 'probe', async () => { t += 1000; if (t < outageEnd) throw R62; return 'ok' },
            sshRetryPolicy({}), { sleep: async ms => { sleeps.push(ms); t += ms }, log: l => log.push(l), now: () => t })
        expect(out).toBe('ok')
        expect(sleeps.slice(0, 6)).toEqual([2000, 4000, 8000, 16000, 30000, 30000])
        expect(sleeps.every(s => s <= 30_000)).toBe(true)
        const ev = log.map(l => JSON.parse(l))
        expect(ev.at(-1)).toMatchObject({ event: 'ssh_retry_ok', host: '100.126.117.80' })
        expect(ev[0]).toMatchObject({ event: 'ssh_retry', attempt: 1, elapsed_ms: 1000, next_in_ms: 2000, stderr: 'Connection reset by 100.126.117.80 port 22' })
        expect(ev.at(-1).elapsed_ms).toBeLessThan(480_000)
    })
    it('an outage longer than the deadline fails, no attempt starts past 480 s, all attempts listed', async () => {
        let t = 0
        const log: string[] = []
        await expect(withSshRetry('h', 'probe', async () => { t += 1000; throw R62 }, sshRetryPolicy({}),
            { sleep: async ms => { t += ms }, log: l => log.push(l), now: () => t }))
            .rejects.toThrow(/transport failure on all \d+ attempt\(s\) within 480000ms .*#1 @1000ms: exit 255 Connection reset/)
        expect(t).toBeLessThanOrEqual(480_000 + 1000)
        expect(JSON.parse(log.at(-1)!)).toMatchObject({ event: 'ssh_retry_exhausted', deadline_ms: 480_000 })
    })
    it('ServerAlive timeout counts as transport', () => {
        expect(isSshTransportFailure(fail(255, 'Timeout, server 100.126.117.80 not responding.'))).toBe(true)
    })
})

describe('Stage2FleetOps.verifySidecarOwner (read-only, sshRead)', () => {
    const s2 = () => new Stage2FleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
    it('r62 replay: one Connection reset, then success → passes with the retry logged', async () => {
        const o = s2()
        const calls = withOnce(o, [R62, NC_OWNER])
        expect(await o.verifySidecarOwner('idea03', 'nextcloud-grade5a-001', 61820)).toEqual(['nextcloud-grade5a-001-nextcloud-app-1'])
        expect(calls.map(c => c.host)).toEqual(['100.126.117.80', '100.126.117.80'])
        const ev = logs.filter(l => l.startsWith('{"event":"ssh_retry')).map(l => JSON.parse(l))
        expect(ev).toEqual([
            expect.objectContaining({ event: 'ssh_retry', host: '100.126.117.80', attempt: 1, stderr: 'Connection reset by 100.126.117.80 port 22' }),
            expect.objectContaining({ event: 'ssh_retry_ok', host: '100.126.117.80', attempt: 2 }),
        ])
    })
    it('persistent reset fails after the budget with every attempt listed', async () => {
        const o = s2()
        const calls = withOnce(o, [R62])
        await expect(o.verifySidecarOwner('idea03', 'nextcloud-grade5a-001', 61820)).rejects.toThrow(
            /ssh 100\.126\.117\.80 .*transport failure on all \d+ attempt\(s\) within 40ms .*#1 @\d+ms: exit 255 Connection reset by 100\.126\.117\.80 port 22; #2 @\d+ms: exit 255 Connection reset/)
        expect(calls.length).toBeGreaterThanOrEqual(3)
        expect(logs.some(l => l.includes('"event":"ssh_retry_exhausted"'))).toBe(true)
    })
    it('a remote non-zero exit is NOT retried', async () => {
        const o = s2()
        const calls = withOnce(o, [fail(1, 'ss: permission denied')])
        await expect(o.verifySidecarOwner('idea03', 'nextcloud-grade5a-001', 61820)).rejects.toThrow(/exit code: 1/)
        expect(calls).toHaveLength(1)
    })
})

describe('mutating calls are never auto-retried', () => {
    it('r67: stage2-dock undock (rawCall) is single-shot via the gated sshMutate; a reset after start → status re-check, not done → fails, run once', async () => {
        const o = new Stage2FleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
        const calls = withOnce(o, [])
        vi.spyOn(o as unknown as { assertSsdOnline: () => void }, 'assertSsdOnline').mockImplementation(() => {})
        const anyO = o as unknown as Record<string, unknown>
        const runs: string[] = []
        anyO.ensureMaster = async () => {}
        anyO.runGated = async (_h: string, g: string) => { runs.push(g); return { code: 255, stdout: '__IDEA_MUTATE_GATE__\n', stderr: 'Connection reset by 100.126.117.80 port 22', sentGo: true } }
        anyO.stage2Status = async () => ({ fixtures: [] })
        anyO.partitionWith = () => ({ present: true }) // still there → not done
        const raw = (o as unknown as { rawCall: (e: string, v: string, a: object) => Promise<unknown> }).rawCall.bind(o)
        await expect(raw('idea03', 'undock', { diskId: 'duration-nextcloud-grade5a-001' })).rejects.toThrow(/status re-check says not_done\. Single-shot: not re-run/)
        expect(runs).toHaveLength(1)
        expect(calls).toHaveLength(0) // never the plain (un-gated) ssh
    })
    it('stage2-dock status (read-only verb) IS retried', async () => {
        const o = new Stage2FleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
        const calls = withOnce(o, [R62, '{"ok":true}'])
        const raw = (o as unknown as { rawCall: (e: string, v: string, a: object) => Promise<unknown> }).rawCall.bind(o)
        await raw('idea03', 'status', {})
        expect(calls).toHaveLength(2)
    })
    it('r67: pm2 restart (rebootEngine --fast) is single-shot; reset after start + Engine not restarted → fails, run once', async () => {
        const o = new RealFleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
        const anyO = o as unknown as Record<string, unknown>
        anyO.disconnect = async () => {}
        anyO.stopDurationFixtureContainers = async () => []
        anyO.sshRead = async (_h: string, c: string) => (c === 'date +%s' ? '1000' : '900')
        const runs: string[] = []
        anyO.ensureMaster = async () => {}
        anyO.runGated = async (_h: string, g: string) => { runs.push(g); return { code: 255, stdout: '__IDEA_MUTATE_GATE__\n', stderr: 'Connection reset by 100.126.117.80 port 22', sentGo: true } }
        await expect(o.rebootEngine('idea03', true)).rejects.toThrow(/pm2 restart engine .*status re-check says not_done/)
        expect(runs.filter(g => g.includes('pm2 restart engine'))).toHaveLength(1)
    })
})
