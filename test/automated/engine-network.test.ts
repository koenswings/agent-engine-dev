/**
 * engine-network.test.ts
 *
 * PR 4 — Engine registration, app distribution, and multi-engine network tests.
 *
 * Three suites at different tiers:
 *
 * ── Suite 1: Engine registration (always runs) ──────────────────────────────
 *   Verifies that the engine correctly registers itself in engineDB when the
 *   store is initialised. No Docker, no network, no disk — pure store assertion.
 *
 *   Store assertions:
 *     engineDB[localEngineId]             exists after createTestStore()
 *     engineDB[localEngineId].id          === localEngineId
 *     engineDB[localEngineId].hostname    is a non-empty string
 *     engineDB[localEngineId].lastBooted  > 0
 *     engineDB[localEngineId].lastHalted  === null (not halted on first boot)
 *     engineDB[localEngineId].version     is a non-empty string
 *     getLocalEngine(store)               returns the registered engine
 *     getRunningEngines(store)            includes the local engine
 *
 * ── Suite 2: App distribution (always runs) ──────────────────────────────────
 *   Verifies assignAppsToEngines() — a pure deterministic function that
 *   round-robins instances across running engines. Tested with synthetic store
 *   data — no network, no Docker.
 *
 *   Assertions:
 *     0 engines → empty Map
 *     1 engine, 3 instances → all 3 assigned to the 1 engine
 *     2 engines, 4 instances → 2 each (deterministic round-robin)
 *     2 engines, 3 instances → 2 and 1
 *     determinism: same inputs always produce the same assignment
 *
 * ── Suite 3: Multi-engine network (skips unless IDEA_NETWORK_TESTS=true) ────
 *   Tests mDNS peer discovery, CRDT state sync across two engines, and
 *   disconnect handling. Requires two engines on the same LAN.
 *
 *   Store assertions (when peers available):
 *     engineDB[remoteEngineId]            appears within mDNS discovery window
 *     getRunningEngines(store)            includes both local and remote engines
 *     remote engineDB[localEngineId]      mirrors local engineDB (CRDT sync)
 *     engineDB[remoteEngineId].lastHalted > lastBooted after peer disconnect
 */

import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { DocHandle } from '@automerge/automerge-repo'
import {
    Store,
    getLocalEngine,
    getRunningEngines,
    assignAppsToEngines,
} from '../../src/data/Store.js'
import { createTestStore } from '../harness/diskSim.js'
import { Engine, localEngineId } from '../../src/data/Engine.js'
import { EngineID, InstanceID } from '../../src/data/CommonTypes.js'

// ── Suite 1: Engine registration ─────────────────────────────────────────────

describe('Engine registration (automated)', () => {
    let storeHandle: DocHandle<Store>

    before(async function () {
        this.timeout(10_000)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
    })

    it('engineDB contains the local engine after store initialisation', function () {
        const store = storeHandle.doc()!
        const engine = store.engineDB[localEngineId as any]
        expect(engine, 'engineDB should contain an entry for localEngineId').to.exist
    })

    it('engine.id matches localEngineId', function () {
        const store = storeHandle.doc()!
        const engine = store.engineDB[localEngineId as any]
        expect(engine.id, 'engine.id should match localEngineId').to.equal(localEngineId)
    })

    it('engine.hostname is a non-empty string', function () {
        const store = storeHandle.doc()!
        const engine = store.engineDB[localEngineId as any]
        expect(engine.hostname, 'hostname should be a non-empty string').to.be.a('string').that.is.not.empty
    })

    it('engine.lastBooted is set to a positive timestamp', function () {
        const store = storeHandle.doc()!
        const engine = store.engineDB[localEngineId as any]
        expect(engine.lastBooted, 'lastBooted should be a positive timestamp').to.be.greaterThan(0)
    })

    it('engine.lastHalted is null on first boot', function () {
        const store = storeHandle.doc()!
        const engine = store.engineDB[localEngineId as any]
        expect(engine.lastHalted, 'lastHalted should be null on first boot').to.be.null
    })

    it('engine.version is a non-empty string', function () {
        const store = storeHandle.doc()!
        const engine = store.engineDB[localEngineId as any]
        expect(engine.version, 'version should be a non-empty string').to.be.a('string').that.is.not.empty
    })

    it('getLocalEngine() returns the registered engine', function () {
        const store = storeHandle.doc()!
        const engine = getLocalEngine(store)
        expect(engine, 'getLocalEngine should return the local engine').to.exist
        expect(engine.id).to.equal(localEngineId)
    })

    it('getRunningEngines() includes the local engine', function () {
        const store = storeHandle.doc()!
        const running = getRunningEngines(store)
        const ids = running.map(e => e.id)
        expect(ids, 'getRunningEngines should include localEngineId').to.include(localEngineId)
    })
})

// ── Suite 2: App distribution ─────────────────────────────────────────────────

