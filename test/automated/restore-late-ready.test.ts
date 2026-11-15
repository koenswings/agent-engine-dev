/**
 * restore-late-ready.test.ts (engine#428)
 *
 * A start that times out at the port-ready gate is left Error with a
 * PORT_NOT_READY: reason. The instance monitor then re-probes and sets
 * Running once the app answers HTTP. restoreApp reports START_PENDING
 * instead of a plain ok when the post-restore start did not reach Running.
 *
 * Part 3 (x-app.restoreHealthTimeout) is not built here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'

vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, processInstance: vi.fn(async () => {}) }
})
vi.mock('../../src/data/RestoreAppFiles.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, ensureAppFilesOnTarget: vi.fn(async () => {}) }
})
vi.mock('../../src/data/RestorePreQuarantine.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, assertPreQuarantineHelper: vi.fn(async () => null), quarantinePreRestore: vi.fn(async () => null) }
})
import http from 'http'
import type { AddressInfo } from 'net'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { config } from '../../src/data/Config.js'
import {
    assertInstancePortReady,
    markInstanceError,
    PORT_NOT_READY_PREFIX,
    isPortNotReadyCondition,
    parsePortNotReadyAt,
    diagnoseInstance,
} from '../../src/data/Instance.js'
import {
    healPortNotReadyErrors,
    resetPortNotReadyHealStateForTests,
    PORT_NOT_READY_HEAL_WINDOW_MS,
} from '../../src/monitors/instanceStatusMonitor.js'
import { restoreApp, backupLifecycle, restoreStartPendingMessage } from '../../src/monitors/backupMonitor.js'
import { runWithTrace } from '../../src/utils/CommandLogger.js'
import { takePendingTraceCloseMessage, takePendingTraceResult } from '../../src/data/CommandLogStore.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const INST = 'inst-428-late' as InstanceID
const OTHER_ENGINE = 'other-engine' as EngineID

const makeDisk = (id: string, device: string, dockedTo: EngineID | null): Disk => ({
    id: id as DiskID,
    name: 'App Disk' as DiskName,
    device: device as any,
    dockedTo,
    created: Date.now() as Timestamp,
    lastDocked: Date.now() as Timestamp,
    diskTypes: ['app'],
    backupConfig: null,
} as Disk)

const listenHttp = async (): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200)
        res.end('ok')
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    return {
        port,
        close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
    }
}

const setupStore = async (opts: {
    status?: string
    condition?: string | null
    port?: number
    dockedTo?: EngineID | null
    instanceId?: InstanceID
    device?: string
}) => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as unknown as Store)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    const device = opts.device ?? uniqueTestDevice()
    const disk = makeDisk('d428', device, opts.dockedTo === undefined ? localEngineId : opts.dockedTo)
    const instanceId = opts.instanceId ?? INST
    h.change(doc => {
        doc.diskDB[disk.id] = disk
        doc.instanceDB[instanceId] = {
            id: instanceId, instanceOf: 'sample-app' as any, name: instanceId as any,
            status: (opts.status ?? 'Error') as any, port: (opts.port ?? 8080) as any,
            serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
            lastStarted: Date.now() as Timestamp, statusCondition: opts.condition ?? null,
            storedOn: disk.id, currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })
    return { h, disk, device, instanceId }
}

const savedTestMode = config.settings.testMode
const origLifecycle = { ...backupLifecycle }

beforeEach(() => {
    resetPortNotReadyHealStateForTests()
    config.settings.testMode = true
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
    backupLifecycle.stopInstance = origLifecycle.stopInstance
    backupLifecycle.startInstance = origLifecycle.startInstance
    config.settings.testMode = savedTestMode
    config.settings.skipBorg = origSkipBorg
})

const origSkipBorg = config.settings.skipBorg

describe('PORT_NOT_READY reason (engine#428 part 1)', () => {
    it('assertInstancePortReady prefixes a timeout with PORT_NOT_READY:', async () => {
        const err = await assertInstancePortReady('dead-428' as any, 59999, '/tmp', {
            readyTimeoutMs: 40,
            stableMs: 20,
            forceRecreate: false,
        }).then(
            () => { throw new Error('expected assertInstancePortReady to reject') },
            (e: unknown) => e as Error,
        )
        expect(err.message.startsWith(PORT_NOT_READY_PREFIX)).toBe(true)
        expect(err.message).toMatch(/never stayed ready/)
        expect(err.message).toMatch(/within 40ms/)
    })

    it('diagnoseInstance keeps PORT_NOT_READY: first and records at=', async () => {
        const inst = { id: INST, serviceImages: [] } as any
        const disk = makeDisk('dx', 'devx', localEngineId)
        const diagnosis = await diagnoseInstance(inst, disk, new Error(`${PORT_NOT_READY_PREFIX} never stayed ready for 20ms within 300000ms`))
        expect(isPortNotReadyCondition(diagnosis)).toBe(true)
        expect(parsePortNotReadyAt(diagnosis)).toBeGreaterThan(0)
        expect(diagnosis).toMatch(/within 300000ms/)
        expect(diagnosis.startsWith('Engine error:')).toBe(false)
    })
})

describe('PORT_NOT_READY heal (engine#428 part 1)', () => {
    it('a fake port that starts answering after the budget ends goes Error, then Running through the heal', async () => {
        const budget = 80
        const stableMs = 40
        const err = await assertInstancePortReady(INST, 59996, '/tmp', {
            readyTimeoutMs: budget,
            stableMs,
            forceRecreate: false,
        }).then(
            () => { throw new Error('expected timeout') },
            (e: unknown) => e as Error,
        )
        expect(err.message.startsWith(PORT_NOT_READY_PREFIX)).toBe(true)

        const httpSrv = await listenHttp()
        const { h, disk } = await setupStore({ status: 'Starting', condition: null, port: httpSrv.port })
        try {
            await markInstanceError(h, h.doc()!.instanceDB[INST] as any, disk, err)
            const afterErr = h.doc()!.instanceDB[INST]
            expect(afterErr.status).toBe('Error')
            expect(isPortNotReadyCondition(afterErr.statusCondition)).toBe(true)

            await healPortNotReadyErrors(h, {
                containersUp: async () => true,
                stableMs,
                probeTimeoutMs: 80,
            })
            const afterHeal = h.doc()!.instanceDB[INST]
            expect(afterHeal.status).toBe('Running')
            expect(afterHeal.statusCondition).toBe(null)
        } finally {
            await httpSrv.close()
        }
    })

    it('a non-PORT_NOT_READY Error is never healed', async () => {
        const httpSrv = await listenHttp()
        const { h } = await setupStore({
            status: 'Error',
            condition: 'Engine error: compose up failed',
            port: httpSrv.port,
        })
        try {
            await healPortNotReadyErrors(h, {
                containersUp: async () => true,
                probeReady: async () => true,
            })
            expect(h.doc()!.instanceDB[INST].status).toBe('Error')
            expect(h.doc()!.instanceDB[INST].statusCondition).toBe('Engine error: compose up failed')
        } finally {
            await httpSrv.close()
        }
    })

    it('does not heal while the disk is undocked', async () => {
        const { h } = await setupStore({
            status: 'Error',
            condition: `${PORT_NOT_READY_PREFIX} at=${Date.now()}; never stayed ready for 20ms within 300000ms`,
            dockedTo: null,
        })
        await healPortNotReadyErrors(h, {
            containersUp: async () => true,
            probeReady: async () => true,
        })
        expect(h.doc()!.instanceDB[INST].status).toBe('Error')
    })

    it('does not heal while the disk is docked to another Engine', async () => {
        const { h } = await setupStore({
            status: 'Error',
            condition: `${PORT_NOT_READY_PREFIX} at=${Date.now()}; never stayed ready for 20ms within 300000ms`,
            dockedTo: OTHER_ENGINE,
        })
        await healPortNotReadyErrors(h, {
            containersUp: async () => true,
            probeReady: async () => true,
        })
        expect(h.doc()!.instanceDB[INST].status).toBe('Error')
    })

    it('does not heal when the compose containers are gone', async () => {
        const { h } = await setupStore({
            status: 'Error',
            condition: `${PORT_NOT_READY_PREFIX} at=${Date.now()}; never stayed ready for 20ms within 300000ms`,
        })
        await healPortNotReadyErrors(h, {
            containersUp: async () => false,
            probeReady: async () => true,
        })
        expect(h.doc()!.instanceDB[INST].status).toBe('Error')
    })

    it('does not heal a legacy dotted id', async () => {
        const dotted = 'app.legacy' as InstanceID
        const { h } = await setupStore({
            status: 'Error',
            condition: `${PORT_NOT_READY_PREFIX} at=${Date.now()}; never stayed ready for 20ms within 300000ms`,
            instanceId: dotted,
        })
        await healPortNotReadyErrors(h, {
            containersUp: async () => true,
            probeReady: async () => true,
        })
        expect(h.doc()!.instanceDB[dotted].status).toBe('Error')
    })

    it('stops probing after the 1 h window from at=', async () => {
        const at = Date.now() - PORT_NOT_READY_HEAL_WINDOW_MS - 1
        const { h } = await setupStore({
            status: 'Error',
            condition: `${PORT_NOT_READY_PREFIX} at=${at}; never stayed ready for 20ms within 300000ms`,
        })
        await healPortNotReadyErrors(h, {
            containersUp: async () => true,
            probeReady: async () => true,
        })
        expect(h.doc()!.instanceDB[INST].status).toBe('Error')
    })
})

describe('restoreApp START_PENDING (engine#428 part 2)', () => {
    let appDevice: string
    let backupDevice: string

    const setupRestore = async (status: 'Running' | 'Stopped') => {
        appDevice = uniqueTestDevice()
        do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
        await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
        await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}/backups/${INST}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`, '[repository]\n')
        config.settings.skipBorg = true
        const h = new Repo({ network: [], storage: undefined }).create<Store>({
            engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
        } as unknown as Store)
        await h.whenReady()
        await createOrUpdateEngine(h, localEngineId)
        const appDisk = makeDisk('r428-ad', appDevice, localEngineId)
        const backupDisk: Disk = {
            ...makeDisk('r428-bd', backupDevice, localEngineId),
            name: 'Backup Disk' as DiskName,
            diskTypes: ['backup'],
        } as Disk
        h.change(doc => {
            doc.diskDB[appDisk.id] = appDisk
            doc.diskDB[backupDisk.id] = backupDisk
            doc.instanceDB[INST] = {
                id: INST, instanceOf: 'sample-app' as any, name: INST as any, status: status as any,
                port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
                lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: appDisk.id,
                currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            } as any
        })
        return { h, appDisk }
    }

    afterEach(async () => {
        if (appDevice) await fs.remove(`${DISKS_ROOT}/${appDevice}`)
        if (backupDevice) await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
    })

    it('the restore trace shows START_PENDING when the post-restore start stays at PORT_NOT_READY', async () => {
        const { h, appDisk } = await setupRestore('Running')
        backupLifecycle.stopInstance = vi.fn(async (handle, inst: any) => {
            handle.change(doc => { (doc.instanceDB as any)[inst.id].status = 'Stopped' })
        }) as any
        backupLifecycle.startInstance = vi.fn(async (handle, inst: any) => {
            handle.change(doc => {
                const rec = (doc.instanceDB as any)[inst.id]
                rec.status = 'Error'
                rec.statusCondition = `${PORT_NOT_READY_PREFIX} at=${Date.now()}; Instance ${inst.id} container is up but host port 8080 never stayed ready for 10000ms within 300000ms.`
            })
        }) as any

        const traceId = 'tr-428-start-pending'
        await runWithTrace({ traceId, command: 'restoreApp', args: '{}' }, async () => {
            await restoreApp(h, INST, appDisk)
        })

        const op = Object.values(h.doc()!.operationDB).find((o: any) => o.kind === 'restoreApp') as any
        expect(op?.status).toBe('Done')
        expect(h.doc()!.instanceDB[INST].status).toBe('Error')
        const closeMsg = takePendingTraceCloseMessage(traceId)
        const result = takePendingTraceResult(traceId)
        expect(closeMsg).toBe('START_PENDING: restored; the app did not answer within 300 s and will show Running once it does')
        expect(result).toContain('START_PENDING: restored; the app did not answer within 300 s')
        expect(restoreStartPendingMessage(h.doc()!.instanceDB[INST] as any)).toBe(closeMsg)
    })
})
