/**
 * copy-app-isolation.test.ts (idea#168 r35): a copy made by copyApp is its own
 * instance — own data, own name, own port — and the original keeps its port.
 *
 *   1. copyApp / moveApp / installApp refuse instance data with a symlink that
 *      resolves outside the instance folder, naming the link and its target.
 *   2. The copy's .env loses the Engine-written `port=` (other lines kept), so
 *      its start allocates a fresh port that skips store-owned ports.
 *   3. copyApp restarts the original BEFORE the copy starts (call order).
 *   4. The copy gets a unique name (<name>-2, -3, …) in compose.yaml and the store.
 *   5. copyApp resolves the instance id-first; an ambiguous name is refused.
 *   6. A failed cross-Engine copy removes its partial folder on the target disk
 *      (over ssh) and leaves no registered instance (idea#168 r36: a partial
 *      folder registered as a second "kolibri" on the next dock). engine#497
 *      (Koen's rule) withdrew this for a LOCAL copy: its partial folder is kept
 *      under an in-flight marker (which blocks registration) and the op resumes.
 *
 * Real files in pretend disks under IDEA_DISKS_ROOT (idea-test-6x). rsync is
 * replaced by fs.copy (links copied as links, like rsync -a), and so is the
 * app-data root helper (idea#168: instance data is copied, sized and deleted as
 * root by `sudo -n idea-app-data`; here its root tokens map to the pretend disks);
 * start/stop and processInstance are recorded, never run (no Docker).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import os from 'os'
import path from 'path'

const order = vi.hoisted(() => [] as string[])
const remoteOverlays = vi.hoisted(() => [] as { src: string | string[], peer: { host: string, engineId: string }, helperArgs: string[], files: Record<string, string> }[])
// r36: make the instance rsync fail after writing part of the copy
const failure = vi.hoisted(() => ({ rsync: null as string | null, process: null as string | null, ssh: null as string | null }))
const sshCalls = vi.hoisted(() => [] as string[])
// idea#168: instance data goes through the app-data helper (copy / send / delete)
const instanceTransfers = vi.hoisted(() => [] as any[])
const helperDeletes = vi.hoisted(() => [] as string[][])

// engine#582: follow-ups to another Engine go through PeerCommands (POST /api/command with a grant);
// here the "delivery" is simulated by appending the command to the target's queue row.
vi.mock('../../src/data/PeerCommands.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        dispatchToPeer: vi.fn(async (sh: any, engineId: string, command: string) => {
            sh.change((d: any) => { d.engineDB[engineId].commands.push(command) })
            return { ok: true, seq: 1, issuerEngineId: engineId }
        }),
        // engine#582: the target accepts this Engine's grant unless a test says otherwise
        preflightPeerGrant: vi.fn(async (_sh: any, engineId: string) => ({ ok: true, issuerEngineId: engineId })),
    }
})

vi.mock('../../src/utils/rsync.js', () => ({
    rsyncDirectory: vi.fn(async (src: string, dest: string, onProgress?: (p: { progressPercent: number }) => void) => {
        const { fs } = await import('zx')
        if (failure.rsync && src.includes('/instances/')) {
            await fs.ensureDir(`${dest}/data/kolibri`)
            await fs.writeFile(`${dest}/data/kolibri/db.sqlite3`, 'partial')
            throw new Error(failure.rsync)
        }
        await fs.copy(src, dest, { overwrite: true, dereference: false })
        onProgress?.({ progressPercent: 100 })
    }),
    // Cross-engine (per-Pi Engine keys): rsync to the peer's helper through its gate.
    // Record what would be sent (the overlay of rewritten files) and to which helper call.
    rsyncToPeer: vi.fn(async (src: string | string[], peer: { host: string, engineId: string }, helperArgs: string[], onProgress?: (p: { progressPercent: number }) => void) => {
        const { fs } = await import('zx')
        const files: Record<string, string> = {}
        const paths: string[] = []
        for (const s of [src].flat()) {
            if ((await fs.stat(s)).isDirectory()) for (const f of await fs.readdir(s)) paths.push(`${s.replace(/\/$/, '')}/${f}`)
            else paths.push(s)
        }
        for (const p of paths) {
            const f = p.split('/').at(-1)!
            if ((await fs.lstat(p)).isFile() && (f === '.env' || f === 'compose.yaml' || f === '.idea-rebind-morango')) files[f] = await fs.readFile(p, 'utf8')
        }
        remoteOverlays.push({ src, peer, helperArgs, files })
        onProgress?.({ progressPercent: 100 })
    }),
    // The app-data helper's copy/send: root tokens are the pretend disks' devices
    rsyncInstanceData: vi.fn(async (t: any, onProgress?: (p: { progressPercent: number }) => void) => {
        const { fs } = await import('zx')
        const { disksRoot } = await import('../../src/data/Config.js')
        const dir = (root: string, id: string) => `${root === 'system' ? '' : `${disksRoot()}/${root}`}/instances/${id}`
        instanceTransfers.push(t)
        if (failure.rsync) {
            if (t.kind === 'copy') {
                await fs.ensureDir(`${dir(t.dstRoot, t.dstId)}/data/kolibri`)
                await fs.writeFile(`${dir(t.dstRoot, t.dstId)}/data/kolibri/db.sqlite3`, 'partial')
            }
            throw new Error(failure.rsync)
        }
        if (t.kind === 'copy') {
            if (await fs.pathExists(dir(t.dstRoot, t.dstId))) throw new Error(`rsync (idea-app-data copy refused: destination exists)`)
            await fs.copy(dir(t.srcRoot, t.srcId), dir(t.dstRoot, t.dstId), { dereference: false })
        }
        onProgress?.({ progressPercent: 100 })
    }),
}))

vi.mock('../../src/utils/appDataHelper.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    const dir = async (root: string, id: string) => {
        const { disksRoot } = await import('../../src/data/Config.js')
        return `${root === 'system' ? '' : `${disksRoot()}/${root}`}/instances/${id}`
    }
    return {
        ...actual,
        instanceDataBytes: vi.fn(async () => 4096),
        deleteInstanceData: vi.fn(async (root: string, id: string) => {
            helperDeletes.push([root, id])
            const { fs } = await import('zx')
            await fs.remove(await dir(root, id))
        }),
        // Local Kolibri marker (and any other basename overlay) via idea-app-data put-files
        putInstanceFiles: vi.fn(async (root: string, id: string, stagingDir: string) => {
            const { fs } = await import('zx')
            const dest = await dir(root, id)
            for (const name of await fs.readdir(stagingDir)) {
                await fs.copy(`${stagingDir}/${name}`, `${dest}/${name}`)
            }
        }),
        // deleteRemoteInstanceData stays real: its ssh goes to the mocked zx $ below
    }
})

// Port candidates are made deterministic per test (zx also uses Math.random)
vi.mock('../../src/utils/utils.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, randomPort: vi.fn(actual.randomPort) }
})

vi.mock('../../src/data/Instance.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        stopInstance: vi.fn(async (_h: any, inst: any) => { order.push(`stop:${inst.id}`) }),
        startInstance: vi.fn(async (_h: any, inst: any) => { order.push(`start:${inst.id}`) }),
    }
})

vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        // Register the copy from its compose.yaml like the real processInstance,
        // but record the start instead of running Docker.
        processInstance: vi.fn(async (handle: any, disk: any, instanceId: any) => {
            const { createOrUpdateInstance } = await import('../../src/data/Instance.js')
            const inst = await createOrUpdateInstance(handle, instanceId, disk)
            order.push(`process:${instanceId}`)
            if (failure.process) throw new Error(failure.process)
            return inst
        }),
    }
})

// ssh (cross-engine only) never runs; everything else is the real zx $
vi.mock('zx', async (importOriginal) => {
    const actual = await importOriginal<any>()
    const mocked = vi.fn((strings: any, ...vals: any[]) => {
        const flat = [...(Array.isArray(strings) ? strings : [String(strings ?? '')]), ...vals.flat().map(String)].join(' ')
        if (/(^|\s)ssh\s/.test(flat.trim() + ' ')) {
            const cmd = Array.isArray(strings)
                ? strings.reduce((acc: string, str: string, i: number) => acc + str + (i < vals.length ? [vals[i]].flat().map(String).join(' ') : ''), '')
                : flat
            sshCalls.push(cmd.replace(/\s+/g, ' ').trim())
            if (failure.ssh) return Promise.reject(new Error(failure.ssh))
            return Promise.resolve({ stdout: '', stderr: '' })
        }
        return actual.$(strings, ...vals)
    }) as any
    mocked.sync = actual.$.sync
    return { ...actual, $: mocked }
})

import { fs, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { disksRoot } from '../../src/data/Config.js'
import { setRootDeviceForTests } from '../../src/data/Disk.js'
import { network } from '../../src/data/Network.js'
import { dispatchToPeer, preflightPeerGrant, PeerGrantRefusal } from '../../src/data/PeerCommands.js'
import { copyApp, moveApp } from '../../src/data/CopyMoveApp.js'
import { installAppFromDisk } from '../../src/data/InstallApp.js'
import { findExternalLinks, uniqueCopyName, clearEnginePort, setComposeInstanceName } from '../../src/data/InstanceCopy.js'
import { choosePortForStart } from '../../src/data/Instance.js'
import { randomPort } from '../../src/utils/utils.js'
import { AppID, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { authorizedEntry } from '../../src/data/PeerAccess.js'
import { peerSshOptions } from '../../src/utils/peerSsh.js'
import { testKey } from '../harness/peerKeys.js'
import { issueGrant, checkGrant, rememberGrant, grantFrom, forgetGrant, clearGrantsForTests, GrantError, GRANT_TTL_MS } from '../../src/data/PeerGrants.js'
import { monoNow } from '../../src/utils/monoClock.js'

/** Per-Pi Engine keys: the local Engine and REMOTE have published and accepted each other's keys. */
const peersExchanged = (doc: Store, remote: EngineID, opts: { remoteAccepts?: boolean } = {}) => {
    const keys = (seed: string) => ({ sshKey: testKey(`${seed}-ssh`), hostKey: testKey(`${seed}-host`), publishedAt: 0 as Timestamp })
    const local = keys('local'); const rem = keys(String(remote))
    ;(doc.engineDB as any)[localEngineId].peerAccess = { ...local, authorized: [authorizedEntry(String(remote), rem)] }
    ;(doc.engineDB as any)[remote].peerAccess = { ...rem, authorized: opts.remoteAccepts === false ? [] : [authorizedEntry(String(localEngineId), local)] }
}

