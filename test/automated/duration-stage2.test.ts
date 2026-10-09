/**
 * Stage 2 harness rehome (Atlas Path A READY 2026-10-09 14:16): six fixtures on three real Intenso
 * SSD partitions (one SSD per Pi), stage2-dock.sh contract, settings preflight (D4 pin), role /
 * move-target timeline, whole-SSD vs sibling partitions, store step, Stage2FleetOps, sidecar owner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { allowedSequentialShare, backupDiskTargetId, eraseDiskTargetId, filesDiskTargetId, fixtureDiskPreflight } from '../duration/fixtureDisks.js'
import { dispatchAction, stage2RedockSharedEraseDisk, stage2SidecarOwnerNote, syncKolibriSidecarUrlForEngine, syncNextcloudSidecarUrlForEngine } from '../duration/actions.js'
import {
    EXIT_STAGE2_PREFLIGHT, PRODUCTION_EFFECTIVE, STAGE2_DOCK_SPLIT, STAGE2_FIXTURES, STAGE2_GAPS, STAGE2_MOVE_TARGET_ID, STAGE2_PINS,
    STAGE2_ROLE_MAP, buildEngineConfigProbe, buildStage2DockCmd, describeStage2Conflicts, describeStage2Windows, parseEngineConfigProbe,
    parseStage2DockJson, parseStage2Status, resolveDurationStage, stage2EngineSettingsProblems, stage2FixturesOn, stage2HomeOf,
    stage2MoveTargetPartition, stage2NotCovered, stage2PinReport, stage2Preflight, stage2RoleTimeline, stage2RoleWindows, stage2SsdsOn,
    stage2WholeSsdProblems, validateStage2Layout, type Stage2Status,
} from '../duration/stage2.js'
import { Stage2FleetOps, buildSidecarOwnerProbe, parseSidecarOwnerProbe } from '../duration/stage2FleetOps.js'
import {
    STAGE2_D10_IDEA02_LAN, STAGE2_STORE_FIX_ENGINE_SRC, buildStage2StoreFixCommand, parseStage2StoreFixOutput, resolveStage2StoreFixMode, runStage2StoreFix,
} from '../duration/stage2StoreFix.js'
import type { SemanticStoreView } from '../duration/types.js'

const K = 'duration-kolibri-grade5a-001'
const AF = 'duration-add-files-001'
const NC = 'duration-nextcloud-grade5a-001'
const E1 = 'duration-empty-001'
const E2 = 'duration-empty-002'
const E3 = 'duration-empty-003'

// READY pi-state-final config.yaml (switchover v2): testMode false, D4 pin, systemDiskSkip, skip*/peerAccess at production values.
const READY_CFG = `settings:
  mdns: true
  isDev: false
  testMode: false
  port: 4321
  skipHardwareId: true
  systemDiskSkip: true
  skipBorg: false
  skipImageLoad: false
  skipMetaUpdate: false
  peerAccess: true
`
const probe = (cfg = READY_CFG, env: Record<string, string> = {}) => ({ configYaml: cfg, pid: '1234', env })
/** READY: idea01's fixture SSD is sda (root sdb); idea03/idea04's is sdb (root sda). */
const ssdKname = (host: string) => (host === 'idea01' ? 'sda' : 'sdb')
const rootOf = (host: string) => (host === 'idea01' ? 'sdb' : 'sda')
const statusFor = (host: string, over: Partial<Stage2Status> = {}): Stage2Status => ({
    ok: true, host, bootId: 'boot-1', rootDisk: rootOf(host), ugreenDetached: true, extraSdDisks: [],
    ssds: stage2SsdsOn(host).map(() => ({ kname: ssdKname(host), serial: '26A1EE83210C', model: 'Intenso SSD Sata III' })),
    fixtures: stage2FixturesOn(host).map(f => {
        const d = ssdKname(host)
        return { partLabel: f.partLabel, diskId: f.diskId, kname: `${d}${f.partNumber}`, parent: d, fsType: 'ext4', fsLabel: f.fsLabel, mounted: `/disks/${d}${f.partNumber}`, present: true }
    }),
    ...over,
})
const goodInput = () => ({
    pool: ['idea01', 'idea03', 'idea04'],
    hosts: { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' } as Record<string, string>,
    status: { idea01: statusFor('idea01'), idea03: statusFor('idea03'), idea04: statusFor('idea04') } as Record<string, Stage2Status | Error>,
    configYaml: { idea01: probe(), idea03: probe(), idea04: probe() } as Record<string, ReturnType<typeof probe> | Error>,
    store: Object.fromEntries(STAGE2_FIXTURES.map(f => [f.diskId, { dockedTo: f.host as string | null, diskTypes: [...f.diskTypes!], instances: [] as string[] }])),
})
const loadWalk = (name: string): { action: string }[] => {
    const url = new URL(`../duration/walks/${name}.yaml`, import.meta.url)
    // dist-test run (pnpm test:unit) has no walks/ copy → fall back to the source tree.
    const p = fs.existsSync(url) ? url : new URL(`../../../test/duration/walks/${name}.yaml`, import.meta.url)
    return (parseYaml(fs.readFileSync(p, 'utf8')) as { steps: { action: string }[] }).steps
}
const COVER_ALL = loadWalk('cover-all')
const at = (action: string, nth = 0) => COVER_ALL.map((s, i) => (s.action === action ? i + 1 : 0)).filter(Boolean)[nth]!

describe('stage switch', () => {
    it('defaults to Stage 1, accepts 2, rejects others', () => {
        expect(resolveDurationStage({})).toBe(1)
        expect(resolveDurationStage({ DURATION_STAGE: '2' })).toBe(2)
        expect(() => resolveDurationStage({ DURATION_STAGE: '3' })).toThrow(/not supported/)
        expect(EXIT_STAGE2_PREFLIGHT).toBe(10)
    })
})

describe('READY fixture homes', () => {
    it('six fixtures, one SSD per Pi, two partitions each, labels as READY §2, never idea02', () => {
        expect(STAGE2_FIXTURES.map(f => [f.host, f.partNumber, f.diskId, f.partLabel, f.fsLabel, f.diskTypes])).toEqual([
            ['idea01', 1, K, 'IDEA-KOLIBRI', 'DUR-KOLIBRI', ['app']],
            ['idea01', 2, AF, 'IDEA-ADDFILES', 'ADDFILES01', ['app']],
            ['idea03', 1, NC, 'IDEA-NEXTCLOUD', 'DUR-NEXTCLOUD', ['app', 'files']],
            ['idea03', 2, E1, 'IDEA-EMPTY001', 'DUR-EMPTY001', ['empty']],
            ['idea04', 1, E2, 'IDEA-EMPTY002', 'DUR-EMPTY002', ['empty']],
            ['idea04', 2, E3, 'IDEA-EMPTY003', 'DUR-EMPTY003', ['empty']],
        ])
        for (const h of ['idea01', 'idea03', 'idea04']) expect(stage2SsdsOn(h)).toEqual([1])
        expect(validateStage2Layout()).toEqual([])
        expect(STAGE2_FIXTURES.some(f => (f.host as string) === 'idea02')).toBe(false)
    })
    it('no fixture is addressed by kname (no sdX in the layout)', () => {
        expect(JSON.stringify(STAGE2_FIXTURES)).not.toMatch(/\bsd[a-z]\d?\b/)
    })
    it('flags duplicates / partition 3 / a third partition on one SSD', () => {
        const f = STAGE2_FIXTURES[0]!
        expect(validateStage2Layout([...STAGE2_FIXTURES, { ...f, partNumber: 3 as 1, diskId: 'x', partLabel: 'X', fsLabel: 'X' }]).join(' ')).toMatch(/partition 3.*carries 3/)
    })
})

describe('stage2-dock.sh contract', () => {
    it('builds sudo -n command lines (diskId only, never sdX)', () => {
        expect(buildStage2DockCmd('status')).toBe('sudo -n /usr/local/sbin/stage2-dock.sh status --json')
        expect(buildStage2DockCmd('undock', { diskId: E3 })).toBe(`sudo -n /usr/local/sbin/stage2-dock.sh undock ${E3} --json`)
        expect(buildStage2DockCmd('eject-ssd', { diskId: E2 })).toBe(`sudo -n /usr/local/sbin/stage2-dock.sh eject-ssd --ssd ${E2} --json`)
        expect(buildStage2DockCmd('import', { diskId: E3, as: K })).toBe(`sudo -n /usr/local/sbin/stage2-dock.sh import ${E3} --as ${K} --json`)
        expect(() => buildStage2DockCmd('dock', { diskId: 'sdb1' })).toThrow(/not a Stage 2 fixture/)
        expect(() => buildStage2DockCmd('dock', { diskId: 'x; rm -rf /' })).toThrow(/valid diskId/)
        expect(() => buildStage2DockCmd('status', {}, '/tmp/../x')).toThrow()
    })
    it('last stdout line must be JSON with boolean ok (stderr noise above is fine)', () => {
        expect(parseStage2DockJson('stage2-dock: undock\n{"ok":true,"already":true}\n', 'dock')).toEqual({ ok: true, already: true })
        expect(() => parseStage2DockJson('done', 'dock')).toThrow(/not JSON/)
        expect(() => parseStage2DockJson('{"x":1}', 'dock')).toThrow(/boolean ok/)
    })
    it('parses the live idea04 status shape (bootId, ssds[])', () => {
        const s = parseStage2Status(JSON.stringify({ ok: true, verb: 'status', exit: 0, host: 'idea04', bootId: 'bea74917', rootDisk: 'sda', ssds: [{ kname: 'sdb', serial: '26A1EE83210C', model: 'INTENSO SSD', ssd: 1, fixtures: [E2, E3] }], fixtures: statusFor('idea04').fixtures, ugreenDetached: true, extraSdDisks: [] }))
        expect(s.bootId).toBe('bea74917')
        expect(s.ssds).toEqual([{ kname: 'sdb', serial: '26A1EE83210C', model: 'INTENSO SSD' }])
        expect(s.fixtures.map(f => f.mounted)).toEqual(['/disks/sdb1', '/disks/sdb2'])
    })
})

describe('Engine settings preflight (READY §4.5)', () => {
    it('READY config passes: no IDEA_* env, testMode false, skipHardwareId true (D4), skip*/peerAccess at production values', () => {
        expect(stage2EngineSettingsProblems(probe(), 'idea01')).toEqual([])
        expect(stage2PinReport(probe())).toEqual(['skipHardwareId=true (D4 pin, test-only)', 'systemDiskSkip=true (pin)'])
        expect(STAGE2_PINS.skipHardwareId.required).toBe(true)
        expect(PRODUCTION_EFFECTIVE.testMode).toBe(false)
    })
    it('any IDEA_* env on the running Engine fails (incl. IDEA_SYSTEM_DISK_SKIP)', () => {
        const p = stage2EngineSettingsProblems(probe(READY_CFG, { IDEA_SYSTEM_DISK_SKIP: 'true', IDEA_WATCH_DIR: '/home/pi/duration-watch' }), 'idea03')
        expect(p.join('\n')).toMatch(/IDEA_SYSTEM_DISK_SKIP/)
        expect(p.join('\n')).toMatch(/IDEA_WATCH_DIR/)
    })
    it('testMode true fails; skipHardwareId false fails as D4; disksRoot/staticPeers/watchDir set fails; skipBorg true fails', () => {
        expect(stage2EngineSettingsProblems(probe(READY_CFG.replace('testMode: false', 'testMode: true')), 'h').join(' ')).toMatch(/testMode = true/)
        expect(stage2EngineSettingsProblems(probe(READY_CFG.replace('skipHardwareId: true', 'skipHardwareId: false')), 'h').join(' ')).toMatch(/skipHardwareId = false.*\(D4\)/)
        expect(stage2EngineSettingsProblems(probe(READY_CFG.replace('  skipHardwareId: true\n', '')), 'h').join(' ')).toMatch(/\(D4\)/)
        expect(stage2EngineSettingsProblems(probe(`${READY_CFG}  disksRoot: /home/pi/duration-disks\n`), 'h').join(' ')).toMatch(/disksRoot/)
        expect(stage2EngineSettingsProblems(probe(`${READY_CFG}  staticPeers: idea03\n`), 'h').join(' ')).toMatch(/staticPeers/)
        expect(stage2EngineSettingsProblems(probe(READY_CFG.replace('skipBorg: false', 'skipBorg: true')), 'h').join(' ')).toMatch(/skipBorg/)
        expect(stage2EngineSettingsProblems(probe(READY_CFG.replace('mdns: true', 'mdns: false')), 'h').join(' ')).toMatch(/mdns/)
        expect(stage2EngineSettingsProblems({ ...probe(), pid: null }, 'h').join(' ')).toMatch(/no running Engine/)
    })
    it('parses the read-only config probe', () => {
        expect(buildEngineConfigProbe()).toMatch(/config\.yaml.*environ/)
        const p = parseEngineConfigProbe(`@@S2 config\nsettings:\n  testMode: false\n@@S2 env\npid=42\nenv:IDEA_TEST_MODE=true\n@@S2 end`)
        expect(p).toEqual({ configYaml: 'settings:\n  testMode: false', pid: '42', env: { IDEA_TEST_MODE: 'true' } })
    })
})

describe('roles + move-only target (READY §4.4)', () => {
    it('role map: Files + Erase share empty-001 (idea03), Backup empty-002 (idea04); empty-003 move-only', () => {
        expect(STAGE2_ROLE_MAP).toEqual({ files: E1, backup: E2, erase: E1 })
        expect(Object.values(STAGE2_ROLE_MAP)).not.toContain(E3)
        expect(STAGE2_MOVE_TARGET_ID).toBe(E3)
        expect(stage2HomeOf(STAGE2_ROLE_MAP.backup)).toBe('idea04') // same Pi as the moved Kolibri (ensureBackupDiskForInstance)
    })
    it('cover-all: Files ends before Erase starts; Backup and move windows; timeline fits', () => {
        const w = stage2RoleWindows(COVER_ALL)
        const files = w.find(x => x.role === 'files')!
        const erase = w.find(x => x.role === 'erase')!
        const move = w.find(x => x.role === 'move')!
        expect(files.to).toBeLessThan(erase.from)
        expect(erase.from).toBe(at('erase_disk'))
        expect(move.from).toBe(at('infra_move_disk'))
        expect(move.to).toBe(COVER_ALL.length)
        expect(stage2RoleTimeline(COVER_ALL)).toEqual([])
        expect(describeStage2Conflicts([])).toMatch(/fits/)
        expect(describeStage2Windows(COVER_ALL)).toMatch(new RegExp(`files=${E1}@\\d+–@\\d+ erase=${E1}@.*move=${E3}@`))
        expect(stage2RoleTimeline(loadWalk('cover-all-skip-copy'))).toEqual([])
    })
    it('detects a role on the move target, an overlapping share, an unlisted share', () => {
        expect(stage2RoleTimeline(COVER_ALL, E3, { ...STAGE2_ROLE_MAP, backup: E3 }).map(c => c.kind)).toContain('move-target')
        expect(stage2RoleTimeline(COVER_ALL, E3, { files: E1, backup: E2, erase: E2 }).map(c => c.kind)).toContain('overlap')
        expect(stage2RoleTimeline(COVER_ALL, E3, { files: E1, backup: E1, erase: E2 }).map(c => c.kind)).toEqual(['share'])
        const steps = [{ action: 'make_backup_disk' }, { action: 'backup_instance' }, { action: 'erase_disk' }]
        expect(stage2RoleTimeline(steps, E3, { files: E1, backup: E2, erase: E2 }).map(c => c.kind)).toEqual(['share'])
    })
    it('move target is always idea04 empty-003; never idea01, never the source', () => {
        expect(stage2MoveTargetPartition('idea04', K).diskId).toBe(E3)
        expect(() => stage2MoveTargetPartition('idea01', NC)).toThrow(/never move onto idea01/)
        expect(() => stage2MoveTargetPartition('idea03', K)).toThrow(/must be idea04/)
        expect(() => stage2MoveTargetPartition('idea04', E3)).toThrow(/move target itself/)
        expect(stage2NotCovered(COVER_ALL)).toEqual([{ step: at('infra_move_disk'), action: 'infra_move_disk', semantics: STAGE2_GAPS[0]!.semantics }])
        expect(STAGE2_GAPS[0]!.semantics).toMatch(/network copy.*duration-empty-003/)
    })
    it('no walk step leaves an SSD half-ejected (whole-SSD only for reboots, redocked in-step)', () => {
        expect(stage2WholeSsdProblems(COVER_ALL)).toEqual([])
        expect(stage2WholeSsdProblems([{ action: 'yank' }])).toEqual(['@1 yank is whole-SSD without an in-step redock — both partitions of that SSD would stay offline'])
        expect(STAGE2_DOCK_SPLIT.infra_move_disk!.level).toBe('partition')
        expect(STAGE2_DOCK_SPLIT.infra_move_disk!.verbs).toMatch(/sibling empty-002 stays mounted/)
    })
})

describe('stage2Preflight (exit 10)', () => {
    it('passes on the READY start state with cover-all', () => {
        const r = stage2Preflight({ ...goodInput(), steps: COVER_ALL })
        expect(r.problems).toEqual([])
        expect(r.ok).toBe(true)
        expect(r.table.filter(t => / pins: /.test(t))).toHaveLength(3)
    })
    it('Nextcloud must be [app, files]; Empties [empty] with no instances; each fixture docked on its home', () => {
        const i = goodInput()
        i.store[NC] = { dockedTo: 'idea03', diskTypes: ['app'], instances: [] }
        i.store[E1] = { dockedTo: 'idea03', diskTypes: ['empty'], instances: ['x'] }
        i.store[K] = { dockedTo: 'idea04', diskTypes: ['app'], instances: [] }
        const p = stage2Preflight(i).problems.join('\n')
        expect(p).toMatch(/nextcloud-grade5a-001: diskTypes=\[app\], reset state is \[app, files\]/)
        expect(p).toMatch(/empty-001: Empty fixture holds instances x/)
        expect(p).toMatch(/kolibri-grade5a-001: dockedTo=idea04, home is idea01/)
    })
    it('fails on IDEA_* env, idea02 in the pool, a fixture on the root disk, a stale non-READY row present', () => {
        const i = goodInput()
        i.configYaml.idea04 = probe(READY_CFG, { IDEA_TEST_MODE: 'true' })
        const s3 = statusFor('idea03'); s3.fixtures[0] = { ...s3.fixtures[0]!, parent: 'sda' }
        i.status.idea03 = s3
        const s4 = statusFor('idea04'); s4.fixtures.push({ partLabel: 'IDEA-MOVE001', diskId: 'duration-empty-004', kname: 'sdc1', parent: 'sdc', fsType: 'ext4', fsLabel: 'X', mounted: null, present: true })
        i.status.idea04 = s4
        const p = stage2Preflight({ ...i, pool: [...i.pool, 'idea02'] }).problems.join('\n')
        expect(p).toMatch(/idea04: Engine env IDEA_TEST_MODE/)
        expect(p).toMatch(/idea02 in pool/)
        expect(p).toMatch(/IDEA-NEXTCLOUD sits on the ROOT disk sda/)
        expect(p).toMatch(/IDEA-MOVE001 is present but is not a READY fixture/)
    })
    it('an absent non-READY row (82aeaa5 MOVE001/SPARE001 present:false) is fine', () => {
        const i = goodInput()
        const s4 = statusFor('idea04'); s4.fixtures.push({ partLabel: 'IDEA-SPARE001', diskId: null, kname: null, parent: null, fsType: null, fsLabel: null, mounted: null, present: false })
        i.status.idea04 = s4
        expect(stage2Preflight(i).ok).toBe(true)
    })
    it('D4: Intenso SSD with skipHardwareId off → collision risk + pin failure', () => {
        const i = goodInput()
        i.configYaml.idea04 = probe(READY_CFG.replace('skipHardwareId: true', 'skipHardwareId: false'))
        expect(stage2Preflight(i).problems.join('\n')).toMatch(/D4 hw-id collision risk/)
    })
})

describe('fixtureDisks role ids (Stage 2 share)', () => {
    const S2 = { DURATION_STAGE: '2' }
    it('Stage 1 unchanged; Stage 2 = STAGE2_ROLE_MAP; DURATION_ERASE_DISK_ID overrides', () => {
        expect([filesDiskTargetId({}), backupDiskTargetId({}), eraseDiskTargetId({})]).toEqual([E1, E3, E2])
        expect([filesDiskTargetId(S2), backupDiskTargetId(S2), eraseDiskTargetId(S2)]).toEqual([E1, E2, E1])
        expect(eraseDiskTargetId({ ...S2, DURATION_ERASE_DISK_ID: ' x ' })).toBe('x')
    })
    it('sequential Files→Erase share allowed only in Stage 2 and only without overlap', () => {
        expect(allowedSequentialShare(['files', 'erase'], COVER_ALL, S2)).toBe(true)
        expect(allowedSequentialShare(['files', 'erase'], COVER_ALL, {})).toBe(false)
        expect(allowedSequentialShare(['files', 'backup'], COVER_ALL, S2)).toBe(false)
        expect(allowedSequentialShare(['files', 'erase'], [{ action: 'make_files_disk' }], S2)).toBe(false)
        expect(allowedSequentialShare(['files', 'erase', 'backup'], COVER_ALL, S2)).toBe(false)
    })
    it('fixture disk preflight passes from step 1 on Stage 2 homes', () => {
        const view: SemanticStoreView = {
            diskDB: Object.fromEntries(STAGE2_FIXTURES.map(f => [f.diskId, { id: f.diskId, dockedTo: f.host, diskTypes: [...f.diskTypes!] }])),
            instanceDB: {}, engineDB: {},
        } as unknown as SemanticStoreView
        const r = fixtureDiskPreflight({ steps: COVER_ALL, startIndex: 0, consoleEngine: 'idea01', poolEngines: ['idea01', 'idea03', 'idea04'], view, env: { DURATION_STAGE: '2' }, expectedHostOf: stage2HomeOf })
        expect(r.problems).toEqual([])
        expect(r.roles.map(x => `${x.role}=${x.diskId}`)).toEqual([`files=${E1}`, `backup=${E2}`, `erase=${E1}`])
        const s1 = fixtureDiskPreflight({ steps: COVER_ALL, startIndex: 0, consoleEngine: 'idea01', poolEngines: ['idea01', 'idea03', 'idea04'], view, env: { DURATION_STAGE: '1', DURATION_ERASE_DISK_ID: E1 }, expectedHostOf: stage2HomeOf })
        expect(s1.problems.join(' ')).toMatch(/resolve to the same disk/)
    })
})

describe('store step (READY §4.7, opt-in, D10-gated)', () => {
    it('mode: off by default; plan | apply; rejects others', () => {
        expect(resolveStage2StoreFixMode({})).toBe('off')
        expect(resolveStage2StoreFixMode({ DURATION_STAGE2_STORE_FIX: 'plan' })).toBe('plan')
        expect(resolveStage2StoreFixMode({ DURATION_STAGE2_STORE_FIX: 'APPLY' })).toBe('apply')
        expect(() => resolveStage2StoreFixMode({ DURATION_STAGE2_STORE_FIX: 'force' })).toThrow()
    })
    it('command: ENGINE_SRC=/workspace/storefix-node, D10_IDEA02_LAN=10.99.0.12, never the gate-bypass flag', () => {
        const p = buildStage2StoreFixCommand('plan', {})
        expect(p.env).toEqual({ ENGINE_SRC: '/workspace/storefix-node', D10_IDEA02_LAN: '10.99.0.12' })
        expect(p.args).toEqual([])
        expect(buildStage2StoreFixCommand('apply', {}).args).toEqual(['--apply'])
        expect(STAGE2_STORE_FIX_ENGINE_SRC).toBe('/workspace/storefix-node')
        expect(STAGE2_D10_IDEA02_LAN).toBe('10.99.0.12')
        expect(JSON.stringify([p, buildStage2StoreFixCommand('apply', {})])).not.toMatch(/even-if-gate-fails/)
    })
    it('verdict: gate FAIL never passes; plan must be empty; apply must report APPLY', () => {
        const json = (mode: string, plan: unknown[]) => JSON.stringify({ mode, ws: 'ws://100.99.231.94:4321', plan, warn: [] }, null, 1)
        expect(parseStage2StoreFixOutput(`D10 gate: PASS\n${json('PLAN', [])}`, 0, 'plan').ok).toBe(true)
        expect(parseStage2StoreFixOutput(`D10 gate: PASS\n${json('PLAN', [{ op: 'delete' }])}`, 0, 'plan').problem).toMatch(/1 pending write/)
        expect(parseStage2StoreFixOutput('D10 gate: FAIL\nREFUSE: ...', 3, 'plan').problem).toMatch(/D10 gate FAIL/)
        expect(parseStage2StoreFixOutput(`D10 gate: PASS\n${json('APPLY', [{ op: 'x' }])}`, 0, 'apply').ok).toBe(true)
        expect(parseStage2StoreFixOutput(`D10 gate: PASS\n${json('PLAN', [])}`, 0, 'apply').ok).toBe(false)
        expect(parseStage2StoreFixOutput('', 1, 'plan').gate).toBe('unknown')
        const seen: string[] = []
        const r = runStage2StoreFix('plan', {}, c => { seen.push(`${c.env.ENGINE_SRC} ${c.file}`); return { stdout: `D10 gate: PASS\n${json('PLAN', [])}`, status: 0 } })
        expect(r.ok).toBe(true)
        expect(seen[0]).toMatch(/^\/workspace\/storefix-node .*stage2-store-fix\.sh$/)
    })
})

describe('per-Pi sidecar URLs + owner check (READY §4.2)', () => {
    it('Stage 2 uses the store port; env override still wins; Stage 1 defaults unchanged', () => {
        expect(syncKolibriSidecarUrlForEngine('idea01', undefined, {}, 18080)).toBe('http://idea01:18080')
        expect(syncKolibriSidecarUrlForEngine('idea04', undefined, {}, 18081)).toBe('http://idea04:18081')
        expect(syncKolibriSidecarUrlForEngine('idea04', undefined, { DURATION_KOLIBRI_PORT: '9' }, 18081)).toBe('http://idea04:9')
        expect(syncNextcloudSidecarUrlForEngine('idea03', undefined, {}, 61820)).toBe('http://idea03:61820')
        expect(syncNextcloudSidecarUrlForEngine('idea03', undefined, {})).toBe('http://idea03:18280')
    })
    it('owner probe: bridge publish (Nextcloud) and host-network listener pid (Kolibri) prove ownership', () => {
        expect(buildSidecarOwnerProbe(K, 18080)).toMatch(/docker ps --filter name='\^duration-kolibri-grade5a-001-'.*ss -ltnpH 'sport = :18080'/)
        expect(() => buildSidecarOwnerProbe('x;y', 1)).toThrow()
        const nc = '@@C nextcloud-grade5a-001-nextcloud-app-1 nextcloud_backend\n@@P nextcloud-grade5a-001-nextcloud-app-1 80/tcp -> 0.0.0.0:61820\n@@P nextcloud-grade5a-001-nextcloud-app-1 80/tcp -> [::]:61820\n@@L LISTEN 0 4096 0.0.0.0:61820 0.0.0.0:* users:(("docker-proxy",pid=12575,fd=7))'
        expect(parseSidecarOwnerProbe(nc, 61820).owners).toEqual(['nextcloud-grade5a-001-nextcloud-app-1'])
        expect(parseSidecarOwnerProbe(nc, 18280).owners).toEqual([])
        const ko = '@@C kolibri-grade5a-001-kolibri-1 host\n@@T kolibri-grade5a-001-kolibri-1 36915\n@@T kolibri-grade5a-001-kolibri-1 36928\n@@L LISTEN 0 30 0.0.0.0:18080 0.0.0.0:* users:(("kolibri-0.15.5",pid=36928,fd=40))'
        expect(parseSidecarOwnerProbe(ko, 18080).owners).toEqual(['kolibri-grade5a-001-kolibri-1'])
        // idea04: native kolibri (pid 1470) answers :18080 — not the fixture.
        expect(parseSidecarOwnerProbe('@@L LISTEN 0 30 0.0.0.0:18080 0.0.0.0:* users:(("kolibri-0.15.5",pid=1470,fd=30))', 18080).owners).toEqual([])
    })
})

// ── Stage2FleetOps against a canned stage2-dock.sh ───────────────────────────
const IP: Record<string, string> = { '10.0.0.1': 'idea01', '10.0.0.3': 'idea03', '10.0.0.4': 'idea04' }
const strip = (c: string) => c.replace('sudo -n /usr/local/sbin/stage2-dock.sh ', '').replace(' --json', '')
class CannedStage2 extends Stage2FleetOps {
    calls: string[] = []
    /** diskId (META) → Engine holder; mounted ⇔ docked here. */
    docked: Record<string, string | null> = {}
    /** partition diskId → META diskId on it (a moved copy). */
    meta: Record<string, string> = {}
    removed = new Set<string>()
    boot: Record<string, string> = { idea01: 'b1', idea03: 'b1', idea04: 'b1' }
    ssdOut = new Set<string>()
    /** Engine eject lags: the partition stays mounted for N status polls after the store says undocked. */
    unmountLag = 0
    lagLeft: Record<string, number> = {}
    statusCalls = 0
    /** dock calls on a present partition (fast re-add cycle the Engine ignores). */
    fastCycles = 0
    /** The Engine ignores even a real add (the "dock had no effect" case). */
    engineDeaf = false
    sleeps: number[] = []
    protected override async ssh(host: string, cmd: string): Promise<string> {
        const h = IP[host]!
        if (cmd.endsWith(' status --json')) {
            this.statusCalls++
            const st = statusFor(h, { bootId: this.boot[h]! })
            st.fixtures = st.fixtures.map(x => {
                const part = x.diskId!
                const metaId = this.meta[part] ?? part
                const present = !this.ssdOut.has(h) && !this.removed.has(part)
                let mounted = present && this.docked[metaId] === h ? x.mounted : null
                if (!mounted && present && (this.lagLeft[metaId] ?? 0) > 0) { this.lagLeft[metaId]!--; mounted = x.mounted }
                return { ...x, diskId: present ? metaId : null, present, mounted, kname: present ? x.kname : null }
            })
            return JSON.stringify(st)
        }
        if (cmd.startsWith('for c in')) return '@@C x host\n'
        const c = strip(cmd)
        this.calls.push(`${h} ${c}`)
        let m: RegExpExecArray | null
        if ((m = /^(eject-ssd|dock-ssd) --ssd (\S+)$/.exec(c))) {
            if (m[1] === 'eject-ssd') { this.ssdOut.add(h); for (const f of stage2FixturesOn(h)) this.docked[this.meta[f.diskId] ?? f.diskId] = null }
            else { this.ssdOut.delete(h); for (const f of stage2FixturesOn(h)) { this.removed.delete(f.diskId); this.docked[this.meta[f.diskId] ?? f.diskId] = h } }
        } else if ((m = /^(dock|undock) (\S+)$/.exec(c))) {
            const onIt = this.meta[m[2]!] ?? m[2]!
            if (m[1] === 'dock') {
                const present = !this.removed.has(m[2]!)
                if (present && this.docked[onIt] === h) return '{"ok":true,"already":true}'
                if (present) {
                    // reset-r53: present but unmounted → the script's ms partx -d/-a cycle; chokidar sees a 'change',
                    // the Engine (add/unlink only) does nothing.
                    this.fastCycles++
                    return '{"ok":true,"already":false,"cycled":true}'
                }
                this.removed.delete(m[2]!)
                if (!this.engineDeaf) this.docked[onIt] = h // a real add uevent: the Engine docks it
                return '{"ok":true,"already":false,"cycled":false}'
            }
            if (this.docked[onIt] === h) return '{"ok":false,"exit":5}'
            this.removed.add(m[2]!)
        } else if ((m = /^reset (\S+)$/.exec(c))) { delete this.meta[m[1]!] }
        return '{"ok":true}'
    }
    protected override async relayPipe(s: string, sc: string, d: string, dc: string): Promise<string> {
        this.calls.push(`RELAY ${IP[s]} ${strip(sc)} | ${IP[d]} ${strip(dc)}`)
        const im = /import (\S+) --as (\S+)/.exec(dc)!
        this.meta[im[1]!] = im[2]!
        return '{"ok":true}'
    }
    override async findDockedEngine(diskId: string): Promise<string | null> {
        return this.docked[diskId] ?? null
    }
}
const mk = () => {
    const o = new CannedStage2({
        poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' },
        storeMode: 'shared', sleep: async (ms: number) => { o.sleeps.push(ms) }, dockWaitMs: 200,
    })
    for (const f of STAGE2_FIXTURES) o.docked[f.diskId] = f.host
    return o
}
/** Engine eject (WS) = store undock in the canned fleet; the partition unmount may lag (unmountLag). */
const engineEjects: string[] = []
const quiet = () => {
    engineEjects.length = 0
    vi.spyOn(RealFleetOps.prototype, 'undockFixtures').mockImplementation(async function (this: CannedStage2, engines: string[], diskId: string) {
        engineEjects.push(`${engines.join(',')} ${diskId}`)
        if (this.docked[diskId] && engines.includes(this.docked[diskId]!)) { this.lagLeft[diskId] = this.unmountLag; this.docked[diskId] = null }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
}

describe('Stage2FleetOps', () => {
    afterEach(() => vi.restoreAllMocks())
    it('refuses idea02 in the pool', () => {
        expect(() => new Stage2FleetOps({ poolEngines: ['idea01', 'idea02'], hosts: { idea01: 'a', idea02: 'b' } })).toThrow(/idea02/)
    })
    it('never writes the Stage 1 dock-trigger folder (duration-watch)', async () => {
        const o = mk() as unknown as { sshDockCopy(e: string, d: string, dev: string): Promise<void>; sshRemoveSentinel(e: string, d: string): Promise<void> }
        await expect(o.sshDockCopy('idea04', E2, 'sdb1')).rejects.toThrow(/duration-watch/)
        await expect(o.sshRemoveSentinel('idea04', 'sdb1')).rejects.toThrow(/dock-trigger folder/)
    })
    it('dock app fixture = partition add on its home Pi only; already:true is success', async () => {
        quiet()
        const o = mk()
        o.docked[NC] = null; o.removed.add(NC)
        await o.dockFixture('idea03', NC)
        expect(o.calls).toEqual([`idea03 dock ${NC}`])
        // Another Pi = a move (network copy), and never onto idea01.
        await expect(o.dockFixture('idea01', NC)).rejects.toThrow(/never move onto idea01/)
        o.docked[AF] = null
        await expect(o.dockFixture('idea04', AF)).rejects.toThrow(/lives on idea01's SSD/)
        o.calls = []
        await o.dockFixture('idea03', NC) // already docked app fixture → no-op
        expect(o.calls).toEqual([])
    })
    it('Engine eject waits until the partition is really unmounted before any partition verb', async () => {
        quiet()
        const o = mk()
        o.unmountLag = 3
        await o.undockFixtures(['idea04'], E3)
        expect(o.calls).toEqual([`idea04 undock ${E3}`])
        expect(o.lagLeft[E3]).toBe(0) // polled through the lag before `undock`
        expect(o.heldUndocked.has(E3)).toBe(true)
    })
    it('Engine eject that never unmounts fails loud (no partition verb)', async () => {
        quiet()
        const o = mk()
        o.unmountLag = 1e9
        await expect(o.undockFixtures(['idea04'], E3)).rejects.toThrow(/not done within/)
        expect(o.calls).toEqual([])
    })
    it('Empty docks fresh: Engine eject → reset → dock; held one is re-added before reset', async () => {
        quiet()
        const o = mk()
        await o.dockFixture('idea03', E1)
        // reset leaves it present + unmounted → undock, gap, dock (reset-r53), never the fast re-add cycle.
        expect(o.calls).toEqual([`idea03 reset ${E1}`, `idea03 undock ${E1}`, `idea03 dock ${E1}`])
        expect(o.fastCycles).toBe(0)
        await o.undockFixtures(['idea03'], E1)
        o.calls = []
        await o.dockFixture('idea03', E1)
        expect(o.calls).toEqual([`idea03 dock ${E1}`, `idea03 reset ${E1}`, `idea03 undock ${E1}`, `idea03 dock ${E1}`])
    })
    it('move_disk = network copy into empty-003: partition verbs only, sibling empty-002 untouched, no SSD verbs', async () => {
        quiet()
        const o = mk()
        await o.moveDisk('idea01', 'idea04', K)
        expect(o.calls).toEqual([
            `idea04 reset ${E3}`,
            `RELAY idea01 export ${K} | idea04 import ${E3} --as ${K}`,
            `idea01 undock ${K}`,
            `idea04 undock ${E3}`, // imported target is present + unmounted → undock, gap, dock
            `idea04 dock ${E3}`,
        ])
        expect(o.fastCycles).toBe(0)
        expect(o.calls.some(c => c.includes(E2) || /-ssd/.test(c))).toBe(false)
        expect(o.docked[E2]).toBe('idea04')
        expect(o.docked[K]).toBe('idea04')
        expect(o.moveCopies.get(E3)).toBe(K)
        expect(o.heldUndocked.has(K)).toBe(true)
        await expect(o.dockFixture('idea01', K)).rejects.toThrow(/two partitions one diskId/)
        await expect(o.dockFixture('idea04', E3)).rejects.toThrow(/holds the moved/)
        // r53 shortcut sweep: a same-Pi "move" is refused, never a silent no-op.
        await expect(o.moveDisk('idea04', 'idea04', AF)).rejects.toThrow(/is not a move \(same Pi\) — refused/)
        await expect(o.moveDisk('idea03', 'idea01', NC)).rejects.toThrow(/never move onto idea01/)
    })
    it('eject-ssd takes both partitions offline: Engine-ejects both, then partition verbs on either are refused until dock-ssd', async () => {
        quiet()
        const o = mk()
        await o.ejectSsd('idea04', E3)
        expect(engineEjects).toEqual([`idea04 ${E2}`, `idea04 ${E3}`])
        expect(o.calls).toEqual([`idea04 eject-ssd --ssd ${E3}`])
        await expect(o.dockFixture('idea04', E2)).rejects.toThrow(/ejected as a whole SSD/)
        await expect(o.moveDisk('idea01', 'idea04', K)).rejects.toThrow(/ejected as a whole SSD/)
        o.calls = []
        await o.dockSsd('idea04', E3)
        expect(o.calls).toEqual([`idea04 dock-ssd --ssd ${E3}`])
        expect([o.docked[E2], o.docked[E3]]).toEqual(['idea04', 'idea04'])
        await expect(o.ejectSsd('idea03', E3)).rejects.toThrow(/not on idea03/)
    })
    it('dock-ssd re-undocks fixtures the harness holds undocked', async () => {
        quiet()
        const o = mk()
        await o.undockFixtures(['idea04'], E3)
        await o.ejectSsd('idea04', E2)
        o.calls = []
        await o.dockSsd('idea04', E2)
        expect(o.calls).toEqual([`idea04 dock-ssd --ssd ${E2}`, `idea04 undock ${E3}`])
    })
    it('D5 net: boot_id change before a fixture op → dock-ssd if the SSD is missing, re-undock held, wait others', async () => {
        quiet()
        const o = mk()
        await o.recordBootIds(['idea01', 'idea03', 'idea04'])
        await o.undockFixtures(['idea04'], E3)
        o.boot.idea04 = 'b2'; o.ssdOut.add('idea04'); o.docked[E2] = null; o.removed.delete(E3)
        o.calls = []
        await o.dockFixture('idea04', E2)
        expect(o.redockLog).toEqual([`idea04: SSD1 missing after boot → dock-ssd --ssd ${E2}`, `idea04: wait docked ${E2}`, `idea04: re-undock ${E3}`])
        expect(o.calls.slice(0, 2)).toEqual([`idea04 dock-ssd --ssd ${E2}`, `idea04 undock ${E3}`])
        expect(o.bootIds.get('idea04')).toBe('b2')
    })
    it('probes use the status mount /disks/<kname> and refuse the root disk', async () => {
        quiet()
        const o = mk()
        expect(await o.stage2MountOf('idea01', K)).toEqual({ dest: '/disks/sda1', kname: 'sda1', partLabel: 'IDEA-KOLIBRI' })
        o.docked[E2] = null
        expect(await o.stage2MountOf('idea04', E2)).toBeNull()
        const bad = mk()
        vi.spyOn(bad, 'stage2Status').mockResolvedValue(statusFor('idea03', { rootDisk: 'sdb' }))
        await expect(bad.stage2MountOf('idea03', NC)).rejects.toThrow(/ROOT disk/)
    })
    it('verifySidecarOwner throws when the port is not served by the instance', async () => {
        const o = mk()
        await expect(o.verifySidecarOwner('idea04', K, 18080)).rejects.toThrow(/not served by/)
        await expect(o.verifySidecarOwner('idea04', 'x;y', 18080)).rejects.toThrow(/odd instance/)
    })
})

describe('Stage 2 erase share + sidecar owner (actions)', () => {
    const view = (e1Types: string[]): SemanticStoreView => ({
        diskDB: Object.fromEntries(STAGE2_FIXTURES.map(f => [f.diskId, { id: f.diskId, dockedTo: f.host, diskTypes: f.diskId === E1 ? e1Types : [...f.diskTypes!] }])),
        instanceDB: {}, engineDB: {},
    } as unknown as SemanticStoreView)
    const ctxWith = (types: string[], stage = 2) => {
        const calls: string[] = []
        const v = view(types)
        const ops = {
            stage,
            readStore: async () => v,
            getStoreMode: () => 'shared' as const,
            waitReady: async () => ({ wsUp: true }),
            undockFixtures: async (e: string[], d: string) => { calls.push(`undock ${e.join(',')} ${d}`) },
            purgeInstancesStoredOn: async (e: string, d: string) => { calls.push(`purge ${e} ${d}`) },
            dockFixture: async (e: string, d: string) => { calls.push(`dock ${e} ${d}`) },
        }
        const ctx = { opts: { ops, fast: true, settleTimeoutMs: 50 }, poolEngines: ['idea01', 'idea03', 'idea04'], excludeEngines: [], walker: {} } as never
        return { ctx, calls }
    }
    afterEach(() => { delete process.env.DURATION_STAGE })
    it('before erase_disk: the Files disk (empty-001) is re-docked fresh on idea03 with a store purge', async () => {
        process.env.DURATION_STAGE = '2'
        const { ctx, calls } = ctxWith(['files'])
        expect(await stage2RedockSharedEraseDisk(ctx)).toMatch(/re-docked duration-empty-001 on idea03/)
        expect(calls).toEqual([`undock idea01,idea03,idea04 ${E1}`, `purge idea03 ${E1}`, `dock idea03 ${E1}`])
    })
    it('no-op when empty-001 is already Empty on idea03, or in Stage 1', async () => {
        process.env.DURATION_STAGE = '2'
        const a = ctxWith(['empty'])
        expect(await stage2RedockSharedEraseDisk(a.ctx)).toBeNull()
        expect(a.calls).toEqual([])
        delete process.env.DURATION_STAGE
        const b = ctxWith(['files'], 1)
        expect(await stage2RedockSharedEraseDisk(b.ctx)).toBeNull()
    })
    it('sidecar owner note: Running needs a store port + owner; non-Running skips', async () => {
        const owner = vi.fn(async () => ['kolibri-grade5a-001-kolibri-1'])
        const ctx = { opts: { ops: { verifySidecarOwner: owner } } } as never
        expect(await stage2SidecarOwnerNote(ctx, 'idea01', 'kolibri-grade5a-001', 18080, 'Running')).toMatch(/owner OK .*idea01:18080/)
        await expect(stage2SidecarOwnerNote(ctx, 'idea01', 'kolibri-grade5a-001', undefined, 'Running')).rejects.toThrow(/no port in the store/)
        expect(await stage2SidecarOwnerNote(ctx, 'idea01', 'kolibri-grade5a-001', 18080, 'Stopped')).toMatch(/skipped/)
        owner.mockRejectedValueOnce(new Error('not served by'))
        await expect(stage2SidecarOwnerNote(ctx, 'idea04', 'kolibri-grade5a-001', 18080, 'Running')).rejects.toThrow(/not served by/)
    })
})

// ── r53 FAIL@58: "already docked" shortcuts must not bypass the Stage 2 per-Pi paths ─────────
const KI = 'kolibri-grade5a-001'
const NI = 'nextcloud-grade5a-001'
const NC_LOGIN = '<form><input name="user"><input name="password"><button type="submit">Log in</button></form>'
/** Live-looking Stage2FleetOps (canned stage2-dock.sh) whose store view follows the canned dock map. */
const liveCanned = () => {
    quiet()
    const o = mk()
    const view = (): SemanticStoreView => ({
        diskDB: Object.fromEntries(Object.entries(o.docked).map(([id, on]) => [id, { id, dockedTo: on, diskTypes: [...(STAGE2_FIXTURES.find(f => f.diskId === id)?.diskTypes ?? [])] }])),
        instanceDB: {
            [KI]: { id: KI, diskId: K, status: o.docked[K] ? 'Running' : 'Undocked', port: 18080 },
            [NI]: { id: NI, diskId: NC, status: o.docked[NC] ? 'Running' : 'Undocked', port: 61820 },
        },
        engineDB: {},
    } as unknown as SemanticStoreView)
    vi.spyOn(o, 'readStore').mockImplementation(async () => view())
    vi.spyOn(o, 'waitReady').mockResolvedValue({ wsUp: true } as never)
    vi.spyOn(o, 'getStoreMode').mockReturnValue('unique' as never)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(NC_LOGIN, { status: 200 })))
    return o
}
const infraCtx = (o: CannedStage2, action: string, walkerEngine: string | null = 'idea01') => ({
    action, from: 'infra_idle', to: 'infra_idle',
    opts: { ops: o, fast: true, settleTimeoutMs: 50, rng: () => 0 },
    walker: { dockedEngine: walkerEngine, step: 57 },
    poolEngines: ['idea01', 'idea03', 'idea04'], excludeEngines: ['idea02'],
    fixtureDisk: K, fixtureInstance: KI, fixtureDisks: [K, NC], fixtureInstances: { [K]: KI, [NC]: NI },
}) as never

describe('r53: Stage 2 already-docked shortcuts', () => {
    const saved = { ...process.env }
    afterEach(() => {
        vi.restoreAllMocks(); vi.unstubAllGlobals()
        for (const k of ['DURATION_NEXTCLOUD_URL', 'DURATION_KOLIBRI_URL', 'DURATION_NEXTCLOUD_PORT', 'DURATION_KOLIBRI_PORT', 'DURATION_NEXTCLOUD_READY_MS']) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
        }
    })
    it('r53 replay: eject_disk@45 ejects Nextcloud on idea03, then infra_dock_fixture@58 re-docks it through the per-Pi path', async () => {
        const o = liveCanned()
        o.docked[NC] = null // Console eject: store undocked, partition present but unmounted on idea03
        const r = await dispatchAction(infraCtx(o, 'infra_dock_fixture'))
        expect(r.ok).toBe(true)
        // d26f4e2: calls = [] ("fixture … already docked on idea01 (no-op)") and a 420 s wait for Nextcloud.
        // Engine-ejected partition is present → undock, gap, dock (reset-r53).
        expect(o.calls).toEqual([`idea03 undock ${NC}`, `idea03 dock ${NC}`])
        expect(o.docked[NC]).toBe('idea03')
        expect(o.docked[K]).toBe('idea01')
        expect(r.message).toMatch(/Stage 2 homes: docked duration-nextcloud-grade5a-001 \[already Docked\+mounted, not re-docked: duration-kolibri-grade5a-001\] \[was not docked: duration-nextcloud-grade5a-001\]/)
        expect(r.message).toMatch(/DURATION_NEXTCLOUD_URL=http:\/\/idea03:61820/)
        expect(r.dockedEngine).toBe('idea01')
    })
    it('all fixtures docked → still a no-op, Nextcloud waited on ITS home Pi (idea03)', async () => {
        const o = liveCanned()
        const r = await dispatchAction(infraCtx(o, 'infra_dock_fixture'))
        expect(r.ok).toBe(true)
        expect(o.calls).toEqual([])
        expect(r.message).toMatch(/all fixtures already docked .* no-op \(Stage 2\)/)
        expect(r.message).toMatch(/DURATION_NEXTCLOUD_URL=http:\/\/idea03:61820/)
        expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('http://idea03:61820/login')
    })
    it('Kolibri undocked too (r52-style undock) → both re-docked on their homes', async () => {
        const o = liveCanned()
        await o.undockFixtures(['idea01', 'idea03', 'idea04'], K)
        o.docked[NC] = null
        o.calls = []
        const r = await dispatchAction(infraCtx(o, 'infra_dock_fixture', null))
        expect(r.ok).toBe(true)
        expect(o.calls).toEqual([`idea01 dock ${K}`, `idea03 undock ${NC}`, `idea03 dock ${NC}`])
    })
    it('a moved copy stays on the move target; only the missing home fixture is docked', async () => {
        const o = liveCanned()
        await o.moveDisk('idea01', 'idea04', K)
        o.docked[NC] = null
        o.calls = []
        const r = await dispatchAction(infraCtx(o, 'infra_dock_fixture', 'idea04'))
        expect(r.ok).toBe(true)
        expect(o.calls).toEqual([`idea03 undock ${NC}`, `idea03 dock ${NC}`])
        expect(r.message).toMatch(/duration-kolibri-grade5a-001 stays on idea04 \(moved copy\)/)
    })
    it('Stage2FleetOps.dockFixture: store says docked but the partition is not mounted → real dock, not a no-op', async () => {
        const o = liveCanned()
        o.docked[NC] = null
        const orig = o.findDockedEngine.bind(o)
        vi.spyOn(o, 'findDockedEngine').mockImplementation(async d => (d === NC ? 'idea03' : orig(d))) // stale store row
        await o.dockFixture('idea03', NC)
        expect(o.calls).toEqual([`idea03 undock ${NC}`, `idea03 dock ${NC}`])
        o.calls = []
        await o.dockFixture('idea03', NC) // now mounted for real → no-op
        expect(o.calls).toEqual([])
    })
    it('infra_move_disk (Stage 2): source = store holder, not stale walker state; network copy to idea04', async () => {
        const o = liveCanned()
        const r = await dispatchAction(infraCtx(o, 'infra_move_disk', 'idea03')) // walker stale (idea03)
        expect(r.ok).toBe(true)
        expect(o.calls).toContain(`RELAY idea01 export ${K} | idea04 import ${E3} --as ${K}`)
        expect(r.dockedEngine).toBe('idea04')
    })
    it('infra_move_disk (Stage 2): fixture undocked or already on the move target → loud failure, no no-op', async () => {
        const a = liveCanned()
        a.docked[K] = null
        await expect(dispatchAction(infraCtx(a, 'infra_move_disk'))).rejects.toThrow(/not docked on a pool engine .* No soft-pass/)
        const b = liveCanned()
        await b.moveDisk('idea01', 'idea04', K)
        b.calls = []
        await expect(dispatchAction(infraCtx(b, 'infra_move_disk', 'idea04'))).rejects.toThrow(/already docked on the move target idea04 — refusing a no-op move/)
        expect(b.calls).toEqual([])
    })
})

// ── reset-r53 (Atlas): a dock of a present-but-Engine-ejected partition is a chokidar 'change' ─────────
describe('reset-r53: undock → gap → dock, then verify the Engine took it', () => {
    afterEach(() => { vi.restoreAllMocks(); delete process.env.DURATION_STAGE2_REDOCK_GAP_MS })
    it("change-not-add: the script's fast re-add cycle alone leaves the Engine undocked (the r53 reset finding)", async () => {
        quiet()
        const o = mk()
        o.docked[NC] = null // Engine-ejected: present, unmounted
        // What a bare `dock` does (Atlas 15:52): cycled:true, Engine never sees an add.
        const out = await (o as unknown as { ssh(h: string, c: string): Promise<string> }).ssh('10.0.0.3', `sudo -n /usr/local/sbin/stage2-dock.sh dock ${NC} --json`)
        expect(JSON.parse(out)).toMatchObject({ ok: true, cycled: true })
        expect(o.docked[NC]).toBeNull()
        expect(o.fastCycles).toBe(1)
    })
    it('present + unmounted → undock, wait the gap (default 5 s), dock; Engine docks it; verified', async () => {
        quiet()
        const o = mk()
        o.docked[NC] = null
        await o.dockFixture('idea03', NC)
        expect(o.calls).toEqual([`idea03 undock ${NC}`, `idea03 dock ${NC}`])
        expect(o.sleeps[0]).toBe(5_000) // the gap sits between undock and dock
        expect(o.fastCycles).toBe(0)
        expect(o.docked[NC]).toBe('idea03')
        expect(o.dockLog).toEqual([`idea03: IDEA-NEXTCLOUD present, not mounted → undock, wait 5000ms, dock`, `idea03: dock ${NC}`])
    })
    it('gap is configurable (constructor, DURATION_STAGE2_REDOCK_GAP_MS); absent partition docks without a gap; mounted is a no-op', async () => {
        quiet()
        process.env.DURATION_STAGE2_REDOCK_GAP_MS = '1500'
        const { stage2RedockGapMs, STAGE2_REDOCK_GAP_MS_DEFAULT } = await import('../duration/stage2FleetOps.js')
        expect(stage2RedockGapMs()).toBe(1500)
        expect(stage2RedockGapMs({ DURATION_STAGE2_REDOCK_GAP_MS: 'x' })).toBe(STAGE2_REDOCK_GAP_MS_DEFAULT)
        const o = mk()
        o.docked[NC] = null
        await o.dockFixture('idea03', NC)
        expect(o.sleeps[0]).toBe(1500)
        const a = mk()
        await a.undockFixtures(['idea03'], NC) // harness undock: partition removed
        a.calls = []; a.sleeps.length = 0
        await a.dockFixture('idea03', NC)
        expect(a.calls).toEqual([`idea03 dock ${NC}`])
        expect(a.sleeps).toEqual([])
        a.calls = []
        await a.dockFixture('idea03', NC)
        expect(a.calls).toEqual([])
    })
    it('a dock with no effect (Engine never takes the partition) fails loud with what it saw', async () => {
        quiet()
        const o = mk()
        o.docked[NC] = null
        o.engineDeaf = true
        await expect(o.dockFixture('idea03', NC)).rejects.toThrow(
            /dock of duration-nextcloud-grade5a-001 on idea03 had no effect within 200ms \(store dockedTo=none, IDEA-NEXTCLOUD present, mounted=no\) — the Engine did not take the partition\. No soft-pass\./,
        )
        expect(o.calls).toEqual([`idea03 undock ${NC}`, `idea03 dock ${NC}`])
    })
    it('move_disk target that the Engine never docks fails loud (no silent move)', async () => {
        quiet()
        const o = mk()
        o.engineDeaf = true
        await expect(o.moveDisk('idea01', 'idea04', K)).rejects.toThrow(/dock of duration-empty-003 \(as duration-kolibri-grade5a-001\) on idea04 had no effect/)
    })
    it('r53 path end-to-end: Console eject@45 then infra_dock_fixture@58 → undock, gap, dock, verified', async () => {
        const o = liveCanned()
        o.docked[NC] = null
        const r = await dispatchAction(infraCtx(o, 'infra_dock_fixture'))
        expect(r.ok).toBe(true)
        expect(o.calls).toEqual([`idea03 undock ${NC}`, `idea03 dock ${NC}`])
        expect(o.sleeps).toContain(5_000)
        expect(o.fastCycles).toBe(0)
        expect(o.docked[NC]).toBe('idea03')
    })
})

// ── r55 (r54 step 58): the per-Pi dock path docks only the disks that need it ─────────
describe('r55: infra_dock_fixture docks only what is not Docked+mounted', () => {
    const saved = { ...process.env }
    afterEach(() => {
        vi.restoreAllMocks(); vi.unstubAllGlobals()
        for (const k of ['DURATION_NEXTCLOUD_URL', 'DURATION_KOLIBRI_URL']) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
        }
    })
    /** cover-all's real fixture set (scenarios/unified.yaml: all four infra_disk). */
    const fullCtx = (o: CannedStage2, walkerEngine: string | null = 'idea01') => ({
        ...(infraCtx(o, 'infra_dock_fixture', walkerEngine) as object),
        fixtureDisks: [K, NC, E1, E2],
    }) as never
    it('r54 replay: eject_disk@45 ejected Nextcloud only → step 58 docks ONLY Nextcloud; Kolibri, empty-001, empty-002 untouched', async () => {
        const o = liveCanned()
        o.docked[NC] = null // Console eject@45: store undocked, partition present + unmounted on idea03
        const r = await dispatchAction(fullCtx(o))
        expect(r.ok, r.message).toBe(true)
        // 1c5f167: + Engine eject, reset, undock, dock of empty-001 (idea03) and empty-002 (idea04).
        expect(o.calls).toEqual([`idea03 undock ${NC}`, `idea03 dock ${NC}`])
        expect(engineEjects).toEqual([])
        expect(o.calls.some(c => c.includes(E1) || c.includes(E2) || c.includes(K))).toBe(false)
        expect(r.message).toMatch(/Stage 2 homes: docked duration-nextcloud-grade5a-001 \[already Docked\+mounted, not re-docked: duration-kolibri-grade5a-001, duration-empty-001, duration-empty-002\]/)
    })
    it('step 61 after infra_undock_fixtures@60: every fixture is undocked → all docked again (Empties fresh)', async () => {
        const o = liveCanned()
        for (const d of [K, NC, E1, E2]) await o.undockFixtures(['idea01', 'idea03', 'idea04'], d)
        o.calls = []
        const r = await dispatchAction(fullCtx(o, null))
        expect(r.ok, r.message).toBe(true)
        expect(o.calls).toEqual([
            `idea01 dock ${K}`, `idea03 dock ${NC}`,
            `idea03 dock ${E1}`, `idea03 reset ${E1}`, `idea03 undock ${E1}`, `idea03 dock ${E1}`,
            `idea04 dock ${E2}`, `idea04 reset ${E2}`, `idea04 undock ${E2}`, `idea04 dock ${E2}`,
        ])
        expect(r.message).not.toMatch(/already Docked\+mounted/)
    })
    it('an Empty docked in the store but NOT mounted is docked (no shortcut on a stale row)', async () => {
        const o = liveCanned()
        o.docked[NC] = null
        const orig = o.findDockedEngine.bind(o)
        o.docked[E1] = null
        vi.spyOn(o, 'findDockedEngine').mockImplementation(async d => (d === E1 ? 'idea03' : orig(d))) // stale store row
        expect(await o.stage2DockedAndMounted('idea03', E1)).toBe(false)
        expect(await o.stage2DockedAndMounted('idea04', E2)).toBe(true)
        expect(await o.stage2DockedAndMounted('idea01', E2)).toBe(false)
    })
})
