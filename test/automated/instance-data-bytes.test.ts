/**
 * instance-data-bytes.test.ts: Instance.dataBytes / dataBytesAt (engine#430).
 *
 * The App data size per instance is measured by the existing `idea-app-data size`
 * (instanceDataBytes) at low priority, after the dock pass, after each successful
 * backup and every 24 h; never while the instance is locked; written only on a change
 * of more than max(5%, 100 MB), rounded to whole MB. A failure keeps the stored value.
 * The runner is injected, so no sudo or helper runs here.
 */
import { describe, it, expect, vi } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { EngineID, InstanceID } from '../../src/data/CommonTypes.js'
import {
    shouldWriteDataBytes, roundDataBytes, measureInstanceDataBytes, DataBytesQueue,
    requestDataBytesForDisk, instancesDockedOn, DATA_BYTES_MIN_CHANGE,
} from '../../src/data/DataBytes.js'
import { lowPriorityAppDataArgv, APP_DATA_HELPER, appDataSudoArgv } from '../../src/utils/appDataHelper.js'
import { resourceLock, instanceKey, diskKey } from '../../src/utils/ResourceLock.js'

const E = 'engine-idea03' as EngineID
const OTHER = 'engine-idea04' as EngineID
const MB = 1_000_000
const disk = (id: string, dockedTo: EngineID | null = E, device: string | null = 'sdb1') =>
    ({ id, name: id, device, created: 0, lastDocked: 0, dockedTo, diskTypes: ['app'], backupConfig: null })
const instance = (id: string, storedOn: string, extra: Record<string, unknown> = {}) => ({
    id, instanceOf: 'nextcloud', name: id, status: 'Running', statusCondition: null, port: 8080, serviceImages: [],
    created: 0, lastBackup: null, lastStarted: 0, storedOn, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
    ...extra,
})

const makeStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, appDB: {}, userDB: {}, operationDB: {},
        diskDB: { d1: disk('d1'), d2: disk('d2'), far: disk('far', OTHER), gone: disk('gone', null, null) } as any,
        instanceDB: {
            'nc-a': instance('nc-a', 'd1'),
            'kolibri-b': instance('kolibri-b', 'd1'),
            'wbo-c': instance('wbo-c', 'd2'),
            'nc-far': instance('nc-far', 'far'),
            'nc-gone': instance('nc-gone', 'gone', { dataBytes: 5_000 * MB, dataBytesAt: 1 }),
        } as any,
    } as any)
    await h.whenReady()
    return h
}
const bytesOf = (h: DocHandle<Store>, id: string) => h.doc().instanceDB[id as InstanceID].dataBytes
const atOf = (h: DocHandle<Store>, id: string) => h.doc().instanceDB[id as InstanceID].dataBytesAt

/** A fake helper runner: `size <root> <id>` prints KiB (du -sk) from the table. */
const fakeRunner = (kib: Record<string, number>) => vi.fn(async (args: string[]) => {
    expect(args[0]).toBe('size')
    const v = kib[args[2]]
    if (v == null) throw new Error(`idea-app-data size exited with code 1: no such instance ${args[2]}`)
    return `${v}\n`
})
const rootOf = async () => 'sdb1'

describe('shouldWriteDataBytes (engine#430 write rule)', () => {
    it('always writes a first value', () => {
        expect(shouldWriteDataBytes(null, 0)).toBe(true)
        expect(shouldWriteDataBytes(undefined, 12 * MB)).toBe(true)
    })
    it('below 2 GB the 100 MB floor applies; above it 5%', () => {
        expect(shouldWriteDataBytes(1_000 * MB, 1_100 * MB)).toBe(false)     // exactly 100 MB: not more
        expect(shouldWriteDataBytes(1_000 * MB, 1_101 * MB)).toBe(true)
        expect(shouldWriteDataBytes(1_000 * MB, 899 * MB)).toBe(true)        // shrinking counts too
        expect(shouldWriteDataBytes(0, DATA_BYTES_MIN_CHANGE)).toBe(false)
        expect(shouldWriteDataBytes(40_000 * MB, 41_900 * MB)).toBe(false)   // 1.9 GB < 5% of 40 GB
        expect(shouldWriteDataBytes(40_000 * MB, 42_001 * MB)).toBe(true)
    })
    it('rounds to whole MB', () => {
        expect(roundDataBytes(1_499_999)).toBe(1 * MB)
        expect(roundDataBytes(1_500_000)).toBe(2 * MB)
        expect(roundDataBytes(0)).toBe(0)
    })
})

