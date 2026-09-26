/**
 * instance-start-status.test.ts — Running only after `docker compose up` (idea#109)
 *
 * An instance must show Running only when its containers really started. Any
 * failure while starting sets Error and leaves a failed `startInstance` trace in
 * the command log (Console History), like the failed `diskDetection` traces of
 * idea#82.
 *
 *   1. Unit: closeTrace never turns an 'error' trace back into 'ok';
 *      recordInstanceStartFailure closes the active `startInstance` trace as
 *      failed, or adds a completed failed trace when there is none.
 *   2. Real containers, five fixture disks docked through the USB monitor, with
 *      the real image-load step on (skipImageLoad = false):
 *      - ok:         image loaded from its tar; Running is written only when
 *                    the container already runs; no warning
 *      - no tar / bad tar: the load problem is a 'warn' log line in the
 *                    start's History entry, the start goes on and reaches
 *                    Running (the image is local; production may also pull)
 *      - bad create: image not local + `pull_policy: never` → `compose create`
 *                    fails → Error, never Running, failed trace
 *      - bad up:     entrypoint that does not exist in the image → `compose
 *                    create` succeeds, `compose up` fails → Error, never
 *                    Running, failed trace
 *   3. createInstanceContainers rejects instead of swallowing the error.
 *
 * Fixtures use `traefik/whoami` (pulled once in setup if missing, like the
 * idea#81 test) and `pull_policy: never`, so the Engine never pulls. Only
 * this suite's labelled containers are removed.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import os from 'os'
import crypto from 'crypto'
import { execSync } from 'child_process'
import { $, fs, path, YAML } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import {
    CommandLogStore,
    CommandTrace,
    addTrace,
    closeTrace,
    setCommandLogHandle,
} from '../../src/data/CommandLogStore.js'
import { runWithTrace } from '../../src/utils/CommandLogger.js'
import {
    createInstanceContainers,
    recordInstanceStartFailure,
    recordInstanceStartWarnings,
    addInstanceStartWarning,
    serviceImageTarPath,
    START_INSTANCE_COMMAND,
    Instance,
} from '../../src/data/Instance.js'
import { Disk } from '../../src/data/Disk.js'
import { config } from '../../src/data/Config.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    createTestStore,
    dockFixture,
    triggerUndock,
    cleanupDisk,
    cleanupContainers,
    cleanupNetworks,
    waitForStatus,
    waitFor,
    uniqueTestDevice,
    TEST_CONTAINER_LABEL,
    TEST_CONTAINER_LABEL_KEY,
    TEST_CONTAINER_LABEL_VALUE,
} from '../harness/diskSim.js'

const IMAGE = 'traefik/whoami'

const newCommandLog = (): DocHandle<CommandLogStore> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
}
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] =>
    h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])
const tracesOf = (h: DocHandle<CommandLogStore>, instanceId: string): CommandTrace[] =>
    traces(h).filter(t => {
        if (t.command !== START_INSTANCE_COMMAND) return false
        // The dock auto-start trace carries instanceName only; standalone failures carry both.
        try {
            const args = JSON.parse(t.args)
            return args.instanceId === instanceId || args.instanceName === `${instanceId}-name`
        } catch { return false }
    })

const fakeInstance = (id: string): Instance => ({ id, name: `${id}-name` } as unknown as Instance)
const fakeDisk = (id: string): Disk => ({ id } as unknown as Disk)

describe('failed start → command log (idea#109, unit)', () => {
    it('closeTrace keeps an error trace failed when it is closed again as ok', () => {
        const h = newCommandLog()
        addTrace(h, { traceId: 't1', command: 'startInstance', args: '{}', startedAt: 1, completedAt: null, status: 'running', errorMessage: null })
        closeTrace(h, 't1', 'error', 'compose up failed')
        closeTrace(h, 't1', 'ok')
        expect(h.doc()!.traces['t1'].status).to.equal('error')
        expect(h.doc()!.traces['t1'].errorMessage).to.equal('compose up failed')
        addTrace(h, { traceId: 't2', command: 'startInstance', args: '{}', startedAt: 1, completedAt: null, status: 'running', errorMessage: null })
        closeTrace(h, 't2', 'ok')
        expect(h.doc()!.traces['t2'].status, 'a normal ok close still works').to.equal('ok')
    })

    it('adds a completed failed startInstance trace when no startInstance trace is active', async () => {
        const h = newCommandLog()
        await recordInstanceStartFailure(fakeInstance('inst-a'), fakeDisk('disk-a'), 'post-copy', 'boom', [], h)
        const all = traces(h)
        expect(all).to.have.length(1)
        expect(all[0].command).to.equal('startInstance')
        expect(all[0].status).to.equal('error')
        expect(all[0].errorMessage).to.equal('boom')
        expect(all[0].completedAt).to.be.a('number')
        expect(JSON.parse(all[0].args)).to.deep.equal({ instanceName: 'inst-a-name', instanceId: 'inst-a', diskId: 'disk-a', cause: 'post-copy' })
    })

    it('closes the active startInstance trace as failed instead of adding a second one', async () => {
        const h = newCommandLog()
        addTrace(h, { traceId: 'outer', command: 'startInstance', args: '{"instanceName":"inst-b-name"}', startedAt: 1, completedAt: null, status: 'running', errorMessage: null })
        await runWithTrace({ traceId: 'outer', command: 'startInstance', args: '{}' }, () =>
            recordInstanceStartFailure(fakeInstance('inst-b'), fakeDisk('disk-b'), 'disk-docked', 'boom', [], h))
        closeTrace(h, 'outer', 'ok')   // what the wrapper does after startInstance returns
        expect(traces(h)).to.have.length(1)
        expect(h.doc()!.traces['outer'].status).to.equal('error')
        expect(h.doc()!.traces['outer'].errorMessage).to.equal('boom')
    })

    it('inside another command trace (e.g. backupApp) it adds its own startInstance trace', async () => {
        const h = newCommandLog()
        addTrace(h, { traceId: 'backup', command: 'backupApp', args: '{}', startedAt: 1, completedAt: null, status: 'running', errorMessage: null })
        await runWithTrace({ traceId: 'backup', command: 'backupApp', args: '{}' }, () =>
            recordInstanceStartFailure(fakeInstance('inst-c'), fakeDisk('disk-c'), 'backup-post-start', 'boom', [], h))
        expect(h.doc()!.traces['backup'].status, 'the backup trace is left alone').to.equal('running')
        expect(tracesOf(h, 'inst-c').map(t => t.status)).to.deep.equal(['error'])
    })

    it('start warnings go into the active startInstance trace as warn log lines', async () => {
        const h = newCommandLog()
        addTrace(h, { traceId: 'outer', command: 'startInstance', args: '{}', startedAt: 1, completedAt: null, status: 'running', errorMessage: null })
        const appended = await runWithTrace({ traceId: 'outer', command: 'startInstance', args: '{}' }, () =>
            addInstanceStartWarning({ level: 'warn', message: 'tar missing', timestamp: 5 }, h))
        expect(appended).to.be.true
        expect(h.doc()!.traces['outer'].logs.map(l => [l.level, l.message])).to.deep.equal([['warn', 'tar missing']])
        expect(h.doc()!.traces['outer'].status, 'a warning alone does not fail the trace').to.equal('running')
        expect(await addInstanceStartWarning({ level: 'warn', message: 'x', timestamp: 6 }, h), 'outside a startInstance trace it is not appended').to.be.false
    })

    it('outside a trace, warnings of a successful start become an ok startInstance trace', async () => {
        const h = newCommandLog()
        const w = [{ level: 'warn' as const, message: 'tar missing', timestamp: 5 }]
        await recordInstanceStartWarnings(fakeInstance('inst-e'), fakeDisk('disk-e'), 'post-copy', w, h)
        const t = tracesOf(h, 'inst-e')
        expect(t.map(x => x.status)).to.deep.equal(['ok'])
        expect(t[0].logs.map(l => l.level)).to.deep.equal(['warn'])
        await recordInstanceStartWarnings(fakeInstance('inst-f'), fakeDisk('disk-f'), 'post-copy', [], h)
        expect(tracesOf(h, 'inst-f'), 'no warnings → no entry').to.have.length(0)
        await recordInstanceStartFailure(fakeInstance('inst-g'), fakeDisk('disk-g'), 'post-move', 'create failed', w, h)
        const g = tracesOf(h, 'inst-g')
        expect(g.map(x => x.status), 'warnings + failure → one error entry').to.deep.equal(['error'])
        expect(g[0].logs.map(l => l.message)).to.deep.equal(['tar missing'])
    })

    it('does nothing (and does not throw) without a command log', async () => {
        await recordInstanceStartFailure(fakeInstance('inst-d'), fakeDisk('disk-d'), 'post-move', 'boom', [], null)
    })
})

interface StartCase {
    kind: 'ok' | 'noTar' | 'badTar' | 'badCreate' | 'badUp'
    nonce: string
    instanceId: string
    device: string
    fixtureDir: string
    statuses: string[]
    runningContainerWhenRunning: boolean | null
}

const newCase = (kind: StartCase['kind']): StartCase => {
    const nonce = crypto.randomBytes(5).toString('hex')
    return {
        kind,
        nonce,
        instanceId: `startst-${kind.toLowerCase()}-${nonce}`,
        device: uniqueTestDevice(),
        fixtureDir: '',
        statuses: [],
        runningContainerWhenRunning: null,
    }
}

const runningContainerNow = (instanceId: string): boolean => {
    const out = execSync(`docker ps -q --filter label=${TEST_CONTAINER_LABEL} --filter name=${instanceId} --filter status=running`).toString()
    return out.trim() !== ''
}

/** A minimal App Disk with one instance of the `startst` app. */
const buildFixtureDisk = async (c: StartCase): Promise<void> => {
    c.fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-startst-'))
    const service: Record<string, unknown> = {
        image: c.kind === 'badCreate' ? `idea-test/not-local:${c.nonce}` : IMAGE,
        pull_policy: 'never',
        labels: { [TEST_CONTAINER_LABEL_KEY]: TEST_CONTAINER_LABEL_VALUE },
        ports: ['${port}:80'],
        restart: 'no',
    }
    if (c.kind === 'badUp') service.entrypoint = ['/idea-test-no-such-binary']
    const xApp = {
        name: 'startst',
        version: '1.0',
        title: 'Start status test app',
        description: 'Synthetic test fixture (idea#109)',
        category: 'education',
        url: 'http://localhost:${port}',
        icon: '',
        author: 'IDEA Test Harness',
    }
    await fs.outputFile(path.join(c.fixtureDir, 'META.yaml'), YAML.stringify({
        diskId: `test-fixture-startst-${c.nonce}`,
        isHardwareId: false,
        diskName: `test-startst-${c.nonce}`,
        created: 1700000000000,
        lastDocked: 1700000000000,
    }))
    await fs.outputFile(path.join(c.fixtureDir, 'apps', 'startst-1.0', 'compose.yaml'),
        YAML.stringify({ services: { startst: service }, 'x-app': xApp }))
    await fs.outputFile(path.join(c.fixtureDir, 'instances', c.instanceId, 'compose.yaml'),
        YAML.stringify({ services: { startst: service }, 'x-app': { ...xApp, instanceName: `${c.instanceId}-name` } }))
    await fs.ensureDir(path.join(c.fixtureDir, 'services'))
    // ok: a real saved image; badTar: a file `docker image load` rejects;
    // noTar / badCreate / badUp: no saved image at all.
    if (c.kind === 'ok') await $`docker save -o ${serviceImageTarPath(c.fixtureDir, IMAGE)} ${IMAGE}`.quiet()
    if (c.kind === 'badTar') await fs.writeFile(serviceImageTarPath(c.fixtureDir, IMAGE), 'not a docker image archive')
}

