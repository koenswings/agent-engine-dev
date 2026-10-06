/**
 * docker-available.test.ts (idea#168 Stage 1)
 *
 * The Docker-only paths ask dockerAvailable() instead of testMode, so the
 * duration pool (testMode for fixture disks, real Docker) gets them:
 *   1. dockerAvailable(): settings.dockerAvailable / IDEA_DOCKER_AVAILABLE wins;
 *      else a cached `docker info` probe (ok cached 10 min, fail 60 s), shared
 *      by concurrent callers, never throws.
 *   2. pollDockerMetricsOnce writes metrics under testMode when Docker answers,
 *      and runs no docker command when it does not.
 *   3. startInstance's "containers already running" shortcut works under
 *      testMode when Docker answers (Running, port from .env, no compose).
 *   4. diagnoseInstance includes container logs under testMode when Docker answers.
 * zx `$` is wrapped: docker commands are answered by the test, nothing else changes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const docker = vi.hoisted(() => ({ available: true, calls: [] as string[], running: '' }))

vi.mock('../../src/utils/dockerAvailable.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, dockerAvailable: vi.fn(async () => docker.available) }
})

vi.mock('zx', async (importOriginal) => {
    const actual = await importOriginal<any>()
    const wrapped = vi.fn((strings: any, ...vals: any[]) => {
        const cmd = Array.isArray(strings)
            ? strings.reduce((acc: string, s: string, i: number) => acc + s + (i < vals.length ? [vals[i]].flat().map(String).join(' ') : ''), '')
            : String(strings)
        const c = cmd.replace(/\s+/g, ' ').trim()
        if (/^docker\b/.test(c)) {
            docker.calls.push(c)
            let stdout = ''
            if (c.startsWith('docker ps')) stdout = docker.running
            else if (c.startsWith('docker stats')) stdout = JSON.stringify({ Name: `${docker.running.trim()}`, CPUPerc: '12.5%', MemUsage: '256MiB / 1GiB', MemPerc: '25%', NetIO: '1kB / 2kB', BlockIO: '10MB / 5MB' }) + '\n'
            else if (c.startsWith('docker logs')) stdout = 'kolibri: boot failed: database is locked\n'
            const p: any = Promise.resolve({ stdout, stderr: '', exitCode: 0 })
            p.quiet = () => p
            p.nothrow = () => p
            return p
        }
        return actual.$(strings, ...vals)
    }) as any
    Object.assign(wrapped, actual.$)
    wrapped.sync = actual.$.sync
    return { ...actual, $: wrapped }
})

import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { config, disksRoot } from '../../src/data/Config.js'
import { pollDockerMetricsOnce } from '../../src/monitors/dockerMetricsMonitor.js'
import { startInstance, diagnoseInstance } from '../../src/data/Instance.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'

const INST = 'kolibri-dock-avail-001' as InstanceID
const DEV = 'idea-test-71'
const DISK = 'DISK_dock-avail' as DiskID

const makeHandle = async (status = 'Running'): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {},
        diskDB: {
            [DISK]: { id: DISK, name: 'Kolibri' as DiskName, device: DEV as any, dockedTo: localEngineId as EngineID, created: 0 as Timestamp, lastDocked: 0 as Timestamp, diskTypes: ['app'], backupConfig: null },
        },
        appDB: {},
        instanceDB: {
            [INST]: {
                id: INST, instanceOf: 'kolibri-1.0', name: 'kolibri', status, port: 0, serviceImages: ['koenswings/kolibri:1.0-0.15.5-dev'],
                created: 0, lastBackup: null, lastStarted: 0, statusCondition: null, storedOn: DISK,
                currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            },
        },
        userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}

const savedTestMode = config.settings.testMode

beforeEach(async () => {
    docker.available = true
    docker.calls.length = 0
    docker.running = ''
    config.settings.testMode = true
    await fs.ensureDir(`${disksRoot()}/${DEV}/instances/${INST}`)
    await fs.writeFile(`${disksRoot()}/${DEV}/instances/${INST}/.env`, 'port=18123\n')
    vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(async () => {
    vi.restoreAllMocks()
    config.settings.testMode = savedTestMode
    await fs.remove(`${disksRoot()}/${DEV}`)
})

describe('dockerAvailable() (real module)', () => {
    let real: typeof import('../../src/utils/dockerAvailable.js')
    const saved = config.settings.dockerAvailable
    beforeEach(async () => {
        real = await vi.importActual<typeof import('../../src/utils/dockerAvailable.js')>('../../src/utils/dockerAvailable.js')
        config.settings.dockerAvailable = undefined
    })
    afterEach(() => {
        config.settings.dockerAvailable = saved
        real.setDockerProbeForTests(null)
    })

    it('settings.dockerAvailable wins over the probe (true and false); testMode plays no part', async () => {
        const probe = vi.fn(async () => true)
        real.setDockerProbeForTests(probe)
        config.settings.dockerAvailable = false
        expect(await real.dockerAvailable()).toBe(false)
        config.settings.dockerAvailable = true
        probe.mockResolvedValue(false)
        expect(await real.dockerAvailable()).toBe(true)
        expect(probe).not.toHaveBeenCalled()
    })

    it('probe result is cached: ok for 10 min, failure for 60 s; concurrent callers share one probe; a throwing probe is false', async () => {
        let t = 1_000_000
        const probe = vi.fn(async () => true)
        real.setDockerProbeForTests(probe, () => t)
        const [a, b] = await Promise.all([real.dockerAvailable(), real.dockerAvailable()])
        expect([a, b]).toEqual([true, true])
        expect(probe).toHaveBeenCalledTimes(1)
        t += real.DOCKER_PROBE_TTL_OK_MS - 1
        expect(await real.dockerAvailable()).toBe(true)
        expect(probe).toHaveBeenCalledTimes(1)
        t += 2
        probe.mockRejectedValueOnce(new Error('docker: command not found'))
        expect(await real.dockerAvailable()).toBe(false)
        expect(probe).toHaveBeenCalledTimes(2)
        t += real.DOCKER_PROBE_TTL_FAIL_MS - 1
        expect(await real.dockerAvailable()).toBe(false)
        t += 2
        expect(await real.dockerAvailable()).toBe(true)                 // daemon came up later
        expect(probe).toHaveBeenCalledTimes(3)
    })

    it('IDEA_DOCKER_AVAILABLE=true|false sets settings.dockerAvailable at load; other values leave it unset', async () => {
        const prev = process.env.IDEA_DOCKER_AVAILABLE
        try {
            for (const [env, want] of [['true', true], ['false', false], ['1', undefined]] as const) {
                vi.resetModules()
                process.env.IDEA_DOCKER_AVAILABLE = env
                const fresh = await vi.importActual<typeof import('../../src/data/Config.js')>('../../src/data/Config.js')
                expect(fresh.config.settings.dockerAvailable, `IDEA_DOCKER_AVAILABLE=${env}`).toBe(want)
            }
        } finally {
            if (prev === undefined) delete process.env.IDEA_DOCKER_AVAILABLE
            else process.env.IDEA_DOCKER_AVAILABLE = prev
            vi.resetModules()
        }
    })
})

describe('Docker-only paths follow dockerAvailable(), not testMode', () => {
    it('metrics poll: testMode + Docker → metrics written; no Docker → no docker command at all', async () => {
        const h = await makeHandle('Running')
        docker.running = `${INST}-kolibri-1\n`
        await pollDockerMetricsOnce(h)
        const m = h.doc().instanceDB[INST].metrics as any
        expect(m?.cpuPercent).toBe(12.5)
        expect(m?.memUsageBytes).toBe(256 * 1024 ** 2)

        docker.available = false
        docker.calls.length = 0
        h.change(d => { (d.instanceDB[INST] as any).metrics = null })
        await pollDockerMetricsOnce(h)
        expect(docker.calls).toEqual([])
        expect(h.doc().instanceDB[INST].metrics).toBeNull()
    })

    it('startInstance: testMode + Docker + containers already up → Running with the .env port, no compose', async () => {
        const h = await makeHandle('Stopped')
        docker.running = `${INST}-kolibri-1\n`
        await startInstance(h, h.doc().instanceDB[INST] as any, h.doc().diskDB[DISK] as any)
        const inst = h.doc().instanceDB[INST]
        expect(inst.status).toBe('Running')
        expect(inst.port).toBe(18123)
        expect(docker.calls).toEqual([`docker ps --filter name=${INST} --format {{.Names}}`])
    })

    it('startInstance: no Docker → the shortcut never asks docker ps', async () => {
        const h = await makeHandle('Stopped')
        docker.available = false
        docker.running = `${INST}-kolibri-1\n`
        await startInstance(h, h.doc().instanceDB[INST] as any, h.doc().diskDB[DISK] as any).catch(() => undefined)
        expect(docker.calls.filter(c => c.startsWith('docker ps --filter name='))).toEqual([])
    })

    it('diagnoseInstance: container logs under testMode when Docker answers; only the error without Docker', async () => {
        const h = await makeHandle('Error')
        const inst = h.doc().instanceDB[INST] as any
        const disk = h.doc().diskDB[DISK] as any
        const withLogs = await diagnoseInstance(inst, disk, new Error('compose up failed'))
        expect(withLogs).toContain('Engine error: compose up failed')
        expect(withLogs).toContain('Container logs (kolibri):\n  kolibri: boot failed: database is locked')
        expect(docker.calls).toEqual([`docker logs --tail=20 ${INST}-kolibri-1`])
        docker.available = false
        expect(await diagnoseInstance(inst, disk, new Error('compose up failed'))).toBe('Engine error: compose up failed')
    })
})
