/**
 * start-rereads-instanceof.test.ts (idea#473)
 *
 * After a manual rollback (stopInstance, idea-app-data restore-snapshot,
 * startInstance) the instance folder has the older compose.yaml but the store
 * still named the newer instanceOf. startInstance must re-read x-app through
 * createOrUpdateInstance (no direct store edit) before it starts.
 *
 * Real compose.yaml on a pretend disk under the disks root; no Docker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { disksRoot } from '../../src/data/Config.js'
import { setRootDeviceForTests } from '../../src/data/Disk.js'
import { refreshInstanceFromCompose, startInstance } from '../../src/data/Instance.js'
import { AppID, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'

const DISK = 'DISK_app' as DiskID
const DEV = 'idea-test-73'
const INST = 'nextcloud-abc123xyz' as InstanceID
const NEW_APP = 'nextcloud-1.0-31.0.1' as AppID
const OLD_APP = 'nextcloud-1.0-30.0.0' as AppID

const root = () => `${disksRoot()}/${DEV}`

const compose = (version: string) => `x-app:
  name: nextcloud
  version: "${version}"
  instanceName: Nextcloud
services:
  app:
    image: nextcloud:${version}
`

const makeHandle = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {},
        diskDB: {
            [DISK]: {
                id: DISK, name: 'app-disk' as DiskName, device: DEV as any,
                dockedTo: localEngineId, created: 0 as Timestamp, lastDocked: 0 as Timestamp,
                diskTypes: ['app'], backupConfig: null,
            },
        },
        appDB: {},
        instanceDB: {
            [INST]: {
                id: INST, instanceOf: NEW_APP, name: 'Nextcloud' as any, status: 'Stopped',
                port: 0 as any, serviceImages: ['nextcloud:31.0.1'] as any, created: 0 as Timestamp,
                lastBackup: null, lastStarted: 0 as Timestamp, statusCondition: null,
                storedOn: DISK, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            },
        },
        userDB: {}, operationDB: {},
    })
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId as EngineID)
    return h
}

describe('startInstance re-reads instanceOf from compose.yaml (idea#473)', () => {
    let h: DocHandle<Store>
    beforeEach(async () => {
        setRootDeviceForTests('mmcblk-not-a-test-disk')
        await fs.remove(root())
        await fs.ensureDir(`${root()}/instances/${INST}`)
        // Restored older files: compose names 1.0-30.0.0, store still has 1.0-31.0.1
        await fs.writeFile(`${root()}/instances/${INST}/compose.yaml`, compose('1.0-30.0.0'))
        h = await makeHandle()
    })
    afterEach(async () => {
        setRootDeviceForTests(null)
        await fs.remove(root())
    })

    it('refreshInstanceFromCompose updates instanceOf to the restored x-app version and keeps Stopped', async () => {
        const inst = h.doc().instanceDB[INST]
        expect(inst.instanceOf).toBe(NEW_APP)
        const out = await refreshInstanceFromCompose(h, inst as any, h.doc().diskDB[DISK] as any)
        expect(out.instanceOf).toBe(OLD_APP)
        const rec = h.doc().instanceDB[INST]
        expect(rec.instanceOf).toBe(OLD_APP)
        expect(rec.status).toBe('Stopped')
        expect([...rec.serviceImages]).toEqual(['nextcloud:1.0-30.0.0'])
        expect(rec.name).toBe('Nextcloud')
    })

    it('startInstance calls refreshInstanceFromCompose before any start work', () => {
        const src = fs.readFileSync('src/data/Instance.ts', 'utf8')
        // The wrapper refreshes first, then hands the updated record to the tracked start.
        expect(src).toMatch(/const inst = await refreshInstanceFromCompose\(storeHandle, instance, disk\)/)
        expect(src).toMatch(/return startInstanceTracked\(storeHandle, inst, disk, cause\)/)
        expect(startInstance.name).toBe('startInstance')
    })
})
