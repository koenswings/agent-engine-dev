/**
 * idea#168 r34@70 — infra_move_disk carries the SOURCE disk's real tree; app-pack fixture
 * trees need their instance data (LOUD precondition, no silent reuse / refresh-from-seed).
 *
 * cover-all-cf231e8-r34 FAIL@70: after infra_move_disk@62 (Kolibri Grade5A idea01→idea03)
 * dockFixture(idea03) reused a stale idea03:~/idea/duration-disks/idea-test-1 whose META.yaml
 * had the right diskId but no Kolibri data → Kolibri on an empty data dir → /en/setup.
 *
 * These tests drive the REAL RealFleetOps code paths (dockFixture / moveDisk and the remote
 * bash they generate) against per-host sandboxes on the box: every "ssh host cmd" runs the
 * generated bash locally with the host's roots substituted, and the walker relay
 * (ssh src | ssh dst) is a local pipe. Only the Automerge store calls are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
    APP_PACK_INSTANCE_DATA,
    FIXTURE_SLOT_COUNT,
    KOLIBRI_GRADE5A_CLASS_NAME,
    RealFleetOps,
    buildFixtureSlotScanRemote,
    buildInstanceDataCheckRemote,
    buildMountScanRemote,
    buildMovePlanRemote,
    buildQuarantineSourceRemote,
    buildRecreateSkipDirsRemote,
    buildSlotLinkScanRemote,
    buildStagingCleanupRemote,
    buildTreeDigestRemote,
    buildTreeSendRemote,
    isOwnInstanceContainer,
    parseMountScan,
    parseSlotLinkScan,
    parseTreeDigest,
    skipDirTarPattern,
    fixtureSlotNames,
    parseFixtureSlotScan,
    parseInstanceDataCheck,
    parseMovePlan,
    sudoPreamble,
} from '../duration/realFleetOps.js'
import type { SemanticStoreView } from '../duration/types.js'

const run = promisify(execFile)

const KOLIBRI = 'duration-kolibri-grade5a-001'
const KINST = 'kolibri-grade5a-001'
const EMPTY = 'duration-empty-001'
const HOSTS = { idea01: 'idea01', idea03: 'idea03', idea04: 'idea04' }
const DB_REL = APP_PACK_INSTANCE_DATA[KOLIBRI]!.keyFile

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** A Kolibri-shaped db.sqlite3 (kolibriauth_collection) plus a walk-state row. */
const makeKolibriDb = (file: string, opts: { grade5a: boolean; walkState?: string }) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const py = [
        'import sqlite3, sys',
        'con = sqlite3.connect(sys.argv[1])',
        'con.execute("CREATE TABLE kolibriauth_collection (id TEXT PRIMARY KEY, name TEXT, kind TEXT, parent_id TEXT)")',
        'con.execute("CREATE TABLE walk_state (k TEXT, v TEXT)")',
        'con.execute("INSERT INTO kolibriauth_collection VALUES (?,?,?,?)", ("386af378", "Duration Tests Facility", "facility", None))',
        'if sys.argv[2] == "1":',
        '    con.execute("INSERT INTO kolibriauth_collection VALUES (?,?,?,?)", ("8264b7d5", "Grade 5A", "classroom", "386af378"))',
        'if sys.argv[3]:',
        '    con.execute("INSERT INTO walk_state VALUES (?,?)", ("progress", sys.argv[3]))',
        'con.commit()',
        'con.close()',
    ].join('\n')
    execFileSync('python3', ['-c', py, file, opts.grade5a ? '1' : '0', opts.walkState ?? ''])
}

const readWalkState = (file: string): string | null => {
    const out = execFileSync('python3', ['-c',
        'import sqlite3,sys\nr=sqlite3.connect(sys.argv[1]).execute("SELECT v FROM walk_state WHERE k=?",("progress",)).fetchone()\nprint(r[0] if r else "")',
        file]).toString().trim()
    return out || null
}

/**
 * idea#168 r35@62 — fake `docker` on PATH for the generated bash: `ps -q`, `ps --filter name=RE
 * --format …` and `inspect --format … <ids>` read <dir>/<host>/docker.tsv (one container per
 * line: id TAB name TAB mount-source…); every call is logged; stop/kill/rm/restart are refused
 * (exit 99) so a test can prove the harness never stops a container. FAKE_DOCKER_BROKEN=1 → ps fails.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$FAKE_DOCKER_HOST $*" >> "$FAKE_DOCKER_LOG"
state="$FAKE_DOCKER_STATE"
case "$1" in
  ps)
    if [ -f "$FAKE_DOCKER_BROKEN" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
    shift; q=0; filter=""
    while [ $# -gt 0 ]; do case "$1" in -q) q=1;; --filter) shift; filter="$1";; --format) shift;; esac; shift; done
    [ -f "$state" ] || exit 0
    while IFS=$'\t' read -r id name rest; do
      [ -n "$id" ] || continue
      if [ -n "$filter" ]; then printf '%s\n' "$name" | grep -Eq -- "\${filter#name=}" || continue; fi
      if [ $q = 1 ]; then echo "$id"; else echo "$name"; fi
    done < "$state";;
  inspect)
    shift; ids=()
    while [ $# -gt 0 ]; do case "$1" in --format|-f) shift;; *) ids+=("$1");; esac; shift; done
    for want in "\${ids[@]}"; do
      while IFS=$'\t' read -r id name rest; do
        [ "$id" = "$want" ] || continue
        IFS=$'\t' read -ra ms <<< "$rest"
        for m in "\${ms[@]}"; do printf '/%s\t%s\n' "$name" "$m"; done
      done < "$state"
    done;;
  stop|kill|rm|restart|start|compose) echo "fake docker: '$1' refused in tests" >&2; exit 99;;
esac
`

type Container = { id: string; name: string; mounts: string[] }
const dockerState = (sb: Sandbox, h: string) => `${sb.dir}/${h}/docker.tsv`
const setContainers = (sb: Sandbox, h: string, cs: Container[]) =>
    fs.writeFileSync(dockerState(sb, h), cs.map(c => [c.id, c.name, ...c.mounts].join('\t')).join('\n') + (cs.length ? '\n' : ''))
const getContainers = (sb: Sandbox, h: string): Container[] =>
    !fs.existsSync(dockerState(sb, h)) ? [] : fs.readFileSync(dockerState(sb, h), 'utf8').split('\n').filter(Boolean)
        .map(l => { const [id, name, ...mounts] = l.split('\t'); return { id: id!, name: name!, mounts } })
const dockerLog = (sb: Sandbox): string[] =>
    fs.existsSync(`${sb.dir}/docker.log`) ? fs.readFileSync(`${sb.dir}/docker.log`, 'utf8').split('\n').filter(Boolean) : []

type Sandbox = {
    dir: string
    ROOT: string
    WATCH: string
    SEED: string
    /** idea#168 Stage 1: DURATION_SERVICE_TARS_ROOT placeholder (per host: <dir>/<h>/tars). */
    TARS: string
    host: (h: string) => { disks: string; watch: string; seed: string; tars: string }
}
const KTAR = 'koenswings_kolibri:1.0-0.15.5-dev.tar'

