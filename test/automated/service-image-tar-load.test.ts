/**
 * service-image-tar-load.test.ts — offline service image loading (idea#81)
 *
 * Schools have no internet: an App starts by loading its Docker images from
 * services/<image>.tar on the App Disk (startInstance, step 3). This suite runs
 * that real code path on a fixture disk, with no network pulls:
 *
 *   1. Tag a tiny local image (traefik/whoami) with a per-run nonce:
 *      idea-test/tarload:<nonce>. The tag exists in no registry.
 *   2. `docker save` it into services/ of a temporary fixture disk, using the
 *      Engine's file naming ('/' → '_'), written out by hand here so that a
 *      change to the Engine's mapping breaks this test.
 *   3. `docker image rm` the tag, so the image can only come back from the tar.
 *   4. Dock the disk with settings.skipImageLoad = false (testMode stays on, so
 *      the mount is still skipped) and wait for Running.
 *   5. Verify the image is back (`docker image inspect`), the labelled container
 *      runs and answers HTTP. The compose file sets `pull_policy: never`, so
 *      Docker never tries to fetch anything.
 *
 * A second disk whose tar is missing checks the negative case: the instance
 * must end in Error and the image must not appear (no network fallback).
 *
 * Cleanup removes only this run's nonce-tagged images and its own labelled
 * containers — never any other image.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import os from 'os'
import crypto from 'crypto'
import { $, fs, path, YAML } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { config, skipImageLoad } from '../../src/data/Config.js'
import { serviceImageTarPath } from '../../src/data/Instance.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    createTestStore,
    dockFixture,
    triggerUndock,
    cleanupDisk,
    cleanupContainers,
    waitForStatus,
    waitForHttp,
    uniqueTestDevice,
    TEST_CONTAINER_LABEL,
    TEST_CONTAINER_LABEL_KEY,
    TEST_CONTAINER_LABEL_VALUE,
    TEST_HOST,
} from '../harness/diskSim.js'

const BASE_IMAGE = 'traefik/whoami'
const IMAGE_REPO = 'idea-test/tarload'

const imageExists = async (image: string): Promise<boolean> => {
    const r = await $`docker image inspect ${image}`.quiet().nothrow()
    return r.exitCode === 0
}

/** Poll until a labelled container of the instance is running. */
const waitForRunningContainer = async (instanceId: string, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const ps = await $`docker ps -q --filter label=${TEST_CONTAINER_LABEL} --filter name=${instanceId} --filter status=running`.quiet().nothrow()
        if (ps.stdout.trim() !== '') return true
        await new Promise(r => setTimeout(r, 300))
    }
    return false
}

interface TarLoadCase {
    nonce: string
    image: string
    instanceId: string
    device: string
    fixtureDir: string
}

const newCase = (): TarLoadCase => {
    const nonce = crypto.randomBytes(6).toString('hex')
    return {
        nonce,
        image: `${IMAGE_REPO}:${nonce}`,
        instanceId: `tarload-${nonce}-idea81`,
        device: uniqueTestDevice(),
        fixtureDir: '',
    }
}

/**
 * Write a minimal App Disk for one instance of the `tarload` app whose only
 * service uses the nonce-tagged image. When saveTar is true, the image is
 * saved to services/<image with / → _>.tar.
 */
const buildFixtureDisk = async (c: TarLoadCase, saveTar: boolean): Promise<void> => {
    c.fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-tarload-'))
    const service = {
        image: c.image,
        pull_policy: 'never',
        labels: { [TEST_CONTAINER_LABEL_KEY]: TEST_CONTAINER_LABEL_VALUE },
        ports: ['${port}:80'],
        restart: 'no',
    }
    const xApp = {
        name: 'tarload',
        version: '1.0',
        title: 'Tar load test app',
        description: 'Synthetic test fixture (idea#81)',
        category: 'education',
        url: 'http://localhost:${port}',
        icon: '',
        author: 'IDEA Test Harness',
    }
    await fs.outputFile(path.join(c.fixtureDir, 'META.yaml'), YAML.stringify({
        diskId: `test-fixture-tarload-${c.nonce}`,
        isHardwareId: false,
        diskName: `test-tarload-${c.nonce}`,
        created: 1700000000000,
        lastDocked: 1700000000000,
    }))
    await fs.outputFile(path.join(c.fixtureDir, 'apps', 'tarload-1.0', 'compose.yaml'),
        YAML.stringify({ services: { tarload: service }, 'x-app': xApp }))
    await fs.outputFile(path.join(c.fixtureDir, 'instances', c.instanceId, 'compose.yaml'),
        YAML.stringify({ services: { tarload: service }, 'x-app': { ...xApp, instanceName: `tarload-${c.nonce}` } }))
    await fs.ensureDir(path.join(c.fixtureDir, 'services'))
    if (saveTar) {
        // Engine naming, spelled out independently: idea-test/tarload:<nonce> → idea-test_tarload:<nonce>.tar
        const tar = path.join(c.fixtureDir, 'services', `idea-test_tarload:${c.nonce}.tar`)
        await $`docker save -o ${tar} ${c.image}`.quiet()
    }
}

