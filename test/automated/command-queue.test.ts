/**
 * command-queue.test.ts (idea#168): the engine command queue (storeMonitor)
 *
 * storeMonitor skipped any queued command without a space, so a bare `reboot`
 * never ran and stayed at the head, blocking every later command until a
 * restart (the startup replay then ran it). Now every head goes through
 * handleCommand and is removed afterwards:
 *   - a bare registered no-arg command (reboot) runs (rebootEngine mocked)
 *   - an unknown bare word gets an error trace and does not block the next one
 *   - a bare command that needs args is refused (error trace), not run
 *   - spaced commands run as before, in order, each once
 *   - the startup replay uses the same path: each pending command runs once,
 *     also when live patches arrive during the replay
 * idea#498: read-only verifyMoveTarget runs outside the serial queue, so it is
 * answered while a startInstance is still in progress; mutating commands stay serial.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'

vi.mock('../../src/data/Engine.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, rebootEngine: vi.fn(async () => {}) }
})

vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, startInstance: vi.fn(async () => {}) }
})

vi.mock('../../src/data/MoveAppRemote.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, verifyMoveTarget: vi.fn(async () => ({ ok: true, code: null, bytes: 1, detail: null, at: Date.now() })) }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, rebootEngine } from '../../src/data/Engine.js'
import { startInstance } from '../../src/data/Instance.js'
import { verifyMoveTarget } from '../../src/data/MoveAppRemote.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { enableStoreMonitor } from '../../src/monitors/storeMonitor.js'

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}
const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] => h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])
const queue = (h: DocHandle<Store>): string[] => [...((h.doc()!.engineDB[localEngineId].commands as any[]) ?? [])].map(String)
const push = (h: DocHandle<Store>, ...cmds: string[]) =>
    h.change(doc => { for (const c of cmds) (doc.engineDB[localEngineId].commands as any[]).push(c) })

describe('engine command queue (idea#168)', () => {
    let h: DocHandle<Store>
    let log: DocHandle<CommandLogStore>
    let err: ReturnType<typeof vi.spyOn>
    beforeEach(async () => {
        vi.mocked(rebootEngine).mockClear()
        vi.mocked(startInstance).mockClear().mockResolvedValue(undefined as any)
        vi.mocked(verifyMoveTarget).mockClear().mockResolvedValue({ ok: true, code: null, bytes: 1, detail: null, at: Date.now() } as any)
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        h = await newStore()
        log = newLog()
    })
    afterEach(() => err.mockRestore())

    it('a bare `reboot` on the queue runs (rebootEngine called once) and is removed', async () => {
        enableStoreMonitor(h, log)
        push(h, 'reboot')
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        expect(vi.mocked(rebootEngine)).toHaveBeenCalledOnce()
        const t = traces(log).find(x => x.command === 'reboot')
        expect(t?.status).toBe('ok')
    })

    it('an unknown bare word gets an error trace and does not block the next command', async () => {
        enableStoreMonitor(h, log)
        push(h, 'bogusword', 'reboot')
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        const bogus = traces(log).find(x => x.command === 'bogusword')
        expect(bogus?.status).toBe('error')
        expect(bogus?.errorMessage).toBe('Unknown command: bogusword')
        expect(vi.mocked(rebootEngine)).toHaveBeenCalledOnce()
    })

    it('a bare command that needs arguments is refused with an error trace, not run, and removed', async () => {
        enableStoreMonitor(h, log)
        push(h, 'ejectDisk', 'reboot')
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        const t = traces(log).find(x => x.command === 'ejectDisk')
        expect(t?.status).toBe('error')
        expect(t?.errorMessage).toBe('Error: Insufficient arguments')
        expect(vi.mocked(rebootEngine)).toHaveBeenCalledOnce()
    })

    it('spaced commands run as before, in order, each once', async () => {
        enableStoreMonitor(h, log)
        push(h, 'ejectDisk no-such-disk', 'cancelOperation op-x')
        push(h, 'reboot')
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        const cmds = traces(log).map(t => t.command)
        expect(cmds.filter(c => c === 'ejectDisk')).toHaveLength(1)
        expect(cmds.filter(c => c === 'cancelOperation')).toHaveLength(1)
        expect(cmds.indexOf('ejectDisk')).toBeLessThan(cmds.indexOf('cancelOperation'))
        expect(traces(log).find(t => t.command === 'ejectDisk')?.errorMessage).toContain("Disk 'no-such-disk' not found.")
        expect(vi.mocked(rebootEngine)).toHaveBeenCalledOnce()
    })

    it('an empty string at the head is refused and removed, not left blocking', async () => {
        enableStoreMonitor(h, log)
        push(h, '', 'reboot')
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        expect(traces(log).find(t => t.command === '(empty)')?.status).toBe('error')
        expect(vi.mocked(rebootEngine)).toHaveBeenCalledOnce()
    })

    it('startup replay: pending commands (bare and spaced) run once each, also with live patches during the replay', async () => {
        push(h, 'reboot', 'bogusword', 'ejectDisk no-such-disk')
        enableStoreMonitor(h, log)
        push(h, 'reboot')                 // live patch while the replay runs
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        expect(vi.mocked(rebootEngine)).toHaveBeenCalledTimes(2)
        const cmds = traces(log).map(t => t.command)
        expect(cmds).toEqual(['reboot', 'bogusword', 'ejectDisk', 'reboot'])
    })

    it('verifyMoveTarget is answered while a startInstance is in progress (idea#498); reboot stays serial', async () => {
        const instId = 'kolibri-498start01'
        h.change(doc => {
            doc.diskDB['d1' as any] = { id: 'd1', name: 'Apps', device: 'idea-test-1', dockedTo: String(localEngineId), diskTypes: ['app'] } as any
            doc.instanceDB[instId as any] = {
                id: instId, name: 'kolibri', storedOn: 'd1', instanceOf: 'kolibri-1.0', status: 'Stopped', port: 50001,
            } as any
        })
        let releaseStart!: () => void
        let startBegan = false
        vi.mocked(startInstance).mockImplementation(() => {
            startBegan = true
            return new Promise(resolve => { releaseStart = () => resolve(undefined as any) })
        })
        enableStoreMonitor(h, log)
        push(h, `startInstance ${instId} d1`)
        await vi.waitFor(() => expect(startBegan).toBe(true))
        expect(vi.mocked(verifyMoveTarget)).not.toHaveBeenCalled()
        push(h, 'verifyMoveTarget op-498 inst-new 12345 true', 'reboot')
        await vi.waitFor(() => expect(vi.mocked(verifyMoveTarget)).toHaveBeenCalled())
        expect(startBegan).toBe(true)
        expect(vi.mocked(rebootEngine)).not.toHaveBeenCalled()
        const vt = traces(log).find(x => x.command === 'verifyMoveTarget')
        expect(vt?.status).toBe('ok')
        releaseStart()
        await vi.waitFor(() => expect(queue(h)).toEqual([]))
        expect(vi.mocked(rebootEngine)).toHaveBeenCalledOnce()
        expect(vi.mocked(startInstance)).toHaveBeenCalledOnce()
    })
})