const SRC = 'DISK_src-r35' as DiskID
const TGT = 'DISK_tgt-r35' as DiskID
const SRC_DEV = 'idea-test-61'
const TGT_DEV = 'idea-test-62'
const ORIG = 'kolibri-grade5a-001' as InstanceID
const APP = 'kolibri-1.0' as AppID

const srcRoot = () => `${disksRoot()}/${SRC_DEV}`
const tgtRoot = () => `${disksRoot()}/${TGT_DEV}`
const origDir = () => `${srcRoot()}/instances/${ORIG}`

const COMPOSE = `# Kolibri test instance
x-app:
  name: kolibri
  version: "1.0"
  instanceName: kolibri # the operator's name
services:
  kolibri:
    image: koenswings/kolibri:1.0
    network_mode: host
    environment:
      - KOLIBRI_HTTP_PORT=18080
      - KOLIBRI_LISTEN_PORT=18080
`

const row = (id: string, name: string, storedOn: string, extra: Record<string, unknown> = {}) => ({
    id, instanceOf: APP, name, status: 'Stopped', port: 0, serviceImages: [], created: 100 as Timestamp,
    lastBackup: null, lastStarted: 0 as Timestamp, statusCondition: null, storedOn,
    currentStep: null, totalSteps: null, stepLabel: null, metrics: null, ...extra,
})

const makeDisk = (id: DiskID, name: string, device: string, dockedTo: EngineID) => ({
    id, name: name as DiskName, device: device as any, dockedTo, created: 0 as Timestamp,
    lastDocked: 0 as Timestamp, diskTypes: ['app'], backupConfig: null,
})

const makeHandle = async (origStatus = 'Running'): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {},
        diskDB: {
            [SRC]: makeDisk(SRC, 'duration-kolibri-grade5a-001', SRC_DEV, localEngineId),
            [TGT]: makeDisk(TGT, 'duration-nextcloud-grade5a-001', TGT_DEV, localEngineId),
        },
        appDB: {},
        instanceDB: { [ORIG]: row(ORIG, 'kolibri', SRC, { status: origStatus, port: 18080, created: 100 }) },
        userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}

let outside: string

const writeSourceDisk = async () => {
    await fs.ensureDir(`${srcRoot()}/apps/${APP}`)
    await fs.writeFile(`${srcRoot()}/apps/${APP}/compose.yaml`, COMPOSE)
    await fs.ensureDir(`${origDir()}/data/kolibri`)
    await fs.writeFile(`${origDir()}/data/kolibri/db.sqlite3`, 'original-db')
    await fs.writeFile(`${origDir()}/compose.yaml`, COMPOSE)
    await fs.writeFile(`${origDir()}/.env`, 'port=18080\npass=s3cret\nKOLIBRI_HTTP_PORT=18080\n')
    await fs.ensureDir(`${tgtRoot()}`)
}

