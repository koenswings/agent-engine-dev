/**
 * static-peers.test.ts (idea#168 follow-up): IDEA_STATIC_PEERS
 *
 *   - parseStaticPeers: with/without port, whitespace, empty entries, invalid
 *     entries skipped with a warning, duplicates once
 *   - unset / empty: nothing happens (no connect, no timers)
 *   - connectEngine called once per peer; a peer the mDNS path already
 *     connected (same ip:port key) is not dialled again
 *   - reconnect after the connection is gone; backoff on failures
 *   - this Engine itself is skipped
 *   - connectEngine: optional port (static peers); without it the key uses
 *     settings.port exactly as before (mDNS path)
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import os from 'os'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { config } from '../../src/data/Config.js'
import { network, connectEngine, disconnectEngine } from '../../src/data/Network.js'
import { EngineID, Hostname, IPAddress, PortNumber } from '../../src/data/CommonTypes.js'
import {
    parseStaticPeers, startStaticPeers, isSelfPeer, staticPeersSetting, STATIC_PEERS_ENV,
    STATIC_PEER_BASE_DELAY_MS, STATIC_PEER_CHECK_INTERVAL_MS,
} from '../../src/data/StaticPeers.js'

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}
const clearConnections = () => { for (const k of Object.keys(network.connections)) delete (network.connections as any)[k] }

describe('parseStaticPeers', () => {
    it('host or host:port; default port when omitted', () => {
        expect(parseStaticPeers('idea01,10.0.0.3:5000', 4321)).toEqual({
            peers: [{ host: 'idea01', port: 4321 }, { host: '10.0.0.3', port: 5000 }], warnings: [],
        })
    })
    it('whitespace and empty entries are ignored; unset/empty gives no peers', () => {
        expect(parseStaticPeers('  idea01 , ,, idea03.local:4321 ,', 4321).peers)
            .toEqual([{ host: 'idea01', port: 4321 }, { host: 'idea03.local', port: 4321 }])
        expect(parseStaticPeers('', 4321)).toEqual({ peers: [], warnings: [] })
        expect(parseStaticPeers(undefined, 4321)).toEqual({ peers: [], warnings: [] })
        expect(parseStaticPeers(' , ', 4321)).toEqual({ peers: [], warnings: [] })
    })
    it('invalid entries are skipped with a warning; valid ones still count', () => {
        const r = parseStaticPeers('idea01:0,idea02:99999,bad host,idea04:abc,a:1:2,-x,10.0.0.4', 4321)
        expect(r.peers).toEqual([{ host: '10.0.0.4', port: 4321 }])
        expect(r.warnings).toHaveLength(6)
        expect(r.warnings[0]).toBe(`${STATIC_PEERS_ENV}: skipping invalid entry 'idea01:0' (port must be 1..65535)`)
        expect(r.warnings[2]).toBe(`${STATIC_PEERS_ENV}: skipping invalid entry 'bad host' (expected host or host:port)`)
    })
    it('duplicates (same host and port) are listed once', () => {
        expect(parseStaticPeers('idea01,IDEA01:4321,idea01:4322', 4321).peers)
            .toEqual([{ host: 'idea01', port: 4321 }, { host: 'idea01', port: 4322 }])
    })
})

describe('isSelfPeer', () => {
    it('own hostname (with or without .local), loopback and local interface addresses are self', () => {
        expect(isSelfPeer(os.hostname(), '203.0.113.7')).toBe(true)
        expect(isSelfPeer(`${os.hostname()}.local`, '203.0.113.7')).toBe(true)
        expect(isSelfPeer('other-host', '127.0.1.1')).toBe(true)   // Debian maps the own hostname to 127.0.1.1
        const local = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4')
        if (local) expect(isSelfPeer('other-host', local.address)).toBe(true)
        expect(isSelfPeer('other-host', '203.0.113.7')).toBe(false)
    })
})

describe('startStaticPeers', () => {
    let h: DocHandle<Store>
    const repo = {} as Repo
    let logs: string[]
    let connect: any
    const resolveMap: Record<string, string> = { idea01: '10.0.0.1', 'idea03.local': '10.0.0.3', idea04: '10.0.0.4', me: '10.0.0.99' }
    const resolve = vi.fn(async (host: string) => {
        if (host in resolveMap) return resolveMap[host]
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host
        throw new Error(`getaddrinfo ENOTFOUND ${host}`)
    })
    const isSelf = (host: string) => host === 'me'
    // Stand-in for connectEngine: records the connection under the same ip:port key
    const fakeConnect = async (address: IPAddress, hostname: Hostname, engineId: EngineID, port: PortNumber) => {
        (network.connections as any)[`${address}:${port}`] = { adapter: {} as any, missedDiscoveryCount: 0, hostname, engineId }
    }
    let handle: { stop: () => void } | undefined

    beforeEach(async () => {
        vi.useFakeTimers()
        clearConnections()
        h = await newStore()
        logs = []
        connect = vi.fn(fakeConnect)
        resolve.mockClear()
        handle = undefined
    })
    afterEach(() => {
        handle?.stop()
        vi.useRealTimers()
        clearConnections()
    })

    const start = (raw: string | undefined) => {
        handle = startStaticPeers(repo, h, { raw, defaultPort: 4321, deps: { connect, resolve, isSelf, log: (m: string) => logs.push(m) } })
        return handle
    }

    it('unset or empty: returns undefined, never connects, schedules nothing', async () => {
        const prevEnv = process.env[STATIC_PEERS_ENV]
        delete process.env[STATIC_PEERS_ENV]
        try {
            expect(config.settings.staticPeers).toBeUndefined()
            expect(staticPeersSetting()).toBeUndefined()
            const timersBefore = vi.getTimerCount()
            expect(start(undefined)).toBeUndefined()
            expect(start('')).toBeUndefined()
            expect(start('   ')).toBeUndefined()
            expect(vi.getTimerCount()).toBe(timersBefore)
            await vi.advanceTimersByTimeAsync(60_000)
            expect(connect).not.toHaveBeenCalled()
            expect(logs).toEqual([])
        } finally {
            if (prevEnv !== undefined) process.env[STATIC_PEERS_ENV] = prevEnv
        }
    })

    it('the env var wins over config.yaml settings.staticPeers', () => {
        const prevEnv = process.env[STATIC_PEERS_ENV]
        const prevCfg = config.settings.staticPeers
        try {
            config.settings.staticPeers = 'from-config'
            delete process.env[STATIC_PEERS_ENV]
            expect(staticPeersSetting()).toBe('from-config')
            process.env[STATIC_PEERS_ENV] = 'from-env'
            expect(staticPeersSetting()).toBe('from-env')
        } finally {
            config.settings.staticPeers = prevCfg
            if (prevEnv === undefined) delete process.env[STATIC_PEERS_ENV]; else process.env[STATIC_PEERS_ENV] = prevEnv
        }
    })

    it('only invalid entries: warns, returns undefined, never connects', async () => {
        expect(start('bad host,idea01:0')).toBeUndefined()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(connect).not.toHaveBeenCalled()
        expect(logs).toHaveLength(2)
    })

    it('connectEngine is called once per peer (resolved ip, port, short hostname), then only checked', async () => {
        start('idea01, idea03.local:5000 ,10.0.0.4,idea01')
        await vi.advanceTimersByTimeAsync(0)
        expect(connect).toHaveBeenCalledTimes(3)
        expect(connect.mock.calls.map(c => [c[0], c[1], c[3]])).toEqual([
            ['10.0.0.1', 'idea01', 4321], ['10.0.0.3', 'idea03', 5000], ['10.0.0.4', '10.0.0.4', 4321],
        ])
        await vi.advanceTimersByTimeAsync(STATIC_PEER_CHECK_INTERVAL_MS * 5)
        expect(connect).toHaveBeenCalledTimes(3)
    })

    it('engineId comes from the store record with that hostname, else a static: placeholder that is filled in later', async () => {
        start('idea01')
        await vi.advanceTimersByTimeAsync(0)
        expect(connect.mock.calls[0][2]).toBe('static:idea01')
        const record = { ...JSON.parse(JSON.stringify(h.doc().engineDB[localEngineId])), id: 'ENGINE_idea01', hostname: 'idea01' }
        h.change(doc => { (doc.engineDB as any)['ENGINE_idea01'] = record })
        await vi.advanceTimersByTimeAsync(STATIC_PEER_CHECK_INTERVAL_MS)
        expect((network.connections as any)['10.0.0.1:4321'].engineId).toBe('ENGINE_idea01')
    })

    it('a peer the mDNS path already connected (same ip:port) is not dialled again; its missed count is reset', async () => {
        (network.connections as any)['10.0.0.1:4321'] = { adapter: {} as any, missedDiscoveryCount: 2, hostname: 'idea01', engineId: 'ENGINE_idea01' }
        start('idea01')
        await vi.advanceTimersByTimeAsync(0)
        expect(connect).not.toHaveBeenCalled()
        expect((network.connections as any)['10.0.0.1:4321'].missedDiscoveryCount).toBe(0)
        expect((network.connections as any)['10.0.0.1:4321'].engineId).toBe('ENGINE_idea01')
    })

    it('reconnects after the connection is gone', async () => {
        start('idea01')
        await vi.advanceTimersByTimeAsync(0)
        expect(connect).toHaveBeenCalledTimes(1)
        delete (network.connections as any)['10.0.0.1:4321']        // e.g. disconnectEngine
        await vi.advanceTimersByTimeAsync(STATIC_PEER_CHECK_INTERVAL_MS)
        expect(connect).toHaveBeenCalledTimes(2)
        expect((network.connections as any)['10.0.0.1:4321']).toBeTruthy()
    })

    it('retries failures with backoff (5 s, 10 s, 20 s ...) and resets after a success', async () => {
        connect.mockRejectedValueOnce(new Error('boom 1')).mockRejectedValueOnce(new Error('boom 2')).mockRejectedValueOnce(new Error('boom 3'))
        start('idea01')
        await vi.advanceTimersByTimeAsync(0)
        expect(connect).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(STATIC_PEER_BASE_DELAY_MS - 1)
        expect(connect).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)                              // 5 s
        expect(connect).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(2 * STATIC_PEER_BASE_DELAY_MS - 1)
        expect(connect).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(1)                              // +10 s
        expect(connect).toHaveBeenCalledTimes(3)
        await vi.advanceTimersByTimeAsync(4 * STATIC_PEER_BASE_DELAY_MS)  // +20 s: succeeds
        expect(connect).toHaveBeenCalledTimes(4)
        expect(logs.some(l => l.includes('attempt 3 failed (boom 3); retrying in 20s'))).toBe(true)
        // After a success a later loss reconnects at the next check, not after a long backoff
        delete (network.connections as any)['10.0.0.1:4321']
        await vi.advanceTimersByTimeAsync(STATIC_PEER_CHECK_INTERVAL_MS)
        expect(connect).toHaveBeenCalledTimes(5)
    })

    it('a host that does not resolve is retried with backoff', async () => {
        start('nowhere')
        await vi.advanceTimersByTimeAsync(0)
        expect(resolve).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(STATIC_PEER_BASE_DELAY_MS)
        expect(resolve).toHaveBeenCalledTimes(2)
        expect(connect).not.toHaveBeenCalled()
        expect(logs.some(l => l.includes('ENOTFOUND nowhere'))).toBe(true)
    })

    it('this Engine itself is skipped (and not retried)', async () => {
        start('me,idea01')
        await vi.advanceTimersByTimeAsync(STATIC_PEER_CHECK_INTERVAL_MS * 3)
        expect(connect).toHaveBeenCalledTimes(1)
        expect(connect.mock.calls[0][1]).toBe('idea01')
        expect(logs).toContain('Static peer me:4321 is this Engine — skipped')
    })

    it('stop() cancels all pending attempts', async () => {
        connect.mockRejectedValue(new Error('down'))
        const s = start('idea01')!
        await vi.advanceTimersByTimeAsync(0)
        s.stop()
        await vi.advanceTimersByTimeAsync(STATIC_PEER_BASE_DELAY_MS * 10)
        expect(connect).toHaveBeenCalledTimes(1)
    })
})

describe('connectEngine port (static peers) — default unchanged for mDNS', () => {
    afterEach(() => clearConnections())

    it('without a port the key uses settings.port; with a port, that port', async () => {
        const repo = new Repo({ network: [], storage: undefined })
        const doc = repo.create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await doc.whenReady()
        const storeHandle = doc as DocHandle<Store>
        const defaultPort = config.settings.port || 1234
        // 127.0.0.2 is loopback but not 'localhost'/'127.0.0.1': nothing listens, the adapter just retries
        await connectEngine(repo, '127.0.0.2' as IPAddress, 'peer-a' as Hostname, 'ENGINE_a' as EngineID, doc.documentId)
        await connectEngine(repo, '127.0.0.2' as IPAddress, 'peer-b' as Hostname, 'ENGINE_b' as EngineID, doc.documentId, 45999 as PortNumber)
        expect(Object.keys(network.connections).sort()).toEqual([`127.0.0.2:${defaultPort}`, '127.0.0.2:45999'].sort())
        // A second call for the same key does not add a connection
        await connectEngine(repo, '127.0.0.2' as IPAddress, 'peer-b' as Hostname, 'ENGINE_b' as EngineID, doc.documentId, 45999 as PortNumber)
        expect(Object.keys(network.connections)).toHaveLength(2)
        disconnectEngine(repo, '127.0.0.2' as IPAddress, defaultPort as PortNumber, storeHandle, 'peer-a' as Hostname)
        disconnectEngine(repo, '127.0.0.2' as IPAddress, 45999 as PortNumber, storeHandle, 'peer-b' as Hostname)
        expect(Object.keys(network.connections)).toHaveLength(0)
    })
})