describe('low-priority helper argv (engine#430)', () => {
    it('wraps the unchanged sudo argv in nice -n 19 ionice -c3', () => {
        const args = ['size', 'sdb1', 'nc-a']
        expect(lowPriorityAppDataArgv(args)).toEqual(['-n', '19', 'ionice', '-c3', 'sudo', '-n', APP_DATA_HELPER, 'size', 'sdb1', 'nc-a'])
        // What sudo receives (so the sudoers match) is exactly runAppData's argv.
        expect(lowPriorityAppDataArgv(args).slice(5)).toEqual(appDataSudoArgv(args))
    })
})

describe('dock pass trigger (engine#430)', () => {
    it('measures each instance on the docked disk, one at a time, and stores rounded bytes', async () => {
        const h = await makeStore()
        let inFlight = 0
        let maxInFlight = 0
        const kib: Record<string, number> = { 'nc-a': 2_000_000, 'kolibri-b': 300 }
        const run = vi.fn(async (args: string[]) => {
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise(r => setTimeout(r, 5))
            inFlight--
            return `${kib[args[2]]}\n`
        })
        const q = new DataBytesQueue({ engineId: E, run, rootOf, now: () => 1234 })
        const ids = requestDataBytesForDisk(h, 'd1', E, q)
        expect(ids.sort()).toEqual(['kolibri-b', 'nc-a'])
        await q.idle()
        expect(run).toHaveBeenCalledTimes(2)
        expect(maxInFlight).toBe(1)
        expect(bytesOf(h, 'nc-a')).toBe(roundDataBytes(2_000_000 * 1024))   // 2048 MB
        expect(bytesOf(h, 'kolibri-b')).toBe(0)                               // 307 kB rounds to 0 MB
        expect(atOf(h, 'nc-a')).toBe(1234)
        expect(bytesOf(h, 'wbo-c')).toBeUndefined()                           // another disk: not this pass
        q.stop()
    })

    it('does nothing for a disk docked to another Engine', async () => {
        const h = await makeStore()
        const run = fakeRunner({ 'nc-far': 10 })
        const q = new DataBytesQueue({ engineId: E, run, rootOf })
        expect(requestDataBytesForDisk(h, 'far', E, q)).toEqual([])
        expect(await measureInstanceDataBytes(h, 'nc-far' as InstanceID, { engineId: E, run, rootOf })).toBe('not-docked')
        expect(run).not.toHaveBeenCalled()
    })

    it('the 24 h pass covers every instance on disks docked here, not undocked ones', async () => {
        const h = await makeStore()
        expect(instancesDockedOn(h.doc(), E).sort()).toEqual(['kolibri-b', 'nc-a', 'wbo-c'])
    })

    it('writes again only past the threshold, keeping dataBytesAt of the last write', async () => {
        const h = await makeStore()
        const kib: Record<string, number> = { 'nc-a': 1_000_000 }   // 1024 MB
        let t = 100
        const opts = { engineId: E, run: vi.fn(async (a: string[]) => `${kib[a[2]]}\n`), rootOf, now: () => t }
        expect(await measureInstanceDataBytes(h, 'nc-a' as InstanceID, opts)).toBe('written')
        kib['nc-a'] = 1_050_000; t = 200                              // +51 MB: under 100 MB
        expect(await measureInstanceDataBytes(h, 'nc-a' as InstanceID, opts)).toBe('unchanged')
        expect(bytesOf(h, 'nc-a')).toBe(roundDataBytes(1_000_000 * 1024))
        expect(atOf(h, 'nc-a')).toBe(100)
        kib['nc-a'] = 1_200_000; t = 300                              // +205 MB
        expect(await measureInstanceDataBytes(h, 'nc-a' as InstanceID, opts)).toBe('written')
        expect(bytesOf(h, 'nc-a')).toBe(roundDataBytes(1_200_000 * 1024))
        expect(atOf(h, 'nc-a')).toBe(300)
    })
})

