/**
 * engine#567: durable drop-in for NodeFSStorageAdapter (automerge-repo-storage-nodefs).
 *
 * The stock adapter writes every chunk with a plain fs.writeFile (no fsync) and
 * automerge-repo's compaction unlinks the old chunks right after it (StorageSubsystem
 * #saveTotal: await save(new); then remove(old)). After a power cut on ext4 that left
 * only new 0-byte chunks (kind-panda, 18 Oct 2026): the store loaded as {} and the
 * Engine crash-looped.
 *
 * Same on-disk layout as NodeFSStorageAdapter (<base>/<first 2 id chars>/<rest>/...),
 * so existing store-data loads unchanged, and:
 *   - save: temp file in the target folder -> write -> fsync -> rename -> fsync the folder
 *     (and fsync the parents of any folder it had to create). It resolves only when the
 *     chunk is durable; automerge-repo awaits save before it removes the old chunks, so
 *     an old chunk is never unlinked before its replacement is on disk.
 *   - remove / removeRange: plain unlink / rm, no fsync (a lost unlink only leaves a
 *     redundant chunk, which Automerge dedupes on load).
 *   - load: a 0-byte file counts as missing (undefined) and is moved to the quarantine
 *     folder next to the store (StoreQuarantine.ts), never deleted.
 *   - loadRange skips temp files (dot names); a leftover temp file of another process
 *     (a crash mid-save) is quarantined.
 */
import fs from 'fs'
import path from 'path'
import type { Chunk, StorageAdapterInterface, StorageKey } from '@automerge/automerge-repo'
import { error } from '../utils/utils.js'
import { quarantineFile } from './StoreQuarantine.js'

/** The file operations the adapter uses; injectable so tests can record their order. */
export interface DurableIo {
    open: (p: string, flags: string) => Promise<{ writeFile: (d: Uint8Array) => Promise<void>, sync: () => Promise<void>, close: () => Promise<void> }>
    rename: (from: string, to: string) => Promise<void>
    mkdir: (p: string, opts: { recursive: true }) => Promise<string | undefined>
    readFile: (p: string) => Promise<Uint8Array>
    unlink: (p: string) => Promise<void>
    rm: (p: string, opts: { recursive: true, force: true }) => Promise<void>
    readdir: (p: string) => Promise<fs.Dirent[]>
}

export const nodeIo: DurableIo = {
    open: (p, flags) => fs.promises.open(p, flags),
    rename: (a, b) => fs.promises.rename(a, b),
    mkdir: (p, o) => fs.promises.mkdir(p, o),
    readFile: (p) => fs.promises.readFile(p),
    unlink: (p) => fs.promises.unlink(p),
    rm: (p, o) => fs.promises.rm(p, o),
    readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
}

export const TEMP_PREFIX = '.tmp-'
// One counter per process, not per adapter: two adapters on one folder (a test's next Repo
// while the previous one still saves storage-adapter-id) must never share a temp file name.
let tempSeq = 0

const getKey = (key: StorageKey | string[]): string => path.join(...key)

/** The pid in a temp file name (.tmp-<pid>-<seq>-<name>), or null. */
export const tempFilePid = (name: string): number | null => {
    const m = /^\.tmp-(\d+)-/.exec(name)
    return m ? Number(m[1]) : null
}

export class DurableNodeFSStorageAdapter implements StorageAdapterInterface {
    readonly baseDirectory: string
    private cache: Record<string, Uint8Array> = {}
    private readonly io: DurableIo

    constructor(baseDirectory = 'automerge-repo-data', io: DurableIo = nodeIo) {
        this.baseDirectory = baseDirectory
        this.io = io
    }

    async load(keyArray: StorageKey): Promise<Uint8Array | undefined> {
        const key = getKey(keyArray)
        if (this.cache[key]) return this.cache[key]
        const filePath = this.getFilePath(keyArray)
        let content: Uint8Array
        try {
            content = await this.io.readFile(filePath)
        } catch (e: any) {
            if (e?.code === 'ENOENT') return undefined
            throw e
        }
        if (content.length === 0) {
            await quarantineFile(this.baseDirectory, filePath, 'empty (0-byte) chunk')
            return undefined
        }
        return new Uint8Array(content)
    }

