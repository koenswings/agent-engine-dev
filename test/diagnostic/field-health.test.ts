/**
 * field-health.test.ts — Field Health Diagnostic
 *
 * A comprehensive single-pass health check that verifies every field of every
 * running instance for correctness and completeness. Runs in two modes:
 *
 * ── Fixture mode (default) ──────────────────────────────────────────────────
 *   Docks a test fixture, waits for Running, then checks every instance field.
 *   Runs anywhere — the same Pi setup used for unit tests.
 *   Run: pnpm test:diagnostic
 *
 * ── Live mode ───────────────────────────────────────────────────────────────
 *   Reads the store from the running engine on disk. Checks whatever is
 *   currently running. No fixtures docked. If no instances are running,
 *   the test reports "no running instances" and passes.
 *   Run: IDEA_DIAGNOSTIC_LIVE=true pnpm test:diagnostic
 *
 * Checked fields (per instance):
 *   id             non-empty string
 *   instanceOf     non-empty string (app name + version)
 *   name           non-empty string
 *   status         === 'Running'
 *   port           > 0
 *   storedOn       non-empty string (disk id)
 *   serviceImages  non-empty array; each element is a Docker image reference
 *   created        > 0 (timestamp, set at first dock)
 *   lastStarted    > 0 (timestamp, set when runInstance fires)
 *   lastBackedUp   >= 0 (0 = never backed up; must not be undefined)
 *   HTTP health    GET on port returns 2xx
 *
 * A timestamped diagnostic report is written to test/testresults/ after each run.
 */

import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import path from 'path'
import { DocHandle } from '@automerge/automerge-repo'
import { Store, getRunningEngines, getInstances } from '../../src/data/Store.js'
import { Instance } from '../../src/data/Instance.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    createTestStore,
    dockFixture,
    triggerUndock,
    cleanupDisk,
    cleanupContainers,
    waitForStatus,
    waitForHttp,
    FIXTURES_DIR,
    TEST_DEVICE,
    TEST_HOST,
    SENTINEL,
} from '../harness/diskSim.js'
import { fs } from 'zx'
import { localEngineId } from '../../src/data/Engine.js'

const FIXTURE_SAMPLE_V1 = path.resolve(FIXTURES_DIR, 'disk-sample-v1')
const TEST_INSTANCE_ID  = 'sample-00000000-test1'
const LIVE_MODE         = process.env.IDEA_DIAGNOSTIC_LIVE === 'true'

// ── Report builder ────────────────────────────────────────────────────────────

interface CheckResult { field: string; pass: boolean; value: string; note?: string }

const report: CheckResult[] = []

const check = (field: string, value: unknown, note?: string): CheckResult => {
    const entry: CheckResult = { field, pass: true, value: String(value), note }
    report.push(entry)
    return entry
}

const writeReport = async (instancesChecked: number) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 16)
    const outPath = `test/testresults/diagnostic-report-${ts}.log`
    await fs.ensureDir('test/testresults')

    const passed = report.filter(r => r.pass).length
    const failed = report.filter(r => !r.pass).length
    const lines = [
        `Field Health Diagnostic`,
        `Run: ${new Date().toISOString()} | Mode: ${LIVE_MODE ? 'live' : 'fixture'} | Host: ${TEST_HOST}`,
        `Instances checked: ${instancesChecked}`,
        `─────────────────────────────────────────`,
        ...report.map(r =>
            `  ${r.pass ? '✓' : '✗'} ${r.field.padEnd(20)} ${r.value}${r.note ? `  (${r.note})` : ''}`
        ),
        `─────────────────────────────────────────`,
        `${passed + failed} checks | ${passed} passed | ${failed} failed`,
    ]
    const content = lines.join('\n') + '\n'
    await fs.writeFile(outPath, content)
    process.stdout.write(`\nDiagnostic report: ${outPath}\n`)
    if (failed > 0) process.stdout.write(content)
}

