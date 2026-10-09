/**
 * D9 smoke of stage2-dock.sh on ONE pool Pi (default idea04) against the real fixture SSD.
 * Every script call is logged with its exit code and last-line JSON verdict (evidence JSONL).
 * Engine side = the harness's own Engine eject (Stage2FleetOps.engineEject, WS ejectDisk) and
 * store waits. Leaves both fixtures docked Empty (READY start state). Never idea02; refuses a
 * host other than idea04 unless STAGE2_SMOKE_ALLOW_HOST matches.
 *
 *   DURATION_FLEET_HOSTS=idea01=…,idea03=…,idea04=… tsx test/duration/stage2Smoke.ts --out <dir> [--cycles 10]
 */
import fs from 'node:fs'
import path from 'node:path'
import { $ } from 'zx'
import { parseHostsFlag } from './realFleetOps.js'
import { Stage2FleetOps } from './stage2FleetOps.js'
import { parseStage2Status, stage2FixturesOn, STAGE2_DOCK_SCRIPT_DEFAULT, type Stage2Status } from './stage2.js'

$.verbose = false
const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const HOST = arg('--host', 'idea04')!
const CYCLES = Number(arg('--cycles', '10'))
const OUT = arg('--out')
const PHASES = (arg('--phases', 'status,negative,partition,ssd,move,final')!).split(',')
if (!OUT) { console.error('--out <dir> required'); process.exit(2) }
if (HOST === 'idea02') { console.error('refuse idea02'); process.exit(3) }
if (HOST !== 'idea04' && process.env.STAGE2_SMOKE_ALLOW_HOST !== HOST) { console.error(`refuse ${HOST}: D9 smoke runs on idea04 first`); process.exit(3) }
fs.mkdirSync(OUT, { recursive: true })
const hosts = parseHostsFlag(process.env.DURATION_FLEET_HOSTS ?? '')
const ip = hosts[HOST]; if (!ip) { console.error(`no host for ${HOST}`); process.exit(2) }
const ops = new Stage2FleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts, storeMode: 'shared', dockWaitMs: 180_000 })
const S = STAGE2_DOCK_SCRIPT_DEFAULT
const [P1, P2] = stage2FixturesOn(HOST).map(f => f.diskId) as [string, string]
const log = fs.createWriteStream(path.join(OUT, 'smoke.jsonl'), { flags: 'a' })
const verdicts: { n: number; phase: string; cmd: string; exit: number; want: number; ok: boolean | null; pass: boolean; json: string; ms: number; note?: string }[] = []
let n = 0
const ts = () => new Date().toISOString()

