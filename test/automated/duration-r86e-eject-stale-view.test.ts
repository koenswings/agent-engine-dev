/**
 * r86e FAIL@46 (cover-all-stage2-2e1a34b-r86e): confirm_eject of duration-kolibri-grade5a-001 on idea01.
 * The Engine stopped the container and set the instance Undocked, with the disk dockedTo=null (idea01
 * Engine log; a fresh store read afterwards showed {status:'Undocked', dockedTo:null}). But the walker's
 * CACHED idea01 view kept saying Running for the whole 15 s confirm_eject settle, so the step failed with
 * "docker missing remained". Before failing, the settle now reconnects the engines that reported docker
 * missing and judges one fresh sample. If the fresh store still says Running with no container, it fails
 * loud as before.
 */
import { describe, expect, it } from 'vitest'
import { runStabilityDuringDwell } from '../duration/stability.js'

type Status = 'Running' | 'Undocked'
const mk = (opts: { cached: Status; fresh: Status; withRefresh: boolean }) => {
    let fresh = false
    const refreshes: string[] = []
    const status = () => (fresh ? opts.fresh : opts.cached)
    const ops: Record<string, unknown> = {
        readStore: async () => ({
            engineId: 'idea01',
            instanceDB: { 'kolibri-grade5a-001': { id: 'kolibri-grade5a-001', status: status(), diskId: 'duration-kolibri-grade5a-001' } },
            diskDB: { 'duration-kolibri-grade5a-001': { id: 'duration-kolibri-grade5a-001', dockedTo: status() === 'Running' ? 'idea01' : null } },
            engineDB: {},
        }),
        // Container exited on eject: docker missing while the (cached) store says Running.
        probeStability: async () => {
            const missing = status() === 'Running'
            return {
                ok: !missing,
                detail: missing ? 'idea01: docker missing for kolibri-grade5a-001' : 'ok',
                engines: [{ id: 'idea01', wsUp: true, dockerOk: !missing, statusAnomaly: missing ? 'docker missing for kolibri-grade5a-001' : undefined }],
            }
        },
    }
    if (opts.withRefresh) ops.refreshView = async (e: string, why: string) => { refreshes.push(`${e}: ${why}`); fresh = true; return true }
    return { ops, refreshes }
}
const run = (ops: unknown) => runStabilityDuringDwell({
    ops: ops as never, engines: ['idea01'], intervalMs: 1, failAfter: 3, dwellMs: 5,
    justCompletedAction: 'confirm_eject', dockerMissingSettleMs: 15,
})

describe('r86e: confirm_eject docker-missing settle distrusts a stale cached view once before failing', () => {
    it('replay: cached view frozen at Running, fresh read says Undocked → ok, one reconnect of idea01', async () => {
        const { ops, refreshes } = mk({ cached: 'Running', fresh: 'Undocked', withRefresh: true })
        const r = await run(ops)
        expect(r.ok).toBe(true)
        expect(refreshes.length).toBe(1)
        expect(refreshes[0]).toMatch(/^idea01: docker missing after 15ms settle \(confirm_eject\)/)
    })
    it('fresh read still Running with no container → fails loud (no soft-pass)', async () => {
        const { ops, refreshes } = mk({ cached: 'Running', fresh: 'Running', withRefresh: true })
        const r = await run(ops)
        expect(r.ok).toBe(false)
        expect(r.abortReason).toMatch(/docker missing remained after 15ms settle: idea01: docker missing for kolibri-grade5a-001/)
        expect(refreshes.length).toBe(1)
    })
    it('adapter without refreshView keeps the old verdict', async () => {
        const { ops } = mk({ cached: 'Running', fresh: 'Undocked', withRefresh: false })
        expect((await run(ops)).ok).toBe(false)
    })
})
