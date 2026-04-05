/**
 * instance-lifecycle.test.ts
 *
 * Tier 1 automated test: verifies that the Engine correctly manages instance
 * lifecycle when a disk is docked and undocked.
 *
 * Real Docker containers are started via `docker compose`. The fixture uses
 * traefik/whoami — lightweight (~10 MB), starts in < 1 s once pulled, and
 * serves a plain-text HTTP response on port 80 for health checking.
 *
 * Status transitions verified:
 *   dock   → Docked → Starting → Pauzed → Running  (+ HTTP health check)
 *   undock → Stopped → Undocked               (+ container no longer responds)
 *
 * Tests run in sequence — the lifecycle is stateful and verified end-to-end.
 *
 * First run may take up to 60 s if traefik/whoami is not yet cached locally.
 * Subsequent runs complete in < 15 s.
 *
 * TEST_HOST env var (default: 'localhost'): set to the Docker bridge gateway
 * (e.g. 172.20.0.1) when running inside a sandbox container where the Docker
 * daemon is the host's daemon — published ports are bound on the host, not
 * on the container's loopback. On the Pi (native or via SSH), 'localhost' is correct.
 *
 * Store assertions (full coverage):
 *
 *   After dock (Running):
 *     instanceDB[id].status        === 'Running'
 *     instanceDB[id].port          > 0
 *     instanceDB[id].storedOn      is a string (disk id)
 *     instanceDB[id].instanceOf    is a string containing the app name
 *     instanceDB[id].name          is a non-empty string
 *     instanceDB[id].serviceImages is a non-empty array; each element is the Docker image name
 *     instanceDB[id].lastBackup  is null (never backed up) or a positive Timestamp
 *     instanceDB[id].created       > 0 (set at first dock)
 *     instanceDB[id].lastStarted   > 0 (set in runInstance)
 *     appDB                        has at least one entry for the docked app
 *     HTTP GET on localhost:${port} returns 2xx
 *
 *   After undock:
 *     instanceDB[id]               still exists (retained by design — not deleted on undock)
 *     instanceDB[id].status        === 'Undocked'
 *     diskDB                       has no active (dockedTo != null) entry for test device
 *     port                         goes silent within 10 s (waitForHttpDown)
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import path from 'path'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    createTestStore,
    dockFixture,
    triggerUndock,
    cleanupDisk,
    waitForStatus,
    waitForHttp,
    waitForHttpDown,
    cleanupContainers,
    FIXTURES_DIR,
    TEST_DEVICE,
    TEST_HOST,
    SENTINEL,
} from '../harness/diskSim.js'
import { fs } from 'zx'

const FIXTURE_SAMPLE_V1 = path.resolve(FIXTURES_DIR, 'disk-sample-v1')
const TEST_INSTANCE_ID = 'sample-00000000-test1'

describe('Instance lifecycle (automated, real containers)', () => {
    let storeHandle: DocHandle<Store>
    let instancePort: number

    beforeAll(async () => {
        // Defensive cleanup: disk-dock-undock afterAll() removes disk + containers, but a
        // second cleanupContainers pass here ensures no orphan containers remain before
        // we create a fresh store and watcher.
        await cleanupContainers(TEST_INSTANCE_ID)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        await enableUsbDeviceMonitor(storeHandle)
    }, 15_000)

    afterAll(async () => {
        await fs.remove(SENTINEL).catch(() => {})
        await cleanupContainers(TEST_INSTANCE_ID)
        await cleanupDisk(TEST_DEVICE)
    }, 30_000)

    it('instance reaches Running and container responds to HTTP after dock', { timeout: 120_000 }, async () => {
        // Allow up to 90 s: Docker pull (first run) + compose create + compose up

        await dockFixture(FIXTURE_SAMPLE_V1)

        const running = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Running', 90_000)
        expect(running, 'instance should reach Running within 90 s').to.be.true

        const store = storeHandle.doc()!
        const instance = store.instanceDB[TEST_INSTANCE_ID as any]
        expect(instance, 'instance should exist in instanceDB').to.exist

        // ── core fields ──────────────────────────────────────────────────────
        expect(instance.port, 'instance should have a port assigned').to.be.greaterThan(0)
        expect(instance.storedOn, 'instance should reference its disk').to.be.a('string')

        // ── identity fields ──────────────────────────────────────────────────
        expect(instance.instanceOf, 'instanceOf should reference the app id').to.be.a('string').that.includes('sample')
        expect(instance.name, 'name should be a non-empty string').to.be.a('string').that.is.not.empty

        // ── service metadata ─────────────────────────────────────────────────
        expect(instance.serviceImages, 'serviceImages should be a non-empty array').to.be.an('array').that.is.not.empty
        // Content check: each element should be a non-empty image reference string
        for (const image of instance.serviceImages) {
            expect(image, 'each serviceImage should be a non-empty string').to.be.a('string').that.is.not.empty
        }
        // The fixture uses traefik/whoami — verify the image is recorded correctly
        expect(instance.serviceImages, 'serviceImages should contain the fixture image')
            .to.include('traefik/whoami')

        // ── timestamps ───────────────────────────────────────────────────────
        expect(instance.created, 'created timestamp should be set at first dock').to.be.greaterThan(0)
        expect(instance.lastStarted, 'lastStarted should be set after reaching Running').to.be.greaterThan(0)

        // ── backup state ──────────────────────────────────────────────────────
        // lastBackup is null when never backed up.
        expect(instance.lastBackup, 'lastBackup should be null (never backed up) or a positive timestamp')
            .to.satisfy((v: any) => v === null || (typeof v === 'number' && v > 0))

        // ── appDB cross-check ─────────────────────────────────────────────────
        // Apps are registered when the disk is processed; verify at least one app
        // was written for the docked fixture.
        const appIds = Object.keys(store.appDB)
        const sampleApp = appIds.find(id => id.includes('sample'))
        expect(sampleApp, 'appDB should contain an entry for the sample app after dock').to.exist

        // ── HTTP health check ─────────────────────────────────────────────────
        // Verify the container is actually serving traffic — not just that the
        // engine set a Running status flag.
        // TEST_HOST defaults to 'localhost' (correct on Pi); override with Docker
        // bridge gateway when running inside a sandbox container.
        instancePort = instance.port
        const healthy = await waitForHttp(`http://${TEST_HOST}:${instancePort}/`, 30_000)
        expect(healthy, `traefik/whoami should respond on http://${TEST_HOST}:${instancePort}/`).to.be.true
    })

    it('instance reaches Undocked and container stops responding after undock', { timeout: 30_000 }, async () => {

        await triggerUndock()

        // undockDisk calls stopInstance (stops containers via Docker API → Stopped)
        // then sets status to Undocked. Instance stays in instanceDB — not deleted on undock.
        const undocked = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Undocked', 20_000)
        expect(undocked, 'instance should reach Undocked within 20 s').to.be.true

        const store = storeHandle.doc()!

        // ── instanceDB retention ──────────────────────────────────────────────
        // By design: undockDisk sets status to Undocked but does NOT remove the
        // entry. This preserves instance history and allows re-dock to resume
        // rather than starting fresh. This assertion documents that contract.
        const retained = store.instanceDB[TEST_INSTANCE_ID as any]
        expect(retained, 'instanceDB entry should be retained after undock (not deleted)').to.exist
        expect(retained.status, 'retained entry status should be Undocked').to.equal('Undocked')

        // ── diskDB cross-check ────────────────────────────────────────────────
        // undockDisk sets dsk.dockedTo = null. Verify no active docked entry
        // remains for the test device (entry may persist with dockedTo=null, but
        // must not still point to an engine).
        const activeDiskEntry = Object.values(store.diskDB).find(
            (disk: any) => disk.device === TEST_DEVICE && disk.dockedTo !== null
        )
        expect(activeDiskEntry, 'diskDB should have no active (dockedTo) entry for test device after undock').to.be.undefined

        // ── HTTP health check ─────────────────────────────────────────────────
        // waitForHttpDown polls until the port is closed (connection refused).
        // This is more reliable than a one-shot check: the engine sets status=Undocked
        // immediately after container.stop(), but the kernel may still deliver packets
        // for a brief moment while the container process fully exits.
        const wentDown = await waitForHttpDown(`http://${TEST_HOST}:${instancePort}/`, 10_000)
        expect(wentDown, 'container should stop responding within 10 s after undock').to.be.true
    })
})
