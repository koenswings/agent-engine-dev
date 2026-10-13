/**
 * r63 FAIL@43 copy_app: the Intent's 120 s post-Confirm settle tried to Start the source while copyApp
 * (498 MB image rsync) still held the lock. r64: the harness hands the Intent a store Operation wait
 * (copyApp/moveApp/restoreApp); the Intent starts only after the Operation ended Done.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { WAIT_OP_ACTIONS, opDoneBudgetMs, waitOperationTerminal, type OpRow, type WaitOpKind } from '../duration/opWait.js'
import { waitOperationFor } from '../duration/actions.js'

const T0 = 1_791_666_000_000
const KI = 'kolibri-grade5a-001'
/** One copyApp op on idea01 (and mirrored in idea03's store copy), Running until doneAt, then `end`. */
const fleet = (kind: WaitOpKind, doneAt: number, end: 'Done' | 'Failed' = 'Done', instanceId = KI) => {
    let t = T0
    const row = (): OpRow => ({
        id: 'op1', kind, status: t >= doneAt ? end : 'Running', startedAt: T0 + 1_000,
        completedAt: t >= doneAt ? doneAt : null, error: t >= doneAt && end === 'Failed' ? 'rsync exited with code 23' : null,
        args: { instanceId },
    })
    const polls: number[] = []
    return {
        polls,
        get t() { return t },
        io: {
            engines: ['idea01', 'idea03', 'idea04'],
            listOperations: async (e: string) => { polls.push(t - T0); return e === 'idea04' ? [] : [row(), { ...row(), id: 'old', startedAt: T0 - 600_000, status: 'Done' }] },
            sleep: async (ms: number) => { t += ms },
            now: () => t,
            log: vi.fn(),
        },
    }
}
afterEach(() => vi.restoreAllMocks())

