import { chalk } from 'zx'
import { Hostname } from '../data/CommonTypes.js'
import { isStickerName, normaliseName, pickUniqueName, Rand } from '../utils/nameGenerator.js'

/**
 * Install-time sticker name resolution (idea#184).
 *
 * Order:
 *  1. An explicit --hostname is used as given (existing idea01-04 keep their
 *     names; operators may re-use a sticker name on a re-install).
 *  2. A name persisted by an earlier run (/etc/idea/sticker-name) is kept, so
 *     re-running the installer or --personalize never renames a stickered Pi.
 *  3. Otherwise a new two-word name is generated that is not taken on the LAN
 *     (mDNS), nor in the network database (engineDB hostnames of the store),
 *     nor on the tailnet when tailscale is installed and online (read-only
 *     `tailscale status --json`; no central registry).
 */
export const STICKER_NAME_FILE = '/etc/idea/sticker-name'

export interface StickerNameDeps {
    readPersisted: () => Promise<string | null>
    persist: (name: string) => Promise<void>
    /** Hostnames of every Engine in the network database (may be empty if unreachable). */
    storeNames: () => Promise<{ names: string[], checked: boolean }>
    /** True when `<name>.local` already answers on the LAN. */
    lanTaken: (name: string) => Promise<boolean>
    /** Hostnames on the tailnet; checked=false when tailscale is absent or not online. */
    tailnetNames?: () => Promise<{ names: string[], checked: boolean }>
    rand?: Rand
    log?: (msg: string) => void
}

export interface StickerNameResult {
    name: Hostname
    source: 'explicit' | 'persisted' | 'generated'
    storeChecked: boolean
    tailnetChecked: boolean
}

export const resolveStickerName = async (explicit: string | undefined, deps: StickerNameDeps, maxLanTries = 20): Promise<StickerNameResult> => {
    const log = deps.log ?? (() => {})
    if (explicit) {
        const n = normaliseName(explicit)
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(n)) throw new Error(`bad hostname '${explicit}'`)
        await deps.persist(n)
        return { name: n as Hostname, source: 'explicit', storeChecked: false, tailnetChecked: false }
    }
    const persisted = await deps.readPersisted()
    if (persisted && isStickerName(normaliseName(persisted))) {
        return { name: normaliseName(persisted) as Hostname, source: 'persisted', storeChecked: false, tailnetChecked: false }
    }
    const { names, checked } = await deps.storeNames()
    if (!checked) log('WARNING: network database not reachable; name checked against the LAN only')
    const tailnet = deps.tailnetNames ? await deps.tailnetNames() : { names: [], checked: false }
    if (tailnet.checked) log(`checking the name against ${tailnet.names.length} tailnet name(s)`)
    const taken = new Set([...names, ...tailnet.names].map(normaliseName))
    for (let i = 0; i < maxLanTries; i++) {
        const candidate = pickUniqueName(taken, deps.rand)
        if (await deps.lanTaken(candidate)) {
            log(`${candidate}.local is already on the LAN; picking another name`)
            taken.add(candidate)
            continue
        }
        await deps.persist(candidate)
        return { name: candidate, source: 'generated', storeChecked: checked, tailnetChecked: tailnet.checked }
    }
    throw new Error(`no free sticker name after ${maxLanTries} LAN checks`)
}

/** Unique hostnames in a store document's engineDB. */
export const engineHostnames = (doc: { engineDB?: Record<string, { hostname?: string }> } | undefined): string[] =>
    [...new Set(Object.values(doc?.engineDB ?? {}).map((e) => e?.hostname).filter((h): h is string => !!h))]

/** Text for the sticker, printed at the end of the install and saved next to it. */
export const stickerText = (name: string, consolePort: number): string => {
    const url = `http://${name}.local${consolePort === 80 ? '' : `:${consolePort}`}`
    return [
        '+------------------------------------------+',
        `  STICKER NAME:  ${name}`,
        `  Console:       ${url}`,
        '+------------------------------------------+',
    ].join('\n')
}

// ---------------------------------------------------------------------------
// Real dependencies (Pi). `exec` is zx `$` locally or the ssh wrapper remotely.
// ---------------------------------------------------------------------------

/** tailscale and avahi tools live in /usr/sbin and /usr/bin; a non-login ssh PATH may lack /usr/sbin. */
const TOOL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export interface RealDepsOpts {
    peers?: string[]
    log?: (m: string) => void
    /** Where the chosen name is kept (default /etc/idea/sticker-name). A non-default
     *  path is written without sudo (used by script/sticker-name.ts --no-rename). */
    stickerFile?: string
}