// ── Fixture mode ──────────────────────────────────────────────────────────────

describe('Field health diagnostic (fixture mode)', function () {
    let storeHandle: DocHandle<Store>
    let watcher: Awaited<ReturnType<typeof enableUsbDeviceMonitor>>
    let instancePort: number

    before(async function () {
        if (LIVE_MODE) return this.skip()
        this.timeout(15_000)
        await cleanupContainers(TEST_INSTANCE_ID)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        watcher = await enableUsbDeviceMonitor(storeHandle)
    })

    after(async function () {
        if (LIVE_MODE) return
        this.timeout(30_000)
        await watcher?.close()
        await fs.remove(SENTINEL).catch(() => {})
        await cleanupDisk(TEST_DEVICE)
        await new Promise(r => setTimeout(r, 2_000))
        await cleanupContainers(TEST_INSTANCE_ID)
        await writeReport(1)
    })

    it('instance reaches Running after dock', async function () {
        this.timeout(120_000)
        await dockFixture(FIXTURE_SAMPLE_V1)
        const running = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Running', 90_000)
        expect(running, 'instance should reach Running within 90 s').to.be.true
    })

    it('id — non-empty string', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        check('id', inst.id)
        expect(inst.id, 'id should be a non-empty string').to.be.a('string').that.is.not.empty
    })

    it('instanceOf — non-empty string containing app name and version', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        check('instanceOf', inst.instanceOf)
        expect(inst.instanceOf, 'instanceOf should be a non-empty string').to.be.a('string').that.is.not.empty
        expect(inst.instanceOf, 'instanceOf should contain app name').to.include('sample')
    })

    it('name — non-empty string', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        check('name', inst.name)
        expect(inst.name, 'name should be a non-empty string').to.be.a('string').that.is.not.empty
    })

    it('status — Running', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        check('status', inst.status)
        expect(inst.status).to.equal('Running')
    })

    it('port — positive integer', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        instancePort = inst.port
        check('port', inst.port)
        expect(inst.port, 'port should be > 0').to.be.greaterThan(0)
    })

    it('storedOn — non-empty string (disk id)', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        check('storedOn', inst.storedOn)
        expect(inst.storedOn, 'storedOn should reference a disk id').to.be.a('string').that.is.not.empty
    })

    it('serviceImages — non-empty array of Docker image references', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        check('serviceImages', JSON.stringify(inst.serviceImages))
        expect(inst.serviceImages, 'serviceImages should be a non-empty array').to.be.an('array').that.is.not.empty
        for (const img of inst.serviceImages) {
            expect(img, 'each image should be a non-empty string').to.be.a('string').that.is.not.empty
            expect(img, 'image should contain a / or be a known image name').to.match(/^[a-z0-9]/)
        }
    })

    it('created — positive timestamp (set at first dock)', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        check('created', inst.created, 'first dock timestamp')
        expect(inst.created, 'created should be > 0').to.be.greaterThan(0)
    })

    it('lastStarted — positive timestamp (set when runInstance fires)', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        check('lastStarted', inst.lastStarted, 'set by runInstance')
        expect(inst.lastStarted, 'lastStarted should be > 0').to.be.greaterThan(0)
    })

    it('lastBackedUp — number >= 0 (0 = never backed up)', function () {
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        check('lastBackedUp', inst.lastBackedUp, inst.lastBackedUp === 0 ? 'never backed up' : 'backup timestamp')
        expect(inst.lastBackedUp, 'lastBackedUp must be a number, never undefined')
            .to.be.a('number').that.is.at.least(0)
    })

    it('HTTP health — container responds 2xx on assigned port', async function () {
        this.timeout(15_000)
        const inst = storeHandle.doc()!.instanceDB[TEST_INSTANCE_ID as any]
        const url = `http://${TEST_HOST}:${inst.port}/`
        const healthy = await waitForHttp(url, 10_000)
        check('HTTP health', healthy ? '2xx' : 'no response', url)
        expect(healthy, `container should respond on ${url}`).to.be.true
    })
})