describe('waitOperationTerminal', () => {
    it('r63 replay: copyApp holds the lock 330 s — at the old 120 s settle it is still Running; the wait returns Done only after', async () => {
        const f = fleet('copyApp', T0 + 330_000)
        const r = await waitOperationTerminal({ kind: 'copyApp', instanceId: KI, sinceMs: T0 }, f.io, 900_000, 30_000)
        expect(r.status).toBe('Done')
        expect(r.elapsedMs).toBeGreaterThanOrEqual(330_000)
        // what the old Intent saw at its 120 s budget: the op still Running (Start disabled "Operation in progress")
        const g = fleet('copyApp', T0 + 330_000)
        await g.io.sleep(120_000)
        expect((await g.io.listOperations('idea01'))[0]!.status).toBe('Running')
        expect(f.io.log).toHaveBeenCalledWith(expect.stringContaining('"status":"Running"'))
        expect(f.io.log).toHaveBeenCalledWith(expect.stringContaining('"status":"Done"'))
    })
    it('copy Failed → Error at once with the Engine error and a dump', async () => {
        const f = fleet('copyApp', T0 + 3_000, 'Failed')
        const r = await waitOperationTerminal({ kind: 'copyApp', instanceId: KI, sinceMs: T0 }, f.io, 900_000, 30_000)
        expect(r.status).toBe('Error')
        expect(r.detail).toMatch(/copyApp Failed: rsync exited with code 23 \| ops=\[idea0[13]:copyApp#op1 status=Failed instance=kolibri-grade5a-001/)
        expect(r.elapsedMs).toBeLessThan(10_000)
    })
    it('budget exhausted → Timeout with the op state dumped', async () => {
        const f = fleet('copyApp', T0 + 10_000_000)
        const r = await waitOperationTerminal({ kind: 'copyApp', instanceId: KI, sinceMs: T0 }, f.io, 60_000, 30_000)
        expect(r.status).toBe('Timeout')
        expect(r.detail).toMatch(/copyApp not terminal within 60000ms \| ops=\[.*copyApp#op1 status=Running instance=kolibri-grade5a-001 started=\d+ \(\d+ms ago\) completed=-/)
    })
    it('no Operation for that instance since Confirm → NotSeen after the appear budget (old ops and other instances ignored)', async () => {
        const f = fleet('copyApp', T0 + 5_000, 'Done', 'someone-else')
        const r = await waitOperationTerminal({ kind: 'copyApp', instanceId: KI, sinceMs: T0 }, f.io, 900_000, 30_000)
        expect(r.status).toBe('NotSeen')
        expect(r.elapsedMs).toBeGreaterThanOrEqual(30_000)
    })
    it('store read errors on a peer are reported in the dump, other peers still decide', async () => {
        const f = fleet('copyApp', T0 + 4_000)
        const io = { ...f.io, listOperations: async (e: string) => { if (e === 'idea03') throw new Error('ws down'); return f.io.listOperations(e) } }
        expect((await waitOperationTerminal({ kind: 'copyApp', instanceId: KI, sinceMs: T0 }, io, 900_000, 30_000)).status).toBe('Done')
        const slow = fleet('copyApp', T0 + 10_000_000)
        const io2 = { ...slow.io, listOperations: async (e: string) => { if (e === 'idea03') throw new Error('ws down'); return slow.io.listOperations(e) } }
        expect((await waitOperationTerminal({ kind: 'copyApp', instanceId: KI, sinceMs: T0 }, io2, 10_000, 30_000)).detail).toMatch(/readErrors=\[idea03: ws down\]/)
    })
})

describe('audited long operations', () => {
    it('copy_app/move_app/restore_from_backup get a hook; backup_instance/install_app do not (no post-op Start in the Intent / no Operation kind)', () => {
        expect(WAIT_OP_ACTIONS).toEqual({ copy_app: 'copyApp', move_app: 'moveApp', restore_from_backup: 'restoreApp' })
    })
    it.each([
        ['move_app', 'moveApp' as const, 400_000],
        ['restore_from_backup', 'restoreApp' as const, 250_000],
    ])('%s: a slow %s (> old 120 s settle) waits to Done', async (_a, kind, dur) => {
        const f = fleet(kind, T0 + dur)
        const r = await waitOperationTerminal({ kind, instanceId: KI, sinceMs: T0 }, f.io, opDoneBudgetMs(kind, false, {}), 30_000)
        expect(r).toMatchObject({ status: 'Done' })
        expect(r.elapsedMs).toBeGreaterThanOrEqual(dur)
    })
    it('budgets: copy/move DURATION_COPY_DONE_MS (fast 300 s / 900 s); restore DURATION_RESTORE_DONE_MS defaults to the copy budget', () => {
        expect(opDoneBudgetMs('copyApp', true, {})).toBe(300_000)
        expect(opDoneBudgetMs('moveApp', false, {})).toBe(900_000)
        expect(opDoneBudgetMs('copyApp', true, { DURATION_COPY_DONE_MS: '900000' })).toBe(900_000)
        expect(opDoneBudgetMs('restoreApp', true, { DURATION_COPY_DONE_MS: '900000' })).toBe(900_000)
        expect(opDoneBudgetMs('restoreApp', true, { DURATION_RESTORE_DONE_MS: '600000' })).toBe(600_000)
    })
    it('waitOperationFor: only for hooked actions with a live operation reader; never idea02', async () => {
        const seen: string[] = []
        const ctx = (action: string, live = true) => ({
            action, poolEngines: ['idea01', 'idea02', 'idea03'], excludeEngines: [], opts: {
                fast: true,
                ops: live ? { listOperations: async (e: string) => { seen.push(e); return [{ id: 'x', kind: 'copyApp', status: 'Done', startedAt: Date.now(), args: { instanceId: KI } }] } } : {},
            },
        }) as never
        expect(waitOperationFor(ctx('backup_instance'))).toBeUndefined()
        expect(waitOperationFor(ctx('copy_app', false))).toBeUndefined()
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const r = await waitOperationFor(ctx('copy_app'))!({ kind: 'copyApp', instanceId: KI, sinceMs: Date.now() - 1_000 })
        expect(r.status).toBe('Done')
        expect(seen).not.toContain('idea02')
    })
})
