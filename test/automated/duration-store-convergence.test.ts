/**
 * store_convergence wait/retry + field-level dump (r41 harness tip B).
 */
import { describe, expect, it } from 'vitest'
import { formatSemanticDivergence, semanticStoresEqual, waitForConvergence } from '../duration/convergence.js'
import { evaluateInvariants } from '../duration/invariants.js'
import { FakeFleetOps } from '../duration/actions.js'
import type { SemanticStoreView } from '../duration/types.js'

const KID_FIXTURES = {
    'duration-kolibri-grade5a-001': 'kolibri-grade5a-001',
    'duration-nextcloud-grade5a-001': 'nextcloud-grade5a-001',
} as const

const fakeOps = (partial: ConstructorParameters<typeof FakeFleetOps>[0]) =>
    new FakeFleetOps({ fixtureInstances: { ...KID_FIXTURES }, ...partial })

const baseView = (
    engineId: string,
    opts: { status?: string; dockedTo?: string | null },
): SemanticStoreView => ({
    engineId,
    instanceDB: {
        'kolibri-grade5a-001': {
            id: 'kolibri-grade5a-001',
            status: opts.status ?? 'Running',
            diskId: 'duration-kolibri-grade5a-001',
            name: 'Kolibri',
        },
    },
    diskDB: {
        'duration-kolibri-grade5a-001': {
            id: 'duration-kolibri-grade5a-001',
            dockedTo: opts.dockedTo === undefined ? 'idea01' : opts.dockedTo,
            name: 'duration-kolibri-grade5a-001',
            device: opts.dockedTo === null ? null : 'idea-test-1',
        },
    },
    engineDB: {
        idea01: { id: 'idea01', hostname: 'idea01.local' },
        idea03: { id: 'idea03', hostname: 'idea03.local' },
    },
})

const invCtx = (
    ops: {
        getStoreMode: () => 'shared' | 'unique'
        readStore: (id: string) => Promise<SemanticStoreView>
        waitReady: () => Promise<{ wsUp: boolean; storeSynced: boolean }>
    },
    extra?: { settleTimeoutMs?: number; fast?: boolean },
) => ({
    ops: ops as never,
    walker: { current: 'infra_docked', layer: 'infra' as const, dockedEngine: 'idea01', step: 1 },
    excludeEngines: ['idea02'],
    poolEngines: ['idea01', 'idea03'],
    fixtureDisk: 'duration-kolibri-grade5a-001',
    engines: ['idea01', 'idea03'],
    settleTimeoutMs: extra?.settleTimeoutMs ?? 500,
    fast: extra?.fast ?? true,
})

describe('formatSemanticDivergence', () => {
    it('names DB, id, field, and per-engine values', () => {
        const a = baseView('idea01', { status: 'Running', dockedTo: 'idea01' })
        const b = baseView('idea03', { status: 'Undocked', dockedTo: null })
        const dump = formatSemanticDivergence([a, b])
        expect(dump).toMatch(/instanceDB id=kolibri-grade5a-001 field=status/)
        expect(dump).toMatch(/idea01=Running/)
        expect(dump).toMatch(/idea03=Undocked/)
        expect(dump).toMatch(/diskDB id=duration-kolibri-grade5a-001 field=dockedTo/)
        expect(dump).toMatch(/idea01=idea01/)
        expect(dump).toMatch(/idea03=null/)
        expect(semanticStoresEqual(a, b)).toBe(false)
    })
})

describe('store_convergence wait/retry + field dump', () => {
    it('passes on first try when already equal', async () => {
        let readRounds = 0
        const equal = baseView('idea01', { status: 'Running', dockedTo: 'idea01' })
        const ops = {
            getStoreMode: () => 'shared' as const,
            waitReady: async () => ({ wsUp: true, storeSynced: true }),
            readStore: async (id: string) => {
                readRounds++
                return structuredClone({ ...equal, engineId: id })
            },
        }
        const results = await evaluateInvariants([{ type: 'store_convergence' }], invCtx(ops))
        expect(results[0]?.ok).toBe(true)
        expect(results[0]?.detail).toMatch(/match/)
        // evaluateInvariants one-shot + waitForConvergence first poll — no retry loop
        expect(readRounds).toBeLessThanOrEqual(6)
    })

    it('retries until Automerge lag clears (converge-after-lag)', async () => {
        let poll = 0
        const converged = baseView('idea01', { status: 'Running', dockedTo: 'idea01' })
        const lagged = baseView('idea03', { status: 'Undocked', dockedTo: null })
        const ops = {
            getStoreMode: () => 'shared' as const,
            waitReady: async () => ({ wsUp: true, storeSynced: true }),
            readStore: async (id: string) => {
                const round = Math.floor(poll / 2)
                poll++
                if (round < 2) {
                    return id === 'idea01'
                        ? structuredClone(converged)
                        : structuredClone({ ...lagged, engineId: id })
                }
                return structuredClone({ ...converged, engineId: id })
            },
        }
        const results = await evaluateInvariants(
            [{ type: 'store_convergence' }],
            invCtx(ops, { settleTimeoutMs: 2000, fast: true }),
        )
        expect(results[0]?.ok).toBe(true)
        expect(poll).toBeGreaterThan(4)
    })

    it('hard-fails with field dump when diverge persists (no soft-pass)', async () => {
        const a = baseView('idea01', { status: 'Running', dockedTo: 'idea01' })
        const b = baseView('idea03', { status: 'Starting', dockedTo: null })
        const ops = {
            getStoreMode: () => 'shared' as const,
            waitReady: async () => ({ wsUp: true, storeSynced: true }),
            readStore: async (id: string) =>
                structuredClone(id === 'idea01' ? a : { ...b, engineId: id }),
        }
        const results = await evaluateInvariants(
            [{ type: 'store_convergence' }],
            invCtx(ops, { settleTimeoutMs: 120, fast: true }),
        )
        expect(results[0]?.ok).toBe(false)
        expect(results[0]?.detail).toMatch(/semantic fields diverge:/)
        expect(results[0]?.detail).toMatch(/instanceDB id=kolibri-grade5a-001 field=status/)
        expect(results[0]?.detail).toMatch(/idea01=Running/)
        expect(results[0]?.detail).toMatch(/idea03=Starting/)
        expect(results[0]?.detail).toMatch(/diskDB id=duration-kolibri-grade5a-001 field=dockedTo/)
        expect(results[0]?.detail).not.toBe('semantic fields diverge')
    })

    it('FakeFleetOps shared dock still converges via waitForConvergence', async () => {
        const ops = fakeOps({
            poolEngines: ['idea01', 'idea03'],
            excludeEngines: ['idea02'],
            storeMode: 'shared',
        })
        await ops.dockFixture('idea01', 'duration-kolibri-grade5a-001')
        const result = await waitForConvergence(ops, ['idea01', 'idea03'], 1000)
        expect(result.ok).toBe(true)
        const inv = await evaluateInvariants([{ type: 'store_convergence' }], {
            ops,
            walker: { current: 'infra_docked', layer: 'infra', dockedEngine: 'idea01', step: 1 },
            excludeEngines: ['idea02'],
            poolEngines: ['idea01', 'idea03'],
            fixtureDisk: 'duration-kolibri-grade5a-001',
            engines: ['idea01', 'idea03'],
            settleTimeoutMs: 500,
            fast: true,
        })
        expect(inv[0]?.ok).toBe(true)
    })
})
