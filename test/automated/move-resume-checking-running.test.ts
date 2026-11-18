/**
 * move-resume-checking-running.test.ts — engine#511 Finding 3 (two-Pi proof M3, 2026-11-17).
 *
 * M3: a cross-Engine move idea04 → idea03 reached Checking; idea03 started the marked copy (`--op`,
 * deferred) and its first verifyMoveTarget passed, then cleared the port-ready progress (finally).
 * The SOURCE Engine was cut and resumed AT checking (no second push) and sent `startInstance … --op`
 * and `verifyMoveTarget` again. The copy was still running on the target, so the start took the
 * "containers already running" shortcut, which did not probe the port: the second verify waited
 * for a `stableReached` that never came and answered VERIFY_NOT_RUNNING (RESUME_PENDING 1/3).
 *
 * Here: the real startInstance (Docker answered by a wrapped zx `$`, like docker-available.test.ts)
 * and the real verifyMoveTarget, against a local HTTP server on the copy's .env port.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const docker = vi.hoisted(() => ({ calls: [] as string[], running: '' }))

vi.mock('../../src/utils/dockerAvailable.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, dockerAvailable: vi.fn(async () => true) }
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
            const stdout = c.startsWith('docker ps') ? docker.running : ''
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

import http from 'node:http'
import { AddressInfo } from 'node:net'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { disksRoot } from '../../src/data/Config.js'
import { startInstance } from '../../src/data/Instance.js'
import { verifyMoveTarget } from '../../src/data/MoveAppRemote.js'
import { getPortReadyProgress, resetPortReadyProgressForTests } from '../../src/data/PortReadyProgress.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'

const INST = 'kolibri-m3-resume-001' as InstanceID
const DEV = 'idea-test-511'
const DISK = 'DISK_m3-target' as DiskID
const OP = 'op-m3-511'
const BYTES = 4096

let server: http.Server
let port = 0

const makeHandle = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {},
        diskDB: {
            [DISK]: { id: DISK, name: 'target' as DiskName, device: DEV as any, dockedTo: localEngineId as EngineID, created: 0 as Timestamp, lastDocked: 0 as Timestamp, diskTypes: ['app'], backupConfig: null },
        },
        appDB: {},
        instanceDB: {
            // the shared row stays the source's (storedOn the source disk) until the flip
            [INST]: {
                id: INST, instanceOf: 'kolibri-1.0', name: 'axle511-i5', status: 'Stopped', port: 0, serviceImages: [],
                created: 0, lastBackup: null, lastStarted: 0, statusCondition: null, storedOn: 'DISK_source-elsewhere',
                currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            },
        },
        userDB: {},
        operationDB: {
            [OP]: {
                id: OP, kind: 'moveApp', engineId: 'ENGINE_source', status: 'Running', error: null,
                args: { instanceId: INST, sourceDiskId: 'DISK_source-elsewhere', targetDiskId: DISK, crossEngine: 'true', crossResume: '1', phase: 'checking', wasRunning: '1' },
                move: { phase: 'checking', targetEngineId: localEngineId, sourceInstanceId: INST, targetInstanceId: INST, verify: null, verified: false },
            },
        },
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}

beforeEach(async () => {
    docker.calls.length = 0
    docker.running = ''
    server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
    await fs.ensureDir(`${disksRoot()}/${DEV}/instances/${INST}`)
    await fs.writeFile(`${disksRoot()}/${DEV}/instances/${INST}/.env`, `port=${port}\n`)
    vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(async () => {
    vi.restoreAllMocks()
    resetPortReadyProgressForTests()
    await new Promise<void>(r => server.close(() => r()))
    await fs.remove(`${disksRoot()}/${DEV}`)
})

const verify = (h: DocHandle<Store>, timeoutMs = 4000) =>
    verifyMoveTarget(h, OP, INST, String(BYTES), 'true', { localEngineId: async () => String(localEngineId), targetBytes: async () => BYTES, timeoutMs, pollMs: 20, progressIntervalMs: 50 })

describe('engine#511 Finding 3: resume at Checking while the target copy is already running', () => {
    it('the M3 sequence: first verify ok and clears progress → resumed `--op` start of the RUNNING copy re-checks port-ready → the second verify is ok (not VERIFY_NOT_RUNNING)', async () => {
        const h = await makeHandle()
        // the first run: the copy is already up (as after the first --op start); its port-ready passes
        docker.running = `${INST}-kolibri-1\n`
        const first = verify(h)
        await startInstance(h, h.doc().instanceDB[INST] as any, h.doc().diskDB[DISK] as any, 'cross-engine-cmd', { deferStoreStatus: true, inFlightOpId: OP, portStableMs: 200 })
        expect((await first).ok).toBe(true)
        expect(getPortReadyProgress(INST)).toBeUndefined()                  // cleared by the first verify (finally)

        // the source was cut and resumed AT checking: verify reset, start + verify sent again
        h.change(d => { (d.operationDB as any)[OP].move.verify = null })
        const second = verify(h)
        await startInstance(h, h.doc().instanceDB[INST] as any, h.doc().diskDB[DISK] as any, 'cross-engine-cmd', { deferStoreStatus: true, inFlightOpId: OP, portStableMs: 200 })
        const v = await second
        expect(v).toMatchObject({ ok: true, code: null, bytes: BYTES })
        expect((h.doc().operationDB as any)[OP].move.verify).toMatchObject({ ok: true })
        // the shortcut was taken both times (no compose up), and the shared row was not written
        expect(docker.calls.filter(c => c.startsWith('docker compose'))).toEqual([])
        expect(h.doc().instanceDB[INST].status).toBe('Stopped')
        expect(h.doc().instanceDB[INST].storedOn).toBe('DISK_source-elsewhere')
    })

    it('without the --op (a plain deferred start), the shortcut still does not probe (unchanged); a dead port on the --op re-check fails the start loud (PORT_NOT_READY), never a full start', async () => {
        const h = await makeHandle()
        docker.running = `${INST}-kolibri-1\n`
        await startInstance(h, h.doc().instanceDB[INST] as any, h.doc().diskDB[DISK] as any, 'cross-engine-cmd', { deferStoreStatus: true })
        expect(getPortReadyProgress(INST)).toBeUndefined()
        // the copy's port stops answering (a closed port)
        const dead = http.createServer()
        await new Promise<void>(r => dead.listen(0, '127.0.0.1', () => r()))
        const deadPort = (dead.address() as AddressInfo).port
        await new Promise<void>(r => dead.close(() => r()))
        await fs.writeFile(`${disksRoot()}/${DEV}/instances/${INST}/.env`, `port=${deadPort}\n`)
        await fs.writeFile(`${disksRoot()}/${DEV}/instances/${INST}/compose.yaml`, 'services: {}\nx-app:\n  healthTimeout: 1\n')
        await expect(startInstance(h, h.doc().instanceDB[INST] as any, h.doc().diskDB[DISK] as any, 'cross-engine-cmd', { deferStoreStatus: true, inFlightOpId: OP, portStableMs: 200 }))
            .rejects.toThrow(/PORT_NOT_READY/)
        expect(docker.calls.filter(c => c.startsWith('docker compose'))).toEqual([])
    })
})
