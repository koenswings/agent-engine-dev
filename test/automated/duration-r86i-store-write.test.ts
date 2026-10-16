/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * r86h FAIL@104 (cover-all-stage2-cc06bb5-r86h): the walker's idea03 handle (duration-idea03-1791818178498)
 * was wedged: "Websocket not ready (2)" during step 102, then 42× "outdated document". The ejectDisk write
 * threw "Attempting to change an outdated document", and undockFixtures only warned. idea03's Engine
 * never got the command (no ejectDisk in engine-out.log after step 91/102), and the step timed out after 120 s.
 */
import { describe, expect, it } from 'vitest'
import { RealFleetOps, StoreWriteError } from '../duration/realFleetOps.js'

const outdated = () => { throw new RangeError('Attempting to change an outdated document.  Use Automerge.clone() if you wish to make a writable copy.') }
const mk = () => new RealFleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: { idea01: 'a', idea03: 'b', idea04: 'c' } }) as any

describe('r86i: store writes never fail silently', () => {
    it('wedged handle: reconnect once, the write lands on the fresh handle', async () => {
        const ops = mk()
        const writes: string[] = []
        const wedged = { storeHandle: { change: outdated } }
        const fresh = { storeHandle: { change: (fn: (s: any) => void) => { const s = { engineDB: { E: { commands: [] as string[] } } }; fn(s); writes.push(...s.engineDB.E.commands) } } }
        ops.conns.set('idea03', wedged)
        ops.refreshView = async (e: string) => { ops.conns.set(e, fresh); return true }
        const used = await ops.changeStore('idea03', wedged, 'ejectDisk duration-empty-001', (s: any) => { s.engineDB.E.commands.push('ejectDisk duration-empty-001') })
        expect(used).toBe(fresh)
        expect(writes).toEqual(['ejectDisk duration-empty-001'])
    })
    it('still failing after the reconnect: StoreWriteError, command NOT sent, fail loud', async () => {
        const ops = mk()
        const wedged = { storeHandle: { change: outdated } }
        ops.conns.set('idea03', wedged)
        ops.refreshView = async (e: string) => { ops.conns.set(e, { storeHandle: { change: outdated } }); return true }
        await expect(ops.changeStore('idea03', wedged, 'ejectDisk duration-empty-001', () => {}))
            .rejects.toThrow(/ejectDisk duration-empty-001 on idea03: store write failed twice .*outdated document.*command NOT sent\. Fail loud/)
    })
    it('reconnect gave no fresh connection: fail loud', async () => {
        const ops = mk()
        const wedged = { storeHandle: { change: outdated } }
        ops.conns.set('idea03', wedged)
        ops.refreshView = async () => null
        await expect(ops.changeStore('idea03', wedged, 'x', () => {})).rejects.toBeInstanceOf(StoreWriteError)
    })
    it('undockFixtures rethrows a StoreWriteError instead of warning (the r86h swallow)', async () => {
        const ops = mk()
        const doc = { diskDB: { 'duration-empty-001': { id: 'duration-empty-001', dockedTo: 'ENGINE_gge6zxyl6ftmnri4qx6', name: 'Duration Tests — Empty Disk 001', device: 'sdb2' } }, engineDB: { ENGINE_gge6zxyl6ftmnri4qx6: { commands: [] } } }
        const wedged = { storeHandle: { change: outdated, doc: () => doc } }
        ops.connect = async () => wedged
        ops.conns.set('idea03', wedged)
        ops.liveIds.set('idea03', 'ENGINE_gge6zxyl6ftmnri4qx6')
        ops.refreshView = async () => null
        await expect(ops.undockFixtures(['idea03'], 'duration-empty-001')).rejects.toThrow(/ejectDisk duration-empty-001 on idea03.*Fail loud/)
    })
})
