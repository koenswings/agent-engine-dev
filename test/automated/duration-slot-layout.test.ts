/**
 * idea#168 (Steve GO, option a) — app-data root helper slot safety.
 *
 * The slot builders run as real bash against a sandbox disks root on the box; the preflight
 * verdict is checked against probe outputs (helper present / absent) and through RealFleetOps
 * with a canned ssh.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    APP_DATA_HELPER,
    APP_DATA_ROOTS_FILE,
    EXIT_SLOT_PREFLIGHT,
    REQUIRED_SLOT_COUNT,
    assertSlotPath,
    buildAssertEmptySlotRemote,
    buildEmptySlotRemote,
    buildQuarantineSlotContentsRemote,
    buildSlotLayoutProbeRemote,
    movedAwayRoot,
    parseSlotLayoutProbe,
    requiredSlotNames,
    slotLayoutVerdict,
} from '../duration/slotLayout.js'
import { RealFleetOps, buildSshDockCopyRemote, buildFixtureSlotScanRemote, parseFixtureSlotScan } from '../duration/realFleetOps.js'

let dir = ''
let ROOT = ''
const bash = (script: string, env: Record<string, string> = {}) => {
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } })
    return { code: r.status, out: r.stdout, err: r.stderr }
}
const ino = (p: string) => fs.statSync(p).ino

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-layout-'))
    ROOT = `${dir}/duration-disks`
    fs.mkdirSync(ROOT)
})
afterEach(() => {
    spawnSync('bash', ['-c', `chmod -R u+w ${JSON.stringify(dir)} 2>/dev/null; rm -rf ${JSON.stringify(dir)}`])
})

const fillSlot = (slot: string) => {
    const p = `${ROOT}/${slot}`
    fs.mkdirSync(`${p}/apps/a`, { recursive: true })
    fs.mkdirSync(`${p}/.dotdir/deep`, { recursive: true })
    fs.writeFileSync(`${p}/META.yaml`, 'diskId: duration-empty-001\n')
    fs.writeFileSync(`${p}/.env`, 'x=1\n')
    fs.writeFileSync(`${p}/..odd`, 'odd\n')
    fs.writeFileSync(`${p}/-rf`, 'dash name\n')
    fs.writeFileSync(`${p}/name with spaces*`, 'glob chars\n')
    fs.mkdirSync(`${p}/lost+found`)
    return p
}

describe('emptying a slot keeps the dir', () => {
    it('legacy + helper: every entry incl. dotfiles, "-rf", glob chars removed; lost+found and the dir (same inode) kept; siblings and the root untouched', () => {
        for (const mode of ['legacy', 'helper'] as const) {
            const p = fillSlot('idea-test-2')
            fs.mkdirSync(`${ROOT}/idea-test-1`, { recursive: true })
            fs.writeFileSync(`${ROOT}/idea-test-1/keep`, 'sibling')
            fs.writeFileSync(`${ROOT}/root-file`, 'root')
            const before = ino(p)
            const r = bash(buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-2', mode }))
            expect(r.code, r.err).toBe(0)
            expect(r.out).toContain(`SLOT_EMPTIED ${p}`)
            expect(ino(p)).toBe(before)
            expect(fs.readdirSync(p)).toEqual(['lost+found'])
            expect(fs.readFileSync(`${ROOT}/idea-test-1/keep`, 'utf8')).toBe('sibling')
            expect(fs.readdirSync(ROOT).sort()).toEqual(['idea-test-1', 'idea-test-2', 'root-file'])
            fs.rmSync(`${ROOT}/idea-test-1`, { recursive: true }); fs.rmSync(`${ROOT}/root-file`); fs.rmSync(p, { recursive: true })
        }
    })

    it('keep list (empty-pack strip): META.yaml stays, the rest goes', () => {
        const p = fillSlot('idea-test-3')
        const r = bash(buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-3', mode: 'legacy', keep: ['META.yaml'] }))
        expect(r.code, r.err).toBe(0)
        expect(fs.readdirSync(p).sort()).toEqual(['META.yaml', 'lost+found'])
    })

    it('the generated script never globs: removal is find . -mindepth 1 -maxdepth 1 after cd -P into the slot', () => {
        const s = buildEmptySlotRemote({ disksRoot: '/home/pi/idea/duration-disks', slot: 'idea-test-4', mode: 'helper' })
        expect(s).toContain(`cd -P -- "$_sp"`)
        expect(s).toContain(`find . -mindepth 1 -maxdepth 1 ! -name 'lost+found' -exec rm -rf --one-file-system -- {} +`)
        expect(s).not.toMatch(/rm -rf[^;]*\*/)
        expect(s).not.toMatch(/rmdir|mkdir/)
        expect(s).not.toMatch(/rm -rf[^;]*"\$_sp"/)
    })

    it('helper: instances/<id> go through `sudo -n /usr/local/sbin/idea-app-data delete <slot> <id>` (exact argv) BEFORE anything else; pi-unremovable data is gone; never rm on it', () => {
        const p = fillSlot('idea-test-3')
        for (const id of ['kolibri-grade5a-001', 'app-2']) {
            const locked = `${p}/instances/${id}/data/locked`
            fs.mkdirSync(locked, { recursive: true })
            fs.writeFileSync(`${locked}/db`, 'root-owned on the Pi')
            fs.chmodSync(locked, 0o555)
        }
        fs.mkdirSync(`${dir}/bin`)
        fs.writeFileSync(`${dir}/bin/sudo`, [
            '#!/usr/bin/env bash',
            `printf '%s\\n' "$*" >> ${dir}/sudo.log`,
            `[ -f "${ROOT}/$4/META.yaml" ] || exit 2`,
            `chmod -R u+w "${ROOT}/$4/instances/$5" && rm -rf "${ROOT}/$4/instances/$5"`,
        ].join('\n'), { mode: 0o755 })
        const r = bash(buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-3', mode: 'helper' }), { PATH: `${dir}/bin:${process.env.PATH}` })
        expect(r.code, r.err).toBe(0)
        expect(fs.readFileSync(`${dir}/sudo.log`, 'utf8').split('\n').filter(Boolean).sort()).toEqual([
            `-n ${APP_DATA_HELPER} delete idea-test-3 app-2`,
            `-n ${APP_DATA_HELPER} delete idea-test-3 kolibri-grade5a-001`,
        ])
        expect(r.out).toMatch(/SLOT_HELPER_DELETE idea-test-3 kolibri-grade5a-001/)
        expect(fs.readdirSync(p)).toEqual(['lost+found'])
    })

    it('legacy on the same root-owned-like data fails LOUD (exit 7, names what is left) — no silent half-empty slot', () => {
        const p = fillSlot('idea-test-3')
        const locked = `${p}/instances/app-1/data/locked`
        fs.mkdirSync(locked, { recursive: true })
        fs.writeFileSync(`${locked}/db`, 'x')
        fs.chmodSync(locked, 0o555)
        const r = bash(buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-3', mode: 'legacy' }))
        expect(r.code).toBe(7)
        expect(r.err).toMatch(/SLOT_REFUSED: .*idea-test-3/)
        expect(fs.existsSync(p)).toBe(true)
    })

    it('helper: a failing helper delete is LOUD (exit 7) and the slot data is not rm-ed', () => {
        const p = fillSlot('idea-test-3')
        fs.mkdirSync(`${p}/instances/app-1`, { recursive: true })
        fs.writeFileSync(`${p}/instances/app-1/db`, 'x')
        fs.mkdirSync(`${dir}/bin`)
        fs.writeFileSync(`${dir}/bin/sudo`, '#!/usr/bin/env bash\necho "refused: test" >&2; exit 2\n', { mode: 0o755 })
        const r = bash(buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-3', mode: 'helper' }), { PATH: `${dir}/bin:${process.env.PATH}` })
        expect(r.code).toBe(7)
        expect(r.err).toContain(`SLOT_REFUSED: sudo -n ${APP_DATA_HELPER} delete idea-test-3 app-1 failed`)
        expect(fs.readFileSync(`${p}/instances/app-1/db`, 'utf8')).toBe('x')
        expect(fs.existsSync(`${p}/META.yaml`)).toBe(true)
    })
})

describe('refusals: symlink, non-child, missing', () => {
    it('symlinked slot → exit 7 "is a symlink"; the target keeps its files; the link stays', () => {
        fs.mkdirSync(`${dir}/elsewhere`)
        fs.writeFileSync(`${dir}/elsewhere/precious`, 'p')
        fs.symlinkSync(`${dir}/elsewhere`, `${ROOT}/idea-test-1`)
        for (const mode of ['legacy', 'helper'] as const) {
            for (const script of [
                buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-1', mode }),
                buildAssertEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-1', mode }),
            ]) {
                const r = bash(script)
                expect(r.code).toBe(7)
                expect(r.err).toContain(`SLOT_REFUSED: ${ROOT}/idea-test-1 is a symlink`)
            }
        }
        expect(fs.readdirSync(`${dir}/elsewhere`)).toEqual(['precious'])
        expect(fs.lstatSync(`${ROOT}/idea-test-1`).isSymbolicLink()).toBe(true)
        // quarantine refuses it too
        const q = bash(buildQuarantineSlotContentsRemote({ disksRoot: ROOT, slot: 'idea-test-1', quarantine: `${dir}/duration-moved-away/x` }))
        expect(q.code).toBe(7)
        expect(fs.readdirSync(`${dir}/elsewhere`)).toEqual(['precious'])
    })

    it('missing slot → exit 7, never created (helper wording says Atlas pre-creates slots)', () => {
        const r = bash(buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-6', mode: 'helper' }))
        expect(r.code).toBe(7)
        expect(r.err).toContain(`SLOT_REFUSED: ${ROOT}/idea-test-6 does not exist — the harness never creates a slot dir (helper layout: Atlas pre-creates every slot)`)
        expect(fs.existsSync(`${ROOT}/idea-test-6`)).toBe(false)
        const l = bash(buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-6', mode: 'legacy' }))
        expect(l.code).toBe(7)
        expect(fs.existsSync(`${ROOT}/idea-test-6`)).toBe(false)
    })

    it('a file where the slot should be → exit 7 "is not a directory", file untouched', () => {
        fs.writeFileSync(`${ROOT}/idea-test-2`, 'file')
        const r = bash(buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-2', mode: 'helper' }))
        expect(r.code).toBe(7)
        expect(r.err).toContain('is not a directory')
        expect(fs.readFileSync(`${ROOT}/idea-test-2`, 'utf8')).toBe('file')
    })

    it('non-child: names that are not a direct idea-test-N child, and bad roots, are refused before any script exists', () => {
        for (const slot of ['../idea-test-1', 'sub/idea-test-1', 'idea-test-1/..', 'idea-test-', 'sda1', '.', '', 'idea-test-1/x']) {
            expect(() => buildEmptySlotRemote({ disksRoot: ROOT, slot, mode: 'helper' }), slot).toThrow(/slot safety: refuse slot/)
            expect(() => buildAssertEmptySlotRemote({ disksRoot: ROOT, slot, mode: 'helper' }), slot).toThrow(/slot safety: refuse slot/)
        }
        for (const root of ['relative/disks', '/home/pi/idea/duration-disks/', '/home/pi/../etc', '/home//pi', "/home/pi/x'y"]) {
            expect(() => assertSlotPath(root, 'idea-test-1'), root).toThrow(/slot safety: refuse disks root/)
        }
        expect(assertSlotPath('/home/pi/idea/duration-disks', 'idea-test-3')).toBe('/home/pi/idea/duration-disks/idea-test-3')
        // the helper dock copy refuses a dest that is not <disksRoot>/<slot>
        expect(() => buildSshDockCopyRemote({
            diskId: 'duration-empty-001', pack: 'empty', src: '/s', dest: `${ROOT}/sub/idea-test-3`, sentinel: '/w/idea-test-3',
            disksRoot: ROOT, watchDir: '/w', startInstances: false, slotMode: 'helper',
        })).toThrow(/not a direct child/)
    })

    it('non-child at run time: a slot path whose real location is not <real root>/<name> is refused (pwd -P check)', () => {
        // Simulate a disks root given through a path where the slot's parent resolves elsewhere:
        // ROOT2/idea-test-1 is a real dir inside a DIFFERENT real root than ROOT2 itself resolves to.
        const real = `${dir}/real-root`
        fs.mkdirSync(`${real}/idea-test-1`, { recursive: true })
        fs.writeFileSync(`${real}/idea-test-1/f`, 'x')
        const script = buildEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-1', mode: 'helper' })
            // point _sp (only) at the other root: the guard must catch the mismatch
            .replace(`_sp='${ROOT}/idea-test-1'`, `_sp='${real}/idea-test-1'`)
        const r = bash(script)
        expect(r.code).toBe(7)
        expect(r.err).toContain('is not a direct child of the disks root')
        expect(fs.readFileSync(`${real}/idea-test-1/f`, 'utf8')).toBe('x')
    })

    it('assert-empty: an EMPTY real slot passes; a non-empty one is refused with its entries', () => {
        fs.mkdirSync(`${ROOT}/idea-test-1`)
        expect(bash(buildAssertEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-1', mode: 'helper' })).out).toContain('SLOT_IS_EMPTY')
        fs.writeFileSync(`${ROOT}/idea-test-1/.x`, '')
        const r = bash(buildAssertEmptySlotRemote({ disksRoot: ROOT, slot: 'idea-test-1', mode: 'helper' }))
        expect(r.code).toBe(7)
        expect(r.err).toMatch(/is not empty \(holds: \.x \)/)
    })

    it('quarantine (helper move source): contents incl. dotfiles move OUTSIDE the disks root; slot kept + empty; a quarantine inside the root is refused', () => {
        const p = fillSlot('idea-test-1')
        const before = ino(p)
        const q = `${movedAwayRoot(ROOT)}/idea-test-1-duration-empty-001-t`
        expect(movedAwayRoot('/home/pi/idea/duration-disks')).toBe('/home/pi/idea/duration-moved-away')
        const r = bash(buildQuarantineSlotContentsRemote({ disksRoot: ROOT, slot: 'idea-test-1', quarantine: q }))
        expect(r.code, r.err).toBe(0)
        expect(ino(p)).toBe(before)
        expect(fs.readdirSync(p)).toEqual(['lost+found'])
        expect(fs.readdirSync(q).sort()).toEqual(['-rf', '..odd', '.dotdir', '.env', 'META.yaml', 'apps', 'name with spaces*'])
        expect(() => buildQuarantineSlotContentsRemote({ disksRoot: ROOT, slot: 'idea-test-1', quarantine: `${ROOT}/.moved-away/x` })).toThrow(/outside/)
    })

    it('slot scan: an existing empty dir is EMPTY (helper free slot); absent stays FREE (legacy free slot)', () => {
        fs.mkdirSync(`${ROOT}/idea-test-1`)
        fs.mkdirSync(`${ROOT}/idea-test-2/lost+found`, { recursive: true })
        fs.mkdirSync(`${ROOT}/idea-test-3`)
        fs.writeFileSync(`${ROOT}/idea-test-3/.x`, '')
        fs.symlinkSync(`${dir}`, `${ROOT}/idea-test-4`)
        const scan = parseFixtureSlotScan(bash(buildFixtureSlotScanRemote(ROOT, 'duration-empty-001')).out)
        expect(scan.slice(0, 5).map(s => `${s.device}=${s.state}`)).toEqual([
            'idea-test-1=EMPTY', 'idea-test-2=EMPTY', 'idea-test-3=NOMETA', 'idea-test-4=NOMETA', 'idea-test-5=FREE',
        ])
    })
})

// ── preflight ────────────────────────────────────────────────────────────────

const R = '/home/pi/idea/duration-disks'
const goodHelperProbe = (over: Partial<Record<'version' | 'root' | 'bridge', string>> = {}, slotLines?: string[]) => [
    'HELPER present',
    over.version ?? 'HELPER_VERSION 0 idea-app-data 1',
    over.root ?? 'ROOT dir 0 0 755 root:root',
    ...(slotLines ?? requiredSlotNames().map(s => `SLOT ${s} dir 1000 1000 755 pi:pi yes`)),
    over.bridge ?? 'BRIDGE file 0 0 644',
    ...requiredSlotNames().map(s => `BRIDGE_LINE ${R}/${s}`),
].join('\n')

describe('slot-layout preflight: helper present vs absent', () => {
    it('required slots derived from the harness: idea-test-1..6 (r38@103 adds the Backup Disk duration-empty-003 at idea-test-6)', () => {
        expect(REQUIRED_SLOT_COUNT).toBe(6)
        expect(requiredSlotNames()).toEqual(['idea-test-1', 'idea-test-2', 'idea-test-3', 'idea-test-4', 'idea-test-5', 'idea-test-6'])
        expect(EXIT_SLOT_PREFLIGHT).toBe(7)
    })

    it('helper ABSENT (current f65183a pool) → mode=legacy, ok, nothing enforced — even with a pi-owned root and no slots', () => {
        const v = slotLayoutVerdict('idea01', '100.99.231.94', R, parseSlotLayoutProbe('HELPER absent\nROOT dir 1000 1000 775 pi:pi\n' +
            requiredSlotNames().map(s => `SLOT ${s} missing`).join('\n') + '\nBRIDGE missing\n'))
        expect(v).toMatchObject({ mode: 'legacy', ok: true, problems: [], helperVersion: null })
        expect(v.message).toBe(
            `slot_layout_preflight: idea01 (100.99.231.94): mode=legacy — no ${APP_DATA_HELPER} on this Pi; the harness keeps ` +
            `its pre-helper slot handling unchanged (it creates/removes idea-test-N slot dirs under ${R}; no slot-layout checks enforced)`,
        )
    })

    it('helper PRESENT and layout right → mode=helper, ok, exact message', () => {
        const v = slotLayoutVerdict('idea03', '100.126.117.80', R, parseSlotLayoutProbe(goodHelperProbe()))
        expect(v).toMatchObject({ mode: 'helper', ok: true, problems: [], helperVersion: 'idea-app-data 1' })
        expect(v.message).toBe(
            `slot_layout_preflight: idea03 (100.126.117.80): mode=helper (idea-app-data 1) — ${R} root-owned 0755; ` +
            `slots idea-test-1..6 exist, pi-writable, no symlinks, listed in ${APP_DATA_ROOTS_FILE}; the harness never creates ` +
            `or removes a slot dir, it only empties slots (instances/<id> via sudo -n ${APP_DATA_HELPER} delete <slot> <id>)`,
        )
    })

    it('helper PRESENT, every way the layout can be wrong → FAIL with one exact problem each', () => {
        const slots = requiredSlotNames().map(s => `SLOT ${s} dir 1000 1000 755 pi:pi yes`)
        slots[0] = 'SLOT idea-test-1 missing'
        slots[1] = 'SLOT idea-test-2 symlink'
        slots[2] = 'SLOT idea-test-3 dir 0 0 755 root:root no'
        slots[3] = 'SLOT idea-test-4 notdir'
        const v = slotLayoutVerdict('idea04', '100.108.39.45', R, parseSlotLayoutProbe(goodHelperProbe({
            version: 'HELPER_VERSION 1 sudo: a password is required',
            root: 'ROOT dir 1000 1000 775 pi:pi',
            bridge: 'BRIDGE file 1000 0 664',
        }, slots).replace(`BRIDGE_LINE ${R}/idea-test-5\n`, '').replace(new RegExp(`BRIDGE_LINE ${R}/idea-test-5$`), '')))
        expect(v.mode).toBe('helper')
        expect(v.ok).toBe(false)
        expect(v.problems).toEqual([
            `${APP_DATA_HELPER} exists but \`sudo -n ${APP_DATA_HELPER} version\` did not answer 'idea-app-data <N>' (exit 1: sudo: a password is required) — check the sudoers line 'pi ALL=(root) NOPASSWD: ${APP_DATA_HELPER}'`,
            `disks root ${R} is owned by pi:pi (uid 1000), not root — must be root:root 0755`,
            `disks root ${R} has mode 0775 (group/other-writable) — must be root:root 0755`,
            `slot ${R}/idea-test-1 does not exist — Atlas must pre-create it (the harness never creates a slot dir in helper mode)`,
            `slot ${R}/idea-test-2 is a symlink — must be a real dir`,
            `slot ${R}/idea-test-3 is not writable by pi (owner root:root, mode 0755) — must be pi:pi 0755`,
            `slot ${R}/idea-test-4 is not a directory`,
            `root bridge ${APP_DATA_ROOTS_FILE} is 1000:0 0664 — the helper ignores it unless root:root 0644`,
            `root bridge ${APP_DATA_ROOTS_FILE} does not list ${R}/idea-test-5`,
        ])
        expect(v.message).toBe(`slot_layout_preflight: idea04 (100.108.39.45): mode=helper — FAIL: ${v.problems.join('; ')}`)
    })

    it('helper PRESENT: disks root a symlink / missing; bridge missing → FAIL', () => {
        const v1 = slotLayoutVerdict('idea01', 'h', R, parseSlotLayoutProbe(goodHelperProbe({ root: 'ROOT symlink', bridge: 'BRIDGE missing' })))
        expect(v1.problems).toContain(`disks root ${R} is a symlink — must be a real dir owned by root, mode 0755`)
        expect(v1.problems).toContain(`root bridge ${APP_DATA_ROOTS_FILE} is missing — idea-app-data delete <slot> <id> needs it (root:root 0644, one '${R}/idea-test-N' per line)`)
        const v2 = slotLayoutVerdict('idea01', 'h', R, parseSlotLayoutProbe(goodHelperProbe({ root: 'ROOT missing' })))
        expect(v2.problems).toEqual([`disks root ${R} is missing — must be a real dir owned by root, mode 0755`])
    })

    it('the probe is read-only and only calls sudo when the helper file exists; on the box (no helper) it reports absent + real root/slot states', () => {
        const s = buildSlotLayoutProbeRemote(R, requiredSlotNames())
        expect(s).not.toMatch(/\b(rm|mv|mkdir|rmdir|chmod|chown|tee|touch|cp)\b/)
        expect(s.replace(/2>\/dev\/null|2>&1/g, '')).not.toContain('>') // no redirect writes anything
        expect(s).toContain(`if [ -e '${APP_DATA_HELPER}' ] || [ -L '${APP_DATA_HELPER}' ]; then echo "HELPER present"; if [ -x '${APP_DATA_HELPER}' ]; then _v=$(sudo -n '${APP_DATA_HELPER}' version`)
        expect(fs.existsSync(APP_DATA_HELPER)).toBe(false)
        fs.mkdirSync(`${ROOT}/idea-test-1`)
        fs.symlinkSync(dir, `${ROOT}/idea-test-2`)
        const p = parseSlotLayoutProbe(bash(buildSlotLayoutProbeRemote(ROOT, requiredSlotNames())).out)
        expect(p.helper).toBe('absent')
        expect(p.versionRc).toBeNull()
        expect(p.root).toMatchObject({ state: 'dir', uid: process.getuid!() })
        expect(p.slots.map(x => `${x.name}=${x.state}`)).toEqual(['idea-test-1=dir', 'idea-test-2=symlink', 'idea-test-3=missing', 'idea-test-4=missing', 'idea-test-5=missing', 'idea-test-6=missing'])
        expect(p.slots[0]).toMatchObject({ writable: true })
        expect(() => parseSlotLayoutProbe('garbage')).toThrow(/unparseable/)
    })
})

/** RealFleetOps with a canned ssh per host (no network). */
class CannedFleet extends RealFleetOps {
    readonly calls: string[] = []
    constructor(private readonly answers: Record<string, string | Error>) {
        super({ poolEngines: ['idea01', 'idea03', 'idea04'], excludeEngines: ['idea02'], hosts: { idea01: 'h1', idea03: 'h3', idea04: 'h4' }, sudoMode: 'never',
            // explicit: script/test-run.sh exports IDEA_DISKS_ROOT (a temp dir) for the Engine tests
            disksRoot: R, watchDir: '/home/pi/idea/duration-watch' })
    }
    protected override async ssh(host: string, cmd: string): Promise<string> {
        this.calls.push(`${host}: ${cmd}`)
        const a = this.answers[host]
        if (a instanceof Error) throw a
        return a ?? ''
    }
}

describe('RealFleetOps.preflightSlotLayout / slotModeOf', () => {
    it('mixed pool: legacy Pis pass unchanged, a correct helper Pi passes, the mode per Pi is cached', async () => {
        const absent = 'HELPER absent\nROOT dir 1000 1000 755 pi:pi\nBRIDGE missing\n'
        const ops = new CannedFleet({ h1: absent, h3: goodHelperProbe(), h4: absent })
        const res = await ops.preflightSlotLayout(['idea01', 'idea03', 'idea04'])
        expect(res.map(v => `${v.engine}:${v.mode}:${v.ok}`)).toEqual(['idea01:legacy:true', 'idea03:helper:true', 'idea04:legacy:true'])
        const n = ops.calls.length
        expect(await ops.slotModeOf('idea03')).toBe('helper')
        expect(await ops.slotModeOf('idea01')).toBe('legacy')
        expect(ops.calls.length).toBe(n) // cached, no new ssh
        expect(ops.calls.every(c => !/\b(rm|mv|mkdir)\b/.test(c))).toBe(true)
    })

    it('a helper Pi with a wrong layout FAILS; an ssh failure FAILS (never a silent legacy); slotModeOf throws for them', async () => {
        const ops = new CannedFleet({ h1: goodHelperProbe({ root: 'ROOT dir 1000 1000 755 pi:pi' }), h3: new Error('ssh: connect timed out'), h4: 'HELPER absent\n' })
        const res = await ops.preflightSlotLayout(['idea01', 'idea03', 'idea04'])
        expect(res.map(v => `${v.engine}:${v.ok}`)).toEqual(['idea01:false', 'idea03:false', 'idea04:true'])
        expect(res[1]!.message).toBe('slot_layout_preflight: idea03 (h3): mode=UNKNOWN — FAIL: slot layout probe failed over SSH: ssh: connect timed out')
        await expect(ops.slotModeOf('idea01')).rejects.toThrow(/mode=helper — FAIL: disks root \/home\/pi\/idea\/duration-disks is owned by pi:pi/)
    })

    it('never probes idea02', async () => {
        const ops = new CannedFleet({})
        await expect(ops.slotModeOf('idea02')).rejects.toThrow(/idea02/)
        expect(ops.calls).toEqual([])
    })
})
