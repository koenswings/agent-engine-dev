/**
 * in-flight-marker-guard.test.ts — engine#497 stage 2: every Engine skips registering or
 * starting an instance folder that has a sibling instances/<id>.idea-op-in-flight marker;
 * only the op that owns the marker continues. Real Disk.processInstance and
 * Instance.startInstance on a simulated disk (IDEA_DISKS_ROOT, test/harness/diskSim.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { fs } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk, processInstance } from '../../src/data/Disk.js'
import { startInstance } from '../../src/data/Instance.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const ID = 'copyx1' as InstanceID
const OP = 'Ab3dEf5hJk7mNp9qRs1'
let device: string
let handle: DocHandle<Store>
let disk: Disk

beforeEach(async () => {
    device = uniqueTestDevice()
    const inst = `${DISKS_ROOT}/${device}/instances/${ID}`
    await fs.ensureDir(inst)
    await fs.writeFile(`${inst}/compose.yaml`, 'services:\n  web:\n    image: nginx:1\nx-app:\n  instanceName: copyx\n')
    await fs.writeFile(`${DISKS_ROOT}/${device}/instances/${ID}.idea-op-in-flight`, `opId=${OP}\nengineId=${localEngineId}\ncreated=2026-11-17T09:00:00Z\n`)
    const repo = new Repo({ network: [], storage: undefined })
    disk = {
        id: 'DISK_guard' as DiskID, name: 'guard-disk' as DiskName, device: device as any, dockedTo: localEngineId,
        created: 0 as Timestamp, lastDocked: 0 as Timestamp, diskTypes: ['app'], backupConfig: null,
    } as Disk
    handle = repo.create<Store>({ engineDB: {}, diskDB: { [disk.id]: disk }, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await handle.whenReady()
    await createOrUpdateEngine(handle, localEngineId)
})
afterEach(async () => { await fs.remove(`${DISKS_ROOT}/${device}`) })

describe('engine#497: the in-flight marker blocks registration and start', () => {
    it('a dock scan (no op id) does not register the marked folder', async () => {
        expect(await processInstance(handle, disk, ID)).toBeUndefined()
        expect(handle.doc().instanceDB[ID]).toBeUndefined()
    })

    it('another op is refused loudly (IN_FLIGHT, names the owning op and Engine)', async () => {
        await expect(processInstance(handle, disk, ID, { inFlightOpId: 'Zz9yXw8vUt7sRq6pOn5' }))
            .rejects.toThrow(new RegExp(`IN_FLIGHT: instances/${ID} is being copied by operation ${OP} of Engine ${localEngineId}`))
        expect(handle.doc().instanceDB[ID]).toBeUndefined()
    })

    it('startInstance refuses a marked folder (an operator start or an auto-start)', async () => {
        const inst = { id: ID, name: 'copyx', storedOn: disk.id, status: 'Docked', instanceOf: 'nginx-1' } as any
        await expect(startInstance(handle, inst, disk, 'console-command')).rejects.toThrow(/startInstance: IN_FLIGHT: /)
    })

    it('without the marker nothing is refused by this guard', async () => {
        await fs.remove(`${DISKS_ROOT}/${device}/instances/${ID}.idea-op-in-flight`)
        const { inFlightRefusal } = await import('../../src/data/InFlight.js')
        expect(await inFlightRefusal(`${DISKS_ROOT}/${device}`, ID)).toBeNull()
    })
})