describe('App distribution across engines — assignAppsToEngines() (automated)', () => {
    /** Build a minimal synthetic Store for testing the pure function. */
    const makeStore = (engineIds: string[], instanceIds: string[]): Store => {
        const engineDB: any = {}
        engineIds.forEach(id => {
            engineDB[id] = {
                id: id as unknown as EngineID,
                hostname: id,
                version: '0.0.1',
                hostOS: 'Linux',
                created: 1000,
                lastBooted: 2000,
                lastRun: 2000,
                lastHalted: null, // running
                commands: [],
            }
        })
        const instanceDB: any = {}
        instanceIds.forEach(id => { instanceDB[id] = { id } })
        return { engineDB, diskDB: {}, appDB: {}, instanceDB } as Store
    }

    it('returns empty Map when no engines are running', function () {
        const store = makeStore([], ['inst-1', 'inst-2'])
        const result = assignAppsToEngines(store)
        expect(result.size, 'should be empty with no running engines').to.equal(0)
    })

    it('assigns all instances to the single engine when only one engine runs', function () {
        const store = makeStore(['ENGINE_A'], ['inst-1', 'inst-2', 'inst-3'])
        const result = assignAppsToEngines(store)
        expect(result.size).to.equal(1)
        const assigned = result.get('ENGINE_A' as EngineID)!
        expect(assigned, 'all 3 instances should go to the single engine').to.have.lengthOf(3)
        expect(assigned).to.include.members(['inst-1', 'inst-2', 'inst-3'])
    })

    it('distributes evenly across two engines with 4 instances (2 each)', function () {
        const store = makeStore(['ENGINE_A', 'ENGINE_B'], ['inst-1', 'inst-2', 'inst-3', 'inst-4'])
        const result = assignAppsToEngines(store)
        const a = result.get('ENGINE_A' as EngineID)!
        const b = result.get('ENGINE_B' as EngineID)!
        expect(a, 'ENGINE_A should get 2 instances').to.have.lengthOf(2)
        expect(b, 'ENGINE_B should get 2 instances').to.have.lengthOf(2)
        // All instances are covered — no duplicates, no gaps
        expect([...a, ...b].sort()).to.deep.equal(['inst-1', 'inst-2', 'inst-3', 'inst-4'])
    })

    it('handles uneven distribution (3 instances across 2 engines → 2 and 1)', function () {
        const store = makeStore(['ENGINE_A', 'ENGINE_B'], ['inst-1', 'inst-2', 'inst-3'])
        const result = assignAppsToEngines(store)
        const a = result.get('ENGINE_A' as EngineID)!
        const b = result.get('ENGINE_B' as EngineID)!
        expect(a.length + b.length, 'all instances must be assigned').to.equal(3)
        const sizes = [a.length, b.length].sort()
        expect(sizes, 'distribution should be 1 and 2').to.deep.equal([1, 2])
    })

    it('assignment is deterministic — same inputs always produce the same result', function () {
        const store = makeStore(
            ['ENGINE_B', 'ENGINE_A', 'ENGINE_C'],
            ['inst-3', 'inst-1', 'inst-2', 'inst-4']
        )
        const r1 = assignAppsToEngines(store)
        const r2 = assignAppsToEngines(store)
        const r3 = assignAppsToEngines(store)
        // Compare stringified maps for equality
        const serialize = (m: Map<EngineID, InstanceID[]>) =>
            JSON.stringify([...m.entries()].sort(([a], [b]) => a.localeCompare(b)))
        expect(serialize(r1)).to.equal(serialize(r2))
        expect(serialize(r2)).to.equal(serialize(r3))
    })

    it('engines with lastHalted > lastBooted are excluded from assignment', function () {
        // ENGINE_A is halted — only ENGINE_B should receive instances
        const store = makeStore(['ENGINE_A', 'ENGINE_B'], ['inst-1', 'inst-2'])
        // Mark ENGINE_A as halted
        ;(store.engineDB['ENGINE_A'] as any).lastBooted = 1000
        ;(store.engineDB['ENGINE_A'] as any).lastHalted = 2000  // halted AFTER boot
        const result = assignAppsToEngines(store)
        expect(result.has('ENGINE_A' as EngineID), 'halted engine should not appear in result').to.be.false
        const b = result.get('ENGINE_B' as EngineID)!
        expect(b, 'all instances should go to the running engine').to.have.lengthOf(2)
    })
})

// ── Suite 3: Multi-engine network ─────────────────────────────────────────────

describe('Multi-engine network (automated — skips unless IDEA_NETWORK_TESTS=true)', function () {
    before(function () {
        if (process.env.IDEA_NETWORK_TESTS !== 'true') {
            this.skip()
        }
    })

    it('remote engine appears in engineDB within mDNS discovery window', function () {
        // Requires two engines on the same LAN with mDNS advertising enabled.
        // Run with: IDEA_NETWORK_TESTS=true pnpm test:unit
        //
        // Assertion: engineDB[remoteEngineId] exists and hostname is non-empty
        // after a 15 s mDNS discovery window.
        this.skip() // placeholder — implement when second Pi is available
    })

    it('CRDT sync: local diskDB changes appear on remote engine within sync window', function () {
        this.skip() // placeholder
    })

    it('engineDB[remoteEngineId].lastHalted is set after peer disconnect', function () {
        this.skip() // placeholder
    })
})
