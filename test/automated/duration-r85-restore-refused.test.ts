/**
 * r85 FAIL@100 (cover-all-stage2-17f745f-r85): the Console RestorePanel offered duration-add-files-001
 * (docked on idea01) as a restore target and sent `restoreApp kolibri-grade5a-001 duration-add-files-001`
 * to idea04, which holds the Backup Disk. idea04 refused it ("Disk ... (duration-add-files-001) is not
 * docked to this engine."), so no restoreApp Operation was ever created. The op wait could only end
 * NotSeen after ~1022 s, the Intent took that as "legacy settle" and the step later died on the wrong-tab
 * guard. The wait must surface the Engine's refusal as Error (fail loud, with the Engine message).
 */
import { describe, expect, it } from 'vitest'
import { findRefusedCommand, waitOperationTerminal, type OpWaitIo } from '../duration/opWait.js'

const since = 1_791_791_763_260
const refusal = {
    command: 'restoreApp', args: '["kolibri-grade5a-001","duration-add-files-001"]', status: 'error', startedAt: since + 900,
    errorMessage: "Disk 'Duration Tests — Add Files App' (duration-add-files-001) is not docked to this engine.",
}
const io = (traces: Record<string, (typeof refusal)[]>, extra: Partial<OpWaitIo> = {}): OpWaitIo => {
    let t = since
    return {
        engines: ['idea01', 'idea03', 'idea04'],
        listOperations: async () => [],
        listCommandTraces: async e => traces[e] ?? [],
        sleep: async ms => { t += ms },
        now: () => t,
        ...extra,
    }
}

describe('r85: restoreApp refused by the Engine → Error, not NotSeen', () => {
    it('replay: refusal on idea04 ends the wait at once as Error with the Engine message', async () => {
        let refreshed = 0
        const r = await waitOperationTerminal({ kind: 'restoreApp', instanceId: 'kolibri-grade5a-001', sinceMs: since },
            io({ idea04: [refusal] }, { refresh: async () => { refreshed++; return true } }), 900_000, 60_000)
        expect(r.status).toBe('Error')
        expect(r.detail).toContain('idea04 refused restoreApp')
        expect(r.detail).toContain('is not docked to this engine')
        expect(r.elapsedMs).toBe(0)
        expect(refreshed).toBe(0)
    })
    it('also matches the space-joined command form', async () => {
        const t = { ...refusal, command: 'restoreApp kolibri-grade5a-001 duration-add-files-001', args: '' }
        expect(await findRefusedCommand({ kind: 'restoreApp', instanceId: 'kolibri-grade5a-001', sinceMs: since }, io({ idea04: [t] })))
            .toContain('not docked')
    })
    it('ignores ok traces, older traces, other kinds and other instances', async () => {
        const traces = [
            { ...refusal, status: 'ok' },
            { ...refusal, startedAt: since - 60_000 },
            { ...refusal, command: 'backupApp' },
            { ...refusal, args: '["nextcloud-grade5a-001","x"]' },
        ]
        expect(await findRefusedCommand({ kind: 'restoreApp', instanceId: 'kolibri-grade5a-001', sinceMs: since }, io({ idea04: traces }))).toBeUndefined()
    })
    it('a Done Operation still wins; no traces reader keeps the old NotSeen path', async () => {
        const done = io({}, { listOperations: async () => [{ id: 'op1', kind: 'restoreApp', status: 'Done', startedAt: since + 10, args: { instanceId: 'kolibri-grade5a-001' } }] })
        expect((await waitOperationTerminal({ kind: 'restoreApp', instanceId: 'kolibri-grade5a-001', sinceMs: since }, done, 900_000, 60_000)).status).toBe('Done')
        const plain = io({}); delete plain.listCommandTraces
        expect((await waitOperationTerminal({ kind: 'restoreApp', instanceId: 'kolibri-grade5a-001', sinceMs: since }, plain, 900_000, 60_000)).status).toBe('NotSeen')
    })
    it('unreadable CommandLog on one engine does not hide a refusal on another', async () => {
        const i = io({ idea04: [refusal] }); const base = i.listCommandTraces!
        i.listCommandTraces = async e => { if (e === 'idea01') throw new Error('not ready'); return base(e) }
        expect(await findRefusedCommand({ kind: 'restoreApp', instanceId: 'kolibri-grade5a-001', sinceMs: since }, i)).toContain('idea04')
    })
})