const makeSandbox = (): Sandbox => {
    let dir = ''
    do { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfo-move-')) } while (/sdb/i.test(dir))
    const host = (h: string) => ({ disks: `${dir}/${h}/disks`, watch: `${dir}/${h}/watch`, seed: `${dir}/${h}/seed`, tars: `${dir}/${h}/tars` })
    for (const h of Object.keys(HOSTS)) {
        const p = host(h)
        fs.mkdirSync(p.disks, { recursive: true })
        fs.mkdirSync(p.watch, { recursive: true })
        // idea#168 Stage 1: Atlas-staged service tars on every pool Pi (same image, own copy).
        fs.mkdirSync(p.tars, { recursive: true })
        fs.writeFileSync(`${p.tars}/${KTAR}`, `kolibri image staged on ${h}`)
        // Kid seed packs as on the Pi: kolibri ships compose/.env but NO instance data.
        fs.mkdirSync(`${p.seed}/kolibri/instances/${KINST}`, { recursive: true })
        fs.writeFileSync(`${p.seed}/kolibri/META.yaml`, `diskId: ${KOLIBRI}\n`)
        fs.writeFileSync(`${p.seed}/kolibri/instances/${KINST}/compose.yaml`, 'services: {}\n')
        fs.mkdirSync(`${p.seed}/empty`, { recursive: true })
        fs.writeFileSync(`${p.seed}/empty/META.yaml`, `diskId: ${EMPTY}\n`)
        fs.writeFileSync(`${p.seed}/empty/README.md`, 'humans\n')
    }
    fs.mkdirSync(`${dir}/fakebin`, { recursive: true })
    fs.writeFileSync(`${dir}/fakebin/docker`, FAKE_DOCKER, { mode: 0o755 })
    return { dir, ROOT: `${dir}/__DISKS__`, WATCH: `${dir}/__WATCH__`, SEED: `${dir}/__SEED__`, TARS: `${dir}/__TARS__`, host }
}

/** Kolibri slot on a host. data: 'real' | 'symlink' (Path A idea01) | 'none' (stale META-only). */
const plantKolibriTree = (sb: Sandbox, h: string, slot: string, data: 'real' | 'symlink' | 'none', opts: { grade5a?: boolean; walkState?: string; sessions?: boolean; services?: boolean } = {}) => {
    const root = `${sb.host(h).disks}/${slot}`
    fs.mkdirSync(`${root}/apps/kolibri-1.0`, { recursive: true })
    fs.mkdirSync(`${root}/instances/${KINST}`, { recursive: true })
    fs.writeFileSync(`${root}/META.yaml`, `diskId: ${KOLIBRI}\ndiskName: "Duration Tests — Kolibri Grade 5A"\n`)
    fs.writeFileSync(`${root}/apps/kolibri-1.0/compose.yaml`, 'services: {}\n')
    fs.writeFileSync(`${root}/instances/${KINST}/compose.yaml`, 'services: {}\n')
    fs.writeFileSync(`${root}/instances/${KINST}/.env`, 'port=18080\n')
    // idea#168 Stage 1: a docked app slot carries its services tar (hard link to the host's staged copy).
    if (opts.services) {
        fs.mkdirSync(`${root}/services`, { recursive: true })
        fs.linkSync(`${sb.host(h).tars}/${KTAR}`, `${root}/services/${KTAR}`)
    }
    const dataDir = `${root}/instances/${KINST}/data/kolibri`
    if (data === 'real') {
        makeKolibriDb(`${dataDir}/db.sqlite3`, { grade5a: opts.grade5a ?? true, walkState: opts.walkState })
        fs.mkdirSync(`${dataDir}/content/storage`, { recursive: true })
        fs.writeFileSync(`${dataDir}/content/storage/video.mp4`, Buffer.from('fake-mp4-bytes'))
    } else if (data === 'symlink') {
        const live = `${sb.dir}/${h}/idea166-kolibri-live/data/kolibri`
        makeKolibriDb(`${live}/db.sqlite3`, { grade5a: opts.grade5a ?? true, walkState: opts.walkState })
        fs.mkdirSync(`${live}/content/storage`, { recursive: true })
        fs.writeFileSync(`${live}/content/storage/video.mp4`, Buffer.from('fake-mp4-bytes'))
        fs.mkdirSync(path.dirname(dataDir), { recursive: true })
        fs.symlinkSync(live, dataDir)
    }
    if (opts.sessions && data !== 'none') plantUnreadableSessions(`${dataDir}/sessions`)
    return root
}

/**
 * idea#168 r35@62: Kolibri's Django file sessions — one file per login, root 0600 on the Pi, so
 * unreadable as pi (no sudo -n on idea01). Here: mode 000 files (the box runs as a non-root
 * user, so they really are unreadable) in a distinctive 0750 dir.
 */
const SESSIONS_MODE = 0o750
const plantUnreadableSessions = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true })
    for (const n of ['sessionid-teacher-r35', 'sessionid-learner-r35']) {
        fs.writeFileSync(`${dir}/${n}`, 'django-session-pickle')
        fs.chmodSync(`${dir}/${n}`, 0o000)
    }
    fs.chmodSync(dir, SESSIONS_MODE)
    expect(() => fs.readFileSync(`${dir}/sessionid-teacher-r35`)).toThrow(/EACCES/)
}
const SESSIONS_REL = `instances/${KINST}/data/kolibri/sessions`

/** RealFleetOps whose SSH runs the generated bash locally against per-host sandboxes. */
class LocalFleetOps extends RealFleetOps {
    readonly cmds: { host: string; cmd: string }[] = []
    readonly relays: { src: string; dst: string; srcCmd: string; dstCmd: string }[] = []
    tamperAfterRelay: ((dstHost: string) => void) | null = null
    constructor(private readonly sb: Sandbox, startInstances = true) {
        super({
            poolEngines: ['idea01', 'idea03', 'idea04'],
            excludeEngines: ['idea02'],
            hosts: HOSTS,
            disksRoot: sb.ROOT,
            watchDir: sb.WATCH,
            fixtureSourceRoot: sb.SEED,
            startInstances,
            sudoMode: 'never',
        })
    }
    /** idea#168 r35@62: simulate a failing stream (the real relay runs first, so staging exists). */
    failRelayWith: string | null = null
    /** idea#168 r35@62: simulate a staging dir that cannot be removed on the target. */
    keepStaging = false
    private localize(host: string, cmd: string): string {
        const p = this.sb.host(host)
        const env = `export PATH=${this.sb.dir}/fakebin:$PATH FAKE_DOCKER_HOST=${host} FAKE_DOCKER_STATE=${this.sb.dir}/${host}/docker.tsv ` +
            `FAKE_DOCKER_LOG=${this.sb.dir}/docker.log FAKE_DOCKER_BROKEN=${this.sb.dir}/${host}/docker.broken; `
        return env + cmd
            .replaceAll(this.sb.ROOT, p.disks)
            .replaceAll(this.sb.WATCH, p.watch)
            .replaceAll(this.sb.SEED, p.seed)
            .replaceAll(this.sb.TARS, p.tars)
            .replaceAll('sleep 5', 'sleep 0')
    }
    protected override async ssh(host: string, cmd: string): Promise<string> {
        this.cmds.push({ host, cmd })
        if (this.keepStaging && cmd.includes('STAGING_LEFT')) cmd = cmd.replace(/\$S rm -rf '[^']*' 2>\/dev\/null; /, '')
        try {
            const { stdout } = await run('bash', ['-c', this.localize(host, cmd)], { maxBuffer: 64 << 20 })
            return stdout
        } catch (e) {
            const err = e as { stderr?: string; code?: number; message?: string }
            throw new Error(`ssh ${host} failed (exit code: ${err.code}): ${err.stderr || err.message}`)
        }
    }
    protected override async relayPipe(src: string, srcCmd: string, dst: string, dstCmd: string): Promise<string> {
        this.relays.push({ src, dst, srcCmd, dstCmd })
        const { stdout } = await run('bash', ['-o', 'pipefail', '-c', 'bash -c "$1" | bash -c "$2"', 'relay',
            this.localize(src, srcCmd), this.localize(dst, dstCmd)], { maxBuffer: 64 << 20 })
        this.tamperAfterRelay?.(dst)
        if (this.failRelayWith) throw new Error(this.failRelayWith)
        return stdout
    }
}