export const realStickerNameDeps = (exec: any, opts: RealDepsOpts = {}): StickerNameDeps => {
    const file = opts.stickerFile ?? STICKER_NAME_FILE
    const log = opts.log ?? ((m: string) => console.log(chalk.yellow(m)))
    let avahiWarned = false
    return {
    log,
    readPersisted: async () => {
        try { return (await exec`cat ${file} 2>/dev/null || true`).stdout.trim() || null } catch { return null }
    },
    persist: async (name) => {
        if (file === STICKER_NAME_FILE) await exec`sudo mkdir -p /etc/idea && echo ${name} | sudo tee ${file} > /dev/null`
        else await exec`mkdir -p "$(dirname ${file})" && echo ${name} > ${file}`
    },
    lanTaken: async (name) => {
        try {
            const r = await exec`PATH=${TOOL_PATH}; if command -v avahi-resolve-host-name >/dev/null 2>&1; then timeout 5 avahi-resolve-host-name -4 ${name + '.local'} 2>/dev/null || true; else echo NO-AVAHI-UTILS; fi`
            const out = r.stdout.trim()
            if (out === 'NO-AVAHI-UTILS') {
                if (!avahiWarned) log('WARNING: avahi-resolve-host-name missing (apt install avahi-utils); name NOT checked on the LAN')
                avahiWarned = true
                return false
            }
            return out.length > 0
        } catch { return false }
    },
    storeNames: async () => storeNamesFromPeers(opts.peers ?? await lanEnginePeers(exec)),
    tailnetNames: async () => {
        try {
            const r = await exec`PATH=${TOOL_PATH}; command -v tailscale >/dev/null 2>&1 && timeout 10 tailscale status --json 2>/dev/null || true`
            return parseTailscaleStatusNames(r.stdout)
        } catch { return { names: [], checked: false } }
    },
    }
}

/**
 * Hostnames from `tailscale status --json` (read-only). Only counts when the
 * node is online (BackendState "Running"); otherwise checked=false. Takes both
 * the OS HostName and the MagicDNS label (first part of DNSName) of self and peers.
 */
export const parseTailscaleStatusNames = (out: string): { names: string[], checked: boolean } => {
    let j: any
    try { j = JSON.parse(out) } catch { return { names: [], checked: false } }
    if (!j || j.BackendState !== 'Running') return { names: [], checked: false }
    const names = new Set<string>()
    const add = (n: any) => {
        if (!n) return
        if (typeof n.HostName === 'string' && n.HostName) names.add(normaliseName(n.HostName))
        if (typeof n.DNSName === 'string' && n.DNSName) {
            const label = n.DNSName.split('.')[0]
            if (label) names.add(normaliseName(label))
        }
    }
    add(j.Self)
    for (const p of Object.values(j.Peer ?? {})) add(p)
    return { names: [...names], checked: true }
}

/** Hostnames of Engines advertising on the LAN (ciao service, TXT name=...). */
export const lanEnginePeers = async (exec: any): Promise<string[]> => {
    try {
        const r = await exec`PATH=${TOOL_PATH}; timeout 6 avahi-browse -atrp 2>/dev/null || true`
        return parseAvahiEngineNames(r.stdout)
    } catch { return [] }
}

/** Engine names from `avahi-browse -atrp` output: resolved (=) lines with a TXT "name=" and "id=". */
export const parseAvahiEngineNames = (out: string): string[] => {
    const names = new Set<string>()
    for (const line of out.split('\n')) {
        if (!line.startsWith('=')) continue
        if (!line.includes('"id=')) continue
        const m = line.match(/"name=([^"]+)"/)
        if (m) names.add(normaliseName(m[1]))
    }
    return [...names]
}

/** Read engineDB hostnames from the first peer that serves its store. */
/** Console ports to try on a peer: an Engine serves /api/store-url on its httpPort,
 *  which is 80 on a default install but often 8080 on the pool. */
export const STORE_PORTS = [80, 8080]

export const storeNamesFromPeers = async (peers: string[], ports: number[] = STORE_PORTS): Promise<{ names: string[], checked: boolean }> => {
    const { createClientStore } = await import('../data/Store.js')
    for (const peer of peers) for (const port of ports) {
        const host = peer.endsWith('.local') ? peer : `${peer}.local`
        try {
            const res = await fetch(`http://${host}${port === 80 ? '' : `:${port}`}/api/store-url`, { signal: AbortSignal.timeout(5000) })
            if (!res.ok) continue
            const url = (await res.json())?.url as string | undefined
            if (!url?.startsWith('automerge:')) continue
            const conn = createClientStore([host], `installer-${process.pid}` as any, url.replace('automerge:', '') as any, 15)
            const { handle, repo } = await Promise.race([conn, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 20_000))])
            const doc = await Promise.resolve(handle.doc()) as any
            const names = engineHostnames(doc)
            try { await repo.shutdown() } catch { /* ignore */ }
            return { names: [...names, ...peers], checked: true }
        } catch { /* try next peer */ }
    }
    return { names: peers, checked: false }
}

export const writeStickerFile = async (exec: any, text: string, path = '/home/pi/STICKER.txt') => {
    try { await exec`echo ${text} > ${path}` } catch { /* best effort */ }
}
