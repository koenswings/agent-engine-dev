/**
 * store-port-owner.test.ts (idea#168 r35): at start the Engine never picks a
 * port that another instance in the store owns on this engine, in addition to
 * the netstat check.
 *
 * r35: copyApp copied the original's .env (port=18080) and started the copy
 * while the original was stopped for the snapshot, so netstat saw 18080 free
 * and the copy took the original's port. choosePortForStart now also checks
 * storePortOwner; createPortNumber (fresh ports) already skipped store-owned
 * ports. Real .env files in a temp folder; no Docker.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'

// Port candidates are made deterministic per test (zx also uses Math.random)
vi.mock('../../src/utils/utils.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, randomPort: vi.fn(actual.randomPort) }
})
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'
import os from 'os'
import path from 'path'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { choosePortForStart, storePortOwner, createPortNumber, Instance } from '../../src/data/Instance.js'
import { randomPort } from '../../src/utils/utils.js'
import { freeTcpPort } from '../harness/hostEnv.js'

const LOCAL = localEngineId as EngineID
const OTHER = 'ENGINE_other-engine-000000' as EngineID

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}
const addDisk = (h: DocHandle<Store>, id: string, dockedTo: EngineID) => {
    h.change(doc => {
        doc.diskDB[id as DiskID] = {
            id: id as DiskID, name: id as DiskName, device: `idea-test-${id}` as DeviceName, dockedTo,
            created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: ['app'], backupConfig: null,
        } as any
    })
}
const addInstance = (h: DocHandle<Store>, id: string, opts: { storedOn: string, port: number, status: string, created: number, name?: string }) => {
    h.change(doc => {
        doc.instanceDB[id as InstanceID] = {
            id, name: opts.name ?? 'kolibri', storedOn: opts.storedOn, instanceOf: 'kolibri-1.0',
            port: opts.port, status: opts.status, created: opts.created,
        } as any
    })
}
const inst = (h: DocHandle<Store>, id: string): Instance => h.doc()!.instanceDB[id as InstanceID] as Instance

describe('storePortOwner / choosePortForStart (idea#168 r35)', () => {
    let h: DocHandle<Store>
    let dir: string
    let envPath: string

    beforeEach(async () => {
        h = await newStore()
        addDisk(h, 'd-src', LOCAL)
        addDisk(h, 'd-tgt', LOCAL)
        addDisk(h, 'd-far', OTHER)
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-port-owner-'))
        envPath = path.join(dir, '.env')
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.remove(dir)
    })

    it('a copy whose .env still says the original\'s port moves off it while the original is STOPPED', async () => {
        addInstance(h, 'orig', { storedOn: 'd-src', port: 18080, status: 'Stopped', created: 100 })
        addInstance(h, 'copy', { storedOn: 'd-tgt', port: 0, status: 'Docked', created: 200, name: 'kolibri-2' })
        await fs.writeFile(envPath, 'port=18080\npass=x\n')
        expect(storePortOwner(h.doc()!, inst(h, 'copy'), 18080)?.id).toBe('orig')
        const port = await choosePortForStart(h, inst(h, 'copy'), envPath)
        expect(port).not.toBe(18080)
        expect(port).toBeGreaterThanOrEqual(49152)
        expect(await fs.readFile(envPath, 'utf8')).toContain(`port=${port}`)
        expect(await fs.readFile(envPath, 'utf8')).toContain('pass=x')
    })

    // "Keeps its port" needs a port that is free on this machine: 18080 is in use on a pool
    // Pi (on-Pi triage idea04 2026-10-25), so these two take a port that is free right now.
    it('two records claiming one port (pre-fix data): the older keeps it, the newer moves', async () => {
        const P = await freeTcpPort()
        addInstance(h, 'orig', { storedOn: 'd-src', port: P, status: 'Docked', created: 100 })
        addInstance(h, 'stale-copy', { storedOn: 'd-tgt', port: P, status: 'Docked', created: 200 })
        expect(storePortOwner(h.doc()!, inst(h, 'orig'), P)).toBeUndefined()
        expect(storePortOwner(h.doc()!, inst(h, 'stale-copy'), P)?.id).toBe('orig')
        await fs.writeFile(envPath, `port=${P}\n`)
        expect(await choosePortForStart(h, inst(h, 'orig'), envPath)).toBe(P)
    })

    it('a Running claimant owns the port even when it is the newer record', async () => {
        addInstance(h, 'orig', { storedOn: 'd-src', port: 18080, status: 'Docked', created: 100 })
        addInstance(h, 'copy', { storedOn: 'd-tgt', port: 18080, status: 'Running', created: 200 })
        expect(storePortOwner(h.doc()!, inst(h, 'orig'), 18080)?.id).toBe('copy')
    })

    it('only instances on this engine count: a port owned on another engine is kept', async () => {
        const P = await freeTcpPort()
        addInstance(h, 'far', { storedOn: 'd-far', port: P, status: 'Running', created: 1 })
        addInstance(h, 'mine', { storedOn: 'd-src', port: P, status: 'Docked', created: 100 })
        expect(storePortOwner(h.doc()!, inst(h, 'mine'), P)).toBeUndefined()
        await fs.writeFile(envPath, `port=${P}\n`)
        expect(await choosePortForStart(h, inst(h, 'mine'), envPath)).toBe(P)
    })

    it('no port in .env (a copy): createPortNumber skips a store-owned port', async () => {
        addInstance(h, 'nc', { storedOn: 'd-tgt', port: 50000, status: 'Stopped', created: 1, name: 'nextcloud' })
        addInstance(h, 'copy', { storedOn: 'd-tgt', port: 0, status: 'Docked', created: 200, name: 'kolibri-2' })
        await fs.writeFile(envPath, 'pass=x\n')
        vi.mocked(randomPort).mockReturnValueOnce(50000 as any).mockReturnValueOnce(50001 as any)
        const port = await choosePortForStart(h, inst(h, 'copy'), envPath)
        expect(port).toBe(50001)
        expect(await fs.readFile(envPath, 'utf8')).toContain('port=50001')
    })

    it('createPortNumber never returns a port another instance on this engine stores', async () => {
        addInstance(h, 'nc', { storedOn: 'd-src', port: 50010, status: 'Stopped', created: 1 })
        vi.mocked(randomPort).mockReturnValueOnce(50010 as any).mockReturnValueOnce(50011 as any)
        expect(await createPortNumber(h.doc()!)).toBe(50011)
    })
})
