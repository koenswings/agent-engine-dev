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
 */

import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
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

    before(async function () {
        this.timeout(15_000)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        await enableUsbDeviceMonitor(storeHandle)
    })

    after(async function () {
        this.timeout(30_000)
        await fs.remove(SENTINEL).catch(() => {})
        await cleanupContainers(TEST_INSTANCE_ID)
        await cleanupDisk(TEST_DEVICE)
    })

    it('instance reaches Running and container responds to HTTP after dock', async function () {
        // Allow up to 90 s: Docker pull (first run) + compose create + compose up
        this.timeout(120_000)

        await dockFixture(FIXTURE_SAMPLE_V1)

        const running = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Running', 90_000)
        expect(running, 'instance should reach Running within 90 s').to.be.true

        const store = storeHandle.doc()!
        const instance = store.instanceDB[TEST_INSTANCE_ID as any]
        expect(instance, 'instance should exist in instanceDB').to.exist
        expect(instance.port, 'instance should have a port assigned').to.be.greaterThan(0)
        expect(instance.storedOn, 'instance should reference its disk').to.be.a('string')

        // Verify the container is actually serving traffic — not just that the
        // engine set a Running status flag.
        // TEST_HOST defaults to 'localhost' (correct on Pi); override with Docker
        // bridge gateway when running inside a sandbox container.
        instancePort = instance.port
        const healthy = await waitForHttp(`http://${TEST_HOST}:${instancePort}/`, 30_000)
        expect(healthy, `traefik/whoami should respond on http://${TEST_HOST}:${instancePort}/`).to.be.true
    })

    it('instance reaches Undocked and container stops responding after undock', async function () {
        this.timeout(30_000)

        await triggerUndock()

        // undockDisk calls stopInstance (stops containers via Docker API → Stopped)
        // then sets status to Undocked. Instance stays in instanceDB — not deleted on undock.
        const undocked = await waitForStatus(storeHandle, TEST_INSTANCE_ID, 'Undocked', 20_000)
        expect(undocked, 'instance should reach Undocked within 20 s').to.be.true

        // Verify the container is no longer serving traffic
        const stillAlive = await waitForHttp(`http://${TEST_HOST}:${instancePort}/`, 3_000)
        expect(stillAlive, 'container should not respond after undock').to.be.false
    })
})
