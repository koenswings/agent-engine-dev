/**
 * r82b FAIL@91 (cover-all-stage2-5668cff-r82b, Engine bbb5c0c): install_app@88 registered
 * kolibri-244pq4861ldxkj7vusp on duration-empty-001 (idea03) and it went Running. Then
 * redockEmpty001BeforeMakeFiles purged the record WHILE the disk was still docked with the files on
 * it → the Engine's disk scan re-created the row ("Instance Ids found on disk … Creating new instance
 * object") and restarted it → the eject raced that start ("moved to the 'Undocked' state", then
 * "Error starting app instance … spawn /usr/bin/bash ENOENT") → the second purge found 0 rows and the
 * late Error write left kolibri-244pq…=Error after the fresh re-dock.
 * Fix: eject through the Engine first, wait for the rows to settle, then purge, then dock (an Atlas reset).
 */
import { describe, expect, it } from 'vitest'
import { FakeFleetOps, redockEmpty001BeforeMakeFiles, settleRowsAfterUndock } from '../duration/actions.js'
import type { DiskInstanceRow } from '../duration/types.js'

const E1 = 'duration-empty-001'
const POOL = ['idea01', 'idea03', 'idea04']
const KID = { 'duration-kolibri-grade5a-001': 'kolibri-grade5a-001' } as Record<string, string>

const ctxFor = (ops: unknown) => ({
    opts: { ops, rng: () => 0, settleTimeoutMs: 500, fast: true },
    walker: { current: 'op_disk', layer: 'operator' as const, dockedEngine: 'idea01', step: 91, pendingInstallDisk: null },
    from: 'op_disk', to: 'op_files', action: 'make_files_disk',
    excludeEngines: ['idea02'], poolEngines: POOL,
    fixtureDisk: 'duration-kolibri-grade5a-001', fixtureInstance: 'kolibri-grade5a-001',
    fixtureDisks: ['duration-kolibri-grade5a-001', E1],
})

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const prev: Record<string, string | undefined> = {}
    for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k] }
    try { await fn() } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] } }
}

describe('r82b: purge only after the Engine eject, never while the disk is docked', () => {
    it('order is settle → undock → rows settled → purge → dock (no purge before the undock)', async () => {
        await withEnv({ DURATION_SWITCH_ENGINE_HOST: 'idea01', DURATION_CONSOLE_URL: 'http://idea01:8080', DURATION_EMPTY_DISK_ID: undefined, DURATION_DISK_OP_SETTLE_MS: '2000' }, async () => {
            const ops = new FakeFleetOps({ fixtureInstances: { ...KID }, poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared' })
            await ops.dockFixture('idea01', E1)
            const order: string[] = []
            let undocked = false
            const rowsWhileDocked: DiskInstanceRow[] = [{ id: 'kolibri-244pq', status: 'Running', currentStep: null }]
            const afterUndock: DiskInstanceRow[][] = [
                [{ id: 'kolibri-244pq', status: 'Stopping', currentStep: null }],
                [{ id: 'kolibri-244pq', status: 'Undocked', currentStep: null }],
            ]
            let ai = 0
            let purged = false
            const origUndock = ops.undockFixtures.bind(ops)
            const origPurge = ops.purgeInstancesStoredOn.bind(ops)
            const origDock = ops.dockFixture.bind(ops)
            Object.assign(ops, {
                diskInstancesRaw: async () => {
                    if (purged) return []
                    if (!undocked) { order.push('read:docked'); return rowsWhileDocked }
                    order.push('read:undocked'); return afterUndock[Math.min(ai++, afterUndock.length - 1)]!
                },
                undockFixtures: async (e: string[], d: string) => { order.push('undock'); undocked = true; return origUndock(e, d) },
                purgeInstancesStoredOn: async (e: string, d: string) => {
                    order.push(undocked ? 'purge:undocked' : 'purge:DOCKED'); purged = true; return origPurge(e, d)
                },
                dockFixture: async (e: string, d: string) => { order.push('dock'); return origDock(e, d) },
            })
            const note = await redockEmpty001BeforeMakeFiles(ctxFor(ops) as never)
            expect(order).not.toContain('purge:DOCKED')
            const u = order.indexOf('undock'), p = order.indexOf('purge:undocked'), d = order.lastIndexOf('dock')
            expect(u).toBeGreaterThan(-1)
            expect(p).toBeGreaterThan(u)
            expect(d).toBeGreaterThan(p)
            // purge waited until the Stopping row settled to Undocked
            expect(order.slice(u, p).filter(x => x === 'read:undocked').length).toBeGreaterThanOrEqual(2)
            expect(note).toMatch(/after eject duration-empty-001 rows settled .*kolibri-244pq=Undocked/)
        })
    })

    it('an Error row after the eject is real Engine state: fail loud, never purged away', async () => {
        const ops = { diskInstancesRaw: async () => [{ id: 'kolibri-244pq', status: 'Error', currentStep: null }] }
        await expect(settleRowsAfterUndock({ opts: { ops } } as never, 'idea03', E1, 'L', { budgetMs: 20, pollMs: 1 }))
            .rejects.toThrow(/Engine left kolibri-244pq in Error on duration-empty-001 \(idea03\) after the eject.*not purged/)
    })

    it('a row still mid-operation after the eject fails loud at the budget', async () => {
        const ops = { diskInstancesRaw: async () => [{ id: 'k', status: 'Starting', currentStep: 6 }] }
        await expect(settleRowsAfterUndock({ opts: { ops } } as never, 'idea03', E1, 'L', { budgetMs: 20, pollMs: 1 }))
            .rejects.toThrow(/mid-operation .* after the eject .*refusing to purge/)
    })

    it('no rows / Fake without diskInstancesRaw: no wait, empty note', async () => {
        expect(await settleRowsAfterUndock({ opts: { ops: { diskInstancesRaw: async () => [] } } } as never, 'idea03', E1, 'L')).toBe('')
        expect(await settleRowsAfterUndock({ opts: { ops: {} } } as never, 'idea03', E1, 'L')).toBe('')
    })
})
