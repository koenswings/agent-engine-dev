/**
 * automerge-mixed-version.test.ts — Automerge upgrade compatibility (old <-> new).
 *
 * All Engines share ONE store and field kits stay on the previous Automerge until
 * they are reflashed, so an upgraded Engine must keep syncing with them in both
 * directions, and chunks written by either version must load in the other.
 *
 *   old = automerge-repo 2.3.1 + network-websocket 2.3.1 on automerge 3.2.4 (what
 *         main's Repo ran before this upgrade; devDependency aliases *-compat-old,
 *         pinned by the pnpm override "@automerge/automerge-repo@2.3.1>@automerge/automerge")
 *   new = automerge-repo / network-websocket 2.5.6 on automerge 3.5.0 (dependencies)
 *
 * Both sides store through DurableNodeFSStorageAdapter (the Engine's adapter) and
 * start from the real store-identity/store-template.json under its own doc id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import { next as An } from '@automerge/automerge'
import { Repo as RepoNew, type DocumentId } from '@automerge/automerge-repo'
import { WebSocketClientAdapter as ClientNew, WebSocketServerAdapter as ServerNew } from '@automerge/automerge-repo-network-websocket'
import { next as Ao } from 'automerge-compat-old'
import { Repo as RepoOld } from 'automerge-repo-compat-old'
import { WebSocketClientAdapter as ClientOld, WebSocketServerAdapter as ServerOld } from 'automerge-repo-network-websocket-compat-old'
import { DurableNodeFSStorageAdapter } from '../../src/data/DurableStorageAdapter.js'

type AnyDoc = Record<string, any>
type AnyRepo = any
type Side = 'old' | 'new'

const repoRoot = (() => {
    let d = path.dirname(fileURLToPath(import.meta.url))
    while (!fs.existsSync(path.join(d, 'store-identity', 'store-template.json'))) d = path.dirname(d)
    return d
})()
const TEMPLATE = fs.readFileSync(path.join(repoRoot, 'store-identity', 'store-template.json'))
const TEMPLATE_DOC_ID = '3m2HoZxUR5L1qUc7pYJHQ5EFv1Wo' as DocumentId // any valid id: the Engine imports the template under its store id

const sortedHeads = (h: readonly string[]): string => [...h].sort().join(',')
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (f: () => boolean, ms = 15_000): Promise<boolean> => {
    const t = Date.now()
    while (Date.now() - t < ms) { if (f()) return true; await sleep(25) }
    return f()
}

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-test-am-compat-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const newRepo = (side: Side, dir: string, peerId: string, network: unknown[] = []): AnyRepo => {
    const R: any = side === 'old' ? RepoOld : RepoNew
    return new R({ network, storage: new DurableNodeFSStorageAdapter(path.join(tmp, dir)), peerId, sharePolicy: async () => true })
}
const serverAdapter = (side: Side, wss: WebSocketServer): unknown => side === 'old' ? new ServerOld(wss as any) : new ServerNew(wss as any)
const clientAdapter = (side: Side, port: number): unknown => side === 'old' ? new ClientOld(`ws://127.0.0.1:${port}`) : new ClientNew(`ws://127.0.0.1:${port}`)

const freePort = async (): Promise<number> => {
    const { createServer } = await import('net')
    return new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)) }) })
}

describe('Automerge core: storage format old <-> new', () => {
    it('both versions load store-template.json to the same heads and content', () => {
        const o = Ao.load<AnyDoc>(TEMPLATE), n = An.load<AnyDoc>(TEMPLATE)
        expect(sortedHeads(An.getHeads(n))).toBe(sortedHeads(Ao.getHeads(o)))
        expect(canon(n)).toBe(canon(o))
        expect(Object.keys(n).sort()).toEqual(['appDB', 'diskDB', 'engineDB', 'instanceDB'])
    })

    it('full saves and incremental chunks load across versions in both directions', () => {
        let o = Ao.change(Ao.init<AnyDoc>(), d => { d.m = { a: 1 }; d.l = [1, 2, 3]; d.t = 'hello'; d.c = new Ao.Counter(1) })
        let n = An.load<AnyDoc>(Ao.save(o))
        expect(canon(n)).toBe(canon(o))
        n = An.change(n, d => { d.m.b = 2; d.l.push(4); d.c.increment(2); delete d.m.a })
        o = Ao.loadIncremental(o, An.saveSince(n, Ao.getHeads(o)))
        expect(sortedHeads(Ao.getHeads(o))).toBe(sortedHeads(An.getHeads(n)))
        expect(canon(Ao.load(An.save(n)))).toBe(canon(n))
        o = Ao.change(o, d => { d.m.z = 'old'; d.l.insertAt(0, 0) })
        n = An.loadIncremental(n, Ao.saveSince(o, An.getHeads(n)))
        expect(sortedHeads(An.getHeads(n))).toBe(sortedHeads(Ao.getHeads(o)))
        expect(canon(n)).toBe(canon(o))
    })
})

describe('Automerge core: sync protocol old <-> new', () => {
    const loop = (a: any, A1: any, b: any, A2: any): [any, any] => {
        let sa = A1.initSyncState(), sb = A2.initSyncState()
        for (let i = 0; i < 50; i++) {
            let m1: Uint8Array | null, m2: Uint8Array | null
            ;[sa, m1] = A1.generateSyncMessage(a, sa); if (m1) [b, sb] = A2.receiveSyncMessage(b, sb, m1)
            ;[sb, m2] = A2.generateSyncMessage(b, sb); if (m2) [a, sa] = A1.receiveSyncMessage(a, sa, m2)
            if (!m1 && !m2) break
        }
        return [a, b]
    }
    for (const [first, A1, A2] of [['old', Ao, An], ['new', An, Ao]] as const) {
        it(`diverged histories converge when the ${first} side starts the sync`, () => {
            const base = A1.change(A1.init<AnyDoc>(), (d: AnyDoc) => { d.x = {} })
            let a = A1.clone(base), b = A2.load<AnyDoc>(A1.save(base))
            for (let i = 0; i < 200; i++) {
                a = A1.change(a, (d: AnyDoc) => { d.x['a' + i] = i })
                b = A2.change(b, (d: AnyDoc) => { d.x['b' + i] = 'v' + i })
            }
            ;[a, b] = loop(a, A1, b, A2)
            expect(sortedHeads(A2.getHeads(b))).toBe(sortedHeads(A1.getHeads(a)))
            expect(Object.keys(a.x)).toHaveLength(400)
            expect(canon(b)).toBe(canon(a))
        })
        it(`an empty ${first === 'old' ? 'new' : 'old'} peer receives a whole ${first} document`, () => {
            let full = A1.change(A1.init<AnyDoc>(), (d: AnyDoc) => { d.k = Array.from({ length: 300 }, (_, i) => i) })
            let empty = A2.init<AnyDoc>()
            ;[full, empty] = loop(full, A1, empty, A2)
            expect(sortedHeads(A2.getHeads(empty))).toBe(sortedHeads(A1.getHeads(full)))
            expect(empty.k).toHaveLength(300)
        })
    }
})

describe('automerge-repo over WebSocket: old <-> new Engines on the store template', () => {
    for (const [srv, cli] of [['old', 'new'], ['new', 'old']] as const) {
        it(`${srv} server <-> ${cli} client: changes on both sides reach the other, heads converge, each store dir loads in the other version`, async () => {
            const port = await freePort()
            const wss = new WebSocketServer({ port, host: '127.0.0.1' })
            const rs = newRepo(srv, 'srv', `engine-${srv}-srv`, [serverAdapter(srv, wss)])
            const rc = newRepo(cli, 'cli', `engine-${cli}-cli`, [clientAdapter(cli, port)])
            try {
                const hs = rs.import(TEMPLATE, { docId: TEMPLATE_DOC_ID })
                expect(hs.documentId).toBe(TEMPLATE_DOC_ID)
                hs.change((d: AnyDoc) => { d.engineDB.srv = { version: srv } })
                const hc = await rc.find(hs.url)
                await hc.whenReady()
                hc.change((d: AnyDoc) => { d.engineDB.cli = { version: cli } })
                hs.change((d: AnyDoc) => { d.engineDB.srv2 = { version: srv } })
                const converged = await until(() =>
                    sortedHeads(hs.heads()) === sortedHeads(hc.heads())
                    && Object.keys(hs.doc().engineDB).length === 3 && Object.keys(hc.doc().engineDB).length === 3)
                expect(converged).toBe(true)
                expect(canon(hc.doc())).toBe(canon(hs.doc()))
                await rs.flush(); await rc.flush()
            } finally {
                await rc.shutdown(); await rs.shutdown(); wss.close()
            }
            // store dirs written by each version, loaded by the other version
            for (const [dir, writer] of [['srv', srv], ['cli', cli]] as const) {
                const reader: Side = writer === 'old' ? 'new' : 'old'
                const r = newRepo(reader, dir, `reload-${reader}-${dir}`)
                try {
                    const h = await r.find(`automerge:${TEMPLATE_DOC_ID}`)
                    await h.whenReady()
                    expect(Object.keys(h.doc().engineDB).sort()).toEqual(['cli', 'srv', 'srv2'])
                    expect(Object.keys(h.doc()).sort()).toEqual(['appDB', 'diskDB', 'engineDB', 'instanceDB'])
                } finally { await r.shutdown() }
            }
        }, 30_000)
    }
})
