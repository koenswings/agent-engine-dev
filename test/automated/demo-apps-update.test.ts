/**
 * demo-apps-update.test.ts — updateApp keeps x-app.demo and sets demoPackWarning (engine#369).
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path, os, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { updateApp, UpdateDeps, refreshDemoPackWarning } from '../../src/data/UpdateApp.js'
import { resourceLock } from '../../src/utils/ResourceLock.js'

const ME = String(localEngineId)
const compose = (version: string, demo = true) =>
    `services:\n  web:\n    image: x\nx-app:\n  name: kolibri\n  version: "${version}"\n  instanceName: Kolibri Demo\n` + (demo ? '  demo: true\n' : '')

let h: DocHandle<Store>, tmp: string

const deps = (over: Partial<UpdateDeps> = {}): Partial<UpdateDeps> => ({
    helperProblem: async () => null,
    mountRoot: async () => tmp,
    verifySums: async () => true,
    fetch: async () => { throw new Error('no fetch expected') },
    estimate: async () => ({ folderBytes: 1000, volumeBytes: 0, freeBytes: 50 * 1024 ** 3 }),
    dirBytes: async () => 10,
    stop: async () => { h.change(d => { (d.instanceDB['i1' as any] as any).status = 'Stopped' }) },
    containerIds: async () => [],
    composeDown: async () => {},
    snapshot: async () => ({ path: `${tmp}/.pre-update/i1`, sizeBytes: 4096, previousQuarantinedAt: null, volumes: [] }),
    restoreSnapshot: async () => `${tmp}/.idea-quarantine/i1-x`,
    listSnapshots: async () => ({ snapshots: [{ instanceId: 'i1' as any, sizeBytes: 4096, complete: true }], preUpdateBytes: 4096, quarantineBytes: 0 }),
    reread: async () => {
        const text = await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')
        const v = text.match(/version: "([^"]+)"/)![1]
        const demo = /demo:\s*true/.test(text)
        h.change(d => {
            const i = d.instanceDB['i1' as any] as any
            i.instanceOf = `kolibri-${v}`
            if (demo) i.demo = true
            else delete i.demo
        })
    },
    start: async () => { h.change(d => { (d.instanceDB['i1' as any] as any).status = 'Running' }) },
    health: async () => ({ state: 'healthy', restartCount: 0 }),
    probe: async () => ({ status: 200, body: 'ok' }),
    broadcast: () => {},
    now: () => Date.now(),
    sleep: async () => {},
    stopWaitMs: 1000, pollMs: 1,
    ...over,
})

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-upd-'))
    await fs.outputFile(`${tmp}/instances/i1/compose.yaml`, compose('1.0', true))
    await fs.outputFile(`${tmp}/instances/i1/.env`, 'port=50001\n')
    await fs.outputFile(`${tmp}/apps/kolibri-1.1/compose.yaml`, compose('1.1', false))
    await fs.outputFile(`${tmp}/apps/kolibri-1.1/.env`, 'port=1\n')
    await fs.outputFile(`${tmp}/apps/kolibri-1.1/app.yaml`, `name: kolibri\nversion: "1.1"\ndemo:\n  name: "Kolibri Demo"\n  minEngine: "1.0"\n  pack:\n    file: idea-demo-kolibri-v4.tar\n    url: https://example.invalid/x.tar\n    sha256: "${'c'.repeat(64)}"\n    bytes: 10\n    minVersion: 4\n  reserveBytes: 0\n  steps:\n    - { id: seed, run: demo/hook.sh seed, needs: stopped, timeoutSec: 1 }\n`)
    h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(doc => {
        doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
        doc.instanceDB['i1' as any] = { id: 'i1', name: 'Kolibri Demo', storedOn: 'd1', instanceOf: 'kolibri-1.0', status: 'Running', port: 50001, lastBackup: null, statusCondition: null, demo: true } as any
    })
})
afterEach(async () => {
    for (const k of resourceLock.allLocks().keys()) resourceLock.release(k)
    await fs.remove(tmp)
})

describe('updateApp keeps x-app.demo (engine#369)', () => {
    it('restamps x-app.demo after Swap and sets demoPackWarning when the on-disk pack is below minVersion', async () => {
        await fs.outputFile(`${tmp}/instances/i1/demo-pack/x/pack.json`, JSON.stringify({
            schemaVersion: 1, packVersion: 3, app: 'kolibri', minAppVersion: '1.2',
            bytes: 0, credits: 'CREDITS.txt', hooks: [], files: [],
        }))
        const r = await updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps())
        expect(r).toBeTruthy()
        const text = await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')
        const x = YAML.parse(text)['x-app']
        expect(x.demo).toBe(true)
        expect(x.instanceName).toBe('Kolibri Demo')
        expect(x.version).toBe('1.1')
        expect((h.doc().instanceDB['i1' as any] as any).demo).toBe(true)
        const warn = (h.doc().instanceDB['i1' as any] as any).demoPackWarning
        expect(warn).toEqual({ code: 'PACK_OUTDATED', packVersion: 3, minVersion: 4 })
        // demo-pack/ is left in place (copyBundle does not delete extra dest paths)
        expect(await fs.pathExists(`${tmp}/instances/i1/demo-pack/x/pack.json`)).toBe(true)
    })

    it('does not set a warning when the pack folder is missing, and still keeps x-app.demo', async () => {
        const r = await updateApp(h, 'i1', 'kolibri-1.1', ME, {}, deps())
        expect(r).toBeTruthy()
        const text = await fs.readFile(`${tmp}/instances/i1/compose.yaml`, 'utf8')
        expect(YAML.parse(text)['x-app'].demo).toBe(true)
        expect((h.doc().instanceDB['i1' as any] as any).demoPackWarning ?? null).toBeNull()
    })

    it('clears a previous warning when the on-disk pack meets minVersion', async () => {
        await fs.outputFile(`${tmp}/instances/i1/demo-pack/x/pack.json`, JSON.stringify({
            schemaVersion: 1, packVersion: 4, app: 'kolibri', minAppVersion: '1.2',
            bytes: 0, credits: 'CREDITS.txt', hooks: [], files: [],
        }))
        h.change(d => { (d.instanceDB['i1' as any] as any).demoPackWarning = { code: 'PACK_OUTDATED', packVersion: 3, minVersion: 4 } })
        await refreshDemoPackWarning(h, `${tmp}/instances/i1`, `${tmp}/apps/kolibri-1.1`, 'i1' as any)
        expect((h.doc().instanceDB['i1' as any] as any).demoPackWarning ?? null).toBeNull()
    })
})