describe('locks (engine#430)', () => {
    it('a held instance lock skips the measurement; it runs at the next chance', async () => {
        const h = await makeStore()
        const run = fakeRunner({ 'nc-a': 500_000 })
        const q = new DataBytesQueue({ engineId: E, run, rootOf, retryMs: 20 })
        expect(resourceLock.acquire(instanceKey('nc-a'), 'backupApp')).toBe(true)
        try {
            q.request(h, ['nc-a' as InstanceID])
            await q.idle()
            expect(run).not.toHaveBeenCalled()
            expect(bytesOf(h, 'nc-a')).toBeUndefined()
            expect(q.waitingIds()).toEqual(['nc-a'])
        } finally {
            resourceLock.release(instanceKey('nc-a'))
        }
        await vi.waitFor(() => expect(bytesOf(h, 'nc-a')).toBe(roundDataBytes(500_000 * 1024)), { timeout: 2000, interval: 10 })
        expect(run).toHaveBeenCalledTimes(1)
        expect(q.waitingIds()).toEqual([])
        q.stop()
    })

    it('a held disk lock skips too', async () => {
        const h = await makeStore()
        const run = fakeRunner({ 'wbo-c': 10 })
        expect(resourceLock.acquire(diskKey('d2'), 'createFilesDisk')).toBe(true)
        try {
            expect(await measureInstanceDataBytes(h, 'wbo-c' as InstanceID, { engineId: E, run, rootOf })).toBe('locked')
            expect(run).not.toHaveBeenCalled()
        } finally {
            resourceLock.release(diskKey('d2'))
        }
    })
})

describe('failure (engine#430)', () => {
    it('a helper failure keeps the stored value and dataBytesAt', async () => {
        const h = await makeStore()
        h.change(doc => { const i = doc.instanceDB['nc-a' as InstanceID]; i.dataBytes = 7_000 * MB; i.dataBytesAt = 42 as any })
        const run = vi.fn(async () => { throw new Error('idea-app-data size refused: unknown subcommand') })
        expect(await measureInstanceDataBytes(h, 'nc-a' as InstanceID, { engineId: E, run, rootOf })).toBe('failed')
        expect(bytesOf(h, 'nc-a')).toBe(7_000 * MB)
        expect(atOf(h, 'nc-a')).toBe(42)
        expect(String(h.doc().instanceDB['nc-a' as InstanceID].status)).toBe('Running')
    })

    it('a never-measured instance stays null/absent when the helper gives no size', async () => {
        const h = await makeStore()
        const run = vi.fn(async () => 'usage: idea-app-data …\n')
        expect(await measureInstanceDataBytes(h, 'kolibri-b' as InstanceID, { engineId: E, run, rootOf })).toBe('failed')
        expect(bytesOf(h, 'kolibri-b') ?? null).toBeNull()
    })

    it('one failure does not stop the queue', async () => {
        const h = await makeStore()
        const run = fakeRunner({ 'kolibri-b': 100_000 })   // nc-a fails
        const q = new DataBytesQueue({ engineId: E, run, rootOf })
        q.request(h, ['nc-a' as InstanceID, 'kolibri-b' as InstanceID])
        await q.idle()
        expect(bytesOf(h, 'nc-a')).toBeUndefined()
        expect(bytesOf(h, 'kolibri-b')).toBe(roundDataBytes(100_000 * 1024))
        q.stop()
    })
})
