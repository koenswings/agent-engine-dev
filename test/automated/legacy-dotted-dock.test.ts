/**
 * legacy-dotted-dock.test.ts (idea#494, engine#367)
 *
 * A legacy dotted instance stays listed so removeInstance can clear it, but
 * dock/boot must not compose up, rewrite .env (hostname/ip/port) or allocate
 * a port. Status is Error with the legacy statusCondition. Manual startInstance
 * is refused with the same message, and no compose / .env work runs.
 *
 * Real files on a pretend App Disk under the disks root; startInstance is not
 * reached on dock (the guard returns first).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { disksRoot } from '../../src/data/Config.js'
import { setRootDeviceForTests, processInstance } from '../../src/data/Disk.js'
import { startInstance } from '../../src/data/Instance.js'
import { LEGACY_DOTTED_INSTANCE_MESSAGE, isLegacyDottedInstanceId } from '../../src/utils/instanceIds.js'
import { AppID, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'

const DISK = 'DISK_app' as DiskID
const DEV = 'idea-test-74'
const DOTTED = 'nextcloud-yj8ral61js46bphogbi.backup-20261027-181633' as InstanceID
const STRICT = 'nextcloud-yj8ral61js46bphogbi' as InstanceID
const APP = 'nextcloud-1.0-31.0.1' as AppID

const root = () => `${disksRoot()}/${DEV}`
const instDir = (id: string) => `${root()}/instances/${id}`

const COMPOSE = `x-app:
  name: nextcloud
  version: "1.0-31.0.1"
  instanceName: Nextcloud backup
services:
  app:
    image: nextcloud:31.0.1
`

const ENV = 'port=9980\nhostname=old-host\nip=10.0.0.9\n'

const makeHandle = async (id: InstanceID, status: string = 'Undocked'): Promise<DocHandle<Store>> => {
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
            [id]: {
                id, instanceOf: APP, name: 'Nextcloud backup' as any, status: status as any,
                port: 9980 as any, serviceImages: ['nextcloud:31.0.1'] as any, created: 0 as Timestamp,
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

describe('legacy dotted instances on dock and start (idea#494)', () => {
    beforeEach(async () => {
        setRootDeviceForTests('mmcblk-not-a-test-disk')
        await fs.remove(root())
    })
    afterEach(async () => {
        setRootDeviceForTests(null)
        await fs.remove(root())
    })

    it('processInstance lists a dotted id as Error and does not rewrite .env or allocate a port', async () => {
        await fs.ensureDir(instDir(DOTTED))
        await fs.writeFile(`${instDir(DOTTED)}/compose.yaml`, COMPOSE)
        await fs.writeFile(`${instDir(DOTTED)}/.env`, ENV)
        const h = await makeHandle(DOTTED, 'Undocked')
        const inst = await processInstance(h, h.doc().diskDB[DISK] as any, DOTTED)
        expect(inst).toBeDefined()
        expect(h.doc().instanceDB[DOTTED].status).toBe('Error')
        expect(h.doc().instanceDB[DOTTED].statusCondition).toBe(LEGACY_DOTTED_INSTANCE_MESSAGE)
        expect(await fs.readFile(`${instDir(DOTTED)}/.env`, 'utf8')).toBe(ENV)
        expect(h.doc().instanceDB[DOTTED].port).toBe(9980)
    })

    it('a previously Stopped dotted id is still marked Error on dock, with .env left alone', async () => {
        await fs.ensureDir(instDir(DOTTED))
        await fs.writeFile(`${instDir(DOTTED)}/compose.yaml`, COMPOSE)
        await fs.writeFile(`${instDir(DOTTED)}/.env`, ENV)
        const h = await makeHandle(DOTTED, 'Stopped')
        const inst = await processInstance(h, h.doc().diskDB[DISK] as any, DOTTED)
        expect(inst).toBeDefined()
        expect(h.doc().instanceDB[DOTTED].status).toBe('Error')
        expect(h.doc().instanceDB[DOTTED].statusCondition).toBe(LEGACY_DOTTED_INSTANCE_MESSAGE)
        expect(await fs.readFile(`${instDir(DOTTED)}/.env`, 'utf8')).toBe(ENV)
    })

    it('startInstance of a dotted id is refused with the same message and does not rewrite .env', async () => {
        await fs.ensureDir(instDir(DOTTED))
        await fs.writeFile(`${instDir(DOTTED)}/compose.yaml`, COMPOSE)
        await fs.writeFile(`${instDir(DOTTED)}/.env`, ENV)
        const h = await makeHandle(DOTTED, 'Docked')
        await expect(startInstance(h, h.doc().instanceDB[DOTTED] as any, h.doc().diskDB[DISK] as any, 'console-command'))
            .rejects.toThrow(LEGACY_DOTTED_INSTANCE_MESSAGE)
        expect(h.doc().instanceDB[DOTTED].status).toBe('Error')
        expect(h.doc().instanceDB[DOTTED].statusCondition).toBe(LEGACY_DOTTED_INSTANCE_MESSAGE)
        expect(await fs.readFile(`${instDir(DOTTED)}/.env`, 'utf8')).toBe(ENV)
        expect(h.doc().instanceDB[DOTTED].port).toBe(9980)
    })

    it('a strict id is not treated as legacy', () => {
        expect(isLegacyDottedInstanceId(STRICT)).toBe(false)
        expect(isLegacyDottedInstanceId(DOTTED)).toBe(true)
    })
})