const cleanupCase = async (c: TarLoadCase): Promise<void> => {
    await triggerUndock(c.device).catch(() => {})
    await cleanupContainers(c.instanceId)
    await cleanupDisk(c.device).catch(() => {})
    if (c.fixtureDir) await fs.remove(c.fixtureDir).catch(() => {})
    // Only ever remove this run's own nonce tag (untags; the base image stays).
    if (await imageExists(c.image)) await $`docker image rm ${c.image}`.quiet().nothrow()
}

describe('skipImageLoad / serviceImageTarPath (idea#81)', () => {
    it('follows testMode when skipImageLoad is unset, and overrides it when set', () => {
        const saved = { testMode: config.settings.testMode, skip: config.settings.skipImageLoad }
        try {
            config.settings.skipImageLoad = undefined
            config.settings.testMode = false
            expect(skipImageLoad(), 'production (testMode off) loads the tars').to.equal(false)
            config.settings.testMode = true
            expect(skipImageLoad(), 'tests skip the tar load by default').to.equal(true)
            config.settings.skipImageLoad = false
            expect(skipImageLoad(), 'skipImageLoad=false forces the tar load in testMode').to.equal(false)
            config.settings.testMode = false
            config.settings.skipImageLoad = true
            expect(skipImageLoad(), 'skipImageLoad=true skips the tar load').to.equal(true)
        } finally {
            config.settings.testMode = saved.testMode
            config.settings.skipImageLoad = saved.skip
        }
    })

    it('maps every / in the image name to _', () => {
        expect(serviceImageTarPath('/disks/sda1', 'traefik/whoami')).to.equal('/disks/sda1/services/traefik_whoami.tar')
        expect(serviceImageTarPath('/d', 'ghcr.io/org/app:1.2')).to.equal('/d/services/ghcr.io_org_app:1.2.tar')
        expect(serviceImageTarPath('/d', 'nginx:latest')).to.equal('/d/services/nginx:latest.tar')
    })
})

describe('Service images load from services/*.tar on the App Disk (idea#81, real containers)', () => {
    let storeHandle: DocHandle<Store>
    const savedSkip = config.settings.skipImageLoad
    const good = newCase()
    const missing = newCase()

    beforeAll(async () => {
        // Setup only: the base image must be local so we can tag it. The Engine
        // path under test never pulls (pull_policy: never + unpublished tag).
        if (!(await imageExists(BASE_IMAGE))) await $`docker pull ${BASE_IMAGE}`.quiet()

        for (const c of [good, missing]) {
            await $`docker tag ${BASE_IMAGE} ${c.image}`.quiet()
        }
        await buildFixtureDisk(good, true)
        await buildFixtureDisk(missing, false)
        for (const c of [good, missing]) {
            await $`docker image rm ${c.image}`.quiet()
            expect(await imageExists(c.image), `${c.image} should be gone before docking`).to.be.false
        }

        // Run the real tar-load path; testMode stays on (mount skipped for fixtures).
        config.settings.skipImageLoad = false
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        await enableUsbDeviceMonitor(storeHandle)
    }, 120_000)

    afterAll(async () => {
        await cleanupCase(good)
        await cleanupCase(missing)
        config.settings.skipImageLoad = savedSkip
    }, 60_000)

    it('the fixture tar uses the Engine file name', () => {
        expect(fs.existsSync(serviceImageTarPath(good.fixtureDir, good.image)),
            'services/idea-test_tarload:<nonce>.tar should be where the Engine looks').to.be.true
    })

    it('loads the image from the tar and reaches Running without network access', { timeout: 120_000 }, async () => {
        await dockFixture(good.fixtureDir, good.device)

        const running = await waitForStatus(storeHandle, good.instanceId, 'Running', 90_000)
        expect(running, 'instance should reach Running within 90 s').to.be.true

        expect(await imageExists(good.image), `${good.image} should be loaded from the tar`).to.be.true

        // Running is written just before `docker compose up`; confirm the container really runs.
        expect(await waitForRunningContainer(good.instanceId, 30_000), 'the labelled container should be running').to.be.true

        const instance = storeHandle.doc()!.instanceDB[good.instanceId as any]
        expect(instance.serviceImages).to.include(good.image)
        expect(instance.port).to.be.greaterThan(0)
        const healthy = await waitForHttp(`http://${TEST_HOST}:${instance.port}/`, 30_000)
        expect(healthy, 'container started from the loaded image should answer HTTP').to.be.true
        expect(storeHandle.doc()!.instanceDB[good.instanceId as any].status).to.equal('Running')
    })

    it('fails with Error (no network fallback) when the tar is missing', { timeout: 120_000 }, async () => {
        await dockFixture(missing.fixtureDir, missing.device)

        const errored = await waitForStatus(storeHandle, missing.instanceId, 'Error', 90_000)
        expect(errored, 'instance without its tar should end in Error').to.be.true

        const condition = storeHandle.doc()!.instanceDB[missing.instanceId as any].statusCondition ?? ''
        expect(condition, 'the error should point at the missing tar').to.include('idea-test_tarload')
        expect(await imageExists(missing.image), 'the image must not appear from anywhere else').to.be.false
        const ps = await $`docker ps -aq --filter label=${TEST_CONTAINER_LABEL} --filter name=${missing.instanceId}`
        expect(ps.stdout.trim(), 'no container should be created').to.equal('')
    })
})
