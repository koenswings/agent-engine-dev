/**
 * undock-pending-no-autostart.test.ts (engine#535, Markov seed 42 FAIL@306 on idea03)
 *
 * A spurious udev re-add right after an eject starts a dock pass that walks the disk's instances
 * one after the other. The next eject waited for the start in flight, returned, and the dock pass
 * then began the NEXT instance's start: image load + .env writes on the disk while umount ran
 * ("target is busy", disk left mounted, dockedTo=null). While an undock of the disk is pending the
 * dock pass must not begin another auto-start.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { disksRoot } from '../../src/data/Config.js'
import { setRootDeviceForTests, processInstance } from '../../src/data/Disk.js'
import { markUndockPending, resetUndockPendingForTests } from '../../src/data/InstanceInFlight.js'
import { AppID, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'

const DISK = 'duration-empty-001' as DiskID
const DEV = 'idea-test-535'
const ID = 'kolibri-0mr83b9elkxc53qw2wk' as InstanceID
const root = () => `${disksRoot()}/${DEV}`
const instDir = () => `${root()}/instances/${ID}`
const ENV = 'port=61148\nhostname=old-host\nip=10.0.0.9\n'
const COMPOSE = `x-app:
  name: kolibri
  version: "1.0"
  instanceName: Kolibri
services:
  app:
    image: koenswings/kolibri:1.0
`

const makeHandle = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {},
        diskDB: {
            [DISK]: {
                id: DISK, name: 'Empty Disk 001' as DiskName, device: DEV as any,
                dockedTo: localEngineId, created: 0 as Timestamp, lastDocked: 0 as Timestamp,
                diskTypes: ['app'], backupConfig: null,
            },
        },
        appDB: {},
        instanceDB: {
            [ID]: {
                id: ID, instanceOf: 'kolibri-1.0' as AppID, name: 'Kolibri' as any, status: 'Undocked' as any,
                port: 61148 as any, serviceImages: ['koenswings/kolibri:1.0'] as any, created: 0 as Timestamp,
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

describe('dock pass vs a pending undock (engine#535)', () => {
    beforeEach(async () => {
        setRootDeviceForTests('mmcblk-not-a-test-disk')
        resetUndockPendingForTests()
        await fs.remove(root())
        await fs.ensureDir(instDir())
        await fs.writeFile(`${instDir()}/compose.yaml`, COMPOSE)
        await fs.writeFile(`${instDir()}/.env`, ENV)
    })
    afterEach(async () => {
        setRootDeviceForTests(null)
        resetUndockPendingForTests()
        await fs.remove(root())
    })

    it('does not begin an auto-start while an undock of the disk is pending: no Starting, no step, .env untouched', async () => {
        const h = await makeHandle()
        markUndockPending(String(DISK))
        const inst = await processInstance(h, h.doc().diskDB[DISK] as any, ID)
        expect(inst).toBeDefined()
        const row = h.doc().instanceDB[ID]
        expect(row.status).toBe('Docked')
        expect(row.currentStep ?? null).toBeNull()
        expect(Object.values(h.doc().operationDB ?? {}).filter((o: any) => o.kind === 'startApp' || o.type === 'startApp')).toHaveLength(0)
        expect(await fs.readFile(`${instDir()}/.env`, 'utf8')).toBe(ENV)
    })
})
