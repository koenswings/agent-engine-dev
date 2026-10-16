/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * r69 (r68 FAIL@62 infra_move_disk): a ~919 s box pause mid export|import let ServerAlive (15 s × 8) kill both
 * relay legs. relayPipe now runs in its own process group with a 30 min ServerAlive budget; moveDisk verifies an
 * interrupted relay read-only, resets the target and retries the whole export|import ONCE. REAL processes:
 * a fake `ssh` (bash) streams a real tar-like byte stream and the import leg dies mid-stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Stage2FleetOps } from '../duration/stage2FleetOps.js'
import { stage2Fixture, stage2MoveTargetPartition } from '../duration/stage2.js'

const K = 'duration-kolibri-grade5a-001'
const T = stage2MoveTargetPartition('idea04', K)
const SRC = stage2Fixture(K)

let dir: string
const FAKE = () => join(dir, 'fakessh')
const st = (f: string, d = '') => existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim() : d

const writeFake = () => writeFileSync(FAKE(), `#!/bin/bash
D="${dir}"
echo "$*" >> "$D/argv"
cmd="\${@: -1}"
case "$cmd" in
  *" export "*)
    [ -f "$D/export_hang" ] && exec sleep 1000
    for i in $(seq 1 200); do echo "tar-chunk-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; sleep 0.005; done ;;
  *" import "*)
    n=$(( $(cat "$D/imports" 2>/dev/null || echo 0) + 1 )); echo $n > "$D/imports"
    mode=$(sed -n "\${n}p" "$D/modes")
    if [ "$mode" = "drop" ]; then
      head -n 20 > /dev/null            # read part of the stream, then the link dies mid-stream
      echo "Timeout, server 100.108.39.45 not responding." >&2; exit 255
    fi
    lines=$(wc -l)                       # consume the whole stream (staged import completes)
    echo "${'$'}lines" > "$D/imported_lines"; echo "${K}" > "$D/target_meta"
    if [ "$mode" = "done_then_drop" ]; then echo "client_loop: send disconnect: Broken pipe" >&2; exit 255; fi
    echo '{"ok":true,"target":"x","as":"${K}","bytes":1}' ;;
esac
`)

class RelayOps extends Stage2FleetOps {
    resets = 0
    srcMeta: string | null = K
    targetMounted: string | null = null
    privHeld = 0
    protected override sshArgs(h: string): string[] { return ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8', `pi@${h}`] }
    override async stage2Status(engineId: string): Promise<any> {
        const fixtures = [
            { partLabel: T.partLabel, diskId: st('target_meta', T.diskId), kname: 'sdb2', parent: 'sdb', fsType: 'ext4', fsLabel: T.fsLabel, mounted: this.privHeld-- > 0 ? '/run/stage2-dock/mnt.abcd' : this.targetMounted, present: true },
            { partLabel: SRC.partLabel, diskId: this.srcMeta, kname: 'sda1', parent: 'sda', fsType: 'ext4', fsLabel: SRC.fsLabel, mounted: null, present: true },
        ]
        return { ok: true, host: engineId, bootId: 'b', rootDisk: 'mmcblk0', ssds: [], fixtures, ugreenDetached: false, extraSdDisks: [] }
    }
    protected override async rawCall(engineId: string, verb: string, args: any): Promise<any> {
        if (verb === 'reset') { this.resets++; writeFileSync(join(dir, 'target_meta'), args.diskId); return { ok: true } }
        throw new Error(`unexpected ${verb}`)
    }
    run() { return (this as any).relayMoveWithRecovery('idea01', 'idea04', K, T) as Promise<{ stdout: string; recovered: boolean; attempts: number }> }
}
const mk = () => new RelayOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' }, storeMode: 'shared', sleep: async () => {} } as any)

let logs: string[] = []
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-'))
    writeFake(); chmodSync(FAKE(), 0o755)
    process.env.DURATION_SSH_BIN = FAKE()
    logs = []
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => { logs.push(String(l)) })
})
afterEach(() => { vi.restoreAllMocks(); delete process.env.DURATION_SSH_BIN; delete process.env.DURATION_RELAY_ATTEMPT_MS })
const modes = (...m: string[]) => writeFileSync(join(dir, 'modes'), m.join('\n') + '\n')
const ev = (e: string) => logs.filter(l => l.includes(`"event":"${e}"`))

