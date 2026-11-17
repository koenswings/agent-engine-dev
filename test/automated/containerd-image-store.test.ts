/**
 * containerd-image-store.test.ts — idea#322: digest verify and selfCheck
 * require Docker's containerd image store. Every docker info answer is faked;
 * the host Docker (classic overlay2 on the box) is never probed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
    CONTAINERD_IMAGE_STORE_REQUIRED,
    CONTAINERD_SNAPSHOTTER_DRIVER_TYPE,
    DOCKER_UNAVAILABLE,
    ImageStoreError,
    assertContainerdImageStore,
    detectContainerdImageStore,
    hasContainerdImageStore,
    parseDriverStatus,
    setImageStoreForTests,
    type DockerInfoExec,
    type ImageStoreCheck,
} from '../../src/utils/containerdImageStore.js'
import {
    containerdImageStoreProblem,
    runContainerdImageStoreSelfCheck,
} from '../../src/monitors/containerdImageStoreCheck.js'
import { verifyServiceImageDigest } from '../../src/data/Instance.js'

const CONTAINERD_JSON = `[["driver-type","${CONTAINERD_SNAPSHOTTER_DRIVER_TYPE}"]]`
const CLASSIC_JSON = '[["Backing Filesystem","extfs"],["Supports d_type","true"],["Using metacopy","false"],["Native Overlay Diff","true"],["userxattr","false"]]'
const CONTAINERD_GO = `[[driver-type ${CONTAINERD_SNAPSHOTTER_DRIVER_TYPE}]]`
const CLASSIC_GO = '[[Backing Filesystem extfs] [Supports d_type true] [Using metacopy false] [Native Overlay Diff true] [userxattr false]]'

const execOf = (r: { exitCode: number, stdout?: string, stderr?: string } | Error): DockerInfoExec => {
    return async () => {
        if (r instanceof Error) throw r
        return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    }
}

const classicCheck = async (): Promise<ImageStoreCheck> =>
    detectContainerdImageStore(execOf({ exitCode: 0, stdout: CLASSIC_JSON }))

describe('parseDriverStatus', () => {
    it('parses JSON DriverStatus for the containerd store', () => {
        const pairs = parseDriverStatus(CONTAINERD_JSON)
        expect(pairs).toEqual([['driver-type', CONTAINERD_SNAPSHOTTER_DRIVER_TYPE]])
        expect(hasContainerdImageStore(pairs!)).toBe(true)
    })
    it('parses JSON DriverStatus for the classic overlay2 store (box Docker 27)', () => {
        const pairs = parseDriverStatus(CLASSIC_JSON)
        expect(pairs).toEqual([
            ['Backing Filesystem', 'extfs'],
            ['Supports d_type', 'true'],
            ['Using metacopy', 'false'],
            ['Native Overlay Diff', 'true'],
            ['userxattr', 'false'],
        ])
        expect(hasContainerdImageStore(pairs!)).toBe(false)
    })
    it('tolerates leading and trailing whitespace around JSON', () => {
        expect(parseDriverStatus(`\n${CONTAINERD_JSON}\n`)).toEqual([['driver-type', CONTAINERD_SNAPSHOTTER_DRIVER_TYPE]])
    })
    it('treats null or empty DriverStatus as an empty list (not containerd)', () => {
        expect(parseDriverStatus('null')).toEqual([])
        expect(parseDriverStatus('')).toEqual([])
        expect(parseDriverStatus('[]')).toEqual([])
        expect(hasContainerdImageStore([])).toBe(false)
    })
    it('parses the raw Go {{.DriverStatus}} text, including keys with spaces', () => {
        expect(parseDriverStatus(CONTAINERD_GO)).toEqual([['driver-type', CONTAINERD_SNAPSHOTTER_DRIVER_TYPE]])
        expect(hasContainerdImageStore(parseDriverStatus(CLASSIC_GO)!)).toBe(false)
        expect(parseDriverStatus(CLASSIC_GO)?.[0]).toEqual(['Backing Filesystem', 'extfs'])
        expect(parseDriverStatus(CLASSIC_GO)?.[3]).toEqual(['Native Overlay Diff', 'true'])
    })
    it('does not treat io.containerd.runc.v2 or a wrong driver-type as the image store', () => {
        expect(hasContainerdImageStore(parseDriverStatus('[["runtime","io.containerd.runc.v2"]]')!)).toBe(false)
        expect(hasContainerdImageStore(parseDriverStatus('[["driver-type","overlay2"]]')!)).toBe(false)
    })
    it('returns null for unparseable text (not a false containerd pass)', () => {
        expect(parseDriverStatus('Storage Driver: overlay2')).toBeNull()
        expect(parseDriverStatus('not json')).toBeNull()
        expect(parseDriverStatus('{"driver-type":"io.containerd.snapshotter.v1"}')).toBeNull()
        expect(parseDriverStatus('[["driver-type"]]')).toBeNull()
    })
})

describe('detectContainerdImageStore (fake exec)', () => {
    it('reports containerd when DriverStatus has driver-type io.containerd.snapshotter.v1', async () => {
        const check = await detectContainerdImageStore(execOf({ exitCode: 0, stdout: CONTAINERD_JSON }))
        expect(check).toMatchObject({ kind: 'containerd', containerd: true })
        expect(check.driverStatus?.[0]).toEqual(['driver-type', CONTAINERD_SNAPSHOTTER_DRIVER_TYPE])
    })
    it('reports classic when DriverStatus is the overlay2 list', async () => {
        const check = await classicCheck()
        expect(check).toMatchObject({ kind: 'classic', containerd: false })
        expect(check.driverStatus?.some(([k]) => k === 'Backing Filesystem')).toBe(true)
    })
    it('reports unreachable when docker exits non-zero', async () => {
        const check = await detectContainerdImageStore(execOf({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon\n' }))
        expect(check).toMatchObject({ kind: 'unreachable', containerd: false, driverStatus: null })
        expect(check.detail).toMatch(/Cannot connect to the Docker daemon/)
    })
    it('reports unreachable when the exec throws (docker missing or timed out)', async () => {
        const check = await detectContainerdImageStore(execOf(new Error('docker: command not found')))
        expect(check).toMatchObject({ kind: 'unreachable', containerd: false })
        expect(check.detail).toMatch(/command not found/)
    })
    it('reports unknown when stdout cannot be parsed', async () => {
        const check = await detectContainerdImageStore(execOf({ exitCode: 0, stdout: 'Storage Driver: overlay2\n' }))
        expect(check).toMatchObject({ kind: 'unknown', containerd: false, driverStatus: null })
        expect(check.detail).toMatch(/unparseable DriverStatus/)
    })
})

describe('runContainerdImageStoreSelfCheck', () => {
    const watchDir = process.env.IDEA_WATCH_DIR
    afterEach(() => {
        if (watchDir === undefined) delete process.env.IDEA_WATCH_DIR
        else process.env.IDEA_WATCH_DIR = watchDir
    })

    it('is skipped in test runs (IDEA_WATCH_DIR is set)', async () => {
        process.env.IDEA_WATCH_DIR = '/tmp/idea-test-watch'
        const detect = vi.fn(classicCheck)
        expect(await runContainerdImageStoreSelfCheck({ detect })).toBeNull()
        expect(detect).not.toHaveBeenCalled()
    })
    it('is silent when the mocked store is containerd', async () => {
        delete process.env.IDEA_WATCH_DIR
        const msg = await runContainerdImageStoreSelfCheck({
            skip: false,
            detect: () => detectContainerdImageStore(execOf({ exitCode: 0, stdout: CONTAINERD_JSON })),
        })
        expect(msg).toBeNull()
    })
    it('reports a named CONTAINERD_IMAGE_STORE_REQUIRED problem on the classic store', async () => {
        delete process.env.IDEA_WATCH_DIR
        const check = await classicCheck()
        const msg = await runContainerdImageStoreSelfCheck({ skip: false, detect: async () => check })
        expect(msg).toBe(containerdImageStoreProblem(check))
        expect(msg).toMatch(new RegExp(`^${CONTAINERD_IMAGE_STORE_REQUIRED}:`))
        expect(msg).toMatch(/not using the containerd image store/)
        expect(msg).toMatch(/driver-type io\.containerd\.snapshotter\.v1/)
        expect(msg).toMatch(/RepoDigests do not survive/)
        expect(msg).toMatch(/idea#322/)
    })
    it('reports a named DOCKER_UNAVAILABLE problem when Docker is down', async () => {
        delete process.env.IDEA_WATCH_DIR
        const check = await detectContainerdImageStore(execOf({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon' }))
        const msg = await runContainerdImageStoreSelfCheck({ skip: false, detect: async () => check })
        expect(msg).toMatch(new RegExp(`^${DOCKER_UNAVAILABLE}:`))
        expect(msg).toMatch(/did not answer/)
        expect(msg).toMatch(/Cannot connect to the Docker daemon/)
    })
})

describe('assertContainerdImageStore / verifyServiceImageDigest early fail', () => {
    const PINNED = `koenswings/kolibri:1.1-0.19.5@sha256:${'a'.repeat(64)}`
    beforeEach(() => setImageStoreForTests(null))
    afterEach(() => setImageStoreForTests(null))

    it('throws CONTAINERD_IMAGE_STORE_REQUIRED on the classic store without inspecting the image', async () => {
        setImageStoreForTests(execOf({ exitCode: 0, stdout: CLASSIC_JSON }))
        await expect(assertContainerdImageStore()).rejects.toSatisfy((e: unknown) => {
            expect(e).toBeInstanceOf(ImageStoreError)
            const err = e as ImageStoreError
            expect(err.code).toBe(CONTAINERD_IMAGE_STORE_REQUIRED)
            expect(err.message).toMatch(new RegExp(`^${CONTAINERD_IMAGE_STORE_REQUIRED}:`))
            expect(err.message).toMatch(/not using the containerd image store/)
            return true
        })
        await expect(verifyServiceImageDigest(PINNED)).rejects.toThrow(ImageStoreError)
        await expect(verifyServiceImageDigest(PINNED)).rejects.toThrow(CONTAINERD_IMAGE_STORE_REQUIRED)
    })
    it('throws DOCKER_UNAVAILABLE when Docker is down, without a digest-mismatch message', async () => {
        setImageStoreForTests(execOf({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon' }))
        await expect(assertContainerdImageStore()).rejects.toSatisfy((e: unknown) => {
            expect(e).toBeInstanceOf(ImageStoreError)
            const err = e as ImageStoreError
            expect(err.code).toBe(DOCKER_UNAVAILABLE)
            expect(err.message).toMatch(new RegExp(`^${DOCKER_UNAVAILABLE}:`))
            expect(err.message).not.toMatch(/per-platform manifest digest/)
            return true
        })
        await expect(verifyServiceImageDigest(PINNED)).rejects.toThrow(DOCKER_UNAVAILABLE)
    })
    it('does not throw when the mocked store is containerd (tag-only still skips the check)', async () => {
        setImageStoreForTests(execOf({ exitCode: 0, stdout: CONTAINERD_JSON }))
        await expect(assertContainerdImageStore()).resolves.toBeUndefined()
        // tag-only returns before the store check; this must stay silent even on classic
        setImageStoreForTests(execOf({ exitCode: 0, stdout: CLASSIC_JSON }))
        await expect(verifyServiceImageDigest('koenswings/kolibri:1.1-0.19.5')).resolves.toBeUndefined()
    })
})
