/**
 * HostIdentity: which Pi an instance is running on, for the apps (agent-engine-dev#163).
 *
 * On every start the Engine writes two variables into every instance's .env:
 *   IDEA_HOSTNAME  bare hostname of this Pi ('idea03'; no '.local')
 *   IDEA_HOST_IPS  comma-separated IPv4 addresses of this Pi (LAN, Wi-Fi, Tailscale), no ports
 * An app's compose file passes them to the containers that need them. Nextcloud's
 * before-starting hook (app-nextcloud docker-entrypoint-hooks.d/before-starting/
 * 20-idea-trusted-domains.sh) uses them to set trusted_domains.
 *
 * Because the values are rewritten on every start, they follow the instance
 * when its disk is moved or copied to another Pi.
 */
import os from 'os'
import { $, fs, YAML } from 'zx'
import { log } from '../utils/utils.js'
import { Store, getLocalEngine } from './Store.js'

export interface HostIdentity {
    hostname: string        // bare, no '.local'; '' when unknown
    ips: string[]           // IPv4, ordered: wired, wireless, others, Tailscale
}

type Ifaces = ReturnType<typeof os.networkInterfaces>

/** Injectable for tests: the network interfaces and os.hostname() this Pi reports. */
let ops: { networkInterfaces: () => Ifaces; osHostname: () => string } = {
    networkInterfaces: () => os.networkInterfaces(),
    osHostname: () => os.hostname(),
}
/** Tests only: replace the interface / hostname source (null: the real os). */
export const setHostIdentityOpsForTests = (o: Partial<typeof ops> | null): void => {
    ops = o
        ? { ...{ networkInterfaces: () => os.networkInterfaces(), osHostname: () => os.hostname() }, ...o }
        : { networkInterfaces: () => os.networkInterfaces(), osHostname: () => os.hostname() }
}

/** Container / bridge interfaces: their addresses are not reachable from a school laptop. */
const VIRTUAL_IFACE = /^(docker\d*|br-|veth|virbr|cni|flannel|lxc|lxd)/

const ifaceRank = (name: string): number => {
    if (/^(eth|en)/.test(name)) return 0
    if (/^(wlan|wl)/.test(name)) return 1
    if (/^tailscale/.test(name)) return 3
    return 2
}

/** All non-internal IPv4 addresses of this host, container bridges excluded, deduplicated. */
export const hostIPv4s = (ifaces: Ifaces = ops.networkInterfaces()): string[] => {
    const names = Object.keys(ifaces ?? {})
        .filter(n => !VIRTUAL_IFACE.test(n))
        .sort((a, b) => ifaceRank(a) - ifaceRank(b) || a.localeCompare(b))
    const out: string[] = []
    for (const n of names) {
        for (const a of ifaces[n] ?? []) {
            const fam = (a as any).family
            if ((fam === 'IPv4' || fam === 4) && !a.internal && !out.includes(a.address)) out.push(a.address)
        }
    }
    return out
}

/** Bare hostname: lower-case, trailing '.local' (and any domain) dropped. */
export const bareHostname = (h: string | undefined | null): string =>
    String(h ?? '').trim().replace(/\.local\.?$/i, '').split('.')[0].toLowerCase()

/** This Pi's identity: the local Engine's hostname (os.hostname() as fallback) and its IPv4s. */
export const hostIdentity = (store: Store): HostIdentity => {
    let hostname = ''
    try { hostname = bareHostname(getLocalEngine(store).hostname) } catch { /* no local engine record */ }
    if (!hostname) hostname = bareHostname(ops.osHostname())
    return { hostname, ips: hostIPv4s() }
}

/**
 * The wired address (eth0), else the first IPv4. Nextcloud's compose
 * uses it as `${ip}` for Collabora's extra_hosts entry.
 */
export const primaryIPv4 = (ifaces: Ifaces = ops.networkInterfaces()): string | undefined =>
    ifaces['eth0']?.find(a => ((a as any).family === 'IPv4' || (a as any).family === 4) && !a.internal)?.address
    ?? hostIPv4s(ifaces)[0]

/**
 * Set `KEY=value` lines in a .env file: replace an existing line, else append.
 * Written with fs, not addOrUpdateEnvVariable: that one goes through zx's shell
 * quoting, which turns a value with a comma into `$'a,b'` in the file, and its
 * `echo >>` glues the line onto a last line without a newline.
 */
export const setEnvLines = async (envPath: string, vars: Record<string, string>): Promise<void> => {
    const cur = (await fs.pathExists(envPath)) ? await fs.readFile(envPath, 'utf8') : ''
    let lines = cur.length ? cur.replace(/\n$/, '').split('\n') : []
    for (const [k, v] of Object.entries(vars)) {
        const first = lines.findIndex(l => l.startsWith(`${k}=`))
        lines = lines.filter((l, i) => i === first || !l.startsWith(`${k}=`))
        if (first >= 0) lines[first] = `${k}=${v}`
        else lines.push(`${k}=${v}`)
    }
    // In place (keeps the file's owner and mode; .env holds the app password)
    await fs.writeFile(envPath, lines.join('\n') + '\n')
}

/** Write IDEA_HOSTNAME / IDEA_HOST_IPS into an instance's .env (every app, every start). */
export const writeHostIdentityEnv = async (envPath: string, id: HostIdentity): Promise<void> => {
    try {
        await setEnvLines(envPath, { IDEA_HOSTNAME: id.hostname, IDEA_HOST_IPS: id.ips.join(',') })
    } catch (e: any) {
        log(`Could not write IDEA_HOSTNAME / IDEA_HOST_IPS to ${envPath}: ${e?.message ?? e}`)
    }
}