/** Replace data/kolibri with a link to a live dir outside the disk (the r35 fixture). */
const linkDataOffDisk = async () => {
    await fs.remove(`${origDir()}/data/kolibri`)
    await fs.ensureDir(`${outside}/idea166-kolibri-live/data/kolibri`)
    await fs.symlink(`${outside}/idea166-kolibri-live/data/kolibri`, `${origDir()}/data/kolibri`)
}

// engine#497 (helper v20): marker, verify-copy and the version check go through
// InFlight.inFlightHelper; recorded here (no sudo, no marker file on the pretend disks)
import { inFlightHelper, peerInFlight, CROSS_ENGINE_RESUME_CAPABILITY } from '../../src/data/InFlight.js'
const inFlightCalls: string[][] = []
// engine#497 stage 3 (a, helper v23): the peer marker and the source-side verify-send go through
// InFlight.peerInFlight; recorded here
const peerInFlightCalls: string[][] = []
beforeEach(() => {
    inFlightCalls.length = 0
    inFlightHelper.atLeast = async () => null
    inFlightHelper.run = async (args: string[]) => { inFlightCalls.push(args); return args[0] === 'verify-copy' ? 'differences=0\n' : '' }
    peerInFlightCalls.length = 0
    peerInFlight.helperProblem = async () => null
    peerInFlight.mark = async (host, peer, root, id, opId) => { peerInFlightCalls.push(['mark', host, peer, root, id, opId]) }
    peerInFlight.clear = async (host, peer, root, id, opId) => { peerInFlightCalls.push(['clear', host, peer, root, id, opId]) }
    peerInFlight.verify = async (_sr, _si, host, peer, root, id, opId) => { peerInFlightCalls.push(['verify', host, peer, root, id, opId]); return { differences: 0, diffs: [] } }
})

const copyDirs = async (): Promise<string[]> =>
    (await fs.readdir(`${tgtRoot()}/instances`).catch(() => [] as string[]))