const sshRaw = async (cmd: string) => {
    const r = await $`ssh -o BatchMode=yes -o ConnectTimeout=15 ${`pi@${ip}`} ${cmd}`.nothrow()
    return { exit: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
}
/** Run one script command; record exit + last JSON line; check against the contract. */
const call = async (phase: string, cmdTail: string, want: number, check?: (j: Record<string, unknown>) => string | null, opts: { sudo?: boolean; raw?: string } = {}) => {
    const cmd = opts.raw ?? `${opts.sudo === false ? '' : 'sudo -n '}${S} ${cmdTail}`
    const t0 = Date.now()
    const r = await sshRaw(cmd)
    const last = r.stdout.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? ''
    let j: Record<string, unknown> = {}; let okv: boolean | null = null; let note: string | null = null
    try { j = JSON.parse(last); okv = typeof j.ok === 'boolean' ? (j.ok as boolean) : null } catch { note = 'last line not JSON' }
    if (okv === null && !note) note = 'no boolean ok'
    if (!note && (okv === true) !== (want === 0)) note = `ok=${okv} vs exit ${want}`
    if (!note && j.exit !== undefined && j.exit !== r.exit) note = `json exit ${j.exit} != process exit ${r.exit}`
    if (!note && check) note = check(j)
    const pass = r.exit === want && !note
    const v = { n: ++n, phase, cmd, exit: r.exit, want, ok: okv, pass, json: last, ms: Date.now() - t0, ...(note ? { note } : {}) }
    verdicts.push(v)
    log.write(JSON.stringify({ ts: ts(), ...v, stderr: r.stderr.trim().slice(-400) }) + '\n')
    console.log(`${pass ? 'PASS' : 'FAIL'} #${v.n} [${phase}] ${cmd.replace(`sudo -n ${S} `, '')} → exit ${r.exit} (want ${want}) ${last.slice(0, 220)}${note ? `  !! ${note}` : ''}`)
    if (!pass) throw new Error(`smoke step #${v.n} failed: ${cmd} exit ${r.exit} want ${want} ${note ?? ''}`)
    return j
}
const event = (phase: string, what: string, extra: Record<string, unknown> = {}) => {
    log.write(JSON.stringify({ ts: ts(), phase, event: what, ...extra }) + '\n')
    console.log(`     [${phase}] ${what} ${Object.keys(extra).length ? JSON.stringify(extra) : ''}`)
}
const status = async (): Promise<Stage2Status> => parseStage2Status((await sshRaw(`sudo -n ${S} status --json`)).stdout)
const fx = (st: Stage2Status, id: string) => st.fixtures.find(x => x.partLabel === stage2FixturesOn(HOST).find(f => f.diskId === id)!.partLabel)!
let ROOT = ''; let BOOT = ''
const rootSafe = (j: Record<string, unknown>): string | null => {
    const st = j as unknown as Stage2Status
    if (st.rootDisk !== ROOT) return `rootDisk changed ${ROOT}→${st.rootDisk}`
    if ((st.ssds ?? []).some(d => d.kname === ROOT)) return 'root disk listed in ssds[]'
    if ((st.fixtures ?? []).some(f => f.parent === ROOT)) return 'a fixture sits on the root disk'
    if (st.bootId !== BOOT) return `bootId changed ${BOOT}→${st.bootId} (Pi rebooted?)`
    return null
}
const waitStore = async (phase: string, id: string, docked: boolean) => {
    const t0 = Date.now()
    for (;;) {
        const on = await ops.findDockedEngine(id)
        const st = await status()
        const p = fx(st, id)
        const good = docked ? on === HOST && !!p.mounted && p.mounted === `/disks/${p.kname}` : on !== HOST && !p.mounted
        if (good) { event(phase, `${id} ${docked ? 'docked+mounted' : 'undocked+unmounted'}`, { dockedTo: on, kname: p.kname, mounted: p.mounted, ms: Date.now() - t0 }); return }
        if (Date.now() - t0 > 180_000) throw new Error(`${id}: store/mount did not reach docked=${docked} (dockedTo=${on} mounted=${p.mounted})`)
        await new Promise(r => setTimeout(r, 1000))
    }
}
const eject = async (phase: string, id: string) => {
    const t0 = Date.now()
    await ops.engineEject(HOST, id)
    event(phase, `Engine eject ${id} done`, { ms: Date.now() - t0 })
}
const has = (k: string, v: unknown) => (j: Record<string, unknown>) => (j[k] === v ? null : `${k}=${JSON.stringify(j[k])}, want ${JSON.stringify(v)}`)

const main = async () => {
    console.log(`D9 smoke on ${HOST} (${ip}) ${ts()} fixtures ${P1}/${P2} cycles ${CYCLES}`)
    // ── status ──
    let st = await status(); ROOT = st.rootDisk ?? ''; BOOT = st.bootId ?? ''
    if (!ROOT || !BOOT) throw new Error('status without rootDisk/bootId')
    if (PHASES.includes('status')) {
        await call('status', 'status --json', 0, j => rootSafe(j)
            ?? ((j.ssds as unknown[]).length === 1 ? null : `ssds[] length ${(j.ssds as unknown[]).length}`)
            ?? (/^[0-9a-f-]{36}$/.test(String(j.bootId)) ? null : 'bootId format'))
        for (const id of [P1, P2]) { if (!fx(st, id).mounted) throw new Error(`${id} not mounted at start`) }
    }
    // ── contract negatives (no state change) ──
    if (PHASES.includes('negative')) {
        await call('negative', '', 2, undefined, { raw: `sudo -n ${S}` })
        await call('negative', 'dock --json', 2)
        await call('negative', 'dock duration-nope --json', 3)
        await call('negative', 'status --json', 3, undefined, { sudo: false })
        await call('negative', `undock ${P2} --json`, 5)
        await call('negative', `dock ${P2} --json`, 0, has('already', true))
        await call('negative', `reset ${P2} --json`, 5)
        await call('negative', 'reset duration-kolibri-grade5a-001 --json', 3)
        await call('negative', 'eject-ssd --ssd duration-kolibri-grade5a-001 --json', 3)
        await call('negative', `eject-ssd --ssd ${P1} --json`, 5)
        await call('negative', `export ${P2} --json`, 5, undefined, { raw: `set -o pipefail; sudo -n ${S} export ${P2} | tail -c 300` })
        await call('negative', 'status --json', 0, rootSafe)
    }
    // ── partition undock/dock round trips (P2; sibling P1 must stay mounted) ──
    if (PHASES.includes('partition')) for (let c = 1; c <= CYCLES; c++) {
        const ph = `partition#${c}`
        await eject(ph, P2)
        await call(ph, `undock ${P2} --json`, 0, has('already', false))
        await call(ph, `undock ${P2} --json`, 0, has('already', true))
        await call(ph, 'status --json', 0, j => rootSafe(j) ?? (fx(j as unknown as Stage2Status, P2).present ? `${P2} still present` : null)
            ?? (fx(j as unknown as Stage2Status, P1).mounted ? null : `sibling ${P1} lost its mount`))
        await call(ph, `dock ${P2} --json`, 0, has('already', false))
        await waitStore(ph, P2, true)
        await call(ph, `dock ${P2} --json`, 0, has('already', true))
    }
    // ── whole-SSD eject/dock round trips (both partitions) ──
    if (PHASES.includes('ssd')) for (let c = 1; c <= CYCLES; c++) {
        const ph = `ssd#${c}`
        await eject(ph, P1); await eject(ph, P2)
        await call(ph, `eject-ssd --ssd ${P1} --json`, 0)
        await call(ph, 'status --json', 0, j => rootSafe(j) ?? (((j.ssds as unknown[]).length === 0 && !fx(j as unknown as Stage2Status, P1).present && !fx(j as unknown as Stage2Status, P2).present) ? null : 'SSD still visible'))
        if (c === 1) await call(ph, `eject-ssd --ssd ${P1} --json`, 4) // second eject: SSD already gone → exit 4 (not already:true)
        await call(ph, `dock-ssd --ssd ${P1} --json`, 0)
        await waitStore(ph, P1, true); await waitStore(ph, P2, true)
        if (c === 1) await call(ph, `dock-ssd --ssd ${P1} --json`, 0) // idempotent: port already bound
        await call(ph, 'status --json', 0, rootSafe)
    }
    // ── reset + export | import (move mechanism) on the two Empties, then restore ──
    if (PHASES.includes('move')) {
        const ph = 'move'
        await eject(ph, P1); await eject(ph, P2)
        await call(ph, `reset ${P2} --json`, 0, has('previousDiskId', P2))
        await call(ph, `import ${P2} --as ${P1} --json`, 0, has('as', P1), { raw: `set -o pipefail; sudo -n ${S} export ${P1} | sudo -n ${S} import ${P2} --as ${P1} --json` })
        await call(ph, 'status --json', 0, j => rootSafe(j) ?? (fx(j as unknown as Stage2Status, P2).diskId === P1 ? null : 'target META not the source id'))
        await call(ph, `import ${P2} --as ${P1} --json`, 5, undefined, { raw: `set -o pipefail; sudo -n ${S} export ${P1} | sudo -n ${S} import ${P2} --as ${P1} --json` })
        await call(ph, `reset ${P2} --json`, 0, has('previousDiskId', P1))
        await call(ph, 'status --json', 0, j => rootSafe(j) ?? (fx(j as unknown as Stage2Status, P2).diskId === P2 ? null : 'reset META wrong'))
        await call(ph, `dock ${P1} --json`, 0); await waitStore(ph, P1, true)
        await call(ph, `dock ${P2} --json`, 0); await waitStore(ph, P2, true)
    }
    // ── final: READY start state ──
    if (PHASES.includes('final')) {
        st = await status()
        const view = await ops.readStore(HOST)
        const final = [P1, P2].map(id => ({ id, kname: fx(st, id).kname, mounted: fx(st, id).mounted, dockedTo: view.diskDB[id]?.dockedTo, diskTypes: view.diskDB[id]?.diskTypes, instances: Object.values(view.instanceDB).filter(i => i.diskId === id).map(i => i.id) }))
        event('final', 'start state', { final, bootId: st.bootId, rootDisk: st.rootDisk })
        for (const f of final) if (f.dockedTo !== HOST || !f.mounted || JSON.stringify(f.diskTypes) !== '["empty"]' || f.instances.length) throw new Error(`final state wrong: ${JSON.stringify(f)}`)
        await call('final', 'status --json', 0, rootSafe)
    }
}
main().then(() => {
    const fails = verdicts.filter(v => !v.pass).length
    fs.writeFileSync(path.join(OUT, 'verdicts.json'), JSON.stringify({ host: HOST, cycles: CYCLES, total: verdicts.length, fails, verdicts }, null, 1))
    console.log(`SMOKE ${fails ? 'FAIL' : 'PASS'}: ${verdicts.length} script calls, ${fails} failed`)
    return ops.close()
}).then(() => process.exit(0), async e => {
    console.error(`SMOKE FAIL: ${e instanceof Error ? e.message : String(e)}`)
    fs.writeFileSync(path.join(OUT, 'verdicts.json'), JSON.stringify({ host: HOST, cycles: CYCLES, total: verdicts.length, aborted: String(e), verdicts }, null, 1))
    try { await ops.close() } catch { /* */ }
    process.exit(1)
})