/** In-memory dock state standing in for the Automerge stores (unique mode). */
const stubStore = (ops: LocalFleetOps, sb: Sandbox, initial: Record<string, string | null> = {}, hooks: { afterUndock?: (host: string) => void } = {}) => {
    const docked = new Map<string, string | null>(Object.entries(initial))
    const calls = { undock: [] as string[] }
    const slotOf = (h: string, diskId: string): string | null => {
        for (const s of fixtureSlotNames()) {
            const meta = `${sb.host(h).disks}/${s}/META.yaml`
            if (fs.existsSync(meta) && fs.readFileSync(meta, 'utf8').includes(`diskId: ${diskId}`)) return s
        }
        return null
    }
    Object.assign(ops as object, {
        findDockedEngine: async (d: string) => docked.get(d) ?? null,
        undockFixtures: async (engines: string[], d: string) => {
            calls.undock.push(`${engines.join(',')}:${d}`)
            const on = docked.get(d)
            if (on && engines.includes(on)) {
                const s = slotOf(on, d)
                if (s) fs.rmSync(`${sb.host(on).watch}/${s}`, { force: true })
                docked.set(d, null)
                // The Engine stops the disk's own instance containers on eject (compose `<id>-…`).
                setContainers(sb, on, getContainers(sb, on).filter(c => !c.name.startsWith(`${KINST}-`)))
                hooks.afterUndock?.(on)
            }
        },
        waitDiskUndocked: async (d: string) => {
            if (docked.get(d)) throw new Error(`still docked ${d}`)
        },
        waitDiskDocked: async (engine: string, d: string) => {
            const s = slotOf(engine, d)
            if (!s || !fs.existsSync(`${sb.host(engine).watch}/${s}`)) {
                throw new Error(`RealFleetOps: disk ${d} not docked on ${engine} (no sentinel for a ${d} slot)`)
            }
            docked.set(d, engine)
        },
        readStore: async (engine: string): Promise<SemanticStoreView> => ({
            engineId: engine,
            instanceDB: {},
            diskDB: Object.fromEntries([...docked.entries()].map(([id, on]) => [id, { id, dockedTo: on, device: null }])),
            engineDB: {},
        }),
    })
    return { docked, calls, slotOf }
}

let sb: Sandbox
const savedTarsEnv = { root: process.env.DURATION_SERVICE_TARS_ROOT, mode: process.env.DURATION_SERVICE_TARS }
beforeEach(() => {
    sb = makeSandbox()
    process.env.DURATION_SERVICE_TARS_ROOT = sb.TARS
    delete process.env.DURATION_SERVICE_TARS
})
afterEach(() => {
    fs.rmSync(sb.dir, { recursive: true, force: true })
    for (const [k, v] of [['DURATION_SERVICE_TARS_ROOT', savedTarsEnv.root], ['DURATION_SERVICE_TARS', savedTarsEnv.mode]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
})

describe('idea#168 r34@70: hasHealthyFixtureTree is a LOUD instance-data precondition', () => {
    it('(a) stale tree with matching META but no Kolibri data → dockFixture refuses loudly naming host, path, diskId, what is missing; nothing docked', async () => {
        plantKolibriTree(sb, 'idea03', 'idea-test-1', 'none') // the r34 idea03 tree from 10-01
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb)
        const err = await ops.dockFixture('idea03', KOLIBRI).then(() => null, e => e as Error)
        expect(err).toBeInstanceOf(Error)
        expect(err!.message).toContain(`refuse stale fixture tree idea03:${sb.ROOT}/idea-test-1 (host idea03) for ${KOLIBRI}`)
        expect(err!.message).toContain(`${DB_REL} not found`)
        expect(err!.message).toMatch(/No silent reuse and no silent refresh-from-seed/)
        // No sentinel fired, no copy from the seed pack, nothing docked.
        expect(fs.readdirSync(sb.host('idea03').watch)).toEqual([])
        expect(ops.cmds.some(c => c.cmd.includes('touch '))).toBe(false)
        expect(ops.cmds.some(c => c.cmd.includes('cp -a'))).toBe(false)
        expect(store.docked.get(KOLIBRI) ?? null).toBeNull()
    })

    it('(a) tree whose db.sqlite3 has no Grade 5A classroom (Kolibri booted on an empty dir) → refuses loudly', async () => {
        plantKolibriTree(sb, 'idea03', 'idea-test-1', 'real', { grade5a: false })
        const ops = new LocalFleetOps(sb)
        stubStore(ops, sb)
        await expect(ops.dockFixture('idea03', KOLIBRI)).rejects.toThrow(
            new RegExp(`refuse stale fixture tree idea03:.*idea-test-1.*${KOLIBRI}.*db\\.sqlite3 has no classroom 'Grade 5A' under a facility`),
        )
        expect(fs.readdirSync(sb.host('idea03').watch)).toEqual([])
    })

    it('healthy tree (db.sqlite3 with Grade 5A, real data inside the slot) is reused on the requested engine (regression)', async () => {
        const root = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real', { walkState: 'kept' })
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb)
        await ops.dockFixture('idea01', KOLIBRI)
        expect(store.docked.get(KOLIBRI)).toBe('idea01')
        expect(fs.existsSync(`${sb.host('idea01').watch}/idea-test-1`)).toBe(true)
        // Reused as-is: walk state intact, nothing re-seeded.
        expect(readWalkState(`${root}/${DB_REL}`)).toBe('kept')
    })

    it('two slots with the same diskId on one host → LOUD (never picks one silently)', async () => {
        plantKolibriTree(sb, 'idea03', 'idea-test-1', 'real')
        plantKolibriTree(sb, 'idea03', 'idea-test-6', 'real')
        const ops = new LocalFleetOps(sb)
        stubStore(ops, sb)
        await expect(ops.dockFixture('idea03', KOLIBRI)).rejects.toThrow(/idea03 \(idea03\) holds 2 trees for duration-kolibri-grade5a-001: .*idea-test-1, .*idea-test-6/)
    })

    it('slot scan stays idea-test-1..8: a healthy tree on idea-test-8 is found, one on idea-test-9 is not (→ seed refusal)', async () => {
        expect(FIXTURE_SLOT_COUNT).toBe(8)
        expect(fixtureSlotNames()).toEqual(['idea-test-1', 'idea-test-2', 'idea-test-3', 'idea-test-4', 'idea-test-5', 'idea-test-6', 'idea-test-7', 'idea-test-8'])
        plantKolibriTree(sb, 'idea01', 'idea-test-8', 'real')
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb)
        await ops.dockFixture('idea01', KOLIBRI)
        expect(store.docked.get(KOLIBRI)).toBe('idea01')
        expect(fs.existsSync(`${sb.host('idea01').watch}/idea-test-8`)).toBe(true)

        plantKolibriTree(sb, 'idea04', 'idea-test-9', 'real')
        const ops4 = new LocalFleetOps(sb)
        stubStore(ops4, sb)
        await expect(ops4.dockFixture('idea04', KOLIBRI)).rejects.toThrow(/no duration-kolibri-grade5a-001 tree on idea04 .*idea-test-1\.\.8.*seed pack .* has no instance data/)
    })

    it('no tree on the target + seed pack without instance data → refuses a silent refresh-from-seed (no slot created)', async () => {
        const ops = new LocalFleetOps(sb)
        stubStore(ops, sb)
        const err = await ops.dockFixture('idea03', KOLIBRI).then(() => null, e => e as Error)
        expect(err?.message).toMatch(/Refusing a silent refresh-from-seed \(it would start kolibri-grade5a-001 without instances\/kolibri-grade5a-001\/data\/kolibri\/db\.sqlite3\)/)
        expect(fs.readdirSync(sb.host('idea03').disks)).toEqual([])
    })

    it('dock-only smoke (no --start-instances): META-only Kolibri tree is still reused — instance data not required (regression)', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'none')
        const ops = new LocalFleetOps(sb, false)
        const store = stubStore(ops, sb)
        await ops.dockFixture('idea01', KOLIBRI)
        expect(store.docked.get(KOLIBRI)).toBe('idea01')
    })

    it('empty pack keeps its always-fresh-copy dock (regression): seed copied, README stripped, sentinel fired', async () => {
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb)
        await ops.dockFixture('idea01', EMPTY)
        expect(store.docked.get(EMPTY)).toBe('idea01')
        expect(fs.readdirSync(`${sb.host('idea01').disks}/idea-test-3`).sort()).toEqual(['META.yaml'])
        expect(fs.existsSync(`${sb.host('idea01').watch}/idea-test-3`)).toBe(true)
    })

    it('Nextcloud instance data: installed config.php + data/db required; unreadable config (no sudo) says NOT verified', () => {
        const NC = 'duration-nextcloud-grade5a-001'
        const spec = APP_PACK_INSTANCE_DATA[NC]!
        const root = `${sb.host('idea01').disks}/idea-test-2`
        const d = `${root}/instances/nextcloud-grade5a-001/data`
        const check = () => parseInstanceDataCheck(execFileSync('bash', ['-c', buildInstanceDataCheckRemote({ root, spec, sudoMode: 'never' })]).toString())
        fs.mkdirSync(`${root}/instances/nextcloud-grade5a-001`, { recursive: true })
        expect(check()).toEqual({ ok: false, detail: expect.stringMatching(/data\/nextcloud .* not found or empty/) })
        fs.mkdirSync(`${d}/nextcloud/config`, { recursive: true })
        fs.writeFileSync(`${d}/nextcloud/config/config.php`, "<?php $CONFIG = array ('installed' => false);\n")
        expect(check()).toEqual({ ok: false, detail: expect.stringMatching(/data\/db \(MariaDB datadir\) not found or empty/) })
        fs.mkdirSync(`${d}/db/nextcloud`, { recursive: true })
        expect(check()).toEqual({ ok: false, detail: expect.stringMatching(/has no 'installed' => true/) })
        fs.writeFileSync(`${d}/nextcloud/config/config.php`, "<?php $CONFIG = array (\n  'installed' => true,\n);\n")
        expect(check()).toEqual({ ok: true, detail: expect.stringMatching(/installed=true/) })
        fs.chmodSync(`${d}/nextcloud/config/config.php`, 0o000)
        try {
            expect(check()).toEqual({ ok: true, detail: expect.stringMatching(/installed flag NOT verified/) })
        } finally {
            fs.chmodSync(`${d}/nextcloud/config/config.php`, 0o644)
        }
        fs.rmSync(`${d}/nextcloud/config/config.php`)
        expect(check()).toEqual({ ok: false, detail: expect.stringMatching(/config\.php not found/) })
    })

    it('instance-data check: OK verdict names facility + Grade 5A; parse helpers', async () => {
        const root = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'symlink')
        const out = execFileSync('bash', ['-c', buildInstanceDataCheckRemote({ root, spec: APP_PACK_INSTANCE_DATA[KOLIBRI]!, sudoMode: 'never' })]).toString()
        expect(parseInstanceDataCheck(out)).toEqual({ ok: true, detail: expect.stringMatching(/^facility=Duration Tests Facility class=Grade 5A bytes=\d+$/) })
        expect(KOLIBRI_GRADE5A_CLASS_NAME).toBe('Grade 5A')
        expect(parseInstanceDataCheck('')).toMatchObject({ ok: false })
        expect(sudoPreamble('auto')).toMatch(/sudo -n true/)
        expect(sudoPreamble('never')).toBe(`S=''`)
        const scan = parseFixtureSlotScan(execFileSync('bash', ['-c', buildFixtureSlotScanRemote(sb.host('idea01').disks, KOLIBRI)]).toString())
        expect(scan).toHaveLength(8)
        expect(scan[0]).toEqual({ device: 'idea-test-1', state: 'MATCH', mount: false })
        expect(scan[1]).toEqual({ device: 'idea-test-2', state: 'FREE', mount: false })
    })
})

