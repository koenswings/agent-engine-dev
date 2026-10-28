/**
 * forget-disk-trace.test.ts (agent-engine-dev#262): forgetDisk through the engine command
 * queue must report ok when it removed the record. Seen on idea03: the trace said
 * "changed while it was being forgotten; nothing removed" although the record was gone.
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { enableStoreMonitor } from '../../src/monitors/storeMonitor.js'
import { forgetDisk } from '../../src/data/ForgetDisk.js'

const DISK = '20070Q450002'
const disk = (id: string) => ({ id, name: `stale ${id}`, dockedTo: null, device: null, created: 1, lastDocked: 1, diskType: 'app' })

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(d => { (d.diskDB as any)[DISK] = disk(DISK); (d.diskDB as any)['1so47cqrv6kor7anvxm'] = disk('1so47cqrv6kor7anvxm') })
    return h
}
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] => h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])
const queue = (h: DocHandle<Store>): string[] => [...((h.doc()!.engineDB[localEngineId].commands as any[]) ?? [])].map(String)

describe('forgetDisk reports what it did (#262)', () => {
    let h: DocHandle<Store>
    let log: DocHandle<CommandLogStore>
    let err: ReturnType<typeof vi.spyOn>
    beforeEach(async () => {
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        h = await newStore()
        log = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
    })
    afterEach(() => err.mockRestore())

    it('direct call: removes and returns the id', () => {
        expect(forgetDisk(h, DISK)).toBe(DISK)
        expect(h.doc()!.diskDB[DISK as any]).toBeUndefined()
    })

    it('via the command queue: both records removed and both traces ok', async () => {
        enableStoreMonitor(h, log)
        h.change(d => { (d.engineDB[localEngineId].commands as any[]).push(`forgetDisk ${DISK}`, 'forgetDisk 1so47cqrv6kor7anvxm') })
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        await vi.waitFor(() => expect(traces(log).filter(t => t.command?.startsWith('forgetDisk') && t.status !== 'pending' && t.status !== 'running').length).toBe(2))
        expect(h.doc()!.diskDB[DISK as any]).toBeUndefined()
        const ts = traces(log).filter(t => t.command?.startsWith('forgetDisk'))
        for (const t of ts) expect({ c: t.command, s: t.status, e: t.errorMessage ?? null }).toEqual({ c: t.command, s: "ok", e: null })
    })
})