describe('copyApp / moveApp / installApp: instance isolation (idea#168 r35)', () => {
    let h: DocHandle<Store>

    beforeEach(async () => {
        order.length = 0
        remoteOverlays.length = 0
        sshCalls.length = 0
        instanceTransfers.length = 0
        helperDeletes.length = 0
        failure.rsync = null
        failure.process = null
        failure.ssh = null
        setRootDeviceForTests('mmcblk-not-a-test-disk')
        outside = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-outside-'))
        await fs.remove(srcRoot()); await fs.remove(tgtRoot())
        await writeSourceDisk()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        setRootDeviceForTests(null)
        await fs.remove(srcRoot()); await fs.remove(tgtRoot()); await fs.remove(outside)
    })

    // ── 1. off-disk links ────────────────────────────────────────────────────

    it('copyApp refuses an off-disk data link, naming link and target, before stopping anything', async () => {
        h = await makeHandle('Running')
        await linkDataOffDisk()
        const target = await fs.realpath(`${outside}/idea166-kolibri-live/data/kolibri`)
        await expect(copyApp(h, ORIG as any, SRC, TGT)).rejects.toThrow(
            `copyApp: instance data links off the disk: 'data/kolibri' -> '${target}'`)
        expect(order).toEqual([])                                   // source never stopped
        expect(Object.keys(h.doc().operationDB)).toHaveLength(0)
        expect(await copyDirs()).toEqual([])
    })

    it('moveApp refuses the same link; installApp refuses it before writing to the target', async () => {
        h = await makeHandle('Running')
        await linkDataOffDisk()
        await expect(moveApp(h, ORIG as any, SRC, TGT)).rejects.toThrow(/moveApp: instance data links off the disk: 'data\/kolibri' -> '.*idea166-kolibri-live\/data\/kolibri'/)
        expect(order).toEqual([])
        await expect(installAppFromDisk(h, APP, h.doc().diskDB[SRC] as any, h.doc().diskDB[TGT] as any, 'kolibri' as any))
            .rejects.toThrow(/installApp: instance data links off the disk: 'data\/kolibri' -> '.*idea166-kolibri-live\/data\/kolibri'/)
        expect(await fs.pathExists(`${tgtRoot()}/apps/${APP}`)).toBe(false)
        expect(await copyDirs()).toEqual([])
    })

    it('findExternalLinks: links inside the instance folder are fine; dangling and chained escapes are caught', async () => {
        await fs.ensureDir(`${origDir()}/data/v1`)
        await fs.symlink('v1', `${origDir()}/data/current`)                 // inside: ok
        await fs.symlink('/nonexistent/idea-r35', `${origDir()}/dangling`)   // dangling, outside
        await fs.symlink(outside, `${origDir()}/data/out`)                   // outside
        await fs.symlink('data/out', `${origDir()}/chain`)                   // inside link → outside
        const links = (await findExternalLinks(origDir())).map(l => l.link).sort()
        expect(links).toEqual(['chain', 'dangling', 'data/out'])
    })

    // ── 2–4. local copy: order, name, port ───────────────────────────────────

    it('restarts the original BEFORE the copy starts (call order)', async () => {
        h = await makeHandle('Running')
        await copyApp(h, ORIG as any, SRC, TGT)
        const [newId] = await copyDirs()
        expect(order).toEqual([`stop:${ORIG}`, `start:${ORIG}`, `process:${newId}`])
        expect(Object.values(h.doc().operationDB)[0].status).toBe('Done')
    })

    it('the copy gets its own data, a unique name and no inherited port; its start skips store-owned ports', async () => {
        h = await makeHandle('Running')
        // Another instance on this engine already owns 50000 in the store
        h.change(doc => { (doc.instanceDB as any)['nc-001'] = row('nc-001', 'nextcloud', TGT, { port: 50000 }) })
        await copyApp(h, ORIG as any, SRC, TGT)
        const [newId] = await copyDirs()
        const copyDir = `${tgtRoot()}/instances/${newId}`

        // own data: a real directory, not a link
        expect((await fs.lstat(`${copyDir}/data/kolibri`)).isDirectory()).toBe(true)
        expect(await fs.readFile(`${copyDir}/data/kolibri/db.sqlite3`, 'utf8')).toBe('original-db')
        expect(await fs.readFile(`${copyDir}/.idea-rebind-morango`, 'utf8')).toBe('r40\n')

        // unique name in compose.yaml (comments kept) and in the store
        const compose = await fs.readFile(`${copyDir}/compose.yaml`, 'utf8')
        expect(YAML.parse(compose)['x-app'].instanceName).toBe('kolibri-2')
        expect(compose).toContain('# Kolibri test instance')
        expect(h.doc().instanceDB[newId as InstanceID].name).toBe('kolibri-2')
        expect(h.doc().instanceDB[ORIG].name).toBe('kolibri')

        // .env: Engine port gone, other lines kept; original untouched
        const env = await fs.readFile(`${copyDir}/.env`, 'utf8')
        expect(env).not.toMatch(/^port=/m)
        expect(env).toContain('pass=s3cret')
        expect(await fs.readFile(`${origDir()}/.env`, 'utf8')).toContain('port=18080')

        // the copy's start: first random candidate is the store-owned 50000 → skipped
        vi.mocked(randomPort).mockReturnValueOnce(50000 as any).mockReturnValueOnce(50001 as any)
        const port = await choosePortForStart(h, h.doc().instanceDB[newId as InstanceID] as any, `${copyDir}/.env`)
        expect(port).toBe(50001)
        expect(port).not.toBe(18080)
    })

    it('copying again gives kolibri-3; copying the copy continues the series', async () => {
        h = await makeHandle('Stopped')
        h.change(doc => { (doc.instanceDB as any)['k2'] = row('k2', 'kolibri-2', TGT) })
        expect(uniqueCopyName(h.doc(), 'kolibri')).toBe('kolibri-3')
        expect(uniqueCopyName(h.doc(), 'kolibri-2')).toBe('kolibri-3')
        expect(uniqueCopyName(h.doc(), 'kolibri-grade5a-001')).toBe('kolibri-grade5a-001-2')
        expect(uniqueCopyName(h.doc(), 'nextcloud')).toBe('nextcloud-2')
        await copyApp(h, ORIG as any, SRC, TGT)
        const [newId] = await copyDirs()
        expect(h.doc().instanceDB[newId as InstanceID].name).toBe('kolibri-3')
    })

    it('clearEnginePort / setComposeInstanceName (pure)', () => {
        expect(clearEnginePort('port=18080\npass=x\nKOLIBRI_HTTP_PORT=18080\nexport_port=1\n')).toBe('pass=x\nKOLIBRI_HTTP_PORT=18080\nexport_port=1\n')
        expect(YAML.parse(setComposeInstanceName('services: {}\n', 'kolibri-2'))['x-app'].instanceName).toBe('kolibri-2')
    })

    // ── 5. id-first copy ─────────────────────────────────────────────────────

    it('copyApp by id copies exactly that instance when two share the name on the source disk; the name is refused', async () => {
        h = await makeHandle('Stopped')
        const TWIN = 'kolibri-twin-002' as InstanceID
        h.change(doc => { (doc.instanceDB as any)[TWIN] = row(TWIN, 'kolibri', SRC, { status: 'Running', created: 300 }) })
        await fs.copy(origDir(), `${srcRoot()}/instances/${TWIN}`)
        await fs.writeFile(`${srcRoot()}/instances/${TWIN}/data/kolibri/db.sqlite3`, 'twin-db')

        await expect(copyApp(h, 'kolibri' as any, SRC, TGT)).rejects.toThrow(
            `copyApp: Instance name 'kolibri' is ambiguous: ${ORIG} (on disk ${SRC}), ${TWIN} (on disk ${SRC}). Use the instance id.`)
        expect(order).toEqual([])

        await copyApp(h, TWIN as any, SRC, TGT)
        const [newId] = await copyDirs()
        expect(order).toEqual([`stop:${TWIN}`, `start:${TWIN}`, `process:${newId}`])
        expect(await fs.readFile(`${tgtRoot()}/instances/${newId}/data/kolibri/db.sqlite3`, 'utf8')).toBe('twin-db')
    })

    it('copyApp by a shared name + source disk (Console wire format) picks the one on that disk', async () => {
        h = await makeHandle('Stopped')
        h.change(doc => { (doc.instanceDB as any)['k-elsewhere'] = row('k-elsewhere', 'kolibri', TGT) })
        await copyApp(h, 'kolibri' as any, SRC, TGT)
        const [newId] = await copyDirs()
        expect(order).toEqual([`process:${newId}`])
        expect(h.doc().instanceDB[newId as InstanceID].name).toBe('kolibri-2')
    })

    // ── cross-engine: id dispatch, name/port overlay, restart first ──────────

    it('cross-engine: overlay without port and with the unique name; startInstance dispatched by id after the restart', async () => {
        h = await makeHandle('Running')
        const REMOTE = 'ENGINE_remote-r35' as EngineID
        h.change(doc => {
            doc.diskDB[TGT].dockedTo = REMOTE
            ;(doc.engineDB as any)[REMOTE] = { id: REMOTE, commands: [], lastRun: Date.now(), capabilities: [CROSS_ENGINE_RESUME_CAPABILITY] }
            peersExchanged(doc, REMOTE)
        })
        network.connections['10.0.0.35:4321' as any] = { adapter: {} as any, missedDiscoveryCount: 0, hostname: 'idea35' as any, engineId: REMOTE }
        try {
            await copyApp(h, ORIG as any, SRC, TGT)
            const newRow = Object.values(h.doc().instanceDB).find(i => String(i.id) !== ORIG)!
            expect(newRow.name).toBe('kolibri-2')
            // The helper sends the original files as root (idea#168); the overlay (from a local temp dir) then replaces them
            const opId = (Object.values(h.doc().operationDB)[0] as any).id
            // engine#497 (a): the push carries the op id (a resumed run continues into the same folder)
            expect(instanceTransfers).toEqual([{ kind: 'send', srcRoot: SRC_DEV, srcId: ORIG, host: '10.0.0.35', peerEngineId: REMOTE, dstRoot: TGT_DEV, dstId: newRow.id, opId }])
            // marked on the peer before the first byte, verified against the source, cleared after registration
            expect(peerInFlightCalls).toEqual([
                ['mark', '10.0.0.35', REMOTE, TGT_DEV, newRow.id, opId],
                ['verify', '10.0.0.35', REMOTE, TGT_DEV, newRow.id, opId],
                ['clear', '10.0.0.35', REMOTE, TGT_DEV, newRow.id, opId],
            ])
            expect((Object.values(h.doc().operationDB)[0] as any)).toMatchObject({ status: 'Done', args: { crossResume: '1', crossEngine: 'true', phase: 'done' } })
            // every remote step goes to the peer's helper with this Engine's key, pinned by the peer's Engine id
            expect(sshCalls).toEqual([`ssh ${peerSshOptions(REMOTE).join(' ')} pi@10.0.0.35 -- sudo -n /usr/local/sbin/idea-app-data ensure-dirs ${TGT_DEV}`])
            expect(remoteOverlays.map(o => [o.peer, o.helperArgs])).toEqual([
                [{ host: '10.0.0.35', engineId: REMOTE }, ['receive-app', TGT_DEV, APP]],
                [{ host: '10.0.0.35', engineId: REMOTE }, ['receive-files', TGT_DEV, newRow.id]],
                [{ host: '10.0.0.35', engineId: REMOTE }, ['receive-files', TGT_DEV, newRow.id]], // Kolibri rebind marker
            ])
            const toCopy = remoteOverlays.filter(o => o.helperArgs[0] === 'receive-files')
            expect(toCopy).toHaveLength(2)
            expect([toCopy[0].src].flat().every(p => /idea-copy-[^/]+\/(compose\.yaml|\.env)$/.test(p))).toBe(true)   // overlay files only
            expect([toCopy[1].src].flat().every(p => /idea-kolibri-rebind-[^/]+\/\.idea-rebind-morango$/.test(p))).toBe(true)
            const overlay = toCopy[0]
            expect(YAML.parse(overlay.files['compose.yaml'])['x-app'].instanceName).toBe('kolibri-2')
            expect(overlay.files['.env']).not.toMatch(/^port=/m)
            expect(toCopy[1].files['.idea-rebind-morango']).toBe('r40\n')
            expect(h.doc().engineDB[REMOTE].commands).toEqual([`startInstance ${newRow.id} ${TGT} --cause cross-engine-cmd`])
            expect(vi.mocked(dispatchToPeer)).toHaveBeenCalledWith(h, String(REMOTE), `startInstance ${newRow.id} ${TGT} --cause cross-engine-cmd`)
            expect(order).toEqual([`stop:${ORIG}`, `start:${ORIG}`])
        } finally {
            delete network.connections['10.0.0.35:4321' as any]
        }
    })
    // ── 6. failed copy: partial folder removed (idea#168 r36) ────────────────

    const R36_RSYNC = 'rsync exited with code 23: rsync: [sender] send_files failed to open "/disks/idea-test-61/instances/kolibri-grade5a-001/data/kolibri/sessions/kolibrie9es3": Permission denied (13)'

    it('engine#497: a failed local copy KEEPS its partial folder under its in-flight marker, registers no instance, parks the op and restarts the source', async () => {
        h = await makeHandle('Running')
        failure.rsync = R36_RSYNC
        await copyApp(h, ORIG as any, SRC, TGT)
        const newId = instanceTransfers[0].dstId
        expect(await copyDirs()).toEqual([newId])                          // the partial folder is kept (r36 delete withdrawn)
        expect(Object.keys(h.doc().instanceDB)).toEqual([ORIG])            // nothing registered
        const op = Object.values(h.doc().operationDB)[0] as any
        expect(op.status).toBe('Pending')
        expect(op.error).toBe(`RESUME_PENDING (1/3): ${R36_RSYNC}`)
        expect(op.args).toMatchObject({ targetInstanceId: newId, phase: 'copying', resumeFailures: '1' })
        expect(order).toEqual([`stop:${ORIG}`, `start:${ORIG}`])           // source back up, copy never processed
        // it failed IN the instance copy; nothing was removed, the marker was written first
        expect(instanceTransfers.map(t => t.kind)).toEqual(['copy'])
        expect(instanceTransfers[0].opId).toBe(op.id)
        expect(helperDeletes).toEqual([])
        expect(inFlightCalls).toEqual([['mark-in-flight', TGT_DEV, newId, op.id, String(localEngineId)]])
    })

    it('engine#497 (a): a failed cross-engine copy keeps the partial folder on the peer under its marker (no remote delete) and parks the op', async () => {
        h = await makeHandle('Stopped')
        const REMOTE = 'ENGINE_remote-r36' as EngineID
        h.change(doc => {
            doc.diskDB[TGT].dockedTo = REMOTE
            ;(doc.engineDB as any)[REMOTE] = { id: REMOTE, commands: [], lastRun: Date.now(), capabilities: [CROSS_ENGINE_RESUME_CAPABILITY] }
            peersExchanged(doc, REMOTE)
        })
        network.connections['10.0.0.36:4321' as any] = { adapter: {} as any, missedDiscoveryCount: 0, hostname: 'idea36' as any, engineId: REMOTE }
        try {
            failure.rsync = R36_RSYNC
            await copyApp(h, ORIG as any, SRC, TGT)
            expect(instanceTransfers.map(t => t.kind)).toEqual(['send'])
            const newId = instanceTransfers[0].dstId
            expect(newId).not.toBe(ORIG)
            const op = Object.values(h.doc().operationDB)[0] as any
            expect(instanceTransfers[0].opId).toBe(op.id)
            expect(sshCalls.filter(c => / rm -rf /.test(c)), JSON.stringify(sshCalls)).toEqual([])
            // no remote delete any more: only ensure-dirs went over ssh; the partial stays marked
            expect(sshCalls.filter(c => /idea-app-data/.test(c))).toEqual([
                `ssh ${peerSshOptions(REMOTE).join(' ')} pi@10.0.0.36 -- sudo -n /usr/local/sbin/idea-app-data ensure-dirs ${TGT_DEV}`,
            ])
            expect(peerInFlightCalls).toEqual([['mark', '10.0.0.36', REMOTE, TGT_DEV, newId, op.id]])
            expect(sshCalls.some(c => /StrictHostKeyChecking=no/.test(c))).toBe(false)
            expect(helperDeletes).toEqual([])
            expect(Object.keys(h.doc().instanceDB)).toEqual([ORIG])
            expect(h.doc().engineDB[REMOTE].commands).toEqual([])          // no remote startInstance
            expect(op.status).toBe('Pending')
            expect(op.error).toBe(`RESUME_PENDING (1/3): ${R36_RSYNC}`)
            expect(op.args).toMatchObject({ targetInstanceId: newId, phase: 'copying', crossEngine: 'true', crossResume: '1', targetMarked: '1', targetEngineId: REMOTE })
            // the SOURCE resumes it (Koen Q1 option A): the same op pushes again into the same id
            failure.rsync = null
            instanceTransfers.length = 0
            peerInFlightCalls.length = 0
            await copyApp(h, ORIG as any, SRC, TGT, 'console-command', { recoveredOpId: op.id })
            expect(instanceTransfers).toEqual([{ kind: 'send', srcRoot: SRC_DEV, srcId: ORIG, host: '10.0.0.36', peerEngineId: REMOTE, dstRoot: TGT_DEV, dstId: newId, opId: op.id }])
            expect(peerInFlightCalls).toEqual([
                ['mark', '10.0.0.36', REMOTE, TGT_DEV, newId, op.id],
                ['verify', '10.0.0.36', REMOTE, TGT_DEV, newId, op.id],
                ['clear', '10.0.0.36', REMOTE, TGT_DEV, newId, op.id],
            ])
            expect(Object.keys(h.doc().operationDB)).toEqual([op.id])
            expect(h.doc().operationDB[op.id]).toMatchObject({ status: 'Done', args: { phase: 'done' } })
            expect(Object.keys(h.doc().instanceDB).sort()).toEqual([ORIG, newId].sort())
        } finally {
            delete network.connections['10.0.0.36:4321' as any]
        }
    })

    it('engine#511 B2: a resume whose ensure-dirs exits 255 stays parked (RESUME_WAITING), keeps the partial under the marker, and finishes when the target is back', async () => {
        h = await makeHandle('Stopped')
        const REMOTE = 'ENGINE_remote-r36' as EngineID
        h.change(doc => {
            doc.diskDB[TGT].dockedTo = REMOTE
            ;(doc.engineDB as any)[REMOTE] = { id: REMOTE, commands: [], lastRun: Date.now(), capabilities: [CROSS_ENGINE_RESUME_CAPABILITY] }
            peersExchanged(doc, REMOTE)
        })
        network.connections['10.0.0.36:4321' as any] = { adapter: {} as any, missedDiscoveryCount: 0, hostname: 'idea36' as any, engineId: REMOTE }
        try {
            // Mid-receive cut (B2): a link failure after the marker is written, not a real rsync-23
            failure.rsync = 'exit code: 255'
            await copyApp(h, ORIG as any, SRC, TGT)
            const newId = instanceTransfers[0].dstId
            const op = Object.values(h.doc().operationDB)[0] as any
            expect(op.status).toBe('Pending')
            expect(op.error).toMatch(/^RESUME_WAITING/)
            expect(op.args.resumeFailures).toBeUndefined()
            expect(op.args).toMatchObject({ targetInstanceId: newId, targetMarked: '1', crossResume: '1' })
            // resume while the target is cut: ensure-dirs fails the way zx reports ssh exit 255
            failure.rsync = null
            failure.ssh = 'exit code: 255'
            instanceTransfers.length = 0
            peerInFlightCalls.length = 0
            sshCalls.length = 0
            await copyApp(h, ORIG as any, SRC, TGT, 'console-command', { recoveredOpId: op.id })
            const parked = h.doc().operationDB[op.id] as any
            expect(parked.status).toBe('Pending')
            expect(parked.error).toMatch(/^RESUME_WAITING/)
            expect(parked.error).toMatch(/exit code: 255/)
            expect(parked.args.resumeFailures).toBeUndefined()
            expect(parked.args).toMatchObject({ targetInstanceId: newId, targetMarked: '1', phase: 'copying' })
            expect(sshCalls.filter(c => /idea-app-data ensure-dirs/.test(c)).length).toBeGreaterThan(0)
            expect(sshCalls.filter(c => / rm -rf /.test(c)), JSON.stringify(sshCalls)).toEqual([])
            expect(helperDeletes).toEqual([])
            expect(instanceTransfers).toEqual([])                         // send never started
            expect(Object.keys(h.doc().instanceDB)).toEqual([ORIG])
            // the target is really back: the same op resumes to Done
            failure.ssh = null
            instanceTransfers.length = 0
            peerInFlightCalls.length = 0
            await copyApp(h, ORIG as any, SRC, TGT, 'console-command', { recoveredOpId: op.id })
            expect(instanceTransfers).toEqual([{ kind: 'send', srcRoot: SRC_DEV, srcId: ORIG, host: '10.0.0.36', peerEngineId: REMOTE, dstRoot: TGT_DEV, dstId: newId, opId: op.id }])
            expect(h.doc().operationDB[op.id]).toMatchObject({ status: 'Done', args: { phase: 'done' } })
            expect(Object.keys(h.doc().instanceDB).sort()).toEqual([ORIG, newId].sort())
        } finally {
            delete network.connections['10.0.0.36:4321' as any]
        }
    })

    it('a cross-engine copy to a peer that has not accepted this Engine\'s key yet is refused in validate(): nothing sent, nothing stopped', async () => {
        h = await makeHandle('Running')
        const REMOTE = 'ENGINE_remote-r37' as EngineID
        h.change(doc => {
            doc.diskDB[TGT].dockedTo = REMOTE
            ;(doc.engineDB as any)[REMOTE] = { id: REMOTE, hostname: 'idea37', commands: [], lastRun: Date.now(), capabilities: [CROSS_ENGINE_RESUME_CAPABILITY] }
            peersExchanged(doc, REMOTE, { remoteAccepts: false })
        })
        network.connections['10.0.0.37:4321' as any] = { adapter: {} as any, missedDiscoveryCount: 0, hostname: 'idea37' as any, engineId: REMOTE }
        try {
            await expect(copyApp(h, ORIG as any, SRC, TGT)).rejects.toThrow(
                /^copyApp: Engine 'idea37' \(ENGINE_remote-r37\) has not accepted this Engine's key yet .* Try again in a minute\.$/)
            h.change(doc => { delete (doc.engineDB as any)[REMOTE].peerAccess })
            await expect(copyApp(h, ORIG as any, SRC, TGT)).rejects.toThrow(/has not published an Engine key \(it runs an older Engine/)
            expect(sshCalls).toEqual([])
            expect(remoteOverlays).toEqual([])
            expect(instanceTransfers).toEqual([])
            expect(order).toEqual([])
            expect(Object.keys(h.doc().instanceDB)).toEqual([ORIG])
        } finally {
            delete network.connections['10.0.0.37:4321' as any]
        }
    })

    it('a copy that fails AFTER registering keeps its folder (registered instance, not a partial copy); a refusal before the rsync touches nothing', async () => {
        h = await makeHandle('Stopped')
        failure.process = 'docker compose up failed'
        await copyApp(h, ORIG as any, SRC, TGT)
        const [newId] = await copyDirs()
        expect(newId).toBeTruthy()
        expect(h.doc().instanceDB[newId as InstanceID]).toBeTruthy()
        expect((Object.values(h.doc().operationDB)[0] as any).error).toBe('RESUME_PENDING (1/3): docker compose up failed')   // engine#497: resumes

        // a refusal (unknown target) fails before the folder exists: nothing created, nothing removed
        failure.process = null
        await fs.remove(`${tgtRoot()}/instances`)
        await expect(copyApp(h, ORIG as any, SRC, 'DISK_nope' as DiskID)).rejects.toThrow()
        expect(await copyDirs()).toEqual([])
    })

    // ── engine#582: a stale grant never lets work for the other Engine start ──

    const STALE = (engineId: string) => ({ ok: false, code: 'GRANT_EXPIRED', message: 'This permission expired (or this Engine restarted). Start again.', issuerEngineId: engineId })
    const crossSetup = async (remote: EngineID, addr: string, status = 'Running') => {
        h = await makeHandle(status)
        h.change(doc => {
            doc.diskDB[TGT].dockedTo = remote
            ;(doc.engineDB as any)[remote] = { id: remote, commands: [], lastRun: Date.now(), capabilities: [CROSS_ENGINE_RESUME_CAPABILITY] }
            peersExchanged(doc, remote)
        })
        network.connections[`${addr}:4321` as any] = { adapter: {} as any, missedDiscoveryCount: 0, hostname: 'idea-stale' as any, engineId: remote }
    }

    it('engine#582: a stale grant: nothing stopped, no ensure-dirs, no marker, no rsync, nothing registered; op Failed GRANT_EXPIRED with issuerEngineId', async () => {
        const REMOTE = 'ENGINE_remote-g1' as EngineID
        await crossSetup(REMOTE, '10.0.0.41')
        vi.mocked(preflightPeerGrant).mockClear()
        vi.mocked(dispatchToPeer).mockClear()
        vi.mocked(preflightPeerGrant).mockResolvedValueOnce(STALE(REMOTE))
        try {
            const err = await copyApp(h, ORIG as any, SRC, TGT).then(() => null, (e) => e)
            expect(err).toBeInstanceOf(PeerGrantRefusal)
            expect(err).toMatchObject({ code: 'GRANT_EXPIRED', issuerEngineId: REMOTE, traceResult: { code: 'GRANT_EXPIRED', issuerEngineId: REMOTE, dispatchedTo: REMOTE, step: 'start' } })
            expect(vi.mocked(preflightPeerGrant).mock.calls.map(c => c[1])).toEqual([REMOTE])
            expect(order).toEqual([])                       // the source was never stopped
            expect(h.doc().instanceDB[ORIG].status).toBe('Running')
            expect(sshCalls).toEqual([])                    // no ensure-dirs (mkdir) on the peer
            expect(peerInFlightCalls).toEqual([])           // no marker
            expect(instanceTransfers).toEqual([])           // no rsync of instance data
            expect(remoteOverlays).toEqual([])              // no app master / overlay / image push
            expect(helperDeletes).toEqual([])
            expect(Object.keys(h.doc().instanceDB)).toEqual([ORIG])   // nothing registered
            expect(vi.mocked(dispatchToPeer)).not.toHaveBeenCalled()
            const op = Object.values(h.doc().operationDB)[0] as any
            expect(op.status).toBe('Failed')
            expect(op.error).toMatch(/^GRANT_EXPIRED: /)
            expect(op.args).toMatchObject({ errorCode: 'GRANT_EXPIRED', issuerEngineId: REMOTE })
        } finally {
            delete network.connections['10.0.0.41:4321' as any]
        }
    })

    it('engine#582: via handleCommand the copyApp trace ends as error with errorCode GRANT_EXPIRED and issuerEngineId in its result', async () => {
        const REMOTE = 'ENGINE_remote-g5' as EngineID
        await crossSetup(REMOTE, '10.0.0.45')
        vi.mocked(preflightPeerGrant).mockResolvedValueOnce(STALE(REMOTE))
        const { commands } = await import('../../src/data/Commands.js')
        const { handleCommand } = await import('../../src/utils/commandUtils.js')
        const { commandLogText } = await import('../../src/data/CommandLogStore.js')
        const log = new Repo({ network: [], storage: undefined }).create<any>({ traces: {}, recentTraceIds: [] })
        try {
            await handleCommand(commands, h, 'engine', `copyApp ${ORIG} ${SRC} ${TGT}`, log)
            const ids = log.doc().recentTraceIds
            const t = log.doc().traces[ids[ids.length - 1]]
            expect(t).toMatchObject({ command: 'copyApp', status: 'error', errorCode: 'GRANT_EXPIRED' })
            expect(JSON.parse(commandLogText(t.result) ?? '{}')).toMatchObject({ code: 'GRANT_EXPIRED', issuerEngineId: REMOTE, dispatchedTo: REMOTE })
            expect(order).toEqual([])
            expect(instanceTransfers).toEqual([])
            expect(h.doc().instanceDB[ORIG].status).toBe('Running')
        } finally {
            delete network.connections['10.0.0.45:4321' as any]
        }
    })

    it('engine#582: the grant goes stale during the copy: checked again before registering; no row, marker kept, no startInstance', async () => {
        const REMOTE = 'ENGINE_remote-g2' as EngineID
        await crossSetup(REMOTE, '10.0.0.42', 'Stopped')
        vi.mocked(preflightPeerGrant).mockClear()
        vi.mocked(dispatchToPeer).mockClear()
        vi.mocked(preflightPeerGrant)
            .mockResolvedValueOnce({ ok: true, issuerEngineId: REMOTE })
            .mockResolvedValueOnce(STALE(REMOTE))
        try {
            await expect(copyApp(h, ORIG as any, SRC, TGT)).rejects.toMatchObject({ code: 'GRANT_EXPIRED', traceResult: { step: 'register', issuerEngineId: REMOTE } })
            expect(vi.mocked(preflightPeerGrant).mock.calls.map(c => c[1])).toEqual([REMOTE, REMOTE])
            const newId = instanceTransfers[0].dstId
            expect(peerInFlightCalls.map(c => c[0])).toEqual(['mark', 'verify'])   // never cleared: the copy stays marked there
            expect(Object.keys(h.doc().instanceDB)).toEqual([ORIG])               // not registered for the peer's disk
            expect(vi.mocked(dispatchToPeer)).not.toHaveBeenCalled()
            expect(h.doc().engineDB[REMOTE].commands).toEqual([])
            expect(sshCalls.filter(c => / rm -rf |delete-instance/.test(c))).toEqual([])   // nothing deleted there either
            expect(helperDeletes).toEqual([])
            const op = Object.values(h.doc().operationDB)[0] as any
            expect(op).toMatchObject({ status: 'Failed', args: { errorCode: 'GRANT_EXPIRED', issuerEngineId: REMOTE, targetInstanceId: newId } })
        } finally {
            delete network.connections['10.0.0.42:4321' as any]
        }
    })

    it('engine#582: a resumed cross copy after a restart of this Engine (no grant kept): refused before the marker is touched or anything is pushed', async () => {
        const REMOTE = 'ENGINE_remote-g3' as EngineID
        await crossSetup(REMOTE, '10.0.0.43', 'Stopped')
        try {
            failure.rsync = R36_RSYNC
            await copyApp(h, ORIG as any, SRC, TGT)
            const op = Object.values(h.doc().operationDB)[0] as any
            expect(op.status).toBe('Pending')
            failure.rsync = null
            instanceTransfers.length = 0
            peerInFlightCalls.length = 0
            sshCalls.length = 0
            remoteOverlays.length = 0
            vi.mocked(preflightPeerGrant).mockClear()
            vi.mocked(preflightPeerGrant).mockResolvedValueOnce(STALE(REMOTE))
            await expect(copyApp(h, ORIG as any, SRC, TGT, 'console-command', { recoveredOpId: op.id })).rejects.toMatchObject({ code: 'GRANT_EXPIRED' })
            expect(peerInFlightCalls).toEqual([])
            expect(instanceTransfers).toEqual([])
            expect(sshCalls).toEqual([])
            expect(remoteOverlays).toEqual([])
            expect(Object.keys(h.doc().instanceDB)).toEqual([ORIG])
            expect(h.doc().operationDB[op.id]).toMatchObject({ status: 'Failed', args: { errorCode: 'GRANT_EXPIRED', issuerEngineId: REMOTE } })
        } finally {
            delete network.connections['10.0.0.43:4321' as any]
        }
    })

    it('engine#595: the grant check names the transfer; a helper ticket refusal mid-copy (the target restarted) fails the op GRANT_EXPIRED, never parks it', async () => {
        const REMOTE = 'ENGINE_remote-t1' as EngineID
        await crossSetup(REMOTE, '10.0.0.46', 'Stopped')
        vi.mocked(preflightPeerGrant).mockClear()
        try {
            failure.rsync = `idea-app-data send exited with code 12: refused: GRANT_EXPIRED: Engine ${String(localEngineId)} has no live permission from this Engine to write instance x on sdz1 (it expired, this Engine restarted, or …). Nothing was written; start the operation again from the Console\nrsync: connection unexpectedly closed`
            const err = await copyApp(h, ORIG as any, SRC, TGT).then(() => null, (e) => e)
            expect(err).toBeInstanceOf(PeerGrantRefusal)
            expect(err).toMatchObject({ code: 'GRANT_EXPIRED', issuerEngineId: REMOTE, traceResult: { step: 'transfer' } })
            const [call] = vi.mocked(preflightPeerGrant).mock.calls
            const op = Object.values(h.doc().operationDB)[0] as any
            expect(call[1]).toBe(REMOTE)
            expect(call[2]).toEqual({ targetDiskId: String(TGT), dstId: op.args.targetInstanceId, appId: expect.any(String), opId: op.id, services: expect.any(Boolean) })
            expect(op.status).toBe('Failed')
            expect(op.error).toMatch(new RegExp(`^GRANT_EXPIRED: Engine ${REMOTE} refused the transfer: Engine .* has no live permission`))
            expect(op.args).toMatchObject({ errorCode: 'GRANT_EXPIRED', issuerEngineId: REMOTE })
            expect(peerInFlightCalls.map(c => c[0])).toEqual(['mark'])        // the partial stays marked there
            expect(helperDeletes).toEqual([])                                  // nothing deleted there
            expect(Object.keys(h.doc().instanceDB)).toEqual([ORIG])
        } finally {
            failure.rsync = null
            delete network.connections['10.0.0.46:4321' as any]
        }
    })

    it('engine#582: with a good grant the copy asks the target twice (start, before registering) and then dispatches startInstance', async () => {
        const REMOTE = 'ENGINE_remote-g4' as EngineID
        await crossSetup(REMOTE, '10.0.0.44', 'Stopped')
        vi.mocked(preflightPeerGrant).mockClear()
        vi.mocked(dispatchToPeer).mockClear()
        try {
            const id = await copyApp(h, ORIG as any, SRC, TGT)
            expect(id).toBeTruthy()
            expect(vi.mocked(preflightPeerGrant).mock.calls.map(c => c[1])).toEqual([REMOTE, REMOTE])
            expect(vi.mocked(dispatchToPeer)).toHaveBeenCalledWith(h, String(REMOTE), `startInstance ${id} ${TGT} --cause cross-engine-cmd`)
        } finally {
            delete network.connections['10.0.0.44:4321' as any]
        }
    })

    it('engine#582: GRANT_EXPIRED, then a fresh grant from the same issuer: the same copy runs to Done', async () => {
        const REMOTE = 'ENGINE_remote-g6' as EngineID
        await crossSetup(REMOTE, '10.0.0.47', 'Stopped')
        // the target's grant check, with the real grant code: its issued grants and key, this Engine's received grant
        const keyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-retry-'))
        clearGrantsForTests()
        vi.mocked(preflightPeerGrant).mockClear()
        vi.mocked(dispatchToPeer).mockClear()
        vi.mocked(preflightPeerGrant).mockImplementation(async (_sh: any, engineId: string) => {
            const g = grantFrom(engineId)
            if (!g) return STALE(engineId)
            try { checkGrant(g, engineId, String(localEngineId), undefined, keyDir); return { ok: true, issuerEngineId: engineId } } catch (e) {
                if (!(e instanceof GrantError)) throw e
                forgetGrant(engineId)
                return { ok: false, code: e.code, message: e.message, issuerEngineId: engineId }
            }
        })
        try {
            // a grant the issuer no longer knows (its 6 h ran out): refused at the start, nothing done
            rememberGrant(issueGrant(REMOTE, String(localEngineId), 'admin', monoNow() - GRANT_TTL_MS - 1, keyDir).grant, String(localEngineId))
            await expect(copyApp(h, ORIG as any, SRC, TGT)).rejects.toMatchObject({ code: 'GRANT_EXPIRED', issuerEngineId: REMOTE, traceResult: { step: 'start' } })
            const failed = Object.values(h.doc().operationDB)[0] as any
            expect(failed).toMatchObject({ status: 'Failed', args: { errorCode: 'GRANT_EXPIRED', issuerEngineId: REMOTE } })
            expect(grantFrom(REMOTE)).toBeNull()                       // the refused grant is dropped
            expect(instanceTransfers).toEqual([])
            expect(peerInFlightCalls).toEqual([])
            expect(Object.keys(h.doc().instanceDB)).toEqual([ORIG])

            // the Console takes a new grant from the same issuer; the same copy now runs to Done
            rememberGrant(issueGrant(REMOTE, String(localEngineId), 'admin', undefined, keyDir).grant, String(localEngineId))
            const id = await copyApp(h, ORIG as any, SRC, TGT)
            expect(id).toBeTruthy()
            expect(vi.mocked(preflightPeerGrant).mock.calls.map(c => c[1])).toEqual([REMOTE, REMOTE, REMOTE])   // refused start; start + before registering
            const done = Object.values(h.doc().operationDB).find((o: any) => o.id !== failed.id) as any
            expect(done.status).toBe('Done')
            expect(instanceTransfers).toHaveLength(1)
            expect(Object.keys(h.doc().instanceDB).sort()).toEqual([ORIG, id].sort())
            expect(vi.mocked(dispatchToPeer)).toHaveBeenCalledWith(h, String(REMOTE), `startInstance ${id} ${TGT} --cause cross-engine-cmd`)
        } finally {
            vi.mocked(preflightPeerGrant).mockImplementation(async (_sh: any, engineId: string) => ({ ok: true, issuerEngineId: engineId }))
            clearGrantsForTests()
            await fs.remove(keyDir)
            delete network.connections['10.0.0.47:4321' as any]
        }
    })

    it('engine#582: a local copy never asks for a grant', async () => {
        h = await makeHandle('Stopped')
        vi.mocked(preflightPeerGrant).mockClear()
        await copyApp(h, ORIG as any, SRC, TGT)
        expect(vi.mocked(preflightPeerGrant)).not.toHaveBeenCalled()
    })
})