    async save(keyArray: StorageKey, binary: Uint8Array): Promise<void> {
        const key = getKey(keyArray)
        this.cache[key] = binary
        const filePath = this.getFilePath(keyArray)
        const dir = path.dirname(filePath)
        await this.mkdirDurable(dir)
        const tmp = path.join(dir, `${TEMP_PREFIX}${process.pid}-${++tempSeq}-${path.basename(filePath)}`)
        const fh = await this.io.open(tmp, 'w')
        try {
            await fh.writeFile(binary)
            await fh.sync()
        } finally {
            await fh.close()
        }
        await this.io.rename(tmp, filePath)
        await this.fsyncDir(dir)
    }

    async remove(keyArray: StorageKey): Promise<void> {
        delete this.cache[getKey(keyArray)]
        try {
            await this.io.unlink(this.getFilePath(keyArray))
        } catch (e: any) {
            if (e?.code !== 'ENOENT') throw e
        }
    }

    async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
        const dirPath = this.getFilePath(keyPrefix)
        const cachedKeys = this.cachedKeys(keyPrefix)
        const diskFiles = await this.walkdir(dirPath)
        const diskKeys = diskFiles.map(fileName => {
            const k = getKey([path.relative(this.baseDirectory, fileName)])
            return k.slice(0, 2) + k.slice(3)
        })
        const allKeys = [...new Set([...cachedKeys, ...diskKeys])]
        const chunks = await Promise.all(allKeys.map(async keyString => {
            const key = keyString.split(path.sep)
            const data = await this.load(key)
            return { data, key }
        }))
        return chunks
    }

    async removeRange(keyPrefix: StorageKey): Promise<void> {
        this.cachedKeys(keyPrefix).forEach(key => delete this.cache[key])
        await this.io.rm(this.getFilePath(keyPrefix), { recursive: true, force: true })
    }

    private cachedKeys(keyPrefix: string[]): string[] {
        const prefix = getKey(keyPrefix)
        return Object.keys(this.cache).filter(key => key.startsWith(prefix))
    }

    private getFilePath(keyArray: string[]): string {
        const [firstKey, ...remainingKeys] = keyArray
        return path.join(this.baseDirectory, firstKey.slice(0, 2), firstKey.slice(2), ...remainingKeys)
    }

    /** fsync a folder so a rename/create in it is durable. EINVAL/EISDIR (no dir fsync on this fs) is ignored. */
    private async fsyncDir(dir: string): Promise<void> {
        let fh
        try {
            fh = await this.io.open(dir, 'r')
            await fh.sync()
        } catch (e: any) {
            if (e?.code !== 'EINVAL' && e?.code !== 'EISDIR') throw e
        } finally {
            await fh?.close()
        }
    }

    /** mkdir -p; when it created folders, fsync each new folder's parent so the entries survive a power cut. */
    private async mkdirDurable(dir: string): Promise<void> {
        const first = await this.io.mkdir(dir, { recursive: true })
        if (!first) return
        const created = path.resolve(first)
        let d = path.resolve(dir)
        const toSync: string[] = []
        while (true) {
            toSync.push(path.dirname(d))
            if (d === created || path.dirname(d) === d) break
            d = path.dirname(d)
        }
        for (const p of toSync.reverse()) await this.fsyncDir(p)
    }

    /** Files under dirPath, recursively; skips temp files (quarantining another process's leftovers). */
    private async walkdir(dirPath: string): Promise<string[]> {
        let entries: fs.Dirent[]
        try {
            entries = await this.io.readdir(dirPath)
        } catch (e: any) {
            if (e?.code === 'ENOENT') return []
            throw e
        }
        const files = await Promise.all(entries.map(async (entry): Promise<string[]> => {
            const sub = path.resolve(dirPath, entry.name)
            if (entry.isDirectory()) return this.walkdir(sub)
            if (entry.name.startsWith('.')) {
                const pid = tempFilePid(entry.name)
                if (pid !== null && pid !== process.pid) {
                    await quarantineFile(this.baseDirectory, sub, 'leftover temp file of an interrupted save')
                } else if (pid === null) {
                    error(`[store-health] ignoring unexpected hidden file ${sub}`)
                }
                return []
            }
            return [sub]
        }))
        return files.flat()
    }
}
