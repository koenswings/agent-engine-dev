/**
 * rename-instance.test.ts — renameInstance (agent-engine-dev#220): display name only,
 * compose.yaml x-app.instanceName + store; refusals; same-name no-op; lock; command wiring.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'os'
import { fs, path } from 'zx'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { parse } from 'yaml'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { renameInstance, validateNewInstanceName, RenameError } from '../../src/data/RenameInstance.js'
import { resourceLock, instanceKey } from '../../src/utils/ResourceLock.js'
import { commands } from '../../src/data/Commands.js'

const ME = String(localEngineId)
const OTHER = 'other-engine'
let tmp: string
let h: DocHandle<Store>

const compose = (name: string) => `services:\n  app:\n    image: x:1  # keep me\nx-app:\n  name: kolibri\n  version: "1.0"\n  instanceName: ${name}\n`

const inst = (id: string, name: string, storedOn: string | null) => ({
    id, name, storedOn, instanceOf: 'kolibri-1.0', status: 'Running', statusCondition: null, port: 8081,
    serviceImages: [], created: 1, lastBackup: null, lastStarted: 1, currentStep: null, totalSteps: null,
    stepLabel: null, metrics: null, filesMounts: null,
})

const setup = async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-rename-'))
    h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change((d: any) => {
        d.diskDB['diskA'] = { id: 'diskA', name: 'A', dockedTo: ME, device: 'sdz1' }
        d.diskDB['diskB'] = { id: 'diskB', name: 'B', dockedTo: OTHER, device: 'sdz1' }
        d.instanceDB['i1'] = inst('i1', 'kolibri', 'diskA')
        d.instanceDB['i2'] = inst('i2', 'Nextcloud', 'diskA')
        d.instanceDB['i3'] = inst('i3', 'Library', 'diskB')   // same name allowed: other Engine
    })
    for (const id of ['i1', 'i2']) {
        await fs.ensureDir(path.join(tmp, id))
        await fs.writeFile(path.join(tmp, id, 'compose.yaml'), compose(id === 'i1' ? 'kolibri' : 'Nextcloud'))
    }
}
const deps = { instanceRoot: async (_s: Store, id: string) => path.join(tmp, id) }
const rename = (arg: string, name: string) => renameInstance(h, arg, name, ME, deps)
const code = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return (e as RenameError).code ?? String(e) } }
const composeName = async (id: string) => parse(await fs.readFile(path.join(tmp, id, 'compose.yaml'), 'utf-8'))['x-app'].instanceName

describe('renameInstance (agent-engine-dev#220)', () => {
    beforeEach(setup)
    afterEach(async () => { resourceLock.release(instanceKey('i1')); await fs.remove(tmp) })

    it('renames a running instance: compose x-app.instanceName and the store; id, folder and other compose keys unchanged', async () => {
        const r = await rename('i1', '  Kolibri Demo  ')
        expect(r).toEqual({ instanceId: 'i1', oldName: 'kolibri', newName: 'Kolibri Demo', changed: true })
        expect(String(h.doc().instanceDB['i1' as any].name)).toBe('Kolibri Demo')
        expect(h.doc().instanceDB['i1' as any].status).toBe('Running')
        expect(await composeName('i1')).toBe('Kolibri Demo')
        const text = await fs.readFile(path.join(tmp, 'i1', 'compose.yaml'), 'utf-8')
        expect(text).toContain('# keep me')
        expect(text).toContain('version: "1.0"')
        expect(await fs.pathExists(path.join(tmp, 'i1'))).toBe(true)
        expect(resourceLock.getLockInfo(instanceKey('i1'))).toBeUndefined()
    })

    it('accepts a unique local instance name as the argument', async () => {
        expect((await rename('Nextcloud', 'Files')).instanceId).toBe('i2')
    })

    it('same name as now: no-op ok, nothing written', async () => {
        const before = await fs.stat(path.join(tmp, 'i1', 'compose.yaml'))
        expect(await rename('i1', 'kolibri')).toMatchObject({ changed: false })
        expect((await fs.stat(path.join(tmp, 'i1', 'compose.yaml'))).mtimeMs).toBe(before.mtimeMs)
    })

    it('refusals: NOT_FOUND, NOT_LOCAL, EMPTY_NAME, NAME_TOO_LONG, BAD_NAME', async () => {
        expect(await code(rename('nope', 'x'))).toBe('NOT_FOUND')
        expect(await code(rename('i3', 'x'))).toBe('NOT_LOCAL')
        expect(await code(rename('i1', '   '))).toBe('EMPTY_NAME')
        expect(await code(rename('i1', 'x'.repeat(65)))).toBe('NAME_TOO_LONG')
        expect(await code(rename('i1', 'a\nb'))).toBe('BAD_NAME')
        expect((await rename('i1', 'y'.repeat(64))).newName).toHaveLength(64)
    })

    it('NAME_TAKEN is case-insensitive among this Engine\'s instances only', async () => {
        expect(await code(rename('i1', 'NEXTCLOUD'))).toBe('NAME_TAKEN')
        expect(await rename('i1', 'Library')).toMatchObject({ changed: true })   // i3 is on another Engine
        expect(await composeName('i1')).toBe('Library')
    })

    it('BUSY while a copy/move/backup holds the instance lock; nothing written', async () => {
        expect(resourceLock.acquire(instanceKey('i1'), 'copyApp')).toBe(true)
        expect(await code(rename('i1', 'Other'))).toBe('BUSY')
        expect(await composeName('i1')).toBe('kolibri')
        expect(String(h.doc().instanceDB['i1' as any].name)).toBe('kolibri')
        resourceLock.release(instanceKey('i1'))
    })

    it('COMPOSE_WRITE_FAILED leaves the store unchanged and releases the lock', async () => {
        await fs.remove(path.join(tmp, 'i1', 'compose.yaml'))
        expect(await code(rename('i1', 'Other'))).toBe('COMPOSE_WRITE_FAILED')
        expect(String(h.doc().instanceDB['i1' as any].name)).toBe('kolibri')
        expect(resourceLock.getLockInfo(instanceKey('i1'))).toBeUndefined()
    })

    it('validateNewInstanceName trims and keeps inner spaces', () => {
        expect(validateNewInstanceName('  Kolibri  Demo ')).toBe('Kolibri  Demo')
    })

    it('is a registered engine command with a variadic name, and advertised as a capability', () => {
        const c = commands.find(x => x.name === 'renameInstance')!
        expect(c.scope).toBe('engine')
        expect(c.args.map(a => a.name)).toEqual(['instanceId', 'newName'])
        expect((c.args[1] as any).variadic).toBe(true)
        expect(ENGINE_CAPABILITIES).toContain('renameInstance')
    })
})
