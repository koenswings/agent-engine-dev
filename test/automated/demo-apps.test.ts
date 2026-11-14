/**
 * demo-apps.test.ts — setupDemo / removeDemo refusals, source selection,
 * INTERRUPTED/resume, step ids, copy/move/backup NOT_DEMO (engine#369).
 * Downloads are injected fakes; IDEA_NETWORK_TESTS stays unset.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import {
    setupDemo, removeDemo, DemoError, stepPlan, parseAppsList, parseAppsFlag,
    demoKey, markDemoInterrupted, resetDemoHbForTests,
} from '../../src/data/DemoApps.js'
import { recoverInterruptedOperations } from '../../src/data/Operations.js'
import { validate } from '../../src/data/CopyMoveApp.js'
import { backupInstance } from '../../src/monitors/backupMonitor.js'
import { resourceLock } from '../../src/utils/ResourceLock.js'
import { stampComposeInstanceIdentity } from '../../src/data/InstanceCopy.js'
import type { InstanceID } from '../../src/data/CommonTypes.js'

const ME = String(localEngineId)
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const CREDITS = 'thanks\n'
const packDoc = (packVersion = 4) => ({
    schemaVersion: 1,
    packVersion,
    app: 'kolibri',
    minAppVersion: '1.2',
    bytes: Buffer.byteLength(CREDITS),
    credits: 'CREDITS.txt',
    hooks: [{ id: 'seed', needs: 'stopped' }, { id: 'classwork', needs: 'running' }],
    files: [{ path: 'CREDITS.txt', sha256: sha(CREDITS), bytes: Buffer.byteLength(CREDITS) }],
})

const appYaml = (sha256: string, bytes: number, minVersion = 3) => `name: kolibri
version: 1.2-0.19.5
demo:
  name: "Kolibri Demo"
  minEngine: "1.0"
  pack:
    file: idea-demo-kolibri-v4.tar
    url: https://example.invalid/idea-demo-kolibri-v4.tar
    sha256: "${sha256}"
    bytes: ${bytes}
    minVersion: ${minVersion}
  reserveBytes: 1000
  steps:
    - { id: seed,      run: demo/hook.sh seed,      needs: stopped, timeoutSec: 60 }
    - { id: classwork, run: demo/hook.sh classwork, needs: running, timeoutSec: 60 }
`

let h: DocHandle<Store>, tmp: string, hooks: string[], downloads: string[], broadcasts: any[]

const writeValidPack = async (dir: string, packVersion = 4) => {
    await fs.outputFile(path.join(dir, 'CREDITS.txt'), CREDITS)
    await fs.outputFile(path.join(dir, 'pack.json'), JSON.stringify(packDoc(packVersion), null, 2))
}

const releaseLocks = () => { for (const k of resourceLock.allLocks().keys()) resourceLock.release(k) }

const seedStore = async (over: { extraDisks?: Record<string, any>, instances?: Record<string, any> } = {}) => {
    h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(doc => {
        doc.diskDB['d1' as any] = { id: 'd1', name: 'Apps', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
        if (over.extraDisks) Object.assign(doc.diskDB, over.extraDisks)
        if (over.instances) Object.assign(doc.instanceDB, over.instances)
    })
}

const deps = (over: Record<string, unknown> = {}) => ({
    mountRoot: async () => tmp,
    hasInternet: async () => false,
    availableBytes: async () => 50 * 1024 ** 3,
    install: async (args: any) => {
        const id = 'inst-k'
        await fs.outputFile(path.join(tmp, 'instances', id, 'compose.yaml'), 'services: {}\nx-app:\n  instanceName: Kolibri Demo\n  demo: true\n')
        h.change(doc => {
            doc.instanceDB[id as any] = { id, name: args.instanceName, storedOn: 'd1', instanceOf: args.appId, status: 'Stopped', port: 50001, demo: true } as any
        })
        return id as InstanceID
    },
    start: async (inst: any) => { h.change(d => { (d.instanceDB[inst.id] as any).status = 'Running' }) },
    stop: async (inst: any) => { h.change(d => { (d.instanceDB[inst.id] as any).status = 'Stopped' }) },
    remove: async (instanceArg: string) => {
        const id = instanceArg
        h.change(d => { delete d.instanceDB[id as any] })
        return { instanceId: id as InstanceID, quarantinePath: `${tmp}/.idea-quarantine/${id}`, keptVolumes: [] as string[] }
    },
    runHook: async ({ step }: { step: string }) => { hooks.push(step); return { code: 0, stderr: '' } },
    download: async (url: string, dest: string) => { downloads.push(url); throw new Error('download should be mocked in this test') },
    broadcast: (m: any) => { broadcasts.push(m) },
    now: () => Date.now(),
    sleep: async () => {},
    ...over,
})

const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message) } }

beforeEach(async () => {
    hooks = []; downloads = []; broadcasts = []
    resetDemoHbForTests()
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-apps-'))
    const bundle = path.join(tmp, 'apps', 'kolibri-1.2-0.19.5')
    await fs.outputFile(path.join(bundle, 'app.yaml'), appYaml('a'.repeat(64), 100, 3))
    await fs.outputFile(path.join(bundle, 'demo', 'hook.sh'), '#!/bin/bash\nexit 0\n')
    await fs.outputFile(path.join(bundle, 'compose.yaml'), 'services:\n  web:\n    image: x\n')
    await seedStore()
})
afterEach(async () => { releaseLocks(); await fs.remove(tmp) })

describe('parseAppsList / parseAppsFlag', () => {
    it('parses a comma string and the --apps flag', () => {
        expect(parseAppsList('kolibri,nextcloud')).toEqual(['kolibri', 'nextcloud'])
        expect(parseAppsFlag(['--apps', 'kolibri'])).toEqual(['kolibri'])
        expect(parseAppsFlag([])).toEqual(['kolibri', 'nextcloud'])
        expect(() => parseAppsList('kiwix')).toThrow(DemoError)
        expect(() => parseAppsList('kiwix')).toThrow(/UNKNOWN_APP/)
    })
})

describe('setupDemo refusals (no Operation)', () => {
    it('NOT_FOUND / NOT_DOCKED / SYSTEM_DISK / NOT_APP_DISK', async () => {
        expect(await codeOf(setupDemo(h, 'no-such', ['kolibri'], ME, deps()))).toMatch(/^NOT_FOUND: /)
        h.change(doc => { doc.diskDB['away' as any] = { id: 'away', name: 'Away', device: null, dockedTo: null, diskTypes: ['app'] } as any })
        expect(await codeOf(setupDemo(h, 'away', ['kolibri'], ME, deps()))).toMatch(/^NOT_DOCKED: /)
        h.change(doc => { doc.diskDB['sys' as any] = { id: 'sys', name: 'System', device: 'idea-test-sys', dockedTo: ME, diskTypes: ['system'] } as any })
        expect(await codeOf(setupDemo(h, 'sys', ['kolibri'], ME, deps()))).toMatch(/^SYSTEM_DISK: /)
        h.change(doc => { doc.diskDB['bk' as any] = { id: 'bk', name: 'Backup', device: 'idea-test-b', dockedTo: ME, diskTypes: ['backup'] } as any })
        expect(await codeOf(setupDemo(h, 'bk', ['kolibri'], ME, deps()))).toMatch(/^NOT_APP_DISK: /)
        expect(Object.keys(h.doc().operationDB ?? {})).toHaveLength(0)
    })

    it('DEMO_EXISTS when a set already lives on another docked disk; DEMO_AMBIGUOUS when split across disks', async () => {
        h.change(doc => {
            doc.diskDB['d2' as any] = { id: 'd2', name: 'Other', device: 'idea-test-2', dockedTo: ME, diskTypes: ['app'] } as any
            doc.instanceDB['demo-on-d2' as any] = { id: 'demo-on-d2', name: 'Kolibri Demo', storedOn: 'd2', instanceOf: 'kolibri-1.2-0.19.5', status: 'Running', demo: true } as any
        })
        expect(await codeOf(setupDemo(h, 'd1', ['kolibri'], ME, deps()))).toMatch(/^DEMO_EXISTS: /)
        h.change(doc => {
            doc.instanceDB['demo-on-d1' as any] = { id: 'demo-on-d1', name: 'Nextcloud Demo', storedOn: 'd1', instanceOf: 'nextcloud-1.0', status: 'Running', demo: true } as any
        })
        expect(await codeOf(setupDemo(h, 'd1', ['kolibri'], ME, deps()))).toMatch(/^DEMO_AMBIGUOUS: /)
        expect(Object.keys(h.doc().operationDB ?? {})).toHaveLength(0)
    })

    it('BUSY when the Engine demo lock is held', async () => {
        expect(resourceLock.acquire(demoKey(ME), 'setupDemo')).toBe(true)
        expect(await codeOf(setupDemo(h, 'd1', ['kolibri'], ME, deps()))).toMatch(/^BUSY: /)
    })

    it('NO_SOURCE when offline and there is no local pack; PACK_OUTDATED when the only local pack is too old', async () => {
        expect(await codeOf(setupDemo(h, 'd1', ['kolibri'], ME, deps({ hasInternet: async () => false })))).toMatch(/^NO_SOURCE: /)
        const idea = path.join(tmp, 'IDEA-DEMO', 'kolibri')
        await writeValidPack(idea, 1)
        expect(await codeOf(setupDemo(h, 'd1', ['kolibri'], ME, deps({ hasInternet: async () => false })))).toMatch(/^PACK_OUTDATED: /)
        expect(Object.keys(h.doc().operationDB ?? {})).toHaveLength(0)
    })
})

describe('setupDemo happy path and resume', () => {
    it('installs from a local pack, uses stable step ids, never downloads, and records args as a comma string', async () => {
        await writeValidPack(path.join(tmp, 'IDEA-DEMO', 'kolibri'), 4)
        const r = await setupDemo(h, 'd1', ['kolibri'], ME, deps())
        expect(r.code).toBe('DEMO_READY')
        expect(r.apps[0].instanceId).toBe('inst-k')
        expect(r.apps[0].source).toBe('local')
        expect(hooks).toEqual(['seed', 'classwork'])
        expect(downloads).toEqual([])
        const ops = Object.values(h.doc().operationDB)
        expect(ops).toHaveLength(1)
        const op = ops[0] as any
        expect(op.kind).toBe('setupDemo')
        expect(op.args).toEqual({ targetDiskId: 'd1', apps: 'kolibri' })
        expect(op.status).toBe('Done')
        expect(op.demo.code).toBe('DEMO_READY')
        expect(op.demo.apps[0].steps.map((s: any) => s.id)).toEqual(['install', 'download', 'verify', 'seed', 'start', 'ready', 'classwork'])
        expect(op.demo.apps[0].steps.every((s: any) => s.status === 'done')).toBe(true)
        expect(h.doc().instanceDB['inst-k' as any].demo).toBe(true)
        expect(stepPlan({ name: 'Kolibri Demo', pack: null, reserveBytes: 0, steps: [
            { id: 'seed', run: 'demo/hook.sh seed', needs: 'stopped', timeoutSec: 1 },
            { id: 'classwork', run: 'demo/hook.sh classwork', needs: 'running', timeoutSec: 1 },
        ] })).toEqual(['install', 'download', 'verify', 'seed', 'start', 'ready', 'classwork'])
    })

    it('downloads the sha256-pinned GitHub asset when no local pack is present (mocked)', async () => {
        const payload = path.join(tmp, 'payload')
        await writeValidPack(payload, 4)
        const tar = path.join(tmp, 'idea-demo-kolibri-v4.tar')
        const { $ } = await import('zx')
        await $`tar -cf ${tar} -C ${payload} pack.json CREDITS.txt`
        const digest = sha(await fs.readFile(tar))
        await fs.outputFile(path.join(tmp, 'apps', 'kolibri-1.2-0.19.5', 'app.yaml'), appYaml(digest, (await fs.stat(tar)).size, 3))
        const r = await setupDemo(h, 'd1', ['kolibri'], ME, deps({
            hasInternet: async () => true,
            download: async (url: string, dest: string, onProgress?: Function) => {
                downloads.push(url)
                onProgress?.(10, 100)
                await fs.copy(tar, dest)
            },
        }))
        expect(r.code).toBe('DEMO_READY')
        expect(r.apps[0].source).toBe('github')
        expect(downloads).toEqual(['https://example.invalid/idea-demo-kolibri-v4.tar'])
        expect(broadcasts.some(m => m.type === 'idea/progress' && m.step === 'download' && m.opId)).toBe(true)
        expect(await fs.pathExists(path.join(tmp, 'instances', 'inst-k', 'demo-pack', 'x', 'pack.json'))).toBe(true)
    })

    it('CHECKSUM_MISMATCH when the downloaded tar does not match the pin', async () => {
        const tar = path.join(tmp, 'wrong.tar')
        await fs.outputFile(tar, 'not-the-pack')
        await fs.outputFile(path.join(tmp, 'apps', 'kolibri-1.2-0.19.5', 'app.yaml'), appYaml('b'.repeat(64), 12, 3))
        expect(await codeOf(setupDemo(h, 'd1', ['kolibri'], ME, deps({
            hasInternet: async () => true,
            download: async (_u: string, dest: string) => { await fs.copy(tar, dest) },
        })))).toMatch(/^CHECKSUM_MISMATCH: /)
        const op = Object.values(h.doc().operationDB)[0] as any
        expect(op.status).toBe('Failed')
        expect(op.error).toMatch(/^CHECKSUM_MISMATCH: /)
    })

    it('INTERRUPTED on recover, then setupDemo resumes an existing instance', async () => {
        await writeValidPack(path.join(tmp, 'IDEA-DEMO', 'kolibri'), 4)
        const instDir = path.join(tmp, 'instances', 'inst-k')
        await fs.outputFile(path.join(instDir, 'compose.yaml'), 'services: {}\nx-app:\n  instanceName: Kolibri Demo\n  demo: true\n')
        await writeValidPack(path.join(instDir, 'demo-pack', 'x'), 4)
        h.change(doc => {
            doc.instanceDB['inst-k' as any] = { id: 'inst-k', name: 'Kolibri Demo', storedOn: 'd1', instanceOf: 'kolibri-1.2-0.19.5', status: 'Stopped', port: 50001, demo: true } as any
            doc.operationDB['op-demo'] = {
                id: 'op-demo', kind: 'setupDemo',
                args: { targetDiskId: 'd1', apps: 'kolibri' },
                cause: 'console-command', subject: null, engineId: ME,
                status: 'Running', progressPercent: 20, currentStep: 0, totalSteps: 7, stepLabel: 'kolibri: download',
                startedAt: 0, completedAt: null, error: null,
                demo: {
                    targetDiskId: 'd1', code: null, resultText: null,
                    apps: [{ app: 'kolibri', instanceId: 'inst-k', source: 'local', packVersion: '4', code: null, detail: null,
                        steps: [
                            { id: 'install', status: 'done' }, { id: 'download', status: 'running' }, { id: 'verify', status: 'pending' },
                            { id: 'seed', status: 'pending' }, { id: 'start', status: 'pending' }, { id: 'ready', status: 'pending' },
                            { id: 'classwork', status: 'pending' },
                        ] }],
                },
            } as any
        })
        await recoverInterruptedOperations(h, {})
        const interrupted = h.doc().operationDB['op-demo'] as any
        expect(interrupted.status).toBe('Failed')
        expect(interrupted.error).toMatch(/^INTERRUPTED: /)
        expect(interrupted.demo.code).toBe('INTERRUPTED')
        // markDemoInterrupted is also safe to call twice
        markDemoInterrupted(h, 'op-demo')

        let installed = 0
        const r = await setupDemo(h, 'd1', ['kolibri'], ME, deps({
            install: async () => { installed += 1; return 'inst-k' as InstanceID },
        }))
        expect(r.code).toBe('DEMO_READY')
        expect(installed).toBe(0)
        expect(hooks).toEqual(['seed', 'classwork'])
    })
})

describe('removeDemo and other refusals', () => {
    it('NOT_DEMO refuses the whole command when any id is not a demo', async () => {
        h.change(doc => {
            doc.instanceDB['plain' as any] = { id: 'plain', name: 'Kolibri', storedOn: 'd1', instanceOf: 'kolibri-1.2-0.19.5', status: 'Running' } as any
            doc.instanceDB['demo-k' as any] = { id: 'demo-k', name: 'Kolibri Demo', storedOn: 'd1', instanceOf: 'kolibri-1.2-0.19.5', status: 'Running', demo: true } as any
        })
        expect(await codeOf(removeDemo(h, ['plain'], ME, deps()))).toMatch(/^NOT_DEMO: /)
        expect(Object.keys(h.doc().operationDB ?? {})).toHaveLength(0)
        expect(h.doc().instanceDB['plain' as any]).toBeTruthy()
    })

    it('removes docked demos and records instanceIds as a comma string', async () => {
        h.change(doc => {
            doc.instanceDB['demo-k' as any] = { id: 'demo-k', name: 'Kolibri Demo', storedOn: 'd1', instanceOf: 'kolibri-1.2-0.19.5', status: 'Running', demo: true } as any
        })
        const r = await removeDemo(h, ['demo-k'], ME, deps())
        expect(r.code).toBe('DEMO_REMOVED')
        expect(r.removed[0].instanceId).toBe('demo-k')
        const op = Object.values(h.doc().operationDB)[0] as any
        expect(op.kind).toBe('removeDemo')
        expect(op.args).toEqual({ instanceIds: 'demo-k' })
        expect(op.status).toBe('Done')
        expect(h.doc().instanceDB['demo-k' as any]).toBeUndefined()
    })
})

describe('copy / move / backup refusals', () => {
    it('validate(copy/move) returns NOT_DEMO for a demo instance', async () => {
        h.change(doc => {
            doc.diskDB['d2' as any] = { id: 'd2', name: 'Other', device: 'idea-test-2', dockedTo: ME, diskTypes: ['app'] } as any
            doc.instanceDB['demo-k' as any] = { id: 'demo-k', name: 'Kolibri Demo', storedOn: 'd1', instanceOf: 'kolibri-1.2-0.19.5', status: 'Stopped', demo: true } as any
        })
        expect(await validate(h.doc() as any, 'demo-k' as any, 'd1' as any, 'd2' as any, 'copy')).toMatch(/^NOT_DEMO: /)
        expect(await validate(h.doc() as any, 'demo-k' as any, 'd1' as any, 'd2' as any, 'move')).toMatch(/^NOT_DEMO: /)
    })

    it('backupInstance throws NOT_DEMO for a console backup of a demo instance', async () => {
        h.change(doc => {
            doc.diskDB['bk' as any] = { id: 'bk', name: 'Backup', device: 'idea-test-b', dockedTo: ME, diskTypes: ['backup'] } as any
            doc.instanceDB['demo-k' as any] = { id: 'demo-k', name: 'Kolibri Demo', storedOn: 'd1', instanceOf: 'kolibri-1.2-0.19.5', status: 'Running', demo: true } as any
        })
        await expect(backupInstance(h, 'demo-k' as any, h.doc().diskDB['bk' as any] as any, undefined, 'console-command'))
            .rejects.toThrow(/NOT_DEMO: /)
    })
})

describe('stampComposeInstanceIdentity', () => {
    it('writes x-app.demo on a demo and deletes the key otherwise', () => {
        const base = "services:\n  web:\n    image: x\nx-app:\n  name: kolibri\n  instanceName: Old\n"
        const demoed = stampComposeInstanceIdentity(base, { instanceName: 'Kolibri Demo', demo: true })
        expect(demoed).toMatch(/instanceName: Kolibri Demo/)
        expect(demoed).toMatch(/demo: true/)
        const cleared = stampComposeInstanceIdentity(demoed, { instanceName: 'Kolibri Demo' })
        expect(cleared).not.toMatch(/demo:/)
    })
})
