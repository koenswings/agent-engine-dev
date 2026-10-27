/**
 * idea#307: a partition whose read-only look failed (mkfs still running) is looked at again once
 * lsblk shows a changed filesystem (fs type or UUID); an unchanged one is never retried, and the
 * existing lsblk poll (startUnformattedDiskPoll) drives the retry.
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import {
    recordFailedLook, clearFailedLook, failedLookDevices, clearFailedLooksForTests, retryChangedFailedLooks, PartitionSignature,
} from '../../src/monitors/failedLookRetry.js'
import { setAfterUnformattedPoll, startUnformattedDiskPoll, setUnformattedOpsForTests } from '../../src/data/UnformattedDisks.js'

const sigs = (o: Record<string, PartitionSignature>) => async () => new Map(Object.entries(o))

describe('failed-look retry after a filesystem change (idea#307)', () => {
    beforeEach(() => clearFailedLooksForTests())
    afterEach(() => { clearFailedLooksForTests(); setAfterUnformattedPoll(null); setUnformattedOpsForTests(null); vi.useRealTimers() })

    it('mkfs finished after the failed look (no fs → ext4 with UUID): retried once, then forgotten', async () => {
        recordFailedLook('sdb1', { fsType: null, uuid: null })
        const retried: string[] = []
        const read = sigs({ sdb1: { fsType: 'ext4', uuid: 'u-1' } })
        expect(await retryChangedFailedLooks(async d => { retried.push(d) }, read)).toEqual(['sdb1'])
        expect(retried).toEqual(['sdb1'])
        expect(failedLookDevices()).toEqual([])
        expect(await retryChangedFailedLooks(async d => { retried.push(d) }, read)).toEqual([])   // not again
    })

    it('a UUID change alone (re-formatted ext4 → ext4) is a change', async () => {
        recordFailedLook('sdc2', { fsType: 'ext4', uuid: 'old' })
        expect(await retryChangedFailedLooks(async () => {}, sigs({ sdc2: { fsType: 'ext4', uuid: 'new' } }))).toEqual(['sdc2'])
    })

    it('unchanged signature (look failed for another reason, e.g. mounted elsewhere): never retried, kept', async () => {
        recordFailedLook('sdb1', { fsType: 'ext4', uuid: 'u-1' })
        const retry = vi.fn(async () => {})
        expect(await retryChangedFailedLooks(retry, sigs({ sdb1: { fsType: 'ext4', uuid: 'u-1' } }))).toEqual([])
        expect(retry).not.toHaveBeenCalled()
        expect(failedLookDevices()).toEqual(['sdb1'])
    })

    it('a partition lsblk no longer lists is dropped without a retry', async () => {
        recordFailedLook('sdd1', null)
        const retry = vi.fn(async () => {})
        expect(await retryChangedFailedLooks(retry, sigs({}))).toEqual([])
        expect(retry).not.toHaveBeenCalled()
        expect(failedLookDevices()).toEqual([])
    })

    it('unknown signature at failure (lsblk failed) counts as changed once lsblk shows one', async () => {
        recordFailedLook('sde1', null)
        expect(await retryChangedFailedLooks(async () => {}, sigs({ sde1: { fsType: 'ext4', uuid: 'x' } }))).toEqual(['sde1'])
    })

    it('clearFailedLook (unplug / later successful look) stops any retry; no lsblk read when nothing failed', async () => {
        recordFailedLook('sdb1', null)
        clearFailedLook('sdb1')
        const read = vi.fn(sigs({ sdb1: { fsType: 'ext4', uuid: 'u' } }))
        expect(await retryChangedFailedLooks(async () => {}, read)).toEqual([])
        expect(read).not.toHaveBeenCalled()
    })

    it('the existing lsblk poll runs the after-poll hook on each tick', async () => {
        vi.useFakeTimers()
        setUnformattedOpsForTests({ lsblkJson: async () => [], hardwareId: async () => undefined } as any)
        const hook = vi.fn(async () => {})
        setAfterUnformattedPoll(hook)
        const store: any = { doc: () => ({ engineDB: {} }), change: () => {} }
        const stop = startUnformattedDiskPoll(store, 1000)
        await vi.advanceTimersByTimeAsync(1000)
        await vi.advanceTimersByTimeAsync(1000)
        stop()
        expect(hook.mock.calls.length).toBeGreaterThanOrEqual(1)
    })
})
