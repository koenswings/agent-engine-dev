/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Markov 5 (random-c1cc4bb-markov-20261119, step 93 infra_dock_fixture): "Stage 2: Engine eject of
 * duration-empty-001 on idea03 not done within 120000ms (dockedTo=idea03 IDEA-EMPTY001 mounted=/disks/sdb2)".
 * idea03's store history shows exactly four walker writes (the step 92 ejects, last 00:58:36 CET) and none
 * in step 93, and idea03's Engine log has no ejectDisk after 00:58:34: the command was never written. The
 * walker's own view of idea03's store still showed empty-001 undocked (it had just been re-docked at
 * 00:59:05), so undockFixtures skipped silently and engineEject waited for an eject nobody asked for.
 * Now the Pi's mount state wins: view says undocked + partition mounted → the eject is forced and sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { Stage2FleetOps } from '../duration/stage2FleetOps.js'

const EMPTY = 'duration-empty-001'
const LIVE = 'ENGINE_gge6zxyl6ftmnri4qx6'
const mkConn = (dockedTo: string | null) => {
    const writes: string[] = []
    const doc = { diskDB: { [EMPTY]: { id: EMPTY, name: 'Duration Tests — Empty Disk 001', dockedTo, device: 'sdb2' } }, engineDB: { [LIVE]: { commands: [] as string[] } } }
    return { writes, conn: { storeHandle: { doc: () => doc, change: (fn: (s: any) => void) => { const s = { engineDB: { [LIVE]: { commands: [] as string[] } } }; fn(s); writes.push(...s.engineDB[LIVE].commands) } } } }
}
const mkOps = (conn: unknown) => {
    const ops = new RealFleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: 'a', idea03: 'b', idea04: 'c' } }) as any
    ops.connect = async () => conn
    ops.liveIds.set('idea03', LIVE)
    return ops
}

describe('RealFleetOps.sendEject reports whether it wrote the command', () => {
    it('view says undocked: nothing written, reason reported (never a silent skip)', async () => {
        const { conn, writes } = mkConn(null)
        const r = await mkOps(conn).sendEject('idea03', EMPTY, false)
        expect(r).toEqual({ sent: false, why: 'view-undocked' })
        expect(writes).toEqual([])
    })
    it('force: the command is written although the view says undocked', async () => {
        const { conn, writes } = mkConn(null)
        const r = await mkOps(conn).sendEject('idea03', EMPTY, true)
        expect(r).toEqual({ sent: true })
        expect(writes).toEqual([`ejectDisk ${EMPTY}`])
    })
    it('docked in the view: written, as before', async () => {
        const { conn, writes } = mkConn(LIVE)
        expect(await mkOps(conn).sendEject('idea03', EMPTY, false)).toEqual({ sent: true })
        expect(writes).toEqual([`ejectDisk ${EMPTY}`])
    })
    it('undockFixtures keeps its old contract (a stale-undocked view is a quiet skip)', async () => {
        const { conn, writes } = mkConn(null)
        await mkOps(conn).undockFixtures(['idea03'], EMPTY)
        expect(writes).toEqual([])
    })
})

describe('Stage2FleetOps.engineEject with a stale walker view (Markov 5 step 93)', () => {
    afterEach(() => vi.restoreAllMocks())
    const mk = (mounted: string | null) => {
        const o = new Stage2FleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: 'a', idea03: 'b', idea04: 'c' }, storeMode: 'shared', sleep: async () => {}, dockWaitMs: 50 }) as any
        const sent: string[] = []
        let up = mounted
        o.sendEject = async (e: string, d: string, force: boolean) => {
            if (!force) return { sent: false, why: 'view-undocked' }
            sent.push(`${e} ${d} forced`); up = null; return { sent: true }
        }
        o.stage2Status = async () => ({ fixtures: [{ partLabel: 'IDEA-EMPTY001', present: true, mounted: up, diskId: EMPTY }] })
        o.partitionWith = (st: any) => st.fixtures[0]
        o.findDockedEngine = async () => (up ? 'idea03' : null)
        return { o, sent }
    }
    it('view says undocked but the Pi has the partition mounted: the eject is forced and the wait ends', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const { o, sent } = mk('/disks/sdb2')
        await o.engineEject('idea03', EMPTY)
        expect(sent).toEqual([`idea03 ${EMPTY} forced`])
    })
    it('view says undocked and the Pi agrees (nothing mounted): no forced command', async () => {
        const { o, sent } = mk(null)
        await o.engineEject('idea03', EMPTY)
        expect(sent).toEqual([])
    })
    it('even forced the command cannot be sent: fail loud at once, not after the full wait', async () => {
        const { o } = mk('/disks/sdb2')
        o.sendEject = async () => ({ sent: false, why: 'no-live-id' })
        await expect(o.engineEject('idea03', EMPTY)).rejects.toThrow(/could not be sent \(no-live-id\).*mounted at \/disks\/sdb2.*Fail loud/)
    })
})