describe('idea#168 r34@70: moveDisk carries the source disk\'s real tree (no fixture copy, no seed refresh)', () => {
    it('(b) idea01→idea03: target gets the source DB byte-for-byte (same sha256, walk state kept), source quarantined, docked on idea03', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real', { walkState: 'r34-steps-1-61:lesson+quiz+progress', services: true })
        const srcDb = `${sb.host('idea01').disks}/idea-test-1/${DB_REL}`
        const srcHash = sha256(srcDb)
        // Busy idea03 slots: idea-test-1 another pack, idea-test-2 an unrelated dir.
        fs.mkdirSync(`${sb.host('idea03').disks}/idea-test-1`, { recursive: true })
        fs.writeFileSync(`${sb.host('idea03').disks}/idea-test-1/META.yaml`, 'diskId: duration-nextcloud-grade5a-001\n')
        fs.mkdirSync(`${sb.host('idea03').disks}/idea-test-2`, { recursive: true })

        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        fs.writeFileSync(`${sb.host('idea01').watch}/idea-test-1`, '')
        await ops.moveDisk('idea01', 'idea03', KOLIBRI)

        const dst = `${sb.host('idea03').disks}/idea-test-3`
        const dstDb = `${dst}/${DB_REL}`
        expect(fs.lstatSync(`${dst}/instances/${KINST}/data/kolibri`).isDirectory()).toBe(true)
        expect(fs.lstatSync(dstDb).isFile()).toBe(true)
        expect(sha256(dstDb)).toBe(srcHash)
        expect(readWalkState(dstDb)).toBe('r34-steps-1-61:lesson+quiz+progress')
        expect(fs.readFileSync(`${dst}/instances/${KINST}/data/kolibri/content/storage/video.mp4`, 'utf8')).toBe('fake-mp4-bytes')
        expect(fs.readFileSync(`${dst}/META.yaml`, 'utf8')).toContain(`diskId: ${KOLIBRI}`)
        expect(fs.readFileSync(`${dst}/instances/${KINST}/.env`, 'utf8')).toBe('port=18080\n')
        // idea#168 Stage 1: services/*.tar not streamed; the target links ITS staged copy.
        expect(fs.statSync(`${dst}/services/${KTAR}`).ino).toBe(fs.statSync(`${sb.host('idea03').tars}/${KTAR}`).ino)
        expect(fs.readFileSync(`${dst}/services/${KTAR}`, 'utf8')).toBe('kolibri image staged on idea03')
        expect(ops.relays.every(r => r.srcCmd.includes("--exclude='./services'"))).toBe(true)
        // Moved tree passes the Grade 5A precondition on the target.
        const verdict = parseInstanceDataCheck(execFileSync('bash', ['-c', buildInstanceDataCheckRemote({ root: dst, spec: APP_PACK_INSTANCE_DATA[KOLIBRI]!, sudoMode: 'never' })]).toString())
        expect(verdict.ok).toBe(true)
        // Store: docked on the target; sentinel on idea03 only.
        expect(store.docked.get(KOLIBRI)).toBe('idea03')
        expect(fs.existsSync(`${sb.host('idea03').watch}/idea-test-3`)).toBe(true)
        expect(fs.existsSync(`${sb.host('idea01').watch}/idea-test-1`)).toBe(false)
        expect(store.calls.undock).toEqual([`idea01:${KOLIBRI}`])
        // Source: the disk left idea01 — slot gone (quarantined with its data).
        expect(fs.existsSync(`${sb.host('idea01').disks}/idea-test-1`)).toBe(false)
        const moved = fs.readdirSync(`${sb.host('idea01').disks}/.moved-away`)
        expect(moved).toHaveLength(1)
        expect(moved[0]).toMatch(/^idea-test-1-duration-kolibri-grade5a-001-/)
        expect(sha256(`${sb.host('idea01').disks}/.moved-away/${moved[0]}/${DB_REL}`)).toBe(srcHash)
        // No staging left; nothing came from the seed pack; no cp -a fixture copy.
        expect(fs.readdirSync(sb.host('idea03').disks).filter(n => n.startsWith('.incoming'))).toEqual([])
        expect([...ops.cmds.map(c => c.cmd), ...ops.relays.flatMap(r => [r.srcCmd, r.dstCmd])].some(c => c.includes(sb.SEED) || c.includes('cp -a'))).toBe(false)
        // One stream (the slot); no external-link stream any more (idea#168 r35@62).
        expect(ops.relays.map(r => `${r.src}→${r.dst}`)).toEqual(['idea01→idea03'])
        // Mount scans before and after the eject on the source; read-only docker only.
        expect(ops.cmds.filter(c => c.cmd.includes('MOUNT_SCAN_END')).map(c => c.host)).toEqual(['idea01', 'idea01'])
        expect(dockerLog(sb).every(l => / (ps|inspect)\b/.test(l))).toBe(true)
    })

    it('(b) target already holds a stale tree for the disk (the r34 idea03 idea-test-1) → LOUD before eject; source untouched', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real')
        plantKolibriTree(sb, 'idea03', 'idea-test-1', 'none')
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        await expect(ops.moveDisk('idea01', 'idea03', KOLIBRI)).rejects.toThrow(
            new RegExp(`target idea03 could not take ${KOLIBRI}: target idea03 \\(idea03\\) already holds a tree for ${KOLIBRI} at .*idea-test-1 \\(stale duplicate\\).*refusing to reuse or overwrite`),
        )
        expect(store.calls.undock).toEqual([])
        expect(store.docked.get(KOLIBRI)).toBe('idea01')
        expect(fs.existsSync(`${sb.host('idea01').disks}/idea-test-1/${DB_REL}`)).toBe(true)
        expect(ops.relays).toEqual([])
    })

    it('(b) source tree is itself stale (META only) → LOUD before eject, no transfer', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'none')
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        await expect(ops.moveDisk('idea01', 'idea03', KOLIBRI)).rejects.toThrow(/refuse stale fixture tree idea01:.*idea-test-1.*db\.sqlite3 not found/)
        expect(store.calls.undock).toEqual([])
        expect(ops.relays).toEqual([])
    })

    it('(b) content mismatch after transfer → staging removed, source tree intact, LOUD; target never docked', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real')
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        ops.tamperAfterRelay = dst => {
            const f = `${sb.host(dst).disks}/.incoming-idea-test-1-${KOLIBRI}/${DB_REL}`
            if (fs.existsSync(f)) fs.appendFileSync(f, 'x')
        }
        await expect(ops.moveDisk('idea01', 'idea03', KOLIBRI)).rejects.toThrow(/content mismatch after transfer.*Staging idea03:.*removed \(verified absent\); source tree left intact \(undocked\) at idea01:.*idea-test-1/)
        expect(fs.readdirSync(sb.host('idea03').disks)).toEqual([])
        expect(fs.existsSync(`${sb.host('idea01').disks}/idea-test-1/${DB_REL}`)).toBe(true)
        expect(store.docked.get(KOLIBRI) ?? null).toBeNull()
    })

    it('dockFixture on another engine while the app disk is docked elsewhere carries the real tree (moveDisk), not a seed copy', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real', { walkState: 'before-redock' })
        const srcHash = sha256(`${sb.host('idea01').disks}/idea-test-1/${DB_REL}`)
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        await ops.dockFixture('idea04', KOLIBRI)
        expect(store.docked.get(KOLIBRI)).toBe('idea04')
        const dstDb = `${sb.host('idea04').disks}/idea-test-1/${DB_REL}`
        expect(sha256(dstDb)).toBe(srcHash)
        expect(readWalkState(dstDb)).toBe('before-redock')
    })

    it('move plan / tar / quarantine builders: the plan still REPORTS links out of the slot (moveDisk refuses them); mount points refused', async () => {
        const root = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'symlink')
        const plan = parseMovePlan(execFileSync('bash', ['-c', buildMovePlanRemote(root, 'never')]).toString())
        expect(plan.error).toBeNull()
        expect(plan.mountFsType).toBeNull()
        expect(plan.instances).toEqual([KINST])
        expect(plan.extLinks).toEqual([{ rel: `instances/${KINST}/data/kolibri`, target: `${sb.dir}/idea01/idea166-kolibri-live/data/kolibri` }])
        expect(buildTreeSendRemote('/x/idea-test-1', [`instances/${KINST}/data/kolibri`], 'auto'))
            .toMatch(/cd '\/x\/idea-test-1' && \$S tar --numeric-owner -cpf - --exclude='\.\/instances\/kolibri-grade5a-001\/data\/kolibri' \.$/)
        expect(buildQuarantineSourceRemote('/x/idea-test-1', '/x/.moved-away/q')).toMatch(/refuse quarantine of mount point/)
        expect(parseMovePlan('PLAN_END')).toMatchObject({ error: null })
        expect(parseMovePlan('')).toMatchObject({ error: expect.stringMatching(/incomplete/) })
    })
})

