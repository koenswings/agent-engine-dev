/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * r67 FAIL@23: one sidecar-owner docker-ps read on idea03 lasted 795 s of wall time and was never retried
 * (attempts=1 > 480 s deadline). Root cause: the box VM froze (dmesg "virtual machine fork" inside the window),
 * so neither the 120 s attempt kill nor ssh's ServerAlive (both monotonic) could fire, and the retry deadline
 * was measured in WALL time. r68: monotonic deadline + at least one retry, process-group kill that resolves at
 * once, dead mux detection. These tests use REAL processes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { execSync } from 'node:child_process'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { runProcess, startPauseMonitor } from '../duration/procRun.js'
import { withSshRetry, sshRetryPolicy } from '../duration/sshRetry.js'

const dir = mkdtempSync(join(tmpdir(), 'r68-'))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// Fake ssh: hangs (with a grandchild that also holds the pipes) for the first HANG_N calls, then answers.
// `-O check|exit` go to the REAL ssh (stale mux socket test); `-fN` (master start) is recorded and succeeds.
const FAKE = join(dir, 'fakessh')
writeFileSync(FAKE, `#!/bin/bash
for a in "$@"; do
  if [ "$a" = "-O" ]; then exec ssh "$@"; fi
  if [ "$a" = "-fN" ]; then echo "master $*" >> "${dir}/masters"; exit 0; fi
done
n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/count"
if [ "$n" -le "\${HANG_N:-0}" ]; then
  sleep 1000 & echo $! >> "${dir}/grandkids"
  sleep 1000
fi
echo "OK attempt $n"
`)
chmodSync(FAKE, 0o755)

const ops = (extra: Record<string, unknown> = {}) => {
    const o = Object.create(RealFleetOps.prototype) as any
    Object.assign(o, { sshUser: 'pi', masterStats: { started: 0, reused: 0, recreated: 0 }, ...extra })
    return o
}

let server: Server
let port = 0
const socks: Socket[] = []
beforeAll(async () => {
    // A "frozen" sshd: accepts, sends a banner, then never answers (like a link that died mid-session).
    server = createServer(s => { socks.push(s); s.write('SSH-2.0-OpenSSH_9.2\r\n') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as { port: number }).port
})
afterAll(() => { socks.forEach(s => s.destroy()); server.close() })

describe('real processes: per-attempt kill', () => {
    it('REAL ssh to a frozen sshd is killed at the attempt budget and resolves at once as a transport failure', async () => {
        const o = ops({ sshArgs: (h: string) => ['-p', String(port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `pi@${h}`] })
        const t0 = Date.now()
        const err = await o.sshOnce('127.0.0.1', 'docker ps', 1_500).catch((e: any) => e)
        const took = Date.now() - t0
        expect(took).toBeGreaterThanOrEqual(1_400)
        expect(took).toBeLessThan(4_000)
        expect(err).toMatchObject({ exitCode: 255 })
        expect(err.stderr).toMatch(/Timeout, server 127\.0\.0\.1 not responding \(walker killed the ssh process group after 1500ms\)/)
        expect(execSync(`pgrep -f "^ssh -p ${port} " || true`).toString().trim()).toBe('')
    })
    it('never-returning REAL ssh plus its REAL ControlMaster child (same group): both killed at the budget, retried as transport failure', async () => {
        const MUX = join(dir, 'muxssh')
        const cp = join(dir, 'cm-sock')
        writeFileSync(MUX, `#!/bin/bash
ssh -p ${port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ControlMaster=yes -o ControlPath=${cp} -N pi@127.0.0.1 &
echo $! > "${dir}/masterpid"
echo $$ > "${dir}/clientpid"
exec ssh -p ${port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ControlPath=${cp} -o ControlMaster=no pi@127.0.0.1 "$@"
`)
        chmodSync(MUX, 0o755)
        process.env.DURATION_SSH_BIN = MUX
        try {
            const o = ops({ sshArgs: () => [] })
            const t0 = Date.now()
            const err = await o.sshOnce('127.0.0.1', 'docker ps', 1_500).catch((e: any) => e)
            expect(Date.now() - t0).toBeLessThan(4_000)
            expect(err).toMatchObject({ exitCode: 255 })
            await new Promise(res => setTimeout(res, 300))
            const master = Number(readFileSync(join(dir, 'masterpid'), 'utf8')), client = Number(readFileSync(join(dir, 'clientpid'), 'utf8'))
            expect(alive(master)).toBe(false)
            expect(alive(client)).toBe(false)
        } finally { delete process.env.DURATION_SSH_BIN }
    })
    it('the whole process group dies (grandchild holding the pipes too) and the promise does not wait for close', async () => {
        writeFileSync(join(dir, 'count'), '0'); writeFileSync(join(dir, 'grandkids'), '')
        const t0 = Date.now()
        const r = await runProcess(FAKE, ['host', 'cmd'], { timeoutMs: 800, env: { ...process.env, HANG_N: '1' } })
        expect(Date.now() - t0).toBeLessThan(2_500)
        expect(r).toMatchObject({ code: null, timedOut: true, killedGroup: true })
        await new Promise(res => setTimeout(res, 200))
        const kids = readFileSync(join(dir, 'grandkids'), 'utf8').trim().split('\n').filter(Boolean).map(Number)
        expect(kids).toHaveLength(1)
        expect(alive(kids[0]!)).toBe(false)
    })
    it('hang, hang, answer: each attempt killed at the budget, retried and logged within the deadline (real sshRead path)', async () => {
        writeFileSync(join(dir, 'count'), '0')
        process.env.HANG_N = '2'
        process.env.DURATION_SSH_BIN = FAKE
        process.env.DURATION_SSH_READ_ATTEMPT_MS = '700'
        process.env.DURATION_SSH_RETRY_BACKOFF_MS = '100'
        const logs: string[] = []
        const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => { logs.push(String(l)) })
        try {
            const o = ops({ sshArgs: (h: string) => [`pi@${h}`] })
            const t0 = Date.now()
            const out = await o.sshRead('100.126.117.80', 'docker ps')
            expect(out).toMatch(/OK attempt 3/)
            expect(Date.now() - t0).toBeLessThan(5_000)
            const retries = logs.filter(l => l.includes('"event":"ssh_retry"'))
            expect(retries).toHaveLength(2)
            expect(retries[0]).toMatch(/"host":"100\.126\.117\.80".*"attempt":1.*walker killed the ssh process group after 700ms/)
            expect(logs.some(l => /"event":"ssh_retry_ok".*"attempt":3/.test(l))).toBe(true)
        } finally {
            spy.mockRestore()
            for (const k of ['HANG_N', 'DURATION_SSH_BIN', 'DURATION_SSH_READ_ATTEMPT_MS', 'DURATION_SSH_RETRY_BACKOFF_MS']) delete process.env[k]
        }
    })
})

describe('dead ControlMaster', () => {
    it('a stale mux socket (master gone) fails -O check with the REAL ssh → exit, unlink, recreate (counted, logged)', async () => {
        const cdir = mkdtempSync(join(tmpdir(), 'cm-'))
        process.env.DURATION_SSH_CONTROL_DIR = cdir
        process.env.DURATION_SSH_BIN = FAKE
        const logs: string[] = []
        const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => { logs.push(String(l)) })
        try {
            const o = ops({ sshArgs: (h: string) => ['-o', 'BatchMode=yes', `pi@${h}`] })
            const sock = o.controlPathFor('100.126.117.80')
            // A unix socket file whose listener is gone = a dead master.
            execSync(`python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind('${sock}');s.close()"`)
            expect(existsSync(sock)).toBe(true)
            await o.ensureMaster('100.126.117.80')
            expect(existsSync(sock)).toBe(false)
            expect(o.masterStats).toEqual({ started: 1, reused: 0, recreated: 1 })
            expect(logs.some(l => /"event":"ssh_master_dead","host":"100\.126\.117\.80".*recreate/.test(l))).toBe(true)
            expect(readFileSync(join(dir, 'masters'), 'utf8')).toMatch(new RegExp(`ControlPath=${sock}.*ControlMaster=yes.*-fN`))
        } finally {
            spy.mockRestore()
            delete process.env.DURATION_SSH_CONTROL_DIR; delete process.env.DURATION_SSH_BIN
        }
    })
})

