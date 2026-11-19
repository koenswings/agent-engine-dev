/**
 * Markov seed 42 FAIL@274 (idea#533): install_app aborted after redockEmpty002BeforeSecondInstall waited
 * DURATION_DISK_OP_SETTLE_MS for an install nobody was running. walker.pendingInstallDisk (set by step 72,
 * disk empty-001) survived the step-92/93 undock + fresh fixture dock that wiped the instance, so the
 * reset saw "install pending, 0 rows" and waited out the budget. Engine side was clean (cmds=0).
 */
import { describe, expect, it } from 'vitest'
import { FakeFleetOps, dispatchAction, noteDiskResetToEmpty, settleDiskOpsBeforeReset } from '../duration/actions.js'
import { StubUiDriver } from '../duration/ui/index.js'
import type { DiskInstanceRow } from '../duration/types.js'

const E1 = 'duration-empty-001'
const E2 = 'duration-empty-002'
const KID_FIXTURES = {
    'duration-kolibri-grade5a-001': 'kolibri-grade5a-001',
    'duration-nextcloud-grade5a-001': 'nextcloud-grade5a-001',
} as const

const fakeOps = () => new FakeFleetOps({ fixtureInstances: { ...KID_FIXTURES }, poolEngines: ['idea01', 'idea03'], excludeEngines: ['idea02'], storeMode: 'shared' })

const emptyRows = () => ({ diskInstancesRaw: async (): Promise<DiskInstanceRow[]> => [] })

const stepCtx = (ops: FakeFleetOps, action: string, walker: Record<string, unknown>) => ({
    opts: { ops, rng: () => 0, settleTimeoutMs: 500, fast: true, stubUi: true, uiDriver: new StubUiDriver() },
    walker: { current: 'op_disk', layer: 'operator', dockedEngine: 'idea01', step: 274, ...walker } as {
        current: string; layer: string; dockedEngine: string; step: number; empty002HoldsApp?: boolean; pendingInstallDisk?: string | null
    },
    from: 'op_disk',
    to: 'op_install',
    action,
    excludeEngines: ['idea02'],
    poolEngines: ['idea01', 'idea03'],
    fixtureDisk: 'duration-kolibri-grade5a-001',
    fixtureInstance: 'kolibri-grade5a-001',
    fixtureDisks: ['duration-kolibri-grade5a-001', 'duration-nextcloud-grade5a-001', E1, E2],
    fixtureInstances: { ...KID_FIXTURES },
})

describe('idea#533: stale pendingInstallDisk after the instance was wiped', () => {
    it('step-274 replay: pending install + 0 rows waits the whole budget (the bug)', async () => {
        const ctx = { opts: { ops: emptyRows() }, walker: { pendingInstallDisk: E1 } } as never
        await expect(settleDiskOpsBeforeReset(ctx, 'idea03', E1, 'redockEmpty002BeforeSecondInstall', { budgetMs: 20, pollMs: 1 })).rejects.toThrow(
            /install_app pending; no instances\) — refusing to reset a disk under a live op/,
        )
    })

    it('after the dock reset clears the mark, the same read settles at once', async () => {
        const walker = { pendingInstallDisk: E1 as string | null, empty002HoldsApp: true }
        noteDiskResetToEmpty({ walker } as never, E1)
        expect(walker.pendingInstallDisk).toBeNull()
        const ctx = { opts: { ops: emptyRows() }, walker } as never
        expect(await settleDiskOpsBeforeReset(ctx, 'idea03', E1, 'L', { budgetMs: 20, pollMs: 1 })).toBe('')
    })

    it('a reset of another disk leaves the pending mark alone (r75 protection)', () => {
        const walker = { pendingInstallDisk: E1 as string | null, empty002HoldsApp: true }
        noteDiskResetToEmpty({ walker } as never, 'duration-empty-003')
        expect(walker.pendingInstallDisk).toBe(E1)
        expect(walker.empty002HoldsApp).toBe(true)
    })

    it('Stage 2: the erase target (empty-001) reset clears the late-install hold', () => {
        const prev = process.env.DURATION_STAGE
        process.env.DURATION_STAGE = '2'
        try {
            const walker = { pendingInstallDisk: null as string | null, empty002HoldsApp: true }
            noteDiskResetToEmpty({ walker } as never, E1)
            expect(walker.empty002HoldsApp).toBe(false)
        } finally {
            if (prev === undefined) delete process.env.DURATION_STAGE
            else process.env.DURATION_STAGE = prev
        }
    })

    it('infra_dock_fixture (step 93) clears pendingInstallDisk and the hold for the re-docked empties', async () => {
        const ops = fakeOps()
        const ctx = stepCtx(ops, 'infra_dock_fixture', { pendingInstallDisk: E1, empty002HoldsApp: true })
        const r = await dispatchAction({ ...ctx, from: 'infra', to: 'infra' } as any)
        expect(r.ok, r.message).toBe(true)
        expect(ctx.walker.pendingInstallDisk).toBeNull()
        expect(ctx.walker.empty002HoldsApp).toBe(false)
    })

    it('start_after_install (instance Running) clears pendingInstallDisk and names the real hold disk', async () => {
        const ops = fakeOps()
        await ops.dockFixture('idea01', E2)
        const ctx = stepCtx(ops, 'start_after_install', { current: 'op_install', pendingInstallDisk: E1 })
        const r = await dispatchAction({ ...ctx, from: 'op_install', to: 'op_instance' } as any)
        expect(r.ok, r.message).toBe(true)
        expect(ctx.walker.pendingInstallDisk).toBeNull()
        expect(ctx.walker.empty002HoldsApp).toBe(true)
        expect(r.message).toMatch(/duration-empty-002 now holds the late-installed app/)
    })

    it('install_app still marks its disk pending (r75: reset waits for a landing install)', async () => {
        const ops = fakeOps()
        const ctx = stepCtx(ops, 'install_app', {})
        const r = await dispatchAction(ctx as any)
        expect(r.ok, r.message).toBe(true)
        expect(ctx.walker.pendingInstallDisk).toBe(E1)
    })
})
