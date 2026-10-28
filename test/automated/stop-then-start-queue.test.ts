/**
 * stop-then-start-queue.test.ts (agent-engine-dev#239): `stopInstance` then `startInstance`
 * sent back to back must not let the stop finish after the start. The stop command now
 * awaits the stop, so the engine command queue runs the start only once the stop is done,
 * and the stop trace is not closed ok before the containers are stopped.
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'

const events: string[] = []
let releaseStop: () => void = () => {}
let releaseStart: (() => void) | null = null

vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        stopInstance: vi.fn(async () => {
            events.push('stop:begin')
            await new Promise<void>(r => { releaseStop = r })
            events.push('stop:end')
        }),
        startInstance: vi.fn(async () => {
            if (!releaseStart) { events.push('start'); return }
            events.push('start:begin')
            await new Promise<void>(r => { releaseStart = r })
            events.push('start:end')
        }),
    }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { enableStoreMonitor } from '../../src/monitors/storeMonitor.js'

const INST = 'nextcloud-abc123'
const DISK = 'disk-239'

describe('stopInstance is awaited (#239)', () => {
    let h: DocHandle<Store>
    let log: DocHandle<CommandLogStore>
    let err: ReturnType<typeof vi.spyOn>
    beforeEach(async () => {
        events.length = 0
        releaseStart = null
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        h = new Repo({ network: [], storage: undefined }).create<Store>({
            engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
        } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, localEngineId)
        h.change(d => {
            (d.diskDB as any)[DISK] = { id: DISK, name: 'NC Disk', dockedTo: localEngineId, device: 'sdb1', created: 1, lastDocked: 1, diskTypes: ['app'] }
            ;(d.instanceDB as any)[INST] = { id: INST, name: 'nextcloud', instanceOf: 'nextcloud-1.0', status: 'Running', port: 50000, serviceImages: [], created: 1, lastStarted: 1, storedOn: DISK }
        })
        log = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
    })
    afterEach(() => err.mockRestore())

    const traces = (): CommandTrace[] => log.doc()!.recentTraceIds.map(id => log.doc()!.traces[id])

    it('a startInstance queued right after stopInstance runs only after the stop finished', async () => {
        enableStoreMonitor(h, log)
        h.change(d => { (d.engineDB[localEngineId].commands as any[]).push(`stopInstance ${INST} ${DISK}`, `startInstance ${INST} ${DISK}`) })
        await vi.waitFor(() => expect(events).toContain('stop:begin'))
        await new Promise(r => setTimeout(r, 200))
        expect(events).toEqual(['stop:begin'])
        const stopTrace = traces().find(t => t.command === 'stopInstance')
        expect(stopTrace?.status).toBe('running')
        releaseStop()
        await vi.waitFor(() => expect(events).toEqual(['stop:begin', 'stop:end', 'start']))
        await vi.waitFor(() => expect(traces().find(t => t.command === 'stopInstance')?.status).toBe('ok'))
    })

    it('a stopInstance queued right after startInstance runs only after the start finished', async () => {
        releaseStart = () => {}
        enableStoreMonitor(h, log)
        h.change(d => { (d.engineDB[localEngineId].commands as any[]).push(`startInstance ${INST} ${DISK}`, `stopInstance ${INST} ${DISK}`) })
        await vi.waitFor(() => expect(events).toContain('start:begin'))
        await new Promise(r => setTimeout(r, 200))
        expect(events).toEqual(['start:begin'])
        expect(traces().find(t => t.command === 'startInstance')?.status).toBe('running')
        releaseStart!()
        await vi.waitFor(() => expect(events).toContain('stop:begin'))
        expect(events.slice(0, 3)).toEqual(['start:begin', 'start:end', 'stop:begin'])
        releaseStop()
        await vi.waitFor(() => expect(traces().find(t => t.command === 'startInstance')?.status).toBe('ok'))
        await vi.waitFor(() => expect(traces().find(t => t.command === 'stopInstance')?.status).toBe('ok'))
    })
})