describe('r67 replay: box pause', () => {
    const reset = Object.assign(new Error('reset'), { exitCode: 255, stderr: 'Read from remote host 100.126.117.80: Connection reset by peer' })
    it('attempt spans a 795 s WALL gap (VM pause) but ~100 s monotonic → retried, succeeds; pause logged', async () => {
        let mono = 0, wall = 0, n = 0
        const logs: string[] = []
        const out = await withSshRetry('100.126.117.80', 'sidecar owner docker ps', async () => {
            n++
            if (n === 1) { mono += 100_000; wall += 795_356; throw reset }
            return 'ok'
        }, sshRetryPolicy({}), { sleep: async ms => { mono += ms; wall += ms }, log: l => logs.push(l), now: () => mono, wall: () => wall })
        expect(out).toBe('ok')
        expect(logs.some(l => /"event":"box_pause_detected".*"paused_ms":695356/.test(l))).toBe(true)
        expect(logs.some(l => /"event":"ssh_retry_ok".*"attempt":2/.test(l))).toBe(true)
    })
    it('old behaviour (deadline in wall time, no minimum retry) would have given up after 1 attempt; now ≥ 1 retry even past the deadline', async () => {
        let t = 0, n = 0
        const out = await withSshRetry('h', 'x', async () => { n++; if (n === 1) { t += 795_356; throw reset } return 'ok' },
            sshRetryPolicy({}), { sleep: async ms => { t += ms }, log: () => {}, now: () => t, wall: () => t })
        expect(out).toBe('ok')
        expect(n).toBe(2)
    })
    it('pause monitor logs a box_pause when wall jumps ahead of monotonic', () => {
        let mono = 0, wall = 0
        const logs: string[] = []
        const stop = startPauseMonitor(l => logs.push(l), 60_000, 20_000, { mono: () => mono, wall: () => wall }) as (() => void) & { check: () => void }
        mono += 5_000; wall += 700_000; stop.check()
        mono += 5_000; wall += 5_000; stop.check()
        stop()
        expect(logs).toHaveLength(1)
        expect(logs[0]).toMatch(/"event":"box_pause".*"paused_ms":695000/)
    })
})
