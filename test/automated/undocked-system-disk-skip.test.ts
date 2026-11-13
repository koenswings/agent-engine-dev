/**
 * undocked-system-disk-skip.test.ts — idea#449: an instance on the system disk is never
 * left Starting when systemDiskSkip means no dock pass follows the boot.
 *
 * idea03 (11 Nov 2026): checkAndSetUndockedApps marked the healthy hub Starting "until the
 * dock pass checks it", but config.yaml systemDiskSkip: true skipped the system disk's dock
 * pass, so nothing set it Running again; later boots could not heal it either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { fs, path } from 'zx'
import { Store } from '../../src/data/Store.js'
import { checkAndSetUndockedApps, dockPassWillRun, isSystemDiskMarked } from '../../src/data/UndockedApps.js'
import { EngineID, InstanceID } from '../../src/data/CommonTypes.js'
import { systemDiskSkipSource } from '../../src/data/Config.js'

const E = 'engine-idea03' as EngineID
const HUB = 'usage-dashboard-8fhwrslsrq78xtswed4'
const disk = (id: string, types: string[]) => ({ id, name: id, device: 'sda2', created: 0, lastDocked: 0, dockedTo: E, diskTypes: types, backupConfig: null })
const instance = (id: string, storedOn: string, status: string, lastStarted = 1794395811913) => ({
    id, instanceOf: 'usage-dashboard', name: id, status, statusCondition: null, port: 8080, serviceImages: [],
    created: 0, lastBackup: null, lastStarted, storedOn, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
})

const makeStore = async (hubStatus: string): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, appDB: {}, userDB: {}, operationDB: {},
        diskDB: { sys: disk('sys', ['system', 'app']), diskb: disk('diskb', ['app']) } as any,
        instanceDB: {
            [HUB]: instance(HUB, 'sys', hubStatus),
            'nextcloud-files-b-001': instance('nextcloud-files-b-001', 'diskb', 'Running'),
        } as any,
    } as any)
    await h.whenReady()
    return h
}
const status = (h: DocHandle<Store>, id: string) => String(h.doc().instanceDB[id as InstanceID].status)
const allRunning = vi.fn(async (_id: InstanceID) => true)

describe('checkAndSetUndockedApps with systemDiskSkip (idea#449)', () => {
    it('a Running system-disk instance with containers is NOT marked Starting when no dock pass follows; App Disk instances still are', async () => {
        const h = await makeStore('Running')
        const healthy = vi.fn(async () => true)
        await checkAndSetUndockedApps(h, E, allRunning, { systemDiskSkip: true, containersHealthy: healthy })
        expect(status(h, HUB)).toBe('Running')
        expect(status(h, 'nextcloud-files-b-001')).toBe('Starting')   // its dock pass still runs
        expect(healthy).not.toHaveBeenCalled()
    })

    it('without systemDiskSkip the system-disk instance is marked Starting as before (its dock pass will check it)', async () => {
        const h = await makeStore('Running')
        await checkAndSetUndockedApps(h, E, allRunning, { systemDiskSkip: false, containersHealthy: async () => true })
        expect(status(h, HUB)).toBe('Starting')
    })

    it('heals an instance left Starting by an earlier boot when its containers are up and healthy; lastStarted is refreshed, nothing restarted', async () => {
        const h = await makeStore('Starting')
        const before = Date.now()
        const healthy = vi.fn(async () => true)
        await checkAndSetUndockedApps(h, E, allRunning, { systemDiskSkip: true, containersHealthy: healthy })
        expect(status(h, HUB)).toBe('Running')
        expect(Number(h.doc().instanceDB[HUB as InstanceID].lastStarted)).toBeGreaterThanOrEqual(before)
        expect(healthy).toHaveBeenCalledWith(HUB)
    })

    it('leaves it Starting when the containers are not all healthy, or the health cannot be read', async () => {
        const h = await makeStore('Starting')
        await checkAndSetUndockedApps(h, E, allRunning, { systemDiskSkip: true, containersHealthy: async () => false })
        expect(status(h, HUB)).toBe('Starting')
        await checkAndSetUndockedApps(h, E, allRunning, { systemDiskSkip: true, containersHealthy: async () => { throw new Error('docker down') } })
        expect(status(h, HUB)).toBe('Starting')
        expect(Number(h.doc().instanceDB[HUB as InstanceID].lastStarted)).toBe(1794395811913)
    })

    it('docker not answering: a system-disk instance is not marked Starting when no dock pass follows', async () => {
        const h = await makeStore('Running')
        const failing = vi.fn(async () => { throw new Error('Cannot connect to the Docker daemon') })
        await checkAndSetUndockedApps(h, E, failing, { systemDiskSkip: true, containersHealthy: async () => true })
        expect(status(h, HUB)).toBe('Running')
        expect(status(h, 'nextcloud-files-b-001')).toBe('Starting')
    })

    it('no container at all: still Undocked (the normal rule), skip or not', async () => {
        const h = await makeStore('Running')
        await checkAndSetUndockedApps(h, E, async () => false, { systemDiskSkip: true, containersHealthy: async () => true })
        expect(status(h, HUB)).toBe('Undocked')
    })

    it('dockPassWillRun / isSystemDiskMarked follow the store marker (idea#152)', async () => {
        const h = await makeStore('Running')
        const hub = h.doc().instanceDB[HUB as InstanceID] as any
        const nc = h.doc().instanceDB['nextcloud-files-b-001' as InstanceID] as any
        expect(dockPassWillRun(h.doc(), hub, true)).toBe(false)
        expect(dockPassWillRun(h.doc(), hub, false)).toBe(true)
        expect(dockPassWillRun(h.doc(), nc, true)).toBe(true)
        expect(isSystemDiskMarked({ diskTypes: ['system'] } as any)).toBe(true)
        expect(isSystemDiskMarked({ diskTypes: ['app'] } as any)).toBe(false)
        expect(isSystemDiskMarked(null)).toBe(false)
    })
})

describe('system-disk skip log names the systemDiskSkip setting (idea#449)', () => {
    let saved: string | undefined
    beforeEach(() => { saved = process.env.IDEA_SYSTEM_DISK_SKIP })
    afterEach(() => { if (saved === undefined) delete process.env.IDEA_SYSTEM_DISK_SKIP; else process.env.IDEA_SYSTEM_DISK_SKIP = saved })

    it('says where the setting came from', () => {
        process.env.IDEA_SYSTEM_DISK_SKIP = 'true'
        expect(systemDiskSkipSource()).toMatch(/IDEA_SYSTEM_DISK_SKIP=true/)
        delete process.env.IDEA_SYSTEM_DISK_SKIP
        expect(systemDiskSkipSource()).toBe('config.yaml settings.systemDiskSkip')
    })

    it('the usbDeviceMonitor skip line uses it instead of always printing IDEA_SYSTEM_DISK_SKIP=true', async () => {
        const src = await fs.readFile(path.resolve('src/monitors/usbDeviceMonitor.ts'), 'utf8')
        expect(src).toMatch(/skipping registration \(systemDiskSkip=true: \$\{systemDiskSkipSource\(\)\}\)/)
        expect(src).not.toMatch(/skipping registration \(IDEA_SYSTEM_DISK_SKIP=true\)/)
    })
})