/**
 * Is this instance a Nextcloud instance? Decided from the instance's own
 * compose.yaml, not from store.appDB[instance.instanceOf]. instanceOf is built
 * from the instance compose's x-app.name/version, which need not match the
 * apps/ folder the appDB key comes from: the r54 duration fixture has
 * version '1.0-duration' in apps/nextcloud-1.0, so the appDB lookup missed and
 * the Nextcloud steps were skipped on idea03 (agent-engine-dev#163).
 */
export const isNextcloudInstance = async (instanceDir: string): Promise<boolean> => {
    try {
        const c = YAML.parse(await fs.readFile(`${instanceDir}/compose.yaml`, 'utf8')) ?? {}
        if (String(c?.['x-app']?.name ?? '').toLowerCase() === 'nextcloud') return true
        return Object.prototype.hasOwnProperty.call(c?.services ?? {}, 'nextcloud-app')
    } catch {
        return false
    }
}

// ---------------------------------------------------------------------------
// TODO-remove (agent-engine-dev#163): temporary bridge for Nextcloud instances
// on disks whose app does not yet carry 20-idea-trusted-domains.sh. Same
// algorithm and same managed key as the hook, so the two agree and the bridge
// is a no-op once the hook has run. Remove when all disks carry the hook.
// ---------------------------------------------------------------------------

export const MANAGED_KEY = 'idea_trusted_domains_managed'

/** desired = localhost, host, host.local, IPs; keeps entries the hook/bridge did not write. */
export const planTrustedDomains = (current: string[], managed: string[], id: HostIdentity) => {
    const desired: string[] = []
    const add = (v: string) => { if (v && !desired.includes(v)) desired.push(v) }
    add('localhost')
    if (id.hostname) { add(id.hostname); add(`${id.hostname}.local`) }
    for (const ip of id.ips) add(ip)
    const kept = current.filter((v, i) => v && !managed.includes(v) && !desired.includes(v) && current.indexOf(v) === i)
    const final = [...desired, ...kept]
    const own = desired.filter(v => v !== 'localhost')
    const changed = final.join('\n') !== current.join('\n') || own.join('\n') !== managed.join('\n')
    return { final, own, kept, changed }
}

/** occ runner: args after `php occ`; resolves stdout, rejects on non-zero exit. */
export type OccRunner = (args: string[]) => Promise<string>

export const dockerOcc = (instanceId: string): OccRunner => async (args) =>
    (await $`docker exec ${instanceId}-nextcloud-app-1 runuser --user www-data -- php occ ${args}`.quiet()).stdout

const getList = async (occ: OccRunner, key: string): Promise<string[]> => {
    try {
        return (await occ(['config:system:get', key])).split('\n').map(s => s.trim()).filter(Boolean)
    } catch {
        return []   // occ exits 1 for a missing key
    }
}

/** Write `values` to array key `key` by index, then drop the stale tail (never empties the list first). */
const setList = async (occ: OccRunner, key: string, values: string[], oldLen: number) => {
    for (let i = 0; i < values.length; i++) await occ(['config:system:set', key, String(i), `--value=${values[i]}`])
    for (let i = oldLen - 1; i >= values.length; i--) await occ(['config:system:delete', key, String(i)])
}

export interface BridgeResult { ok: boolean; changed: boolean; trustedDomains?: string[]; error?: string }

/**
 * Set Nextcloud's trusted_domains (and the Collabora wopi_url) for this Pi.
 * Never throws: a failure is logged and returned, the instance is not marked
 * Error (r54: the old post-start occ hack turned a slow occ into an Error).
 * No fixed wait: called after runInstance's port-ready probe.
 */
export const nextcloudTrustedDomainsBridge = async (
    instanceId: string, id: HostIdentity, occ: OccRunner = dockerOcc(instanceId), wopiIp?: string,
): Promise<BridgeResult> => {
    const tag = `nextcloud bridge ${instanceId}`
    try {
        if (!id.hostname && id.ips.length === 0) {
            log(`${tag}: no hostname or IPv4 known — trusted_domains left unchanged`)
            return { ok: true, changed: false }
        }
        if (wopiIp) {
            try { await occ(['config:app:set', '--value=http://' + wopiIp + ':9980', 'richdocuments', 'wopi_url']) }
            catch (e: any) { log(`${tag}: wopi_url not set (${e?.message ?? e}) — continuing`) }
        }
        const current = await getList(occ, 'trusted_domains')
        const managed = await getList(occ, MANAGED_KEY)
        const plan = planTrustedDomains(current, managed, id)
        if (!plan.changed) {
            log(`${tag}: trusted_domains already up to date (${plan.final.join(', ')})`)
            return { ok: true, changed: false, trustedDomains: plan.final }
        }
        await setList(occ, 'trusted_domains', plan.final, current.length)
        await setList(occ, MANAGED_KEY, plan.own, managed.length)
        log(`${tag}: trusted_domains = ${plan.final.join(', ')}${plan.kept.length ? ` (kept: ${plan.kept.join(', ')})` : ''}`)
        return { ok: true, changed: true, trustedDomains: plan.final }
    } catch (e: any) {
        const msg = String(e?.stderr || e?.message || e).trim().split('\n')[0]
        log(`${tag}: could not set trusted_domains (${msg}) — instance stays as it is`)
        return { ok: false, changed: false, error: msg }
    }
}
