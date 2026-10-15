import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'node:fs'
import { CommandLogReader } from '../duration/commandLogReader.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('r86k CommandLog read off the main thread', () => {
    it('worker syncs the Engine CommandLog and returns compact traces; never changes the doc', async () => {
        const wss = new WebSocketServer({ port: 0 })
        const port = (wss.address() as { port: number }).port
        const engine = new Repo({ network: [new WebSocketServerAdapter(wss as never)] })
        const h = engine.create<{ traces: Record<string, unknown>; recentTraceIds: string[] }>({ traces: {}, recentTraceIds: [] })
        h.change(d => {
            d.traces['t1'] = { traceId: 't1', command: 'copyApp', args: 'kolibri-1 disk-x', status: 'error', startedAt: 1000, completedAt: 1010, errorMessage: 'nope', logs: [{ msg: 'x' }] }
            d.recentTraceIds.push('t1')
        })
        const headsBefore = JSON.stringify(h.heads())
        const reader = new CommandLogReader('idea01', `ws://127.0.0.1:${port}`, h.url, () => {})
        try {
            let traces: Awaited<ReturnType<CommandLogReader['list']>> | null = null
            const deadline = Date.now() + 20_000
            while (!traces && Date.now() < deadline) {
                try { traces = await reader.list(2_000) } catch { await sleep(200) }
            }
            expect(traces).toEqual([{ traceId: 't1', command: 'copyApp', args: 'kolibri-1 disk-x', status: 'error', startedAt: 1000, completedAt: 1010, errorMessage: 'nope' }])
            // later Engine changes reach the long-lived worker
            h.change(d => { d.traces['t2'] = { traceId: 't2', command: 'moveApp', args: 'a b', status: 'ok', startedAt: 2000 } })
            let seen = false
            for (let i = 0; i < 50 && !seen; i++) { seen = (await reader.list(2_000)).some(t => t.traceId === 't2'); if (!seen) await sleep(100) }
            expect(seen).toBe(true)
            expect(JSON.stringify(h.heads())).not.toBe(headsBefore) // only the Engine wrote
        } finally {
            await reader.close()
            await engine.shutdown()
            wss.close()
        }
    }, 40_000)

    it('a request times out on the wall clock and a dead worker rejects, both loud', async () => {
        const reader = new CommandLogReader('idea04', 'ws://127.0.0.1:1', 'automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu', () => {})
        const r = await reader.list(300).then(() => 'ok', (e: Error) => e.message)
        expect(r).toMatch(/not synced yet|timed out/)
        await reader.close()
        await expect(reader.list(300)).rejects.toThrow(/exited/)
    }, 20_000)

    it('RealFleetOps.listCommandTraces no longer opens the CommandLog on its main-thread Repo', () => {
        const src = readFileSync(fileURLToPath(new URL('../duration/realFleetOps.ts', import.meta.url)).replace(/([\\/])dist-test[\\/]/, '$1'), 'utf8')
        const body = src.slice(src.indexOf('async listCommandTraces('), src.indexOf('async listCommandTraces(') + 2500)
        expect(body).not.toMatch(/conn\.repo\.find/)
        expect(body).toMatch(/CommandLogReader/)
    })
})
