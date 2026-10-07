/** Stage 2 harness rehome (real SSD per test Pi): layout, stage2-dock.sh contract, preflight, ops, gaps. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { fixtureDiskPreflight } from '../duration/fixtureDisks.js'
import {
    EXIT_STAGE2_PREFLIGHT, STAGE2_FIXTURES, STAGE2_GAPS, buildStage2DockCmd, parseStage2DockJson, parseStage2Status,
    resolveDurationStage, stage2EngineSettingsProblems, stage2FixturesOn, stage2HomeOf, stage2MoveTargetPartition,
    stage2NotCovered, stage2Preflight, stage2SummaryFields, validateStage2Layout, type Stage2Status,
} from '../duration/stage2.js'
import { Stage2FleetOps } from '../duration/stage2FleetOps.js'

const GOOD_CFG = `settings:
  testMode: false
  disksRoot: /disks
  skipImageLoad: false
  skipMetaWrite: true
  skipMetaUpdate: true
  skipHardwareId: true
  skipBorg: false
  peerAccess: true
  mdns: true
`
const statusFor = (host: string, over: Partial<Stage2Status> = {}): Stage2Status => ({
    ok: true, host, rootDisk: 'sda', ugreenDetached: host === 'idea03', extraSdDisks: [],
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
    configYaml: { idea01: GOOD_CFG, idea03: GOOD_CFG, idea04: GOOD_CFG } as Record<string, string | null | Error>,
    store: Object.fromEntries(STAGE2_FIXTURES.map(f => [f.diskId, { dockedTo: f.host, diskTypes: [...f.diskTypes!], instances: [] as string[] }])),
})

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

describe('engine settings pins', () => {
    it('accepts the Stage 2 pins', () => expect(stage2EngineSettingsProblems(GOOD_CFG, 'idea01')).toEqual([]))
    it('flags testMode on, unpinned skip*, private disksRoot, static peers, mDNS off', () => {
        const cfg = GOOD_CFG.replace('testMode: false', 'testMode: true').replace('  skipBorg: false\n', '')
            .replace('disksRoot: /disks', 'disksRoot: /home/pi/idea/duration-disks').replace('mdns: true', 'mdns: false') + '  staticPeers: idea03\n'
        const p = stage2EngineSettingsProblems(cfg, 'idea01').join(' | ')
        expect(p).toMatch(/testMode = true/)
        expect(p).toMatch(/skipBorg not set/)
        expect(p).toMatch(/disksRoot/)
        expect(p).toMatch(/mdns = false/)
        expect(p).toMatch(/staticPeers/)
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
    it('move target = an Empty partition on the target Pi, never the source', () => {
        expect(stage2MoveTargetPartition('idea03', 'duration-kolibri-grade5a-001').diskId).toBe('duration-empty-001')
        expect(stage2MoveTargetPartition('idea04', 'duration-kolibri-grade5a-001').diskId).toBe('duration-empty-003')
        expect(() => stage2MoveTargetPartition('idea01', 'duration-nextcloud-grade5a-001')).toThrow(/no Empty partition/)
    })
})

class CannedStage2 extends Stage2FleetOps {
    calls: string[] = []
    docked: Record<string, string | null> = {}
    protected override async ssh(host: string, cmd: string): Promise<string> {
        this.calls.push(`${host} ${cmd}`)
        const m = / (dock|undock) (\S+) --json$/.exec(cmd)
        if (m) {
            const host2 = Object.entries({ '10.0.0.1': 'idea01', '10.0.0.3': 'idea03', '10.0.0.4': 'idea04' }).find(([h]) => h === host)![1]
            this.docked[m[2]!] = m[1] === 'dock' ? host2 : null
            return `{"ok":true}`
        }
        return `{"ok":true}`
    }
    protected override async relayPipe(s: string, sc: string, d: string, dc: string): Promise<string> {
        this.calls.push(`RELAY ${s} ${sc} | ${d} ${dc}`)
        this.docked['duration-kolibri-grade5a-001'] = null
        return '{"ok":true}'
    }
    override async findDockedEngine(diskId: string): Promise<string | null> {
        if (diskId === 'duration-kolibri-grade5a-001' && this.docked['duration-empty-001'] === 'idea03') return 'idea03'
        return this.docked[diskId] ?? null
    }
}
const mk = () => new CannedStage2({
    poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' },
    storeMode: 'shared', sleep: async () => {},
})

describe('Stage2FleetOps', () => {
    afterEach(() => vi.restoreAllMocks())
    it('refuses idea02 in the pool', () => {
        expect(() => new Stage2FleetOps({ poolEngines: ['idea01', 'idea02'], hosts: { idea01: 'a', idea02: 'b' } })).toThrow(/idea02/)
    })
    it('dock = partition add on the home Pi only', async () => {
        const o = mk()
        await o.dockFixture('idea04', 'duration-empty-002')
        expect(o.calls).toEqual(['10.0.0.4 sudo -n /usr/local/sbin/stage2-dock.sh dock duration-empty-002 --json'])
        o.docked['duration-empty-002'] = null
        await expect(o.dockFixture('idea01', 'duration-empty-002')).rejects.toThrow(/lives on idea04/)
    })
    it('undock = Engine eject first, then partition remove', async () => {
        const o = mk()
        const order: string[] = []
        vi.spyOn(RealFleetOps.prototype, 'undockFixtures').mockImplementation(async () => { order.push('engine-eject') })
        o.docked['duration-empty-002'] = 'idea04'
        await o.undockFixtures(['idea04'], 'duration-empty-002')
        order.push(...o.calls)
        expect(order).toEqual(['engine-eject', '10.0.0.4 sudo -n /usr/local/sbin/stage2-dock.sh undock duration-empty-002 --json'])
    })
    it('move_disk = eject + export|import relay + dock target partition (network copy)', async () => {
        const o = mk()
        vi.spyOn(RealFleetOps.prototype, 'undockFixtures').mockResolvedValue()
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await o.moveDisk('idea01', 'idea03', 'duration-kolibri-grade5a-001')
        expect(o.calls).toEqual([
            'RELAY 10.0.0.1 sudo -n /usr/local/sbin/stage2-dock.sh export duration-kolibri-grade5a-001 | 10.0.0.3 sudo -n /usr/local/sbin/stage2-dock.sh import duration-empty-001 --as duration-kolibri-grade5a-001 --json',
            '10.0.0.3 sudo -n /usr/local/sbin/stage2-dock.sh dock duration-empty-001 --json',
        ])
    })
})
