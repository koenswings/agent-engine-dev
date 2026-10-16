/**
 * install-github-registers.test.ts (idea#168 r81 FAIL@91)
 *
 * installApp's GitHub route (no usable --source bundle, internet up) called buildInstance and
 * returned. buildInstance only writes apps/<appId> and instances/<id> on the disk, so the new
 * instance never reached instanceDB and was never started: no row, no container, until the
 * disk happened to be re-docked. On the pool (Engine 363cb7b, idea03) step 88 install_app built
 * kolibri-x18emc9p8bqqkhrmxjw on duration-empty-001 and nothing else happened.
 *
 * The GitHub route must register the app + instance and start it (processInstance), like the
 * local route, and a failed build must end the command as an error instead of a silent ok.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DeviceName, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'

const built = { result: 'kolibri-test1234' as string | undefined }
vi.mock('../../src/data/Instance.js', async (orig) => {
    const real: any = await orig()
    return { ...real, buildInstance: vi.fn(async () => built.result) }
})
const processInstance = vi.fn(async () => undefined)
vi.mock('../../src/data/Disk.js', async (orig) => {
    const real: any = await orig()
    return { ...real, processInstance }
})
const createOrUpdateApp = vi.fn(async () => undefined)
vi.mock('../../src/data/App.js', async (orig) => {
    const real: any = await orig()
    return { ...real, createOrUpdateApp }
})

const InstallApp = await import('../../src/data/InstallApp.js')
const LOCAL = localEngineId as EngineID

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    h.change(doc => {
        doc.diskDB['empty-001' as DiskID] = {
            id: 'empty-001' as DiskID, name: 'Empty 001' as DiskName, device: 'idea-test-gh1' as DeviceName,
            dockedTo: LOCAL, created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: ['empty'], backupConfig: null,
        } as any
    })
    return h
}

describe('installApp GitHub route registers and starts the new instance (idea#168 r81)', () => {
    beforeEach(() => {
        processInstance.mockClear(); createOrUpdateApp.mockClear(); built.result = 'kolibri-test1234'
        process.env.IDEA_INSTALL_FORCE_ONLINE = 'true'
    })
    afterAll(() => { delete process.env.IDEA_INSTALL_FORCE_ONLINE })

    it('after a successful build: createOrUpdateApp + processInstance(targetDisk, builtId)', async () => {
        const h = await newStore()
        await InstallApp.installApp(h, { appId: 'kolibri-1.0' as any, targetDiskId: 'empty-001' })
        expect(createOrUpdateApp).toHaveBeenCalledWith(h, 'kolibri-1.0', expect.objectContaining({ id: 'empty-001' }))
        expect(processInstance).toHaveBeenCalledTimes(1)
        expect(processInstance).toHaveBeenCalledWith(h, expect.objectContaining({ id: 'empty-001' }), 'kolibri-test1234')
    })

    it('a failed build ends the command as an error, never a silent ok', async () => {
        const h = await newStore()
        built.result = undefined
        await expect(InstallApp.installApp(h, { appId: 'kolibri-1.0' as any, targetDiskId: 'empty-001' }))
            .rejects.toThrow(/GitHub build of 'kolibri-1.0' .* failed/)
        expect(processInstance).not.toHaveBeenCalled()
    })
})
