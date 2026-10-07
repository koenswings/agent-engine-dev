/**
 * fresh-engine-start.test.ts
 *
 * idea#145: a freshly provisioned Engine must start without manual steps.
 *   1. command-log-url.txt names a doc that no peer has (fresh checkout with the
 *      tracked fleet URL) or that is gone from local storage (store-data wiped):
 *      createCommandLogStore gives up after a timeout, creates a fresh
 *      CommandLogStore and rewrites the file, instead of hanging on whenReady().
 *   2. /META.yaml missing: ensureSystemMeta creates it (hardware serial or a
 *      generated id) instead of the Engine exiting at import, or fails with an
 *      actionable error.
 *
 * Uses temp folders only: never store-identity/ and never the real /META.yaml.
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'os'
import { fs, path } from 'zx'
import { Repo, DocHandle, generateAutomergeUrl } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import {
    CommandLogStore, createCommandLogStore, findCommandLogWithTimeout, getCommandLogHandle,
    setCommandLogHandle, shutdownRepo, COMMAND_LOG_LOAD_TIMEOUT_MS,
} from '../../src/data/CommandLogStore.js'
import { DiskMeta, ensureSystemMeta, SYSTEM_META_HELP, SYSTEM_META_PATH } from '../../src/data/Meta.js'
import { DeviceName, DiskID } from '../../src/data/CommonTypes.js'
import pack from '../../package.json' with { type: 'json' }

const ROOT = process.cwd()
let dir = ''
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-145-')) })
afterEach(async () => {
    setCommandLogHandle(null)
    await fs.remove(dir)
})

// ── 1. Command log ──────────────────────────────────────────────────────────

describe('command log never hangs on an unavailable command-log-url.txt (idea#145)', () => {
    const urlFileIn = () => path.join(dir, 'store-identity', 'command-log-url.txt')

    it('a doc no peer ever supplies (find never settles): times out, creates a fresh log, rewrites the file', async () => {
        const fleetUrl = generateAutomergeUrl()
        await fs.outputFile(urlFileIn(), fleetUrl + '\n')
        const repo = new Repo({ network: [], storage: undefined })
        // What a fresh Pi saw: find() waits for a peer that never comes
        ;(repo as any).find = () => new Promise(() => {})

        const started = Date.now()
        const handle = await createCommandLogStore(repo, { urlFile: urlFileIn(), timeoutMs: 300 })
        const took = Date.now() - started

        expect(took).toBeGreaterThanOrEqual(250)
        expect(took).toBeLessThan(5_000)
        expect(handle.url).not.toBe(fleetUrl)
        expect(handle.doc()).toEqual({ traces: {}, recentTraceIds: [] })
        expect((await fs.readFile(urlFileIn(), 'utf-8')).trim()).toBe(handle.url)
        expect(getCommandLogHandle()).toBe(handle)
    })

    it('after a store-data wipe (own previous log gone from storage): recovers with a new log', async () => {
        const storageDir = path.join(dir, 'store-data')
        // Previous run: a log in storage, its URL in the file
        const repo1 = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const old = await createCommandLogStore(repo1, { urlFile: urlFileIn(), timeoutMs: 2_000 })
        await repo1.flush()
        const oldUrl = old.url
        await repo1.shutdown()
        // Wipe store-data, restart
        await fs.remove(storageDir)
        const repo2 = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const started = Date.now()
        const handle = await createCommandLogStore(repo2, { urlFile: urlFileIn(), timeoutMs: 2_000 })
        expect(Date.now() - started).toBeLessThan(5_000)
        expect(handle.url).not.toBe(oldUrl)
        expect((await fs.readFile(urlFileIn(), 'utf-8')).trim()).toBe(handle.url)
        // The unavailable old handle stays cached: plain repo.shutdown() would throw
        // "DocHandle is not ready"; shutdownRepo still saves the new log.
        handle.change(d => { d.recentTraceIds.push('after-wipe') })
        await shutdownRepo(repo2)
        const repo3 = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const again = await createCommandLogStore(repo3, { urlFile: urlFileIn(), timeoutMs: 5_000 })
        expect(again.url).toBe(handle.url)
        expect(again.doc()!.recentTraceIds).toEqual(['after-wipe'])
        await shutdownRepo(repo3)
    })

    it('start.ts shuts the repo down with shutdownRepo', () => {
        expect(fs.readFileSync(path.join(ROOT, 'src/start.ts'), 'utf-8')).toContain('await shutdownRepo(repo)')
    })

    it('a log that is in local storage is loaded, and the file is left as it is', async () => {
        const storageDir = path.join(dir, 'store-data')
        const repo1 = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const first = await createCommandLogStore(repo1, { urlFile: urlFileIn() })
        first.change(d => { d.recentTraceIds.push('t1') })
        await repo1.flush()
        await repo1.shutdown()

        const repo2 = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
        const second = await createCommandLogStore(repo2, { urlFile: urlFileIn(), timeoutMs: 5_000 })
        expect(second.url).toBe(first.url)
        expect(second.doc()!.recentTraceIds).toEqual(['t1'])
        expect((await fs.readFile(urlFileIn(), 'utf-8')).trim()).toBe(first.url)
        await repo2.shutdown()
    })

    it('an empty or invalid URL file and a missing file all give a fresh log', async () => {
        for (const content of [null, '', 'not-an-automerge-url']) {
            await fs.remove(urlFileIn())
            if (content !== null) await fs.outputFile(urlFileIn(), content)
            const repo = new Repo({ network: [], storage: undefined })
            const handle = await createCommandLogStore(repo, { urlFile: urlFileIn(), timeoutMs: 300 })
            expect((await fs.readFile(urlFileIn(), 'utf-8')).trim(), String(content)).toBe(handle.url)
        }
    })

    it('findCommandLogWithTimeout rejects with a clear reason and aborts the pending find', async () => {
        const repo = new Repo({ network: [], storage: undefined })
        let signal: AbortSignal | undefined
        ;(repo as any).find = (_u: string, opts: { signal?: AbortSignal }) => { signal = opts?.signal; return new Promise(() => {}) }
        await expect(findCommandLogWithTimeout(repo, generateAutomergeUrl(), 100)).rejects.toThrow(/not available after 100 ms/)
        expect(signal?.aborted).toBe(true)
    })

    it('the default timeout is 10 s and start.ts still uses createCommandLogStore', () => {
        expect(COMMAND_LOG_LOAD_TIMEOUT_MS).toBe(10_000)
        expect(fs.readFileSync(path.join(ROOT, 'src/start.ts'), 'utf-8')).toContain('await createCommandLogStore(repo)')
    })
})

// ── 2. /META.yaml ───────────────────────────────────────────────────────────

describe('/META.yaml is created when missing (idea#145)', () => {
    const metaPath = () => path.join(dir, 'META.yaml')

    it('missing: writes a new META with the hardware serial when there is one', async () => {
        const written: [DiskMeta, string][] = []
        const meta = await ensureSystemMeta('sda2' as DeviceName, {
            path: metaPath(),
            deps: {
                readHardwareId: async (d) => (d === 'sda2' ? 'SERIAL-145' as DiskID : undefined),
                write: async (m, p) => { written.push([m, p]) },
                now: () => 1_700_000_000_000,
            },
        })
        expect(written).toHaveLength(1)
        expect(written[0][1]).toBe(metaPath())
        expect(meta).toEqual({
            diskId: 'SERIAL-145', isHardwareId: true, diskName: 'SERIAL-145',
            created: 1_700_000_000_000, lastDocked: 1_700_000_000_000, version: String(pack.version),
        })
        expect(written[0][0]).toEqual(meta)
    })

    it('missing and no hardware serial (e.g. an SSD model that is not recognised): a generated id, really written', async () => {
        const meta = await ensureSystemMeta('sda2' as DeviceName, {
            path: metaPath(),
            deps: { readHardwareId: async () => undefined },   // real writeMetaFile: plain write in a temp dir
        })
        expect(meta!.isHardwareId).toBe(false)
        expect(String(meta!.diskId).length).toBeGreaterThan(8)
        expect(fs.readFileSync(metaPath(), 'utf-8')).toContain(`diskId: ${meta!.diskId}`)
    })

    it('present: nothing is written and null is returned', async () => {
        await fs.writeFile(metaPath(), 'diskId: keep-me\n')
        let wrote = false
        expect(await ensureSystemMeta('sda2' as DeviceName, { path: metaPath(), deps: { write: async () => { wrote = true } } })).toBeNull()
        expect(wrote).toBe(false)
        expect(fs.readFileSync(metaPath(), 'utf-8')).toBe('diskId: keep-me\n')
    })

    it('a failed write gives an actionable error, not a crash without a reason', async () => {
        await expect(ensureSystemMeta('sda2' as DeviceName, {
            path: metaPath(),
            deps: { readHardwareId: async () => undefined, write: async () => { throw new Error('sudo: a password is required') } },
        })).rejects.toThrow(/is missing and could not be created: sudo: a password is required\. Run \.\/build-engine --personalize/)
    })

    it('testMode/isDev (allowCreate false) never writes; the error says what to do', async () => {
        let wrote = false
        await expect(ensureSystemMeta('sda2' as DeviceName, { path: metaPath(), allowCreate: false, deps: { write: async () => { wrote = true } } }))
            .rejects.toThrow(SYSTEM_META_HELP)
        expect(wrote).toBe(false)
    })

    it('readMetaUpdateId creates the system META before reading it; Engine.ts exits with a readable reason', () => {
        expect(SYSTEM_META_PATH).toBe('/META.yaml')
        const meta = fs.readFileSync(path.join(ROOT, 'src/data/Meta.ts'), 'utf-8')
        expect(meta).toMatch(/if \(!deviceSpec\) \{\s*await ensureSystemMeta\(device, \{ allowCreate: allowSystemMetaCreate\(\) \}\)/)
        const engine = fs.readFileSync(path.join(ROOT, 'src/data/Engine.ts'), 'utf-8')
        expect(engine).toContain('Cannot start the Engine: could not determine the local Engine id')
    })
})
