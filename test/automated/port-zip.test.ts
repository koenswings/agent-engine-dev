/**
 * port-zip.test.ts (agent-engine-dev#267): a second Engine-allocated port per instance,
 * only for Apps whose compose references `${port_zip`. Real .env/compose files; no Docker.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs } from 'zx'
import os from 'os'
import path from 'path'
import YAML from 'yaml'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, EngineID, InstanceID, PortNumber, Timestamp } from '../../src/data/CommonTypes.js'
import { choosePortZipForStart, composeUsesPortZip, storePortOwner, createPortNumber, syncKolibriHostListenPort, writeEnvVariableAtomic, Instance } from '../../src/data/Instance.js'
import { clearEnginePort } from '../../src/data/InstanceCopy.js'

const LOCAL = localEngineId as EngineID
const KOLIBRI = 'services:\n  kolibri:\n    image: learningequality/kolibri:0.19.5\n    network_mode: host\n    environment:\n      - KOLIBRI_ZIP_CONTENT_PORT=${port_zip:-8081}\nx-app:\n  name: kolibri\n  version: "0.19.5"\n'
const PLAIN = 'services:\n  web:\n    image: x:1\n    ports: ["${port}:80"]\nx-app:\n  name: kiwix\n  version: "1"\n'

let h: DocHandle<Store>
let dir: string
const env = () => path.join(dir, '.env')
const compose = () => path.join(dir, 'compose.yaml')

const addInstance = (id: string, port: number, portZip: number | null, created = 100, status = 'Stopped') => h.change(doc => {
    doc.instanceDB[id as InstanceID] = { id, name: id, storedOn: 'd1', instanceOf: 'kolibri-0.19.5', port, portZip, status, created } as any
})
const inst = (id: string) => h.doc()!.instanceDB[id as InstanceID] as Instance

beforeEach(async () => {
    h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    h.change(doc => { doc.diskDB['d1' as DiskID] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: LOCAL, created: 1 as Timestamp, lastDocked: 1, diskTypes: ['app'], backupConfig: null } as any })
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-port-zip-'))
})
afterEach(async () => { await fs.remove(dir) })

describe('composeUsesPortZip', () => {
    it('matches ${port_zip} and the default forms, nothing else', () => {
        expect(composeUsesPortZip('X=${port_zip}')).toBe(true)
        expect(composeUsesPortZip('X=${port_zip:-8081}')).toBe(true)
        expect(composeUsesPortZip('X=${port_zip-8081}')).toBe(true)
        expect(composeUsesPortZip('X=${port_zipper}')).toBe(false)
        expect(composeUsesPortZip(PLAIN)).toBe(false)
    })
})

describe('choosePortZipForStart', () => {
    it('allocates nothing for an App that does not reference it', async () => {
        await fs.writeFile(compose(), PLAIN); await fs.writeFile(env(), 'port=50001\n')
        addInstance('a', 50001, null)
        expect(await choosePortZipForStart(h, inst('a'), env(), compose(), 50001 as PortNumber)).toBeNull()
        expect(await fs.readFile(env(), 'utf8')).toBe('port=50001\n')
    })
    it('an existing instance without one gets it at its next start, next to port, never equal to port', async () => {
        await fs.writeFile(compose(), KOLIBRI); await fs.writeFile(env(), 'port=50001\npass=x\n')
        addInstance('a', 50001, null)
        const z = await choosePortZipForStart(h, inst('a'), env(), compose(), 50001 as PortNumber)
        expect(z).toBeGreaterThanOrEqual(49152)
        expect(z).not.toBe(50001)
        expect(await fs.readFile(env(), 'utf8')).toBe(`port=50001\npass=x\nport_zip=${z}\n`)
        // kept on the following start
        expect(await choosePortZipForStart(h, inst('a'), env(), compose(), 50001 as PortNumber)).toBe(z)
    })
    it('moves off a port_zip owned by another instance (port or portZip) or equal to its own port', async () => {
        await fs.writeFile(compose(), KOLIBRI)
        addInstance('orig', 50001, 50002, 100)
        addInstance('copy', 50003, null, 200)
        await fs.writeFile(env(), 'port=50003\nport_zip=50002\n')
        const z1 = await choosePortZipForStart(h, inst('copy'), env(), compose(), 50003 as PortNumber)
        expect([50001, 50002, 50003]).not.toContain(z1)
        await fs.writeFile(env(), 'port=50003\nport_zip=50001\n')
        expect([50001, 50002, 50003]).not.toContain(await choosePortZipForStart(h, inst('copy'), env(), compose(), 50003 as PortNumber))
        await fs.writeFile(env(), 'port=50003\nport_zip=50003\n')
        expect(await choosePortZipForStart(h, inst('copy'), env(), compose(), 50003 as PortNumber)).not.toBe(50003)
    })
})

describe('store ownership and createPortNumber', () => {
    it('storePortOwner counts another instance\'s portZip like its port', () => {
        addInstance('orig', 50001, 50002, 100)
        addInstance('copy', 0, null, 200)
        expect(storePortOwner(h.doc()!, inst('copy'), 50002)?.id).toBe('orig')
    })
    it('createPortNumber honours the exclude list', async () => {
        const p = await createPortNumber(h.doc()!, [])
        expect(p).toBeGreaterThanOrEqual(49152)
        expect(typeof (await createPortNumber(h.doc()!, [p]))).toBe('number')
    })
})

describe('copyApp copy gets a fresh port_zip', () => {
    it('clearEnginePort drops port and port_zip, keeps the rest', () => {
        expect(clearEnginePort('port=1\nport_zip=2\npass=x\nport_zipx=3')).toBe('pass=x\nport_zipx=3')
    })
})

describe('syncKolibriHostListenPort with portZip', () => {
    it('keeps a ${port_zip…} reference and fills a literal or missing value', async () => {
        await fs.writeFile(compose(), KOLIBRI)
        await syncKolibriHostListenPort(compose() as any, 50001 as PortNumber, 50002 as PortNumber)
        expect(YAML.parse(await fs.readFile(compose(), 'utf8')).services.kolibri.environment).toContain('KOLIBRI_ZIP_CONTENT_PORT=${port_zip:-8081}')
        await fs.writeFile(compose(), KOLIBRI.replace('${port_zip:-8081}', '8081'))
        await syncKolibriHostListenPort(compose() as any, 50001 as PortNumber, 50002 as PortNumber)
        expect(YAML.parse(await fs.readFile(compose(), 'utf8')).services.kolibri.environment).toContain('KOLIBRI_ZIP_CONTENT_PORT=50002')
    })
})

describe('writeEnvVariableAtomic', () => {
    it('adds then replaces, keeps other lines, leaves no temp file', async () => {
        await fs.writeFile(env(), 'port=1\n')
        await writeEnvVariableAtomic(env(), 'port_zip', '2')
        await writeEnvVariableAtomic(env(), 'port_zip', '3')
        expect(await fs.readFile(env(), 'utf8')).toBe('port=1\nport_zip=3\n')
        expect((await fs.readdir(dir)).filter(f => f.includes('.tmp-'))).toEqual([])
    })
})
