/**
 * channel-builder-autostart.test.ts: idea#193 §8.2a, the Engine starts the docked
 * kolibri-channel-builder when a stick with a top-level kolibri folder is mounted.
 *   kolibri stick + builder Docked → exactly one startInstance (cause usb-stick);
 *   Stopped / Pauzed / operator stop in force → no start (operatorStopped);
 *   no builder on this Engine (or only on another Engine) → noBuilder;
 *   stick without kolibri → no start; two sticks at once → one start;
 *   other apps never started; setting off → disabled; Running → no call;
 *   Error → one try; several builders → most recent lastStarted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import { fs, path } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { config } from '../../src/data/Config.js'
import { decideBuilderAutoStart, autoStartChannelBuilderForStick, setBuilderAutoStartDepsForTests, CHANNEL_BUILDER_APP_NAME } from '../../src/data/ChannelBuilderAutoStart.js'
import { addStick, setUsbStickOpsForTests, resetUsbSticksForTests, StickProbe } from '../../src/data/UsbSticks.js'
import { resourceLock, instanceKey } from '../../src/utils/ResourceLock.js'
import { createTestStore } from '../harness/diskSim.js'

const B_APP = 'kolibri-channel-builder-1.0'
const seed = (h: DocHandle<Store>, insts: { id: string, status: string, lastStarted?: number, engine?: string, app?: string }[]) => h.change(doc => {
    doc.appDB[B_APP as any] = { id: B_APP, name: CHANNEL_BUILDER_APP_NAME } as any
    doc.appDB['kolibri-1.0' as any] = { id: 'kolibri-1.0', name: 'kolibri' } as any
    for (const i of insts) {
        const diskId = `disk-${i.id}`
        doc.diskDB[diskId as any] = { id: diskId, dockedTo: i.engine ?? localEngineId, device: 'sdh1', diskTypes: ['app'] } as any
        doc.instanceDB[i.id as any] = { id: i.id, name: i.id, instanceOf: i.app ?? B_APP, storedOn: diskId, status: i.status, lastStarted: i.lastStarted ?? 0 } as any
    }
})
const stick = { stickId: 'usb-A', device: 'sdb1', label: 'M', displayName: 'USB: M', fsType: 'vfat', sizeBytes: 1, usedBytes: 0, mountedAt: 0, readOnly: true, hasKolibriFolder: true, builderAutoStart: null } as any

describe('idea#193 §8.2a channel builder auto-start', () => {
    let h: DocHandle<Store>
    let started: { id: string, cause?: string }[]
    const savedSetting = config.settings.autoStartChannelBuilder
    beforeEach(async () => {
        h = (await createTestStore()).storeHandle
        started = []
        setBuilderAutoStartDepsForTests({
            start: async (sh, inst) => {
                started.push({ id: String(inst.id) })
                sh.change(doc => { doc.instanceDB[inst.id].status = 'Starting' as any })
                await new Promise(r => setTimeout(r, 50))
                sh.change(doc => { doc.instanceDB[inst.id].status = 'Running' as any })
            },
        })
        config.settings.autoStartChannelBuilder = undefined
    })
    afterEach(() => { setBuilderAutoStartDepsForTests(null); config.settings.autoStartChannelBuilder = savedSetting })

    it('Docked builder → exactly one start', async () => {
        seed(h, [{ id: 'b1', status: 'Docked' }])
        expect(await autoStartChannelBuilderForStick(h, stick)).toBe('started')
        expect(started).toEqual([{ id: 'b1' }])
    })
    it('Error → one try', async () => {
        seed(h, [{ id: 'b1', status: 'Error' }])
        expect(await autoStartChannelBuilderForStick(h, stick)).toBe('started')
        expect(started).toHaveLength(1)
    })
    it.each(['Stopped', 'Pauzed'])('%s → no start (operatorStopped)', async (status) => {
        seed(h, [{ id: 'b1', status }])
        expect(await autoStartChannelBuilderForStick(h, stick)).toBe('operatorStopped')
        expect(started).toEqual([])
    })
    it('operator stop in force on a re-docked (Docked) builder → no start', async () => {
        seed(h, [{ id: 'b1', status: 'Docked', lastStarted: 10 }])
        h.change(doc => { (doc.operationDB as any)['op1'] = { id: 'op1', kind: 'stopApp', cause: 'console-command', status: 'Done', startedAt: 20, args: { instanceId: 'b1' }, subject: { type: 'instance', id: 'b1' } } })
        expect(await autoStartChannelBuilderForStick(h, stick)).toBe('operatorStopped')
        expect(started).toEqual([])
    })
    it('Running / Starting → no call', async () => {
        seed(h, [{ id: 'b1', status: 'Running' }])
        expect(await autoStartChannelBuilderForStick(h, stick)).toBe('alreadyRunning')
        expect(started).toEqual([])
    })
    it('no builder on this Engine (only another app, or a builder on another Engine) → noBuilder', async () => {
        seed(h, [{ id: 'k1', status: 'Docked', app: 'kolibri-1.0' }, { id: 'b-other', status: 'Docked', engine: 'ENGINE_other' }])
        expect(await autoStartChannelBuilderForStick(h, stick)).toBe('noBuilder')
        expect(started).toEqual([])
    })
    it('setting autoStartChannelBuilder false → disabled', async () => {
        seed(h, [{ id: 'b1', status: 'Docked' }])
        config.settings.autoStartChannelBuilder = false
        expect(await autoStartChannelBuilderForStick(h, stick)).toBe('disabled')
        expect(started).toEqual([])
    })
    it('stick without kolibri folder → no start', async () => {
        seed(h, [{ id: 'b1', status: 'Docked' }])
        expect(await autoStartChannelBuilderForStick(h, { ...stick, hasKolibriFolder: false })).toBe('notStartable')
        expect(started).toEqual([])
    })
    it('two sticks at once → one start', async () => {
        seed(h, [{ id: 'b1', status: 'Docked' }])
        const [a, b] = await Promise.all([autoStartChannelBuilderForStick(h, stick), autoStartChannelBuilderForStick(h, { ...stick, stickId: 'usb-B' })])
        expect([a, b].sort()).toEqual(['busy', 'started'])
        expect(started).toHaveLength(1)
    })
    it('instance lock held by another operation → busy, no start', async () => {
        seed(h, [{ id: 'b1', status: 'Docked' }])
        resourceLock.acquire(instanceKey('b1'), 'copyApp')
        try { expect(await autoStartChannelBuilderForStick(h, stick)).toBe('busy') } finally { resourceLock.release(instanceKey('b1')) }
        expect(started).toEqual([])
    })
    it('several builders → the most recent lastStarted; other apps never started', async () => {
        seed(h, [{ id: 'b-old', status: 'Docked', lastStarted: 5 }, { id: 'b-new', status: 'Docked', lastStarted: 9 }, { id: 'k1', status: 'Docked', app: 'kolibri-1.0' }])
        await autoStartChannelBuilderForStick(h, stick)
        expect(started).toEqual([{ id: 'b-new' }])
        expect(decideBuilderAutoStart(h.doc(), localEngineId, true).instance?.id).toBe('b-new')
    })
    it('a failed start → failed', async () => {
        seed(h, [{ id: 'b1', status: 'Docked' }])
        setBuilderAutoStartDepsForTests({ start: async () => { throw new Error('compose up failed') } })
        expect(await autoStartChannelBuilderForStick(h, stick)).toBe('failed')
    })

    describe('through addStick', () => {
        let root = ''
        const savedRoot = process.env.IDEA_USB_ROOT
        beforeEach(async () => {
            root = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-usb-as-'))
            process.env.IDEA_USB_ROOT = root
            resetUsbSticksForTests()
        })
        afterEach(async () => {
            setUsbStickOpsForTests(null); resetUsbSticksForTests()
            if (savedRoot === undefined) delete process.env.IDEA_USB_ROOT; else process.env.IDEA_USB_ROOT = savedRoot
            await fs.remove(root)
        })
        const ops = (withKolibri: boolean) => {
            const mounts: any[] = []
            setUsbStickOpsForTests({
                listMounts: async () => [...mounts], isMountPoint: async (p) => mounts.some(m => m.target === p),
                sudo: async (argv) => { if (argv[1] === '-t') { const mp = argv[argv.length - 1]; mounts.push({ source: argv[argv.length - 2], target: mp, fstype: 'vfat' }); if (withKolibri) await fs.ensureDir(path.join(mp, 'kolibri')) } },
                statfs: async () => ({ sizeBytes: 1, usedBytes: 0 }), dockerExec: async () => {},
            })
        }
        const probe: StickProbe = { fsType: 'vfat', label: 'M', uuid: 'U1', sizeBytes: 1, model: null }
        it('kolibri stick → builder started; result published on Engine.usbSticks', async () => {
            seed(h, [{ id: 'b1', status: 'Docked' }]); ops(true)
            await addStick(h, 'sdb1', probe)
            expect(started).toEqual([{ id: 'b1' }])
            const s = h.doc().engineDB[localEngineId].usbSticks!
            expect(s[0]).toMatchObject({ hasKolibriFolder: true, builderAutoStart: 'started' })
        })
        it('stick without kolibri → no start, builderAutoStart null', async () => {
            seed(h, [{ id: 'b1', status: 'Docked' }]); ops(false)
            await addStick(h, 'sdb1', probe)
            expect(started).toEqual([])
            expect(h.doc().engineDB[localEngineId].usbSticks![0]).toMatchObject({ hasKolibriFolder: false, builderAutoStart: null })
        })
        it('no builder → Console hint state noBuilder', async () => {
            ops(true)
            await addStick(h, 'sdb1', probe)
            expect(h.doc().engineDB[localEngineId].usbSticks![0].builderAutoStart).toBe('noBuilder')
        })
    })

    it('startInstance runs the usb sync once the App is Running (instance-start hook)', async () => {
        const src = await fs.readFile(path.join(process.cwd(), 'src/data/Instance.ts'), 'utf-8')
        // idea#392 (#298): the usbMount.sync check moved into instanceUsbSync() (InstanceApp.ts)
        expect(src).toMatch(/if \(await instanceUsbSync\(storeHandle\.doc\(\), instance\)\)[\s\S]{0,200}syncUsbApps\(storeHandle, 'start', true, instance\.id\)/)
        const appSrc = await fs.readFile(path.join(process.cwd(), 'src/data/InstanceApp.ts'), 'utf-8')
        expect(appSrc).toMatch(/export const instanceUsbSync = [\s\S]{0,300}\.usbMount\?\.sync/)
    })
})
