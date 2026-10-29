/**
 * same-dock-after-wait.test.ts (#170, #196): the shared re-check-after-wait helper.
 */
import { describe, it, expect } from 'vitest'
import { assertSameDockAfterWait, DockChangedError, dockIdentityOf } from '../../src/data/InstanceInFlight.js'

const disk = (o: any = {}) => ({ device: 'sdb2', dockedTo: 'E1', lastDocked: 10, ...o })
const store = (d: any) => ({ diskDB: d === undefined ? {} : { D: d } })

describe('assertSameDockAfterWait', () => {
    const before = dockIdentityOf(disk())
    it('same dock → no throw', () => {
        expect(() => assertSameDockAfterWait(store(disk()), 'D', before, 'x')).not.toThrow()
    })
    it.each([
        ['record gone', undefined, /no longer docked \(was sdb2\)/],
        ['undocked', disk({ dockedTo: null, device: null }), /no longer docked/],
        ['other Engine', disk({ dockedTo: 'E2' }), /now docked to E2/],
        ['other device', disk({ device: 'sdc2' }), /re-docked on sdc2/],
        ['docked again', disk({ lastDocked: 11 }), /dock generation 10 → 11/],
    ])('%s → DockChangedError', (_n, now, re) => {
        let err: any
        try { assertSameDockAfterWait(store(now), 'D', before, 'installApp k') } catch (e) { err = e }
        expect(err).toBeInstanceOf(DockChangedError)
        expect(err.message).toMatch(re)
        expect(err.message).toMatch(/^installApp k: stopped, .*; nothing registered$/)
    })
})