describe('relayPipe (REAL processes)', () => {
    it('import leg killed mid-stream → verify not done, source intact → reset target → ONE retry → ok', async () => {
        modes('drop', 'ok')
        const o = mk()
        const r = await o.run()
        expect(r).toMatchObject({ recovered: false, attempts: 2 })
        expect(r.stdout).toMatch(/"ok":true/)
        expect(st('imports')).toBe('2')
        expect(st('imported_lines')).toBe('200') // the retry carried the whole stream
        expect(o.resets).toBe(1)
        expect(ev('move_relay_failed')[0]).toMatch(/"attempt":1.*Timeout, server 100\.108\.39\.45 not responding/)
        expect(ev('move_relay_verify')[0]).toMatch(/"state":"not_done","sourceIntact":true/)
        expect(logs.findIndex(l => l.includes('move_relay_reset_target'))).toBeLessThan(logs.findIndex(l => l.includes('"event":"move_relay_retry"')))
        expect(ev('move_relay_retry_ok')).toHaveLength(1)
    })
    it('import completed, then the link dropped → detected as done, NO retry, NO reset', async () => {
        modes('done_then_drop')
        const o = mk()
        const r = await o.run()
        expect(r).toMatchObject({ recovered: true, attempts: 1 })
        expect(st('imports')).toBe('1')
        expect(o.resets).toBe(0)
        expect(ev('move_relay_recovered_by_verify')).toHaveLength(1)
    })
    it('second failure fails loudly (both errors kept), exactly one reset and two imports', async () => {
        modes('drop', 'drop', 'ok')
        const o = mk()
        await expect(o.run()).rejects.toThrow(/relay failed \(#1: .*not responding.* \| #2: .*not responding.*\); verify: not_done .*Second failure — no further retry/)
        expect(st('imports')).toBe('2')
        expect(o.resets).toBe(1)
    })
    it('legs get ServerAlive 30 s × 60 (box-pause tolerant), never the old 15 × 8', async () => {
        modes('ok')
        await mk().run()
        const argv = st('argv')
        expect(argv).toMatch(/ServerAliveInterval=30 -o ServerAliveCountMax=60/)
        expect(argv).not.toMatch(/ServerAliveInterval=15|ServerAliveCountMax=8/)
    })
    it('a hung relay is killed as a whole process group at DURATION_RELAY_ATTEMPT_MS', async () => {
        process.env.DURATION_RELAY_ATTEMPT_MS = '800'
        writeFileSync(join(dir, 'export_hang'), '')
        modes('ok')
        const t0 = Date.now()
        await expect((mk() as any).relayPipe('10.0.0.1', 'sudo x export a', '10.0.0.4', 'sudo x import b')).rejects.toThrow(/killed after 800ms/)
        expect(Date.now() - t0).toBeLessThan(3_000)
    })
})

describe('relay recovery (unit)', () => {
    it('unknown target state (mounted under /disks) → loud, no reset, no retry', async () => {
        modes('drop', 'ok')
        const o = mk(); o.targetMounted = '/disks/sdb2'
        await expect(o.run()).rejects.toThrow(/verify: unknown .*Not retried/)
        expect(o.resets).toBe(0); expect(st('imports')).toBe('1')
    })
    it('source not intact → loud, no reset, no retry', async () => {
        modes('drop', 'ok')
        const o = mk(); o.srcMeta = null
        await expect(o.run()).rejects.toThrow(/SOURCE NOT INTACT/)
        expect(o.resets).toBe(0)
    })
    it('a leg still holding a private stage2-dock mount is waited out before classifying', async () => {
        modes('drop', 'ok')
        const o = mk(); o.privHeld = 3
        const r = await o.run()
        expect(r.attempts).toBe(2)
        expect(o.privHeld).toBeLessThan(0)
    })
})