const warnLines = (t: CommandTrace): string[] => t.logs.filter(l => l.level === 'warn').map(l => l.message)

describe('Running only after compose up; failures end in Error (idea#109, real containers)', () => {
    let storeHandle: DocHandle<Store>
    const logHandle = newCommandLog()
    const savedSkip = config.settings.skipImageLoad
    const ok = newCase('ok')
    const noTar = newCase('noTar')
    const badTar = newCase('badTar')
    const badCreate = newCase('badCreate')
    const badUp = newCase('badUp')
    const cases = [ok, noTar, badTar, badCreate, badUp]

    beforeAll(async () => {
        const inspect = await $`docker image inspect ${IMAGE}`.quiet().nothrow()
        if (inspect.exitCode !== 0) await $`docker pull ${IMAGE}`.quiet()
        for (const c of cases) await buildFixtureDisk(c)

        // Run the real image-load step (testMode stays on, so the mount is skipped).
        config.settings.skipImageLoad = false
        setCommandLogHandle(logHandle)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        // Record every status each instance goes through. When it first becomes
        // Running, check synchronously whether its container is already running.
        storeHandle.on('change', ({ doc }) => {
            for (const c of cases) {
                const status = doc.instanceDB[c.instanceId as any]?.status
                if (!status || c.statuses[c.statuses.length - 1] === status) continue
                c.statuses.push(status)
                if (status === 'Running' && c.runningContainerWhenRunning === null) {
                    c.runningContainerWhenRunning = runningContainerNow(c.instanceId)
                }
            }
        })
        await enableUsbDeviceMonitor(storeHandle)
    }, 120_000)

    afterAll(async () => {
        for (const c of cases) {
            await triggerUndock(c.device).catch(() => {})
        }
        await new Promise(r => setTimeout(r, 2_000))
        for (const c of cases) {
            await cleanupContainers(c.instanceId)
            await cleanupNetworks(c.instanceId)
            await cleanupDisk(c.device).catch(() => {})
            if (c.fixtureDir) await fs.remove(c.fixtureDir).catch(() => {})
        }
        setCommandLogHandle(null)
        config.settings.skipImageLoad = savedSkip
    }, 60_000)

    it('success: Running is written only once the container runs', { timeout: 120_000 }, async () => {
        await dockFixture(ok.fixtureDir, ok.device)
        expect(await waitForStatus(storeHandle, ok.instanceId, 'Running', 90_000), 'should reach Running').to.be.true
        expect(ok.runningContainerWhenRunning, `container must already run when Running is written (statuses: ${ok.statuses})`).to.equal(true)
        expect(ok.statuses, 'Pauzed (created) comes before Running').to.include('Pauzed')
        expect(ok.statuses.indexOf('Pauzed')).to.be.lessThan(ok.statuses.indexOf('Running'))
        const inst = storeHandle.doc()!.instanceDB[ok.instanceId as any]
        expect(inst.statusCondition).to.equal(null)
        expect(inst.lastStarted).to.be.greaterThan(0)
        // The dock auto-start closes its trace right after startInstance returns.
        expect(await waitFor(storeHandle, () => tracesOf(logHandle, ok.instanceId).some(x => x.status === 'ok'), 10_000)).to.be.true
        const t = tracesOf(logHandle, ok.instanceId)
        expect(t.map(x => x.status), 'one startInstance trace, closed ok').to.deep.equal(['ok'])
        expect(warnLines(t[0]), 'the image loaded from its tar: no warning').to.deep.equal([])
    })

    for (const [c, what] of [[noTar, 'the saved image is missing'], [badTar, 'docker image load fails']] as const) {
        it(`${what}: the start goes on, reaches Running, and History carries a warning`, { timeout: 120_000 }, async () => {
            await dockFixture(c.fixtureDir, c.device)
            expect(await waitForStatus(storeHandle, c.instanceId, 'Running', 90_000), `should reach Running (statuses: ${c.statuses})`).to.be.true
            expect(c.statuses).to.not.include('Error')
            expect(c.runningContainerWhenRunning).to.equal(true)
            expect(await waitFor(storeHandle, () => tracesOf(logHandle, c.instanceId).some(x => x.status === 'ok'), 10_000)).to.be.true
            const t = tracesOf(logHandle, c.instanceId)
            expect(t.map(x => x.status), 'one startInstance trace, closed ok').to.deep.equal(['ok'])
            const w = warnLines(t[0])
            expect(w, 'one warning for the one service').to.have.length(1)
            expect(w[0]).to.include(serviceImageTarPath('', IMAGE).slice(1))
            expect(w[0]).to.include(c.kind === 'noTar' ? 'not found' : 'failed')
        })
    }

    it('compose create fails (image not local, pull disallowed): Error, never Running, failed trace', { timeout: 120_000 }, async () => {
        await dockFixture(badCreate.fixtureDir, badCreate.device)
        expect(await waitForStatus(storeHandle, badCreate.instanceId, 'Error', 90_000), 'should end in Error').to.be.true
        expect(badCreate.statuses, 'must never show Running').to.not.include('Running')
        expect(badCreate.statuses, 'create never succeeded').to.not.include('Pauzed')
        const inst = storeHandle.doc()!.instanceDB[badCreate.instanceId as any]
        expect(inst.statusCondition ?? '').to.include('Engine error')
        const failed = await waitFor(storeHandle, () => tracesOf(logHandle, badCreate.instanceId).some(t => t.status === 'error'), 10_000)
        expect(failed, 'a failed startInstance trace should be in the command log').to.be.true
        const t = tracesOf(logHandle, badCreate.instanceId)
        expect(t.map(x => x.status), 'exactly one trace, failed (not ok)').to.deep.equal(['error'])
        expect(t[0].errorMessage ?? '').to.not.equal('')
        expect(warnLines(t[0]), 'the missing tar is a warning in the same entry').to.have.length(1)
        const ps = await $`docker ps -aq --filter label=${TEST_CONTAINER_LABEL} --filter name=${badCreate.instanceId}`
        expect(ps.stdout.trim(), 'no container should exist').to.equal('')
    })

    it('compose up fails (bad entrypoint): Error, never Running, failed trace', { timeout: 120_000 }, async () => {
        await dockFixture(badUp.fixtureDir, badUp.device)
        expect(await waitForStatus(storeHandle, badUp.instanceId, 'Error', 90_000), 'should end in Error').to.be.true
        expect(badUp.statuses, 'create succeeded (Pauzed)').to.include('Pauzed')
        expect(badUp.statuses, 'must never show Running').to.not.include('Running')
        const failed = await waitFor(storeHandle, () => tracesOf(logHandle, badUp.instanceId).some(t => t.status === 'error'), 10_000)
        expect(failed, 'a failed startInstance trace should be in the command log').to.be.true
        const t = tracesOf(logHandle, badUp.instanceId)
        expect(t.map(x => x.status), 'exactly one trace, failed (not ok)').to.deep.equal(['error'])
        expect(t[0].errorMessage ?? '').to.not.equal('')
        const op = Object.values(storeHandle.doc()!.operationDB ?? {}).find((o: any) =>
            o.kind === 'startApp' && o.args?.instanceId === badUp.instanceId) as any
        expect(op?.status, 'the startApp operation is Failed').to.equal('Failed')
        expect(runningContainerNow(badUp.instanceId), 'no container runs').to.be.false
    })

    it('createInstanceContainers rejects instead of swallowing the compose create error', { timeout: 60_000 }, async () => {
        const doc = storeHandle.doc()!
        const inst = doc.instanceDB[badCreate.instanceId as any]
        const disk = doc.diskDB[inst.storedOn as any]
        expect(disk, 'the bad-create disk is in the store').to.not.equal(undefined)
        let caught: unknown = null
        try {
            await createInstanceContainers(storeHandle, inst, disk)
        } catch (e) {
            caught = e
        }
        expect(caught, 'createInstanceContainers should reject').to.not.equal(null)
        expect(storeHandle.doc()!.instanceDB[badCreate.instanceId as any].status, 'not moved to Pauzed').to.equal('Error')
    })
})
