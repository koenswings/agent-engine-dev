/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Step 92 (random-mixed c6ed5f4-7cbaf60 Markov, seed 42, infra_undock_fixtures): "Stage 2: Engine eject of
 * duration-kolibri-grade5a-001 on idea01 not done within 120000ms (dockedTo=idea01 IDEA-KOLIBRI mounted=no)".
 * idea01's Engine did eject (log: 'ejected successfully'; its own store: dockedTo=null from a single change at
 * 10:25:09; partition unmounted), but the walker polls findDockedEngine = the FIRST of three replicas that says
 * docked, so one frozen replica kept the pool "docked" for 120 s with no guard (the r65 stale-view guard exists
 * for ops waits, not for this one). Now: Pi unmounted + a replica still docked → that replica is re-synced
 * (counted), and a replica that stays stale fails loud naming it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Stage2FleetOps } from '../duration/stage2FleetOps.js'
import { RealFleetOps } from '../duration/realFleetOps.js'

const K = 'duration-kolibri-grade5a-001'
const POOL = ['idea01', 'idea03', 'idea04']

const mk = (opts: { replicas: Record<string, string | null | 'throw'>; mounted: string | null; healOnRefresh?: boolean }) => {
    const o = new Stage2FleetOps({
        poolEngines: POOL, hosts: { idea01: 'a', idea03: 'b', idea04: 'c' }, storeMode: 'shared',
        sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))), dockWaitMs: 300, ejectViewRefreshMs: 20,
    }) as any
    const replicas = { ...opts.replicas }
    const refreshed: string[] = []
    o.readStore = async (id: string) => {
        if (replicas[id] === 'throw') throw new Error('store doc not ready')
        return { diskDB: { [K]: { id: K, dockedTo: replicas[id] } } }
    }
    o.sendEject = async () => ({ sent: true })
    o.stage2Status = async () => ({ fixtures: [{ partLabel: 'IDEA-KOLIBRI', present: true, mounted: opts.mounted, diskId: K }] })
    o.refreshView = async (e: string, why: string) => {
        refreshed.push(`${e}: ${why}`)
        if (opts.healOnRefresh) replicas[e] = null
        return true
    }
    return { o, refreshed, replicas }
}

describe('step 92: engineEject with one frozen walker replica', () => {
    afterEach(() => vi.restoreAllMocks())

    it('Pi unmounted, idea03\'s replica still says docked → ONLY that replica is re-synced and the eject completes', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const { o, refreshed } = mk({ replicas: { idea01: null, idea03: 'idea01', idea04: null }, mounted: null, healOnRefresh: true })
        await o.engineEject('idea01', K)
        expect(refreshed).toHaveLength(1)
        expect(refreshed[0]).toMatch(/^idea03: engineEject duration-kolibri-grade5a-001: IDEA-KOLIBRI unmounted on idea01 but idea03's view still says dockedTo=idea01/)
        expect(log.mock.calls.flat().join('\n')).toMatch(/view of \[idea03\] still says docked → re-syncing it \(refresh 1\/2\)/)
    })

    it('a replica that stays stale fails LOUD, naming the replica, the per-replica view and the re-syncs (no soft pass)', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const { o, refreshed } = mk({ replicas: { idea01: null, idea03: 'idea01', idea04: null }, mounted: null })
        await expect(o.engineEject('idea01', K)).rejects.toThrow(
            /not done within 300ms \(dockedTo=idea01 IDEA-KOLIBRI mounted=no replicas: idea01=none idea03=idea01 idea04=none; the Pi has it unmounted — the walker's view of \[idea03\] stayed stale through 2 re-sync\(s\)\)/)
        expect(refreshed).toHaveLength(2)
    })

    it('every replica agrees from the start: no re-sync, returns at once', async () => {
        const { o, refreshed } = mk({ replicas: { idea01: null, idea03: null, idea04: null }, mounted: null })
        await o.engineEject('idea01', K)
        expect(refreshed).toEqual([])
    })

    it('the Pi still has the partition mounted (the Engine has not ejected): no re-sync, the plain wait and message', async () => {
        const { o, refreshed } = mk({ replicas: { idea01: 'idea01', idea03: 'idea01', idea04: 'idea01' }, mounted: '/disks/sdb1' })
        await expect(o.engineEject('idea01', K)).rejects.toThrow(/not done within 300ms \(dockedTo=idea01 IDEA-KOLIBRI mounted=\/disks\/sdb1\)$/)
        expect(refreshed).toEqual([])
    })

    it('an unreadable replica is not mistaken for a stale one (no re-sync of it)', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const { o, refreshed } = mk({ replicas: { idea01: null, idea03: 'throw', idea04: 'idea01' }, mounted: null, healOnRefresh: true })
        await o.engineEject('idea01', K)
        expect(refreshed.map(r => r.split(':')[0])).toEqual(['idea04'])
    })
})

describe('step 92: dockedToByReplica / findDockedEngine', () => {
    const ops = (replicas: Record<string, string | null | 'throw'>) => {
        const o = new RealFleetOps({ poolEngines: POOL, hosts: { idea01: 'a', idea03: 'b', idea04: 'c' } }) as any
        o.readStore = async (id: string) => {
            if (replicas[id] === 'throw') throw new Error('x')
            return { diskDB: { [K]: { dockedTo: replicas[id] } } }
        }
        o.liveIds.set('idea01', 'ENGINE_AA000000000000055000')
        return o
    }
    it('names what every replica says (live ids resolved, unreadable marked)', async () => {
        const o = ops({ idea01: null, idea03: 'ENGINE_AA000000000000055000', idea04: 'throw' })
        expect(await o.dockedToByReplica(K)).toEqual({ idea01: null, idea03: 'idea01', idea04: 'unreadable' })
    })
    it('findDockedEngine is unchanged: the first replica that says docked wins, null when none does', async () => {
        expect(await ops({ idea01: null, idea03: 'idea01', idea04: null }).findDockedEngine(K)).toBe('idea01')
        expect(await ops({ idea01: 'throw', idea03: null, idea04: 'idea04' }).findDockedEngine(K)).toBe('idea04')
        expect(await ops({ idea01: null, idea03: null, idea04: null }).findDockedEngine(K)).toBeNull()
    })
})
