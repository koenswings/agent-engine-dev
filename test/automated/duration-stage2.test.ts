/** Stage 2 harness rehome (real SSD per test Pi): layout, stage2-dock.sh contract, preflight, ops, gaps. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { fixtureDiskPreflight } from '../duration/fixtureDisks.js'
import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
    EXIT_STAGE2_PREFLIGHT, STAGE2_SPARE_ID, stage2SsdsOn, PRODUCTION_EFFECTIVE, NOT_ENFORCED_PENDING, STAGE2_DOCK_SPLIT, STAGE2_ROLE_MAP,
    buildEngineConfigProbe, describeStage2Conflicts, parseEngineConfigProbe, stage2MoveTargetId, stage2RoleTimeline, STAGE2_FIXTURES, STAGE2_GAPS, buildStage2DockCmd, parseStage2DockJson, parseStage2Status,
    resolveDurationStage, stage2EngineSettingsProblems, stage2FixturesOn, stage2HomeOf, stage2MoveTargetPartition,
    stage2NotCovered, stage2Preflight, stage2SummaryFields, validateStage2Layout, type Stage2Status,
} from '../duration/stage2.js'
import { Stage2FleetOps } from '../duration/stage2FleetOps.js'

// Golden idea02's config.yaml settings (read-only 2026-10-07), trimmed.
const GOOD_CFG = `settings:
  mdns: true
  isDev: false
  testMode: false   # comment
  port: 4321
  storeIdentityFolder: store-identity
`
const probe = (cfg = GOOD_CFG, env: Record<string, string> = {}) => ({ configYaml: cfg, pid: '1234', env })
const statusFor = (host: string, over: Partial<Stage2Status> = {}): Stage2Status => ({
    ok: true, host, bootId: 'boot-1', rootDisk: 'sda', ugreenDetached: host === 'idea03', extraSdDisks: [],
    ssds: stage2SsdsOn(host).map(n => ({ kname: n === 1 ? 'sdb' : 'sdc', serial: `SER${n}`, model: 'JAJS600M1TB' })),
    fixtures: stage2FixturesOn(host).map(f => {
        const d = f.ssd === 1 ? 'sdb' : 'sdc'
        return {
            partLabel: f.partLabel, diskId: f.diskId, kname: `${d}${f.partNumber}`, parent: d, fsType: 'ext4',
            fsLabel: f.fsLabel, mounted: f.expectDocked === false ? null : `/disks/${d}${f.partNumber}`, present: true,
        }
    }),
    ...over,
})
const goodInput = () => ({
    pool: ['idea01', 'idea03', 'idea04'],
    hosts: { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' } as Record<string, string>,
    status: { idea01: statusFor('idea01'), idea03: statusFor('idea03'), idea04: statusFor('idea04') } as Record<string, Stage2Status | Error>,
    configYaml: { idea01: probe(), idea03: probe(), idea04: probe() } as Record<string, ReturnType<typeof probe> | Error>,
    store: Object.fromEntries(STAGE2_FIXTURES.map(f => [f.diskId, { dockedTo: f.expectDocked === false ? null : f.host, diskTypes: [...f.diskTypes!], instances: [] as string[] }])),
})

const loadWalk = (name: string): { action: string }[] => {
    const url = new URL(`../duration/walks/${name}.yaml`, import.meta.url)
    const p = fs.existsSync(url) ? url : new URL(`../../../test/duration/walks/${name}.yaml`, import.meta.url)
    const doc = parseYaml(fs.readFileSync(p, 'utf8')) as { steps: { action: string }[] }
    return doc.steps
}

describe('stage switch', () => {
    it('defaults to Stage 1, accepts 2, rejects others', () => {
        expect(resolveDurationStage({})).toBe(1)
        expect(resolveDurationStage({ DURATION_STAGE: '1' })).toBe(1)
        expect(resolveDurationStage({ DURATION_STAGE: '2' })).toBe(2)
        expect(() => resolveDurationStage({ DURATION_STAGE: '3' })).toThrow(/not supported/)
    })
})

describe('Stage 2 layout', () => {
    it('≤2 partitions per SSD, idea04 has two SSDs (8 partitions), never idea02', () => {
        expect(validateStage2Layout()).toEqual([])
        expect(stage2FixturesOn('idea01').map(f => f.diskId)).toEqual(['duration-kolibri-grade5a-001', 'duration-add-files-001'])
        expect(stage2FixturesOn('idea03').map(f => f.diskId)).toEqual(['duration-nextcloud-grade5a-001', 'duration-empty-001'])
        expect(stage2FixturesOn('idea04').map(f => `${f.diskId}@ssd${f.ssd}p${f.partNumber}`)).toEqual([
            'duration-empty-002@ssd1p1', 'duration-empty-003@ssd1p2', 'duration-empty-004@ssd2p1', 'duration-empty-005@ssd2p2'])
        expect(STAGE2_FIXTURES).toHaveLength(8)
        expect(stage2SsdsOn('idea04')).toEqual([1, 2])
        expect(STAGE2_FIXTURES.find(f => f.diskId === 'duration-nextcloud-grade5a-001')!.diskTypes).toEqual(['app', 'files'])
        expect(stage2FixturesOn('idea02')).toEqual([])
        expect(STAGE2_FIXTURES.find(f => f.diskId === 'duration-add-files-001')!.diskTypes).toEqual(['app'])
    })
    it('flags a third partition, partition 3 and idea02', () => {
        const bad = [...STAGE2_FIXTURES, { ...STAGE2_FIXTURES[0]!, diskId: 'x', partLabel: 'X', fsLabel: 'X', partNumber: 3 as 1, host: 'idea01' as const }]
        const p = validateStage2Layout(bad)
        expect(p.join(' ')).toMatch(/partition 3/)
        expect(p.join(' ')).toMatch(/idea01 SSD1 carries 3/)
        // a third partition on a SECOND SSD is fine
        const ok2 = [...STAGE2_FIXTURES, { ...STAGE2_FIXTURES[0]!, diskId: 'y', partLabel: 'PY', fsLabel: 'FY', ssd: 2 as const, partNumber: 1 as const }]
        expect(validateStage2Layout(ok2)).toEqual([])
        expect(validateStage2Layout([{ ...STAGE2_FIXTURES[0]!, host: 'idea02' as 'idea01' }]).join()).toMatch(/never/)
    })
})

describe('stage2-dock.sh contract', () => {
    it('builds sudo -n command lines for each verb', () => {
        expect(buildStage2DockCmd('status')).toBe('sudo -n /usr/local/sbin/stage2-dock.sh status --json')
        expect(buildStage2DockCmd('eject-ssd', { diskId: 'duration-empty-004' })).toBe('sudo -n /usr/local/sbin/stage2-dock.sh eject-ssd --ssd duration-empty-004 --json')
        expect(() => buildStage2DockCmd('dock-ssd')).toThrow(/selects the SSD/)
        expect(buildStage2DockCmd('dock', { diskId: 'duration-empty-002' })).toBe('sudo -n /usr/local/sbin/stage2-dock.sh dock duration-empty-002 --json')
        expect(buildStage2DockCmd('export', { diskId: 'duration-kolibri-grade5a-001' })).toBe('sudo -n /usr/local/sbin/stage2-dock.sh export duration-kolibri-grade5a-001')
        expect(buildStage2DockCmd('import', { diskId: 'duration-empty-001', as: 'duration-kolibri-grade5a-001' }))
            .toBe('sudo -n /usr/local/sbin/stage2-dock.sh import duration-empty-001 --as duration-kolibri-grade5a-001 --json')
    })
    it('refuses unknown / injected disk ids and bad script paths', () => {
        expect(() => buildStage2DockCmd('dock', { diskId: 'sda' })).toThrow(/not a Stage 2 fixture/)
        expect(() => buildStage2DockCmd('dock', { diskId: 'x; rm -rf /' })).toThrow(/valid diskId/)
        expect(() => buildStage2DockCmd('dock')).toThrow(/valid diskId/)
        expect(() => buildStage2DockCmd('status', {}, 'stage2-dock.sh')).toThrow(/refuse/)
    })
    it('parses the last JSON line and status', () => {
        expect(parseStage2DockJson('noise\n{"ok":true,"kname":"sdb1"}\n', 'dock').kname).toBe('sdb1')
        expect(() => parseStage2DockJson('done', 'dock')).toThrow(/not JSON/)
        expect(() => parseStage2DockJson('{"x":1}', 'dock')).toThrow(/boolean ok/)
        const st = parseStage2Status(JSON.stringify(statusFor('idea04')))
        expect(st.fixtures).toHaveLength(4)
        expect(st.ssds.map(d => d.kname)).toEqual(['sdb', 'sdc'])
        expect(parseStage2Status(JSON.stringify({ ...statusFor('idea01'), ssds: undefined })).ssds).toEqual([])
        expect(st.fixtures[0]!.mounted).toBe('/disks/sdb1')
    })
})

describe('engine settings = production', () => {
    it('production effective values (all Config.ts defaults)', () => {
        expect(PRODUCTION_EFFECTIVE).toEqual({
            testMode: false, isDev: false, mdns: true, disksRoot: '/disks', staticPeers: null, skipImageLoad: false,
            skipMetaWrite: false, skipBorg: false, skipHardwareId: false, skipMetaUpdate: false, peerAccess: true,
        })
    })
    it('accepts a Pi configured like idea02', () => expect(stage2EngineSettingsProblems(probe(), 'idea01')).toEqual([]))
    it('flags Stage 1 env overrides, test-only keys, testMode, mDNS off, static peers, no Engine', () => {
        const p = stage2EngineSettingsProblems(probe(GOOD_CFG.replace('mdns: true', 'mdns: false') + '  skipBorg: true\n  staticPeers: idea03\n',
            { IDEA_TEST_MODE: 'true', IDEA_DISKS_ROOT: '/home/pi/idea/duration-disks', IDEA_WATCH_DIR: '/home/pi/idea/duration-watch' }), 'idea01').join(' | ')
        for (const re of [/IDEA_TEST_MODE=true/, /IDEA_DISKS_ROOT/, /IDEA_WATCH_DIR/, /settings.skipBorg/, /settings.staticPeers/,
            /effective testMode = true/, /effective mdns = false/, /effective disksRoot/, /effective skipBorg = true/]) expect(p).toMatch(re)
        expect(stage2EngineSettingsProblems({ configYaml: GOOD_CFG, pid: null, env: {} }, 'x').join()).toMatch(/no running Engine/)
    })
    it('skipHardwareId is not enforced until D4', () => {
        expect(NOT_ENFORCED_PENDING.skipHardwareId).toMatch(/D4/)
        expect(stage2EngineSettingsProblems(probe(GOOD_CFG, { IDEA_SKIP_HARDWARE_ID: 'true' }), 'h').join()).not.toMatch(/effective skipHardwareId/)
    })
    it('parses the config probe output', () => {
        const pr = parseEngineConfigProbe(`@@S2 config\n${GOOD_CFG}@@S2 env\npid=42\nenv:IDEA_DISKS_ROOT=/x\n@@S2 end\n`)
        expect(pr.pid).toBe('42'); expect(pr.env).toEqual({ IDEA_DISKS_ROOT: '/x' }); expect(pr.configYaml).toMatch(/testMode: false/)
        expect(buildEngineConfigProbe()).toMatch(/\/home\/pi\/idea\/agents\/agent-engine-dev/)
        expect(buildEngineConfigProbe()).not.toMatch(/(pm2 (restart|start|stop|delete|set)|tee|(?<!2)>\s*\/)/)
    })
})

describe('role map + move target timeline', () => {
    it('roles: Files 001 idea03, Erase 002 / Backup 003 idea04 SSD1; move target 004 on idea04 SSD2, spare 005', () => {
        expect(STAGE2_ROLE_MAP).toEqual({ files: 'duration-empty-001', backup: 'duration-empty-003', erase: 'duration-empty-002' })
        expect(stage2MoveTargetId()).toBe('duration-empty-004')
        const mt = STAGE2_FIXTURES.find(f => f.diskId === 'duration-empty-004')!
        expect([mt.host, mt.ssd, mt.partNumber]).toEqual(['idea04', 2, 1])
        expect(Object.values(STAGE2_ROLE_MAP)).not.toContain(STAGE2_SPARE_ID)
    })
    it('cover-all passes the timeline with the dedicated move target', () => {
        expect(stage2RoleTimeline(loadWalk('cover-all'))).toEqual([])
    })
    it('a role disk as move target is still detected (regression guard)', () => {
        const steps = loadWalk('cover-all')
        expect(stage2RoleTimeline(steps, 'duration-empty-002').map(c => `${c.roleStep} ${c.action}`)).toEqual(['104 erase_disk'])
        expect(stage2RoleTimeline(steps, 'duration-empty-003').map(c => c.action)).toEqual(expect.arrayContaining(['make_backup_disk']))
        expect(describeStage2Conflicts(stage2RoleTimeline(steps, 'duration-empty-002'))).toMatch(/must not be a role disk/)
    })
})

describe('stage2Preflight', () => {
    it('passes on the reset layout', () => {
        const r = stage2Preflight(goodInput())
        expect(r.problems).toEqual([])
        expect(r.ok).toBe(true)
        expect(r.table).toHaveLength(8)
        expect(EXIT_STAGE2_PREFLIGHT).toBe(10)
    })
    it('cover-all passes the preflight timeline with the dedicated move target', () => {
        const r = stage2Preflight({ ...goodInput(), steps: loadWalk('cover-all') })
        expect(r.problems).toEqual([])
    })
    it('fails closed on idea02, root-disk partition, sdb3, vfat, wrong META, dirty store, Ugreen attached', () => {
        const i = goodInput()
        i.hosts.idea02 = '10.0.0.2'
        const s1 = statusFor('idea01')
        s1.fixtures[0]!.parent = 'sda'
        s1.fixtures[1]!.kname = 'sdb3'
        s1.fixtures[1]!.fsType = 'vfat'
        i.status.idea01 = s1
        i.status.idea03 = statusFor('idea03', { ugreenDetached: false, extraSdDisks: ['sdc'] })
        const s4 = statusFor('idea04'); s4.fixtures[0]!.diskId = 'duration-empty-003'; i.status.idea04 = s4
        i.store['duration-empty-001'] = { dockedTo: 'idea03', diskTypes: ['files'], instances: ['x'] }
        i.store['duration-add-files-001'] = { dockedTo: 'idea01', diskTypes: ['app', 'files'], instances: [] }
        i.store['duration-empty-002'] = { dockedTo: 'idea01', diskTypes: ['empty'], instances: [] }
        const p = stage2Preflight(i)
        expect(p.ok).toBe(false)
        const all = p.problems.join(' | ')
        for (const re of [/idea02/, /ROOT disk/, /sdb3/, /ext4 only/, /META diskId duration-empty-003/, /Ugreen/, /sdc/,
            /duration-empty-001: diskTypes=\[files\]/, /holds instances x/, /add-files-001: diskTypes=\[app, files\]/,
            /duration-empty-002: dockedTo=idea01, home is idea04/, /more than one disk/]) expect(all).toMatch(re)
    })
    it('per-SSD checks: SSD2 partitions on the root disk / split across disks / same disk as SSD1', () => {
        const i = goodInput()
        const s4 = statusFor('idea04')
        s4.fixtures[2]!.parent = 'sda'; s4.fixtures[2]!.kname = 'sda1'
        i.status.idea04 = s4
        expect(stage2Preflight(i).problems.join(' | ')).toMatch(/ROOT disk/)
        expect(stage2Preflight(i).problems.join(' | ')).toMatch(/SSD2 fixtures sit on more than one disk/)
        const j = goodInput(); const t4 = statusFor('idea04')
        t4.fixtures.forEach(f => { f.parent = 'sdb'; f.kname = `sdb${f.kname!.slice(-1)}` })
        j.status.idea04 = t4
        expect(stage2Preflight(j).problems.join(' | ')).toMatch(/two fixture SSDs resolve to the same disk/)
    })
    it('spare must stay out of the Engine', () => {
        const i = goodInput()
        i.store['duration-empty-005'] = { dockedTo: 'idea04', diskTypes: ['empty'], instances: [] }
        expect(stage2Preflight(i).problems.join()).toMatch(/spare\) is docked/)
    })
    it('D4: two partitions resolving to one diskId fail; Intenso/Samsung FIT + skipHardwareId off fails', () => {
        const i = goodInput(); const s4 = statusFor('idea04')
        s4.fixtures[0]!.diskId = 'SERIAL123'; s4.fixtures[1]!.diskId = 'SERIAL123'
        i.status.idea04 = s4
        expect(stage2Preflight(i).problems.join(' | ')).toMatch(/D4: diskId SERIAL123 resolves for 2 partitions/)
        const j = goodInput()
        j.status.idea01 = statusFor('idea01', { ssds: [{ kname: 'sdb', serial: 'X1', model: 'Intenso Portable SSD' }] })
        expect(stage2Preflight(j).problems.join(' | ')).toMatch(/D4 hw-id collision risk.*Intenso/)
        j.configYaml.idea01 = probe(GOOD_CFG, { IDEA_SKIP_HARDWARE_ID: 'true' })
        expect(stage2Preflight(j).problems.join(' | ')).not.toMatch(/D4 hw-id collision risk/)
    })
    it('reports a status probe failure and a missing home Pi', () => {
        const i = goodInput()
        i.status.idea04 = new Error('stage2-dock.sh: not found')
        i.pool = ['idea01', 'idea04']
        const all = stage2Preflight(i).problems.join(' | ')
        expect(all).toMatch(/idea04: stage2-dock status failed \(stage2-dock.sh: not found\)/)
        expect(all).toMatch(/fixture home idea03 not in pool_engines/)
    })
})

describe('fixture disk preflight (Stage 2 homes)', () => {
    const view = {
        engineId: 'idea01', instanceDB: {}, engineDB: {},
        diskDB: Object.fromEntries(['duration-empty-001', 'duration-empty-002', 'duration-empty-003'].map(id => [id, { id, dockedTo: stage2HomeOf(id), diskTypes: ['empty'] }])),
    }
    const steps = [{ action: 'make_files_disk' }, { action: 'make_backup_disk' }, { action: 'erase_disk' }]
    it('Stage 1 rule (Console engine) would refuse; Stage 2 homes pass', () => {
        expect(fixtureDiskPreflight({ steps, startIndex: 0, consoleEngine: 'idea01', poolEngines: ['idea01', 'idea03', 'idea04'], view, env: {} }).ok).toBe(false)
        const r = fixtureDiskPreflight({ steps, startIndex: 0, consoleEngine: 'idea01', poolEngines: ['idea01', 'idea03', 'idea04'], view, env: {}, expectedHostOf: stage2HomeOf })
        expect(r.problems).toEqual([])
    })
})

describe('declared gaps', () => {
    it('move_disk is a network copy, listed per walk step', () => {
        expect(STAGE2_GAPS.map(g => g.action)).toEqual(['infra_move_disk'])
        expect(stage2NotCovered([{ action: 'copy_app' }, { action: 'infra_move_disk' }])).toEqual([
            { step: 2, action: 'infra_move_disk', semantics: STAGE2_GAPS[0]!.semantics },
        ])
        expect(stage2SummaryFields(null)).toMatchObject({ stage: 2, stage2NotCovered: [] })
    })
    it('move target = idea04 empty-002 only; never idea03 empty-001 (Files)', () => {
        expect(stage2MoveTargetPartition('idea04', 'duration-kolibri-grade5a-001').diskId).toBe('duration-empty-004')
        expect(() => stage2MoveTargetPartition('idea03', 'duration-kolibri-grade5a-001')).toThrow(/must be idea04/)
        expect(() => stage2MoveTargetPartition('idea04', 'duration-empty-004')).toThrow(/move target itself/)
        expect(STAGE2_GAPS).toHaveLength(1)
    })
    it('dock split: partition for per-disk steps, whole SSD only for reboot/yank', () => {
        const ssd = Object.entries(STAGE2_DOCK_SPLIT).filter(([, v]) => v.level === 'ssd').map(([k]) => k).sort()
        expect(ssd).toEqual(['05:00 daily reboot', 'infra_reboot_engine', 'reboot_engine', 'yank'])
        expect(STAGE2_DOCK_SPLIT.infra_move_disk!.level).toBe('partition')
    })
})

const IP: Record<string, string> = { '10.0.0.1': 'idea01', '10.0.0.3': 'idea03', '10.0.0.4': 'idea04' }
const strip = (c: string) => c.replace('sudo -n /usr/local/sbin/stage2-dock.sh ', '').replace(' --json', '')
class CannedStage2 extends Stage2FleetOps {
    calls: string[] = []
    docked: Record<string, string | null> = {}
    /** partition diskId → META diskId on it (moved copy). */
    meta: Record<string, string> = {}
    boot: Record<string, string> = { idea01: 'b1', idea03: 'b1', idea04: 'b1' }
    ssdMissing = new Set<string>() // `${host}#${ssd}`
    alreadyMounted = new Set<string>()
    protected override async ssh(host: string, cmd: string): Promise<string> {
        const h = IP[host]!
        if (cmd.endsWith(' status --json')) {
            const st = statusFor(h, { bootId: this.boot[h]! })
            stage2FixturesOn(h).forEach((f, i) => { if (this.ssdMissing.has(`${h}#${f.ssd}`)) st.fixtures[i]!.present = false })
            return JSON.stringify(st)
        }
        const c = strip(cmd)
        this.calls.push(`${h} ${c}`)
        const ssd = /^dock-ssd --ssd (\S+)$/.exec(c)
        if (ssd) STAGE2_FIXTURES.filter(f => f.host === h).forEach(f => this.ssdMissing.delete(`${h}#${f.ssd}`))
        const m = /^(dock|undock) (\S+)$/.exec(c)
        if (m) {
            const onIt = this.meta[m[2]!] ?? m[2]!
            if (m[1] === 'dock' && this.alreadyMounted.has(m[2]!)) { this.docked[onIt] = h; return '{"ok":true,"already":true}' }
            this.docked[onIt] = m[1] === 'dock' ? h : null
        }
        return `{"ok":true}`
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
const mk = () => new CannedStage2({
    poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' },
    storeMode: 'shared', sleep: async () => {}, dockWaitMs: 50,
})

describe('Stage2FleetOps', () => {
    afterEach(() => vi.restoreAllMocks())
    const quiet = () => {
        vi.spyOn(RealFleetOps.prototype, 'undockFixtures').mockResolvedValue()
        vi.spyOn(console, 'log').mockImplementation(() => {})
    }
    it('refuses idea02 in the pool', () => {
        expect(() => new Stage2FleetOps({ poolEngines: ['idea01', 'idea02'], hosts: { idea01: 'a', idea02: 'b' } })).toThrow(/idea02/)
    })
    it('dock app fixture = partition add on its home Pi; wrong Pi refused; already:true accepted', async () => {
        quiet()
        const o = mk()
        await o.dockFixture('idea03', 'duration-nextcloud-grade5a-001')
        expect(o.calls).toEqual(['idea03 dock duration-nextcloud-grade5a-001'])
        o.docked['duration-nextcloud-grade5a-001'] = null
        await expect(o.dockFixture('idea01', 'duration-nextcloud-grade5a-001')).rejects.toThrow(/lives on idea03/)
        o.alreadyMounted.add('duration-nextcloud-grade5a-001')
        await o.dockFixture('idea03', 'duration-nextcloud-grade5a-001')
        expect(o.docked['duration-nextcloud-grade5a-001']).toBe('idea03')
    })
    it('Empty fixture docks fresh: Engine eject → reset (partition stays present) → dock', async () => {
        quiet()
        const o = mk()
        o.docked['duration-empty-001'] = 'idea03'
        await o.dockFixture('idea03', 'duration-empty-001')
        expect(o.calls).toEqual(['idea03 reset duration-empty-001', 'idea03 dock duration-empty-001'])
    })
    it('held-undocked Empty is re-added before reset (reset needs it present)', async () => {
        quiet()
        const o = mk()
        o.docked['duration-empty-002'] = 'idea04'
        await o.undockFixtures(['idea04'], 'duration-empty-002')
        o.calls = []
        await o.dockFixture('idea04', 'duration-empty-002')
        expect(o.calls).toEqual(['idea04 dock duration-empty-002', 'idea04 reset duration-empty-002', 'idea04 dock duration-empty-002'])
    })
    it('the spare is never docked', async () => {
        await expect(mk().dockFixture('idea04', 'duration-empty-005')).rejects.toThrow(/spare/)
    })
    it('undock = Engine eject first, then partition remove; held across reboots', async () => {
        const o = mk()
        const order: string[] = []
        vi.spyOn(RealFleetOps.prototype, 'undockFixtures').mockImplementation(async () => { order.push('engine-eject') })
        o.docked['duration-empty-002'] = 'idea04'
        await o.undockFixtures(['idea04'], 'duration-empty-002')
        order.push(...o.calls)
        expect(order).toEqual(['engine-eject', 'idea04 undock duration-empty-002'])
        expect(o.heldUndocked.has('duration-empty-002')).toBe(true)
    })
    it('move_disk → dedicated target empty-004: reset, export|import, undock source, dock target', async () => {
        quiet()
        const o = mk()
        o.docked['duration-kolibri-grade5a-001'] = 'idea01'
        o.docked['duration-empty-004'] = 'idea04'
        await o.moveDisk('idea01', 'idea04', 'duration-kolibri-grade5a-001')
        expect(o.calls).toEqual([
            'idea04 reset duration-empty-004',
            'RELAY idea01 export duration-kolibri-grade5a-001 | idea04 import duration-empty-004 --as duration-kolibri-grade5a-001',
            'idea01 undock duration-kolibri-grade5a-001',
            'idea04 dock duration-empty-004',
        ])
        expect(o.docked['duration-kolibri-grade5a-001']).toBe('idea04')
        expect(o.moveCopies.get('duration-empty-004')).toBe('duration-kolibri-grade5a-001')
        await expect(o.moveDisk('idea01', 'idea03', 'duration-add-files-001')).rejects.toThrow(/must be idea04/)
    })
    it('no fallback: role disks untouched by a move; home re-dock of a moved disk and re-dock of the move target are refused', async () => {
        quiet()
        const o = mk()
        o.docked['duration-kolibri-grade5a-001'] = 'idea01'
        await o.moveDisk('idea01', 'idea04', 'duration-kolibri-grade5a-001')
        expect(o.calls.some(c => /empty-00[123]/.test(c))).toBe(false)
        await expect(o.dockFixture('idea01', 'duration-kolibri-grade5a-001')).rejects.toThrow(/two partitions one diskId/)
        await expect(o.dockFixture('idea04', 'duration-empty-004')).rejects.toThrow(/holds the moved/)
        o.calls = []
        o.docked['duration-empty-002'] = 'idea04'
        await o.dockFixture('idea04', 'duration-empty-002')
        expect(o.calls).toEqual(['idea04 reset duration-empty-002', 'idea04 dock duration-empty-002'])
    })
    it('05:00 reboot (boot_id change) → redock: held-undocked re-undocked, spare kept out, others awaited', async () => {
        quiet()
        const o = mk()
        for (const f of stage2FixturesOn('idea04')) o.docked[f.diskId] = f.expectDocked === false ? null : 'idea04'
        await o.undockFixtures(['idea04'], 'duration-empty-002')
        o.docked['duration-empty-002'] = 'idea04' // boot re-added it
        o.boot.idea04 = 'b2'
        o.calls = []
        await o.dockFixture('idea04', 'duration-empty-003')
        expect(o.redockLog).toEqual([
            'idea04: keep spare duration-empty-005 out',
            'idea04: re-undock duration-empty-002',
            'idea04: wait docked duration-empty-003',
            'idea04: wait docked duration-empty-004',
        ])
        expect(o.calls.slice(0, 2)).toEqual(['idea04 undock duration-empty-005', 'idea04 undock duration-empty-002'])
    })
    it('reboot with ONE SSD missing → dock-ssd for that SSD only', async () => {
        quiet()
        const o = mk()
        vi.spyOn(RealFleetOps.prototype, 'rebootEngine').mockResolvedValue()
        for (const f of stage2FixturesOn('idea04')) o.docked[f.diskId] = f.expectDocked === false ? null : 'idea04'
        o.ssdMissing.add('idea04#2')
        await o.rebootEngine('idea04', true)
        expect(o.calls[0]).toBe('idea04 dock-ssd --ssd duration-empty-004')
        expect(o.calls.filter(c => c.includes('dock-ssd'))).toHaveLength(1)
    })
})
