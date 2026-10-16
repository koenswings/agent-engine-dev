/**
 * hw-inflight-pull.test.ts (#179/#180): verdict of the hw-roundtrip pull-out-during-start case.
 */
import { describe, it, expect } from 'vitest'
import { inflightPullChecks, inflightReplugChecks, inflightWaitLines, PullObservation, UNDOCK_AT_ONCE_MS } from '../../script/hw-inflight-pull.js'

const D = 'disk-abc'
const base = (o: Partial<PullObservation> = {}): PullObservation => ({
    diskId: D, instanceId: 'kiwix-1', statusAtUnplug: 'Starting', startTraceRunningAtUnplug: true,
    unpluggedAt: 1000, undockedAt: 2500, logSinceUnplug: `Processing the removal of USB device sdb2\nInstance kiwix-1 has been moved to the 'Undocked' state`,
    statusesAfterUndock: ['Undocked', 'Undocked'], ...o,
})
const failed = (o: PullObservation) => inflightPullChecks(o).filter(c => !c.ok).map(c => c.what)

describe('hw-roundtrip in-flight pull-out verdict', () => {
    it('fast undock, no wait lines, Undocked → all pass', () => {
        expect(failed(base())).toEqual([])
    })
    it('undock that took the 120 s eject bound fails "at once"', () => {
        const f = failed(base({ undockedAt: 1000 + 120_000 }))
        expect(f.some(w => w.includes('undocked at once'))).toBe(true)
    })
    it('just within the bound passes; never undocked fails', () => {
        expect(failed(base({ undockedAt: 1000 + UNDOCK_AT_ONCE_MS }))).toEqual([])
        expect(inflightPullChecks(base({ undockedAt: null })).find(c => c.what.includes('at once'))?.detail).toMatch(/never undocked/)
    })
    it('eject-wait log lines for the disk fail; for another disk do not', () => {
        const wait = `Waiting up to 119000ms for startInstance kiwix-1 on disk ${D} to settle before undock`
        expect(failed(base({ logSinceUnplug: wait })).some(w => w.includes('in-flight wait'))).toBe(true)
        expect(failed(base({ logSinceUnplug: wait.replace(D, 'other') }))).toEqual([])
        expect(inflightWaitLines(`Undock ${D}: still in flight after 120000ms (x) — stopping anyway`, D)).toHaveLength(1)
        expect(inflightWaitLines(`Undock ${D}: in-flight start(s) settled after 3ms`, D)).toHaveLength(1)
    })
    it('a start that was not in flight at the unplug is not a valid case', () => {
        expect(failed(base({ statusAtUnplug: 'Running', startTraceRunningAtUnplug: false })).some(w => w.includes('was in flight'))).toBe(true)
        expect(failed(base({ statusAtUnplug: 'Stopped', startTraceRunningAtUnplug: true }))).toEqual([])
    })
    it('late start turning the row Error or Running fails; must end Undocked', () => {
        expect(failed(base({ statusesAfterUndock: ['Undocked', 'Error'] })).length).toBe(2)
        expect(failed(base({ statusesAfterUndock: ['Undocked', 'Running', 'Undocked'] }))).toEqual([expect.stringContaining('never Running/Error')])
        expect(failed(base({ statusesAfterUndock: [] })).some(w => w.includes("ends 'Undocked'"))).toBe(true)
    })
    it('after re-plug: Error or stuck Starting fails', () => {
        expect(inflightReplugChecks('i', 'Running')[0].ok).toBe(true)
        expect(inflightReplugChecks('i', 'Stopped')[0].ok).toBe(true)
        expect(inflightReplugChecks('i', 'Error')[0].ok).toBe(false)
        expect(inflightReplugChecks('i', 'Starting')[0].ok).toBe(false)
        expect(inflightReplugChecks('i', null)[0].ok).toBe(false)
    })
})
