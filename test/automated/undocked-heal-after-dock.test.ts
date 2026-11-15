/**
 * undocked-heal-after-dock.test.ts: engine#427 safety net and restart cases.
 *
 * idea03 (15 Nov 2026): after a pm2 restart, instances restored onto a disk with
 * `instances/` but no `apps/` stayed Starting for more than 3 minutes while their
 * containers were healthy. checkAndSetUndockedApps marks them Starting "until the dock
 * pass checks it", but no dock pass processed them. #434 made such a disk an App Disk.
 * As a safety net, healStartingOnDisk (run at the end of processDisk) sets an instance
 * still Starting to Running when its containers are healthy, without restarting it.
 */
import { describe, it, expect, vi } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { checkAndSetUndockedApps, healStartingOnDisk } from '../../src/data/UndockedApps.js'
import { shouldAutoStart } from '../../src/data/AutoStart.js'
import { EngineID, InstanceID } from '../../src/data/CommonTypes.js'

const E = 'engine-idea03' as EngineID
const OTHER = 'engine-idea04' as EngineID
const LAST = 1794395811913
const disk = (id: string, types: string[], dockedTo: EngineID = E) =>
    ({ id, name: id, device: 'sdb1', created: 0, lastDocked: 0, dockedTo, diskTypes: types, backupConfig: null })
const instance = (id: string, storedOn: string, status: string) => ({
    id, instanceOf: 'nextcloud', name: id, status, statusCondition: null, port: 8080, serviceImages: [],
    created: 0, lastBackup: null, lastStarted: LAST, storedOn, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
})

// The WD: a Backup Disk that also holds restored instances, with no apps/ folder.
const makeStore = async (statuses: Record<string, string>): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, appDB: {}, userDB: {}, operationDB: {},
        diskDB: { wd: disk('wd', ['app', 'backup']), other: disk('other', ['app'], OTHER) } as any,
        instanceDB: {
            'nc-p420-a': instance('nc-p420-a', 'wd', statuses.a ?? 'Running'),
            'nc-p420-b': instance('nc-p420-b', 'wd', statuses.b ?? 'Running'),
            'nc-elsewhere': instance('nc-elsewhere', 'other', 'Starting'),
        } as any,
    } as any)
    await h.whenReady()
    return h
}
const status = (h: DocHandle<Store>, id: string) => String(h.doc().instanceDB[id as InstanceID].status)
const lastStarted = (h: DocHandle<Store>, id: string) => Number(h.doc().instanceDB[id as InstanceID].lastStarted)

describe('restart with healthy containers on a disk with instances/ but no apps/ (engine#427)', () => {
    it('boot marks them Starting, the post-dock sweep sets them Running; nothing is started or recreated', async () => {
        const h = await makeStore({})
        const running = vi.fn(async () => true)
        await checkAndSetUndockedApps(h, E, running, { systemDiskSkip: false, containersHealthy: async () => true })
        expect(status(h, 'nc-p420-a')).toBe('Starting')
        expect(status(h, 'nc-p420-b')).toBe('Starting')

        const healthy = vi.fn(async () => true)
        const before = Date.now()
        const healed = await healStartingOnDisk(h, 'wd', E, healthy)
        expect(healed.sort()).toEqual(['nc-p420-a', 'nc-p420-b'])
        expect(status(h, 'nc-p420-a')).toBe('Running')
        expect(status(h, 'nc-p420-b')).toBe('Running')
        expect(lastStarted(h, 'nc-p420-a')).toBeGreaterThanOrEqual(before)
        // Only read-only health checks ran: one per instance, nothing else was called.
        expect(healthy).toHaveBeenCalledTimes(2)
    })

    it('the same disk without containers: Undocked at boot, and the dock gate starts it as before', async () => {
        const h = await makeStore({})
        await checkAndSetUndockedApps(h, E, async () => false, { systemDiskSkip: false, containersHealthy: async () => true })
        expect(status(h, 'nc-p420-a')).toBe('Undocked')
        const doc = h.doc()
        expect(shouldAutoStart(doc, doc.instanceDB['nc-p420-a' as InstanceID]).start).toBe(true)
        // The sweep leaves an instance that is not Starting alone.
        const healthy = vi.fn(async () => true)
        expect(await healStartingOnDisk(h, 'wd', E, healthy)).toEqual([])
        expect(healthy).not.toHaveBeenCalled()
        expect(status(h, 'nc-p420-a')).toBe('Undocked')
    })
})

describe('healStartingOnDisk (engine#427 safety net)', () => {
    it('leaves an instance Starting when its containers are not all healthy, or their health cannot be read', async () => {
        const h = await makeStore({ a: 'Starting', b: 'Starting' })
        const healthy = vi.fn(async (id: InstanceID) => {
            if (id === 'nc-p420-b') throw new Error('docker down')
            return false
        })
        expect(await healStartingOnDisk(h, 'wd', E, healthy)).toEqual([])
        expect(status(h, 'nc-p420-a')).toBe('Starting')
        expect(status(h, 'nc-p420-b')).toBe('Starting')
        expect(lastStarted(h, 'nc-p420-a')).toBe(LAST)
    })

    it('touches only the docked disk it was called for, on this Engine', async () => {
        const h = await makeStore({ a: 'Starting' })
        const healthy = vi.fn(async () => true)
        // A disk docked on another Engine: its Starting instance is not ours to judge.
        expect(await healStartingOnDisk(h, 'other', E, healthy)).toEqual([])
        expect(status(h, 'nc-elsewhere')).toBe('Starting')
        expect(healthy).not.toHaveBeenCalled()
        // Called for wd: only the Starting instance there.
        expect(await healStartingOnDisk(h, 'wd', E, healthy)).toEqual(['nc-p420-a'])
        expect(status(h, 'nc-p420-b')).toBe('Running')
        expect(status(h, 'nc-elsewhere')).toBe('Starting')
    })
})