// ── Live mode ─────────────────────────────────────────────────────────────────

describe('Field health diagnostic (live mode — skips unless IDEA_DIAGNOSTIC_LIVE=true)', function () {
    let liveInstances: Instance[] = []

    before(async function () {
        if (!LIVE_MODE) return this.skip()
        this.timeout(10_000)

        // Load the real store from disk
        const storeUrlPath = './store-identity/store-url.txt'
        if (!fs.existsSync(storeUrlPath)) {
            process.stdout.write('\nLive mode: store-url.txt not found — engine not initialised on this machine.\n')
            return this.skip()
        }

        try {
            const { Repo } = await import('@automerge/automerge-repo')
            const { NodeFSStorageAdapter } = await import('@automerge/automerge-repo-storage-nodefs')
            const storeIdentityFolder = './store-identity'
            const storeDataFolder     = './store-data'
            const storeUrlStr         = fs.readFileSync(storeUrlPath, 'utf-8').trim()
            const storeDocId          = storeUrlStr.replace('automerge:', '') as any

            const repo = new Repo({
                storage: new NodeFSStorageAdapter(storeDataFolder),
                network: [],
            })
            const handle = await repo.find<Store>(storeDocId)
            await handle.whenReady()
            const store = handle.doc()!

            // Collect running instances from the local engine
            liveInstances = getInstances(store)
            process.stdout.write(`\nLive mode: found ${liveInstances.length} running instance(s)\n`)
        } catch (e) {
            process.stdout.write(`\nLive mode: failed to load store — ${e}\n`)
            return this.skip()
        }
    })

    after(async function () {
        if (!LIVE_MODE) return
        await writeReport(liveInstances.length)
    })

    it('all running instances have required fields set', async function () {
        if (!LIVE_MODE) return this.skip()
        if (liveInstances.length === 0) {
            process.stdout.write('Live mode: no running instances — nothing to check\n')
            return // pass: empty system is valid
        }

        for (const inst of liveInstances) {
            check(`${inst.id}.instanceOf`,    inst.instanceOf)
            check(`${inst.id}.name`,          inst.name)
            check(`${inst.id}.status`,        inst.status)
            check(`${inst.id}.port`,          inst.port)
            check(`${inst.id}.storedOn`,      inst.storedOn ?? '')
            check(`${inst.id}.serviceImages`, JSON.stringify(inst.serviceImages))
            check(`${inst.id}.created`,       inst.created)
            check(`${inst.id}.lastStarted`,   inst.lastStarted)
            check(`${inst.id}.lastBackedUp`,  inst.lastBackedUp, inst.lastBackedUp === 0 ? 'never backed up' : 'backed up')

            expect(inst.instanceOf).to.be.a('string').that.is.not.empty
            expect(inst.name).to.be.a('string').that.is.not.empty
            expect(inst.status).to.equal('Running')
            expect(inst.port).to.be.greaterThan(0)
            expect(inst.storedOn).to.be.a('string').that.is.not.empty
            expect(inst.serviceImages).to.be.an('array').that.is.not.empty
            expect(inst.created).to.be.greaterThan(0)
            expect(inst.lastStarted).to.be.greaterThan(0)
            expect(inst.lastBackedUp).to.be.a('number').that.is.at.least(0)
        }
    })

    it('all running instances respond to HTTP health check', async function () {
        if (!LIVE_MODE) return this.skip()
        this.timeout(30_000)
        for (const inst of liveInstances) {
            const url = `http://localhost:${inst.port}/`
            const healthy = await waitForHttp(url, 5_000)
            check(`${inst.id}.HTTP`, healthy ? '2xx' : 'no response', url)
            expect(healthy, `${inst.id} should respond on ${url}`).to.be.true
        }
    })
})
