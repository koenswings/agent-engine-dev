/**
 * InstanceCopy.ts — helpers for commands that copy an instance folder
 * (copyApp, moveApp, installApp from a disk). idea#168 r35.
 *
 *  - assertNoExternalLinks: refuse instance data that links off the disk.
 *    rsync -a (copy/move) and fs.copy (install) reproduce a symlink verbatim,
 *    so a link that leaves the instance folder makes the copy share the
 *    original's data (r35: two Kolibris on one SQLite DB). We refuse rather
 *    than dereference: dereferencing silently copies an arbitrarily large
 *    external tree.
 *  - uniqueCopyName: the copy's instance name (`<name>-2`, `<name>-3`, …).
 *  - clearEnginePort: drop the Engine-written `port=` line from a copied .env
 *    so startInstance allocates a fresh, store-checked port for the copy.
 *  - setComposeInstanceName: write the copy's name into compose.yaml
 *    `x-app.instanceName`, which createOrUpdateInstance stores.
 */

import path from 'path'
import { fs, chalk } from 'zx'
import { parseDocument } from 'yaml'
import { log } from '../utils/utils.js'
import type { Store } from './Store.js'
import type { InstanceName } from './CommonTypes.js'

// ── Off-disk links ────────────────────────────────────────────────────────────

export interface ExternalLink {
    /** The link, relative to the instance folder (e.g. 'data/kolibri') */
    link: string
    /** Where it points: the resolved real path when it exists, else the lexical target */
    target: string
}

const isWithin = (p: string, root: string): boolean => {
    const rel = path.relative(root, p)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Every symlink under `root` that resolves outside `root` (lexically, or after
 * following the link chain). Symlinked directories are not descended into.
 * A directory the Engine (pi) cannot read is skipped with a log line: rsync /
 * fs.copy cannot read it either, so nothing in it can be copied as a link.
 */
export const findExternalLinks = async (root: string): Promise<ExternalLink[]> => {
    const rootLex = path.resolve(root)
    let rootReal: string | undefined
    const realRoot = async (): Promise<string> => {
        if (rootReal === undefined) {
            try { rootReal = await fs.realpath(rootLex) } catch { rootReal = rootLex }
        }
        return rootReal as string
    }
    const found: ExternalLink[] = []
    const walk = async (dir: string): Promise<void> => {
        let entries: any[]
        try {
            entries = await fs.readdir(dir, { withFileTypes: true }) as any[]
        } catch (e: any) {
            if (dir !== rootLex || e?.code !== 'ENOENT') {
                log(chalk.yellow(`findExternalLinks: cannot read ${dir} (${e?.code ?? e}); skipped`))
            }
            return
        }
        for (const entry of entries ?? []) {
            if (!entry || typeof entry !== 'object' || typeof entry.isSymbolicLink !== 'function') continue
            const p = path.join(dir, entry.name)
            if (entry.isSymbolicLink()) {
                let raw: string
                try { raw = await fs.readlink(p) } catch { continue }
                const lexical = path.resolve(path.dirname(p), raw)
                const rr = await realRoot()
                let real: string | null = null
                try { real = await fs.realpath(p) } catch { /* dangling link */ }
                const lexicalInside = isWithin(lexical, rootLex) || isWithin(lexical, rr)
                const realInside = real === null || isWithin(real, rr) || isWithin(real, rootLex)
                if (!lexicalInside || !realInside) {
                    found.push({ link: path.relative(rootLex, p), target: real ?? lexical })
                }
            } else if (entry.isDirectory()) {
                await walk(p)
            }
        }
    }
    await walk(rootLex)
    return found
}

/**
 * The refusal text for off-disk links (no command prefix): names each link and
 * its target, the folder and the disk.
 */
export const externalLinksMessage = (
    instanceDir: string,
    disk: { id: unknown, name: unknown },
    links: ExternalLink[],
): string => {
    const shown = links.slice(0, 10).map(l => `'${l.link}' -> '${l.target}'`).join(', ')
    const more = links.length > 10 ? ` (and ${links.length - 10} more)` : ''
    return `instance data links off the disk: ${shown}${more}. ` +
        `These links in ${instanceDir} on disk '${disk.name}' (${disk.id}) resolve outside the instance folder, ` +
        `so the result would share that data with the original. Replace each link with the real data, then retry.`
}

/** Throw `<command>: instance data links off the disk: …` when there is any. */
export const assertNoExternalLinks = async (
    command: string,
    instanceDir: string,
    disk: { id: unknown, name: unknown },
): Promise<void> => {
    const links = await findExternalLinks(instanceDir)
    if (links.length > 0) throw new Error(`${command}: ${externalLinksMessage(instanceDir, disk, links)}`)
}

// ── Copy name ─────────────────────────────────────────────────────────────────

/**
 * The instance name for a copy: `<base>-<n>` with the smallest n >= 2 that no
 * instance in the store (any engine) uses. The base is the original's name,
 * except that a name that is itself a copy name (`<x>-<n>`, n >= 2, where an
 * instance named `<x>` exists) continues that series: copying `kolibri-2`
 * gives `kolibri-3`, not `kolibri-2-2`. Names such as `kolibri-grade5a-001`
 * are kept whole (`kolibri-grade5a-001-2`).
 */
export const uniqueCopyName = (store: Store, name: string): InstanceName => {
    const taken = new Set(Object.values(store.instanceDB ?? {}).filter(Boolean).map(i => String(i.name)))
    let base = name
    const m = /^(.+)-([1-9]\d*)$/.exec(name)
    if (m && Number(m[2]) >= 2 && taken.has(m[1])) base = m[1]
    for (let n = 2; ; n++) {
        const candidate = `${base}-${n}`
        if (!taken.has(candidate)) return candidate as InstanceName
    }
}

// ── Copied .env / compose.yaml ────────────────────────────────────────────────

/**
 * Remove the Engine-written `port=` line from .env text. Other lines (pass,
 * hostname, ip, app keys) are kept. App/fixture keys such as
 * KOLIBRI_HTTP_PORT in .env are not Engine-written and are left alone: the
 * Engine rewrites the compose listen env to the allocated port at every start
 * (syncKolibriHostListenPort).
 */
export const clearEnginePort = (envText: string): string =>
    envText.split('\n').filter(line => !/^port=/.test(line)).join('\n')

/** Set compose.yaml `x-app.instanceName`, keeping comments and layout. */
export const setComposeInstanceName = (composeText: string, name: string): string => {
    const doc = parseDocument(composeText)
    if (doc.errors.length > 0) throw new Error(`compose.yaml does not parse: ${doc.errors[0].message}`)
    doc.setIn(['x-app', 'instanceName'], name)
    return doc.toString()
}

/**
 * The copy's rewritten files, built from the SOURCE instance folder (so the
 * same content serves a local and a cross-engine target). A file that does not
 * exist in the source is omitted.
 */
export const preparedCopyFiles = async (
    instanceSrc: string,
    copyName: string,
): Promise<{ 'compose.yaml'?: string, '.env'?: string }> => {
    const out: { 'compose.yaml'?: string, '.env'?: string } = {}
    const read = async (f: string): Promise<string | null> => {
        try { return await fs.readFile(`${instanceSrc}/${f}`, 'utf8') } catch (e: any) {
            if (e?.code === 'ENOENT') return null
            throw e
        }
    }
    const compose = await read('compose.yaml')
    if (typeof compose === 'string') out['compose.yaml'] = setComposeInstanceName(compose, copyName)
    const env = await read('.env')
    if (typeof env === 'string') out['.env'] = clearEnginePort(env)
    return out
}