describe('idea#168 r35@62: Kolibri root-0600 session files are left out of the move and recreated empty', () => {
    const spec = APP_PACK_INSTANCE_DATA[KOLIBRI]!

    it('pack spec: Kolibri skips data/kolibri/sessions; Nextcloud skips nothing; tar pattern is the unanchored tail', () => {
        expect(spec.moveSkipDirs).toEqual([SESSIONS_REL])
        expect(APP_PACK_INSTANCE_DATA['duration-nextcloud-grade5a-001']!.moveSkipDirs).toBeUndefined()
        expect(skipDirTarPattern(SESSIONS_REL)).toBe('kolibri/sessions')
    })

    it('generated tar command carries the exclude, and GNU tar really drops ./instances/…/kolibri/sessions', () => {
        const send = buildTreeSendRemote('/x/idea-test-1', [], 'never', ['kolibri/sessions'])
        expect(send).toMatch(/cd '\/x\/idea-test-1' && \$S tar --numeric-owner -cpf - --exclude='kolibri\/sessions' \.$/)

        // Real layout (data/kolibri a real dir in the slot): member ./instances/…/data/kolibri/sessions.
        const realRoot = plantKolibriTree(sb, 'idea03', 'idea-test-1', 'real', { sessions: true })
        const realList = execFileSync('bash', ['-o', 'pipefail', '-c', `${buildTreeSendRemote(realRoot, [], 'never', ['kolibri/sessions'])} | tar -tf -`]).toString()
        expect(realList).toContain(`./${DB_REL}\n`)
        expect(realList).toContain(`./instances/${KINST}/data/kolibri/content/storage/video.mp4`)
        expect(realList).not.toMatch(/sessions/)
        // Sanity: without the exclude, tar as a non-root user fails on the 0600/000 session files.
        expect(() => execFileSync('bash', ['-o', 'pipefail', '-c', `${buildTreeSendRemote(realRoot, [], 'never')} | tar -tf - >/dev/null`], { stdio: 'pipe' })).toThrow()
    })

    it('digest prunes sessions (find -L … -path \'*/kolibri/sessions\' -prune) on an unreadable tree; same digest as the tree without sessions', () => {
        const cmd = buildTreeDigestRemote('/x', DB_REL, 'never', ['kolibri/sessions'])
        expect(cmd).toContain(`find -L . \\( -path '*/kolibri/sessions' \\) -prune -o -type f -print0`)
        expect(cmd.match(/-prune/g)).toHaveLength(2) // count + hash
        const withS = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real', { sessions: true })
        const noS = plantKolibriTree(sb, 'idea03', 'idea-test-1', 'real')
        fs.copyFileSync(`${withS}/${DB_REL}`, `${noS}/${DB_REL}`)
        const dig = (root: string, pats: string[]) => parseTreeDigest(execFileSync('bash', ['-c', buildTreeDigestRemote(root, DB_REL, 'never', pats)], { stdio: 'pipe' }).toString())
        const a = dig(withS, ['kolibri/sessions'])
        const b = dig(noS, ['kolibri/sessions'])
        expect(a).toMatchObject({ files: 6, key: sha256(`${noS}/${DB_REL}`) })
        expect(b).toEqual(a)
        // Sanity: the unpruned digest (b40b8a0) fails on the unreadable session files.
        expect(dig(withS, [])).toMatchObject({ error: expect.stringMatching(/DIGEST_ERR hashing failed/) })
    })

    it('move plan prunes sessions from its link walk and reports the source sessions dir mode/owner', () => {
        const root = plantKolibriTree(sb, 'idea03', 'idea-test-1', 'real', { sessions: true })
        const cmd = buildMovePlanRemote(root, 'never', [SESSIONS_REL])
        expect(cmd).toContain(`find . \\( -path './${SESSIONS_REL}' \\) -prune -o -type l -print0`)
        const plan = parseMovePlan(execFileSync('bash', ['-c', cmd]).toString())
        expect(plan.error).toBeNull()
        const st = fs.statSync(`${root}/${SESSIONS_REL}`)
        expect(plan.skipDirs).toEqual([{ rel: SESSIONS_REL, mode: '750', uid: st.uid, gid: st.gid }])
        // Absent sessions dir: not listed (target falls back to 1777).
        fs.rmSync(`${root}/${SESSIONS_REL}`, { recursive: true, force: true })
        expect(parseMovePlan(execFileSync('bash', ['-c', cmd]).toString()).skipDirs).toEqual([])
    })

    it('recreate: source mode/owner when chown works; 1777 when the source is unknown or chown to it fails; skipped without a parent', () => {
        const st = path.join(sb.dir, 'staging')
        fs.mkdirSync(`${st}/a/kolibri`, { recursive: true })
        fs.mkdirSync(`${st}/b/kolibri`, { recursive: true })
        fs.mkdirSync(`${st}/c/kolibri`, { recursive: true })
        const me = os.userInfo()
        const out = execFileSync('bash', ['-c', buildRecreateSkipDirsRemote(st, [
            { rel: 'a/kolibri/sessions', src: { mode: '750', uid: me.uid, gid: me.gid } },
            { rel: 'b/kolibri/sessions', src: null },
            { rel: 'c/kolibri/sessions', src: { mode: '700', uid: 0, gid: 0 } }, // root-owned source, no sudo on the target
            { rel: 'd/kolibri/sessions', src: null },
        ], 'never')]).toString()
        const mode = (p: string) => (fs.statSync(p).mode & 0o7777).toString(8)
        expect(mode(`${st}/a/kolibri/sessions`)).toBe('750')
        expect(mode(`${st}/b/kolibri/sessions`)).toBe('1777')
        expect(mode(`${st}/c/kolibri/sessions`)).toBe('1777')
        expect(fs.existsSync(`${st}/d`)).toBe(false)
        for (const x of ['a', 'b', 'c']) expect(fs.readdirSync(`${st}/${x}/kolibri/sessions`)).toEqual([])
        expect(out).toMatch(/SKIPDIR a\/kolibri\/sessions recreated empty mode=750 owner=\d+:\d+ \(as source\)/)
        expect(out).toMatch(/SKIPDIR c\/kolibri\/sessions recreated empty mode=1777 \(could not chown to source owner 0:0\)/)
        expect(out).toMatch(/SKIPDIR d\/kolibri\/sessions not recreated/)
    })

    it('(r35@62) idea01→idea03 with UNREADABLE session files in data/kolibri: move succeeds, db.sqlite3 sha256 matches, target has an EMPTY sessions dir (source mode)', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real', { sessions: true, walkState: 'r35-steps-1-61' })
        const srcHash = sha256(`${sb.host('idea01').disks}/idea-test-1/${DB_REL}`)
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        fs.writeFileSync(`${sb.host('idea01').watch}/idea-test-1`, '')
        await ops.moveDisk('idea01', 'idea03', KOLIBRI)

        const dst = `${sb.host('idea03').disks}/idea-test-1`
        expect(sha256(`${dst}/${DB_REL}`)).toBe(srcHash)
        expect(readWalkState(`${dst}/${DB_REL}`)).toBe('r35-steps-1-61')
        const sess = `${dst}/${SESSIONS_REL}`
        expect(fs.lstatSync(sess).isDirectory()).toBe(true)
        expect(fs.readdirSync(sess)).toEqual([])
        expect(fs.statSync(sess).mode & 0o7777).toBe(SESSIONS_MODE)
        expect(store.docked.get(KOLIBRI)).toBe('idea03')
        // Every stream and digest carried the exclude / prune.
        expect(ops.relays.map(r => r.srcCmd).every(c => c.includes(`--exclude='kolibri/sessions'`))).toBe(true)
        expect(ops.cmds.filter(c => c.cmd.includes('DIGEST files=')).map(c => c.host).sort()).toEqual(['idea01', 'idea03'])
        // (idea#168 Stage 1: ./services, re-linked on the target, is pruned in the same group.)
        expect(ops.cmds.filter(c => c.cmd.includes('DIGEST files=')).every(c => /-path '\*\/kolibri\/sessions'( -o -path '\.\/services')? -o -path '\.\/META\.yaml' \\\) -prune/.test(c.cmd))).toBe(true)
        // idea#168 r38: META.yaml is compared parsed (diskId + created) on both sides, never in the byte digest.
        expect(ops.cmds.filter(c => c.cmd.includes('@@META_BEGIN@@')).map(c => c.host).sort()).toEqual(['idea01', 'idea03'])
        // Source session files untouched (quarantined with the source slot on idea01).
        const q = fs.readdirSync(`${sb.host('idea01').disks}/.moved-away`)[0]!
        expect(fs.readdirSync(`${sb.host('idea01').disks}/.moved-away/${q}/${SESSIONS_REL}`).sort()).toEqual(['sessionid-learner-r35', 'sessionid-teacher-r35'])
    })

    it('(r35) real-dir layout idea03→idea04 with unreadable sessions: move succeeds, sessions recreated empty, db hash matches', async () => {
        plantKolibriTree(sb, 'idea03', 'idea-test-2', 'real', { sessions: true, walkState: 'after-r35-move' })
        const srcHash = sha256(`${sb.host('idea03').disks}/idea-test-2/${DB_REL}`)
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea03' })
        fs.writeFileSync(`${sb.host('idea03').watch}/idea-test-2`, '')
        await ops.moveDisk('idea03', 'idea04', KOLIBRI)
        const dst = `${sb.host('idea04').disks}/idea-test-1`
        expect(sha256(`${dst}/${DB_REL}`)).toBe(srcHash)
        expect(fs.readdirSync(`${dst}/${SESSIONS_REL}`)).toEqual([])
        expect(fs.statSync(`${dst}/${SESSIONS_REL}`).mode & 0o7777).toBe(SESSIONS_MODE)
        expect(store.docked.get(KOLIBRI)).toBe('idea04')
        expect(ops.relays).toHaveLength(1)
    })

    it('(r35) source without a sessions dir: target still gets one (1777) so Django file sessions work', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real')
        const ops = new LocalFleetOps(sb)
        stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        await ops.moveDisk('idea01', 'idea03', KOLIBRI)
        const sess = `${sb.host('idea03').disks}/idea-test-1/${SESSIONS_REL}`
        expect(fs.readdirSync(sess)).toEqual([])
        expect(fs.statSync(sess).mode & 0o7777).toBe(0o1777)
    })
})

