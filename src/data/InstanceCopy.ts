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
 *  - rebindKolibriMorangoInstanceId: give a Kolibri copy its own morango
 *    instance id so host-network zeroconf does not NonUniqueNameException
 *    when the original and the copy both advertise (r40 FAIL@102).
 */

import path from 'path'
import { fs, chalk } from 'zx'
import { parseDocument } from 'yaml'
import { log } from '../utils/utils.js'
import type { Store } from './Store.js'
import type { InstanceName } from './CommonTypes.js'
import {
    runAppData, helperAtLeast, kolibriRebindArgs, parseKolibriRebind, KOLIBRI_REBIND_HELPER_MIN,
    type AppDataRunner, type KolibriRebindResult,
} from '../utils/appDataHelper.js'

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
 * Remove the Engine-written `port=` and `port_zip=` (#267) lines from .env text. Other lines (pass,
 * hostname, ip, app keys) are kept. App/fixture keys such as
 * KOLIBRI_HTTP_PORT in .env are not Engine-written and are left alone: the
 * Engine rewrites the compose listen env to the allocated port at every start
 * (syncKolibriHostListenPort).
 */
export const clearEnginePort = (envText: string): string =>
    envText.split('\n').filter(line => !/^port(_zip)?=/.test(line)).join('\n')

/** Set compose.yaml `x-app.instanceName`, keeping comments and layout. */
export const setComposeInstanceName = (composeText: string, name: string): string => {
    const doc = parseDocument(composeText)
    if (doc.errors.length > 0) throw new Error(`compose.yaml does not parse: ${doc.errors[0].message}`)
    doc.setIn(['x-app', 'instanceName'], name)
    return doc.toString()
}

/**
 * engine#369: restamp x-app.instanceName and x-app.demo from the old instance.
 * demo: true writes the flag; otherwise the key is deleted so a bundle cannot
 * invent a demo (or drop one).
 */
export const stampComposeInstanceIdentity = (
    composeText: string,
    fields: { instanceName: string, demo?: true },
): string => {
    const doc = parseDocument(composeText)
    if (doc.errors.length > 0) throw new Error(`compose.yaml does not parse: ${doc.errors[0].message}`)
    doc.setIn(['x-app', 'instanceName'], fields.instanceName)
    if (fields.demo === true) doc.setIn(['x-app', 'demo'], true)
    else doc.deleteIn(['x-app', 'demo'])
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

// ── Kolibri morango identity on copy (r40) ────────────────────────────────────

/**
 * Kolibri 0.15 zeroconf registers with the current morango InstanceIDModel id.
 * copyApp clones the SQLite home, so the copy keeps the original's id. Two
 * host-network Kolibris on the same LAN then hit NonUniqueNameException, the
 * bus exits, and `start && tail -f` leaves Docker "Up" with nothing on the port
 * (r40 FAIL@102 move_app). Mint a fresh 32-hex id for the copy's current row
 * before the copy starts. mDNS itself stays on (Koen rule) — only the service
 * instance id changes.
 *
 * engine#503: the container writes db.sqlite3 as root:root 0644 and the root copy
 * keeps that owner, so the update runs in the app-data root helper
 * (`idea-app-data kolibri-rebind <root> <id>`, v21), never as pi and never by
 * chowning the container's file. The helper also moves a stale server.pid /
 * process_cache and the consumed .idea-rebind-morango markers to .idea-quarantine.
 *
 * Returns the new id, or null when the folder has no Kolibri DB or no current
 * row. Throws HELPER_OUTDATED below v21, and when the DB cannot be updated.
 */
export interface KolibriRebindDeps {
    run: AppDataRunner
    helperAtLeast: (min: number, what: string) => Promise<string | null>
}
export const kolibriRebindDeps: KolibriRebindDeps = {
    run: (args) => runAppData(args),
    helperAtLeast: (min, what) => helperAtLeast(min, what),
}

export const rebindKolibriMorangoInstanceId = async (
    root: string,
    instanceId: string,
    deps: KolibriRebindDeps = kolibriRebindDeps,
): Promise<string | null> => {
    const args = kolibriRebindArgs(root, instanceId)
    const outdated = await deps.helperAtLeast(KOLIBRI_REBIND_HELPER_MIN,
        'Starting a copied or moved Kolibri (the morango id rebind as root, engine#503)')
    if (outdated) {
        throw new Error(`HELPER_OUTDATED: ${outdated} ` +
            `Without a fresh morango id, a host-network Kolibri copy will clash with the original on zeroconf.`)
    }
    let result: KolibriRebindResult
    try {
        result = parseKolibriRebind(await deps.run(args))
    } catch (e: any) {
        throw new Error(
            `rebindKolibriMorangoInstanceId: cannot update the morango id of instance ${instanceId} on ${root}: ${e?.message ?? e}. ` +
            `Without a fresh morango id, a host-network Kolibri copy will clash with the original on zeroconf.`,
        )
    }
    for (const q of result.quarantined) log(`rebindKolibriMorangoInstanceId: moved ${q} (quarantine, never deleted)`)
    if (!result.dbPresent) {
        log(`rebindKolibriMorangoInstanceId: instance ${instanceId} on ${root} has no Kolibri db; leaving as-is`)
        return null
    }
    if (!result.morangoId) {
        log(`rebindKolibriMorangoInstanceId: no current morango row for instance ${instanceId} on ${root}; leaving as-is`)
        return null
    }
    log(`rebindKolibriMorangoInstanceId: instance ${instanceId} on ${root}: current morango id ${result.previousId ?? '?'} → ${result.morangoId}`)
    return result.morangoId
}

/** True when this instance folder looks like Kolibri (data home or compose). */
export const instanceDirLooksLikeKolibri = async (instanceDir: string): Promise<boolean> => {
    if (await fs.pathExists(path.join(instanceDir, 'data', 'kolibri', 'db.sqlite3'))) return true
    try {
        const raw = await fs.readFile(path.join(instanceDir, 'compose.yaml'), 'utf8')
        return /kolibri/i.test(raw)
    } catch {
        return false
    }
}
