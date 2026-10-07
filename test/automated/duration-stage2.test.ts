/** Stage 2 harness rehome (real SSD per test Pi): layout, stage2-dock.sh contract, preflight, ops, gaps. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { fixtureDiskPreflight } from '../duration/fixtureDisks.js'
import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
    EXIT_STAGE2_PREFLIGHT, PRODUCTION_EFFECTIVE, NOT_ENFORCED_PENDING, STAGE2_DOCK_SPLIT, STAGE2_ROLE_MAP,
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
    fixtures: stage2FixturesOn(host).map(f => ({
        partLabel: f.partLabel, diskId: f.diskId, kname: `sdb${f.partNumber}`, parent: 'sdb', fsType: 'ext4',
        fsLabel: f.fsLabel, mounted: `/disks/sdb${f.partNumber}`, present: true,
    })),
    ...over,
})
const goodInput = () => ({
    pool: ['idea01', 'idea03', 'idea04'],
    hosts: { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' } as Record<string, string>,
    status: { idea01: statusFor('idea01'), idea03: statusFor('idea03'), idea04: statusFor('idea04') } as Record<string, Stage2Status | Error>,
    configYaml: { idea01: probe(), idea03: probe(), idea04: probe() } as Record<string, ReturnType<typeof probe> | Error>,
    store: Object.fromEntries(STAGE2_FIXTURES.map(f => [f.diskId, { dockedTo: f.host, diskTypes: [...f.diskTypes!], instances: [] as string[] }])),
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
    it('two fixtures per Pi on partitions 1/2, never idea02', () => {
        expect(validateStage2Layout()).toEqual([])
        expect(stage2FixturesOn('idea01').map(f => f.diskId)).toEqual(['duration-kolibri-grade5a-001', 'duration-add-files-001'])
        expect(stage2FixturesOn('idea03').map(f => f.diskId)).toEqual(['duration-nextcloud-grade5a-001', 'duration-empty-001'])
        expect(stage2FixturesOn('idea04').map(f => f.diskId)).toEqual(['duration-empty-002', 'duration-empty-003'])
        expect(stage2FixturesOn('idea02')).toEqual([])
        expect(STAGE2_FIXTURES.find(f => f.diskId === 'duration-add-files-001')!.diskTypes).toEqual(['app'])
    })
    it('flags a third partition, partition 3 and idea02', () => {
        const bad = [...STAGE2_FIXTURES, { ...STAGE2_FIXTURES[0]!, diskId: 'x', partLabel: 'X', fsLabel: 'X', partNumber: 3 as 1, host: 'idea01' as const }]
        const p = validateStage2Layout(bad)
        expect(p.join(' ')).toMatch(/partition 3/)
        expect(p.join(' ')).toMatch(/idea01 carries 3/)
        expect(validateStage2Layout([{ ...STAGE2_FIXTURES[0]!, host: 'idea02' as 'idea01' }]).join()).toMatch(/never/)
    })
})

describe('stage2-dock.sh contract', () => {
    it('builds sudo -n command lines for each verb', () => {
        expect(buildStage2DockCmd('status')).toBe('sudo -n /usr/local/sbin/stage2-dock.sh status --json')
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
        expect(st.fixtures).toHaveLength(2)
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
    it('roles: Files 001 idea03, Erase 002 / Backup 003 idea04; move target idea04 002 by default', () => {
        expect(STAGE2_ROLE_MAP).toEqual({ files: 'duration-empty-001', backup: 'duration-empty-003', erase: 'duration-empty-002' })
        expect(stage2MoveTargetId({})).toBe('duration-empty-002')
        expect(() => stage2MoveTargetId({ DURATION_STAGE2_MOVE_TARGET: 'duration-empty-001' })).toThrow(/idea04/)
    })
    it('cover-all: move target conflicts with its role whichever of 002/003 is chosen', () => {
        const steps = loadWalk('cover-all')
        const c2 = stage2RoleTimeline(steps, {})
        expect(c2.map(c => `${c.roleStep} ${c.action}`)).toEqual(['104 erase_disk'])
        expect(c2[0]!.moveStep).toBe(62)
        expect(describeStage2Conflicts(c2)).toMatch(/do not fit/)
        const c3 = stage2RoleTimeline(steps, { DURATION_STAGE2_MOVE_TARGET: 'duration-empty-003' })
        expect(c3.map(c => c.action)).toEqual(expect.arrayContaining(['make_backup_disk']))
    })
    it('no move step → no conflict', () => {
        expect(stage2RoleTimeline([{ action: 'erase_disk' }, { action: 'make_backup_disk' }], {})).toEqual([])
    })
})

describe('stage2Preflight', () => {
    it('passes on the reset layout', () => {
        const r = stage2Preflight(goodInput())
        expect(r.problems).toEqual([])
        expect(r.ok).toBe(true)
        expect(r.table).toHaveLength(6)
        expect(EXIT_STAGE2_PREFLIGHT).toBe(10)
    })
    it('fails on the cover-all role/move conflict when given the walk', () => {
        const r = stage2Preflight({ ...goodInput(), steps: loadWalk('cover-all') })
        expect(r.ok).toBe(false)
        expect(r.problems.join()).toMatch(/do not fit/)
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
        expect(stage2MoveTargetPartition('idea04', 'duration-kolibri-grade5a-001', {}).diskId).toBe('duration-empty-002')
        expect(() => stage2MoveTargetPartition('idea03', 'duration-kolibri-grade5a-001', {})).toThrow(/must be idea04/)
        expect(() => stage2MoveTargetPartition('idea04', 'duration-empty-002', {})).toThrow(/move target itself/)
    })
    it('dock split: partition for per-disk steps, whole SSD only for reboot/yank', () => {
        const ssd = Object.entries(STAGE2_DOCK_SPLIT).filter(([, v]) => v.level === 'ssd').map(([k]) => k).sort()
        expect(ssd).toEqual(['05:00 daily reboot', 'infra_reboot_engine', 'reboot_engine', 'yank'])
        expect(STAGE2_DOCK_SPLIT.infra_move_disk!.level).toBe('partition')
    })
})

const IP: Record<string, string> = { '10.0.0.1': 'idea01', '10.0.0.3': 'idea03', '10.0.0.4': 'idea04' }
class CannedStage2 extends Stage2FleetOps {
    calls: string[] = []
    docked: Record<string, string | null> = {}
    boot: Record<string, string> = { idea01: 'b1', idea03: 'b1', idea04: 'b1' }
    ssdMissing = new Set<string>()
    protected override async ssh(host: string, cmd: string): Promise<string> {
        const h = IP[host]!
        if (cmd.endsWith(' status --json')) {
            const st = statusFor(h, { bootId: this.boot[h]! })
            if (this.ssdMissing.has(h)) st.fixtures.forEach(f => { f.present = false })
            return JSON.stringify(st)
        }
        this.calls.push(`${h} ${cmd.replace('sudo -n /usr/local/sbin/stage2-dock.sh ', '').replace(' --json', '')}`)
        if (cmd.endsWith(' dock-ssd --json')) this.ssdMissing.delete(h)
        const m = / (dock|undock) (\S+) --json$/.exec(cmd)
        if (m) {
            const occupant = m[2] === 'duration-empty-002' && this.kolibriOn002 ? 'duration-kolibri-grade5a-001' : m[2]!
            this.docked[occupant] = m[1] === 'dock' ? h : null
        }
        return `{"ok":true}`
    }
    kolibriOn002 = false
    protected override async relayPipe(s: string, sc: string, d: string, dc: string): Promise<string> {
        this.calls.push(`RELAY ${IP[s]} ${sc.replace('sudo -n /usr/local/sbin/stage2-dock.sh ', '')} | ${IP[d]} ${dc.replace('sudo -n /usr/local/sbin/stage2-dock.sh ', '').replace(' --json', '')}`)
        this.kolibriOn002 = true
        return '{"ok":true}'
    }
    override async findDockedEngine(diskId: string): Promise<string | null> {
        return this.docked[diskId] ?? null
    }
}
const mk = () => new CannedStage2({
    poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' },
    storeMode: 'shared', sleep: async () => {},
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
    it('dock app fixture = partition add on its home Pi; wrong Pi refused', async () => {
        quiet()
        const o = mk()
        await o.dockFixture('idea03', 'duration-nextcloud-grade5a-001')
        expect(o.calls).toEqual(['idea03 dock duration-nextcloud-grade5a-001'])
        o.docked['duration-nextcloud-grade5a-001'] = null
        await expect(o.dockFixture('idea01', 'duration-nextcloud-grade5a-001')).rejects.toThrow(/lives on idea03/)
    })
    it('Empty fixture always docks fresh (undock → reset → dock)', async () => {
        quiet()
        const o = mk()
        o.docked['duration-empty-001'] = 'idea03'
        await o.dockFixture('idea03', 'duration-empty-001')
        expect(o.calls).toEqual(['idea03 undock duration-empty-001', 'idea03 reset duration-empty-001', 'idea03 dock duration-empty-001'])
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
    it('move_disk = eject, reset target, export|import relay into idea04 empty-002, undock source, dock target', async () => {
        quiet()
        const o = mk()
        o.docked['duration-kolibri-grade5a-001'] = 'idea01'
        await o.moveDisk('idea01', 'idea04', 'duration-kolibri-grade5a-001')
        expect(o.calls).toEqual([
            'idea04 reset duration-empty-002',
            'RELAY idea01 export duration-kolibri-grade5a-001 | idea04 import duration-empty-002 --as duration-kolibri-grade5a-001',
            'idea01 undock duration-kolibri-grade5a-001',
            'idea04 dock duration-empty-002',
        ])
        expect(o.moveCopies.get('duration-empty-002')).toBe('duration-kolibri-grade5a-001')
        await expect(o.moveDisk('idea01', 'idea03', 'duration-nextcloud-grade5a-001')).rejects.toThrow(/must be idea04/)
    })
    it('Erase redock while 002 holds moved Kolibri: copy out, Kolibri back home, 002 reset fresh', async () => {
        quiet()
        const o = mk()
        o.docked['duration-kolibri-grade5a-001'] = 'idea01'
        await o.moveDisk('idea01', 'idea04', 'duration-kolibri-grade5a-001')
        o.calls = []
        o.kolibriOn002 = false
        await o.dockFixture('idea04', 'duration-empty-002')
        expect(o.calls).toEqual([
            'idea04 undock duration-empty-002',
            'idea01 dock duration-kolibri-grade5a-001',
            'idea04 reset duration-empty-002',
            'idea04 dock duration-empty-002',
        ])
        expect(o.moveCopies.size).toBe(0)
    })
    it('05:00 reboot (boot_id change) → redock: held-undocked fixture undocked again, others awaited', async () => {
        quiet()
        const o = mk()
        o.docked['duration-empty-002'] = 'idea04'
        await o.undockFixtures(['idea04'], 'duration-empty-002')
        o.docked['duration-empty-002'] = 'idea04' // partitions came back at boot
        o.docked['duration-empty-003'] = 'idea04'
        o.boot.idea04 = 'b2'
        o.calls = []
        await o.dockFixture('idea04', 'duration-empty-003')
        expect(o.redockLog).toEqual(['idea04: re-undock duration-empty-002', 'idea04: wait docked duration-empty-003'])
        expect(o.calls[0]).toBe('idea04 undock duration-empty-002')
    })
    it('reboot with SSD missing → dock-ssd (whole SSD) then partition state', async () => {
        quiet()
        const o = mk()
        vi.spyOn(RealFleetOps.prototype, 'rebootEngine').mockResolvedValue()
        o.ssdMissing.add('idea03')
        o.docked['duration-nextcloud-grade5a-001'] = 'idea03'
        o.docked['duration-empty-001'] = 'idea03'
        await o.rebootEngine('idea03', true)
        expect(o.calls).toEqual(['idea03 dock-ssd'])
        expect(o.redockLog[0]).toBe('idea03: SSD missing after boot → dock-ssd')
    })
})