describe('idea#168 r35@62: symlinks out of the slot are refused LOUDLY (dock + move); foreign mounts block the move; failure state is explicit', () => {
    const LIVE = () => `${sb.dir}/idea01/idea166-kolibri-live/data/kolibri`
    const ZOMBIE = 'y3zvlf9ug1t8wgod3uu'
    const OWN = { id: 'c0ffee000001', name: `${KINST}-kolibri-1` }
    /** The @43 copy_app copy on the Nextcloud disk (idea-test-2): data/kolibri is a link to `linkTo`. */
    const plantZombieCopy = (h: string, linkTo: string) => {
        const nc = `${sb.host(h).disks}/idea-test-2`
        fs.mkdirSync(`${nc}/instances/${ZOMBIE}/data/docker`, { recursive: true })
        fs.writeFileSync(`${nc}/META.yaml`, 'diskId: duration-nextcloud-grade5a-001\n')
        fs.writeFileSync(`${nc}/instances/${ZOMBIE}/.env`, 'port=51308\nKOLIBRI_HTTP_PORT=18080\n')
        fs.symlinkSync(linkTo, `${nc}/instances/${ZOMBIE}/data/kolibri`)
        return { id: 'ddc7c065ff91', name: `${ZOMBIE}-kolibri-1`, mounts: [`${nc}/instances/${ZOMBIE}/data/docker`, `${nc}/instances/${ZOMBIE}/data/kolibri`] }
    }
    const noStopCalls = () => expect(dockerLog(sb).filter(l => !/^\S+ (ps|inspect)\b/.test(l))).toEqual([])

    it('dockFixture refuses the Path A layout (data/kolibri → idea166-kolibri-live) naming host, link, target, diskId; nothing docked, not followed', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'symlink')
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb)
        const err = await ops.dockFixture('idea01', KOLIBRI).then(() => null, e => e as Error)
        expect(err?.message).toContain(`refuse fixture tree idea01:${sb.ROOT}/idea-test-1 (host idea01) for ${KOLIBRI}: 1 symlink(s) resolve OUTSIDE the slot`)
        expect(err?.message).toContain(`${sb.ROOT}/idea-test-1/instances/${KINST}/data/kolibri → ${LIVE()}`)
        expect(err?.message).toMatch(/copy_app would copy the link and the copy would share this live data \(idea#168 r35@62\).*Not materialized, not followed/)
        expect(store.docked.get(KOLIBRI) ?? null).toBeNull()
        expect(fs.readdirSync(sb.host('idea01').watch)).toEqual([])
        // Refused before the instance-data check (which would follow the link).
        expect(ops.cmds.some(c => c.cmd.includes('INSTANCE_DATA_OK'))).toBe(false)
    })

    it('ANY path in the slot linking out (not only app data) is refused; a relative link that stays inside the slot is fine', async () => {
        const root = plantKolibriTree(sb, 'idea03', 'idea-test-1', 'real')
        fs.symlinkSync('kolibri/content', `${root}/instances/${KINST}/data/content-link`) // inside: OK
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb)
        await ops.dockFixture('idea03', KOLIBRI)
        expect(store.docked.get(KOLIBRI)).toBe('idea03')

        const outside = path.join(sb.dir, 'host-icon.png')
        fs.writeFileSync(outside, 'png')
        fs.symlinkSync(outside, `${root}/apps/kolibri-1.0/icon.png`)
        const ops2 = new LocalFleetOps(sb)
        stubStore(ops2, sb)
        await expect(ops2.dockFixture('idea03', KOLIBRI)).rejects.toThrow(
            new RegExp(`refuse fixture tree idea03:.*idea-test-1 \\(host idea03\\) for ${KOLIBRI}: 1 symlink\\(s\\) resolve OUTSIDE the slot — .*apps/kolibri-1\\.0/icon\\.png → ${outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        )
    })

    it('link scan builder: LINK_OUT names rel, link text, target; inside/relative links pass; dangling-outside reported; parse needs LINKS_END', () => {
        const root = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'symlink')
        fs.symlinkSync('../../META.yaml', `${root}/instances/${KINST}/meta-link`)
        fs.symlinkSync('/nonexistent-dir/x', `${root}/apps/gone`)
        const scan = parseSlotLinkScan(execFileSync('bash', ['-c', buildSlotLinkScanRemote(root, 'never', [SESSIONS_REL])]).toString())
        expect(scan.error).toBeNull()
        expect(scan.outside.sort((a, b) => a.rel.localeCompare(b.rel))).toEqual([
            { rel: 'apps/gone', raw: '/nonexistent-dir/x', target: '/nonexistent-dir/x' },
            { rel: `instances/${KINST}/data/kolibri`, raw: LIVE(), target: LIVE() },
        ])
        expect(parseSlotLinkScan('')).toMatchObject({ error: expect.stringMatching(/incomplete/) })
        expect(parseSlotLinkScan('LINKS_ERR slot /x missing\nLINKS_END').error).toBe('slot /x missing')
    })

    it('(r35 shape) moveDisk: symlinked source + zombie copy on the NC disk writing the same live dir → refused BEFORE the eject; zombie NOT stopped; nothing streamed', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'symlink', { walkState: 'r35' })
        const zombie = plantZombieCopy('idea01', LIVE())
        setContainers(sb, 'idea01', [zombie])
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        fs.writeFileSync(`${sb.host('idea01').watch}/idea-test-1`, '')
        const err = await ops.moveDisk('idea01', 'idea03', KOLIBRI).then(() => null, e => e as Error)
        expect(err?.message).toMatch(new RegExp(`target idea03 could not take ${KOLIBRI}: RealFleetOps: refuse fixture tree idea01:.*idea-test-1 \\(host idea01\\) for ${KOLIBRI}: 1 symlink\\(s\\) resolve OUTSIDE the slot`))
        expect(err?.message).toContain(`instances/${KINST}/data/kolibri → ${LIVE()}`)
        expect(err?.message).toMatch(/move_duration_ms=\d+/)
        expect(store.calls.undock).toEqual([])
        expect(store.docked.get(KOLIBRI)).toBe('idea01')
        expect(fs.existsSync(`${sb.host('idea01').watch}/idea-test-1`)).toBe(true)
        expect(ops.relays).toEqual([])
        expect(getContainers(sb, 'idea01').map(c => c.name)).toEqual([`${ZOMBIE}-kolibri-1`])
        noStopCalls()
        expect(fs.readdirSync(sb.host('idea03').disks)).toEqual([])
    })

    it('foreign container whose mount resolves INSIDE the source slot (zombie copy linking into the source data) → refused BEFORE the eject, naming container + paths; own instance is not foreign; never stopped', async () => {
        const root = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real', { walkState: 'r36' })
        const srcData = `${root}/instances/${KINST}/data/kolibri`
        const zombie = plantZombieCopy('idea01', srcData)
        setContainers(sb, 'idea01', [{ ...OWN, mounts: [srcData, `${root}/instances/${KINST}/data/docker`] }, zombie])
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        const err = await ops.moveDisk('idea01', 'idea03', KOLIBRI).then(() => null, e => e as Error)
        const msg = err?.message ?? ''
        expect(msg).toContain(`refuse to eject/move ${KOLIBRI}: on idea01 (idea01) running container(s) that are not instances of ${KOLIBRI} (${KINST}) use data inside its slot ${sb.ROOT}/idea-test-1`)
        expect(msg).toContain(`${ZOMBIE}-kolibri-1 mounts ${sb.host('idea01').disks}/idea-test-2/instances/${ZOMBIE}/data/kolibri (→ ${srcData})`)
        expect(msg).not.toContain(`${KINST}-kolibri-1 mounts`)
        expect(msg).toMatch(/NOT stopping them \(the harness never stops foreign containers\).*Nothing changed: duration-kolibri-grade5a-001 still docked on idea01/)
        expect(store.calls.undock).toEqual([])
        expect(store.docked.get(KOLIBRI)).toBe('idea01')
        expect(ops.relays).toEqual([])
        expect(getContainers(sb, 'idea01').map(c => c.name)).toEqual([OWN.name, `${ZOMBIE}-kolibri-1`])
        noStopCalls()
    })

    it('own instance containers only → allowed (the eject stops them); the post-eject re-scan finds nothing; move succeeds', async () => {
        const root = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real')
        setContainers(sb, 'idea01', [{ ...OWN, mounts: [`${root}/instances/${KINST}/data/kolibri`] }])
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        await ops.moveDisk('idea01', 'idea03', KOLIBRI)
        expect(store.docked.get(KOLIBRI)).toBe('idea03')
        expect(isOwnInstanceContainer(OWN.name, [KINST])).toBe(true)
        expect(isOwnInstanceContainer(`${ZOMBIE}-kolibri-1`, [KINST])).toBe(false)
        noStopCalls()
    })

    it('a container that starts using the slot AFTER the eject → refused before the tar; source left EJECTED (said so), no staging on the target', async () => {
        const root = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real')
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' }, {
            afterUndock: h => setContainers(sb, h, [{ id: 'late00000001', name: 'late-writer-1', mounts: [`${root}/instances/${KINST}/data/kolibri`] }]),
        })
        fs.writeFileSync(`${sb.host('idea01').watch}/idea-test-1`, '')
        const err = await ops.moveDisk('idea01', 'idea03', KOLIBRI).then(() => null, e => e as Error)
        expect(err?.message).toMatch(/refuse to stream duration-kolibri-grade5a-001: after the eject on idea01 \(idea01\) running container\(s\) still use data inside .*idea-test-1 — late-writer-1 mounts /)
        expect(err?.message).toMatch(/Source: duration-kolibri-grade5a-001 left EJECTED on idea01 \(undocked, sentinel .*idea-test-1 removed\), tree intact at idea01:.*idea-test-1; NOT re-docked by the harness.*No staging created on idea03/)
        expect(store.docked.get(KOLIBRI) ?? null).toBeNull()
        expect(ops.relays).toEqual([])
        expect(fs.readdirSync(sb.host('idea03').disks)).toEqual([])
        expect(fs.existsSync(`${root}/${DB_REL}`)).toBe(true)
        noStopCalls()
    })

    it('docker cannot be asked on the source → refused before the eject (no silent pass)', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real')
        fs.writeFileSync(`${sb.dir}/idea01/docker.broken`, '')
        const ops = new LocalFleetOps(sb)
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        await expect(ops.moveDisk('idea01', 'idea03', KOLIBRI)).rejects.toThrow(
            /cannot list the running containers' mounts on idea01 \(idea01\) — docker ps failed: Cannot connect to the Docker daemon.*refusing \(no silent pass\)/,
        )
        expect(store.calls.undock).toEqual([])
        expect(store.docked.get(KOLIBRI)).toBe('idea01')
    })

    it('failed stream (tar "file changed as we read it", exit 1) stays a failure: staging verified gone on the target, source left EJECTED + intact (said so), duration in the error', async () => {
        const root = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real', { walkState: 'r35-62' })
        const srcHash = sha256(`${root}/${DB_REL}`)
        const ops = new LocalFleetOps(sb)
        ops.failRelayWith = 'ssh relay idea01→idea03 failed (exit code: 1): tar: kolibri: file changed as we read it'
        const store = stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        fs.writeFileSync(`${sb.host('idea01').watch}/idea-test-1`, '')
        const logs: string[] = []
        const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
        let err: Error | null = null
        try {
            err = await ops.moveDisk('idea01', 'idea03', KOLIBRI).then(() => null, e => e as Error)
        } finally {
            spy.mockRestore()
        }
        const msg = err?.message ?? ''
        expect(msg).toMatch(/tar: kolibri: file changed as we read it/)
        expect(msg).toMatch(new RegExp(`Staging idea03:.*\\.incoming-idea-test-1-${KOLIBRI} removed \\(verified absent\\); source tree left intact \\(undocked\\) at idea01:.*idea-test-1`))
        expect(msg).toMatch(/Source: duration-kolibri-grade5a-001 left EJECTED on idea01 .*NOT re-docked by the harness/)
        expect(msg).toMatch(/\[move_duration_ms=\d+; failed after \d+ms \(preflight \d+ms, eject \d+ms\)\]/)
        expect(fs.readdirSync(sb.host('idea03').disks)).toEqual([])
        expect(sha256(`${root}/${DB_REL}`)).toBe(srcHash)
        expect(store.docked.get(KOLIBRI) ?? null).toBeNull()
        expect(fs.existsSync(`${sb.host('idea01').watch}/idea-test-1`)).toBe(false)
        expect(logs.some(l => /moveDisk duration-kolibri-grade5a-001 idea01→idea03: FAILED after \d+ms/.test(l))).toBe(true)
    })

    it('failed stream whose staging cannot be removed → the error says it is NOT removed (no false "removed")', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real')
        const ops = new LocalFleetOps(sb)
        ops.failRelayWith = 'tar: kolibri: file changed as we read it'
        ops.keepStaging = true
        stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        await expect(ops.moveDisk('idea01', 'idea03', KOLIBRI)).rejects.toThrow(
            /Staging idea03:.*\.incoming-idea-test-1-duration-kolibri-grade5a-001 NOT removed \(still there: .*\) — remove it before the next run/,
        )
        expect(fs.readdirSync(sb.host('idea03').disks)).toEqual([`.incoming-idea-test-1-${KOLIBRI}`])
        const st = path.join(sb.dir, 'st')
        expect(execFileSync('bash', ['-c', buildStagingCleanupRemote(st, 'never')]).toString().trim()).toBe('STAGING_GONE')
    })

    it('successful move logs its duration with phases', async () => {
        plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real')
        const ops = new LocalFleetOps(sb)
        stubStore(ops, sb, { [KOLIBRI]: 'idea01' })
        const logs: string[] = []
        const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
        try {
            await ops.moveDisk('idea01', 'idea03', KOLIBRI)
        } finally {
            spy.mockRestore()
        }
        expect(logs.some(l => /\[RealFleetOps\] moveDisk duration-kolibri-grade5a-001 idea01→idea03: done in \d+ms \(preflight \d+ms, eject \d+ms, stream \d+ms, verify\+commit \d+ms, dock \d+ms\)/.test(l))).toBe(true)
    })

    it('mount scan builder: literal and resolved mount sources inside the roots are hits; outside ones are not; parse needs MOUNT_SCAN_END', () => {
        const root = plantKolibriTree(sb, 'idea01', 'idea-test-1', 'real')
        const zombie = plantZombieCopy('idea01', `${root}/instances/${KINST}/data/kolibri`)
        setContainers(sb, 'idea01', [
            { ...OWN, mounts: [`${root}/instances/${KINST}/data/kolibri`] },
            zombie,
            { id: 'kiwix0000001', name: 'idea166-kiwix-live', mounts: [`${sb.dir}/idea01/idea166-kiwix-live/data`] },
        ])
        const env = `export PATH=${sb.dir}/fakebin:$PATH FAKE_DOCKER_HOST=idea01 FAKE_DOCKER_STATE=${dockerState(sb, 'idea01')} FAKE_DOCKER_LOG=${sb.dir}/docker.log FAKE_DOCKER_BROKEN=${sb.dir}/none; `
        const res = parseMountScan(execFileSync('bash', ['-c', env + buildMountScanRemote([root])]).toString())
        expect(res.error).toBeNull()
        expect(res.hits).toEqual([
            { container: OWN.name, source: `${root}/instances/${KINST}/data/kolibri`, resolved: `${root}/instances/${KINST}/data/kolibri` },
            { container: zombie.name, source: zombie.mounts[1], resolved: `${root}/instances/${KINST}/data/kolibri` },
        ])
        expect(buildMountScanRemote(['/x'])).toContain(`docker inspect --format '{{$n := .Name}}{{range .Mounts}}{{$n}}{{"\\t"}}{{.Source}}{{println}}{{end}}'`)
        expect(buildMountScanRemote(['/x'])).not.toMatch(/docker (stop|kill|rm|restart)/)
        expect(parseMountScan('')).toMatchObject({ error: expect.stringMatching(/incomplete/) })
        expect(parseMountScan('MOUNT_SCAN_ERR docker ps failed: x\nMOUNT_SCAN_END').error).toBe('docker ps failed: x')
    })
})
