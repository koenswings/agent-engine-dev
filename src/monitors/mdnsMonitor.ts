import mDnsSd from 'node-dns-sd'
import { deepPrint, log, error, print } from '../utils/utils.js';
import { chalk } from 'zx';
import { Store, getLocalEngine } from '../data/Store.js';
import { manageDiscoveredPeers } from '../data/Network.js'
import ciao, { CiaoService } from '@homebridge/ciao'
import { DocHandle, DocumentId, Repo } from '@automerge/automerge-repo';
import { EngineID, Hostname, IPAddress } from '../data/CommonTypes.js';
import { config } from '../data/Config.js';
import { readStoreDocId } from '../data/StoreIdentity.js';
import { RefusalLog, storeTag } from '../data/StoreScope.js';
import { readdirSync } from 'fs';
import { isLanInterfaceName, lanAddresses } from './ideaLocal.js';

/**
 * node-dns-sd (peer discovery) binds 0.0.0.0:5353 and, by default, sends its query on every
 * non-internal IPv4 address: tailscale0 (no MULTICAST flag → `send EPERM 224.0.0.251:5353`,
 * pool idea03), docker0/br-* (a bridge that is down or just removed → `send ENODEV`, pool
 * idea04) and veth*. The first failing interface rejects the whole discover(), so discovery
 * also skipped the real LAN for that round. Restrict it to the LAN addresses idea.local
 * publishes on (lanAddresses: never lo, docker*, br-*, veth*, tailscale*, …). Applied to the
 * singleton; node-dns-sd re-reads the list through this method at every start.
 */
export const restrictDnsSdToLan = (sd: any = mDnsSd, lan: () => string[] = () => lanAddresses().map(a => a.address)): void => {
    sd._getNetifAddressList = () => lan()
    if (Array.isArray(sd._netif_address_list)) sd._netif_address_list = lan()
}

/**
 * node-dns-sd's discover() starts `this._sendQueryPacket(buf)` without awaiting or catching it,
 * so a failing multicast send (`send EPERM 224.0.0.251:5353` when OUTPUT udp/5353 is dropped,
 * pool idea03 takeover run 2026-10-15 18:08: 36 -> 110 lines) is an unhandledRejection on
 * every 10 s round, and the remaining interfaces are skipped. Make every send resolve: an
 * error is reported (once per distinct message, see discoverySendError) and the query goes on
 * to the next interface; the round still collects answers until its wait ends.
 */
export const catchDnsSdSendErrors = (sd: any = mDnsSd, report: (e: any) => void = (e) => discoverySendError(e)): void => {
    if (sd.__ideaSendErrorsCaught) return
    const udpSend = sd._udpSend?.bind(sd)
    if (typeof udpSend === 'function') {
        sd._udpSend = (buf: Buffer, port: number, addr: string) =>
            Promise.resolve().then(() => udpSend(buf, port, addr)).catch((e: any) => { report(e) })
    }
    const sendQuery = sd._sendQueryPacket?.bind(sd)
    if (typeof sendQuery === 'function') {
        // setMulticastInterface can throw (EADDRNOTAVAIL when an address just went away)
        sd._sendQueryPacket = (buf: Buffer) =>
            Promise.resolve().then(() => sendQuery(buf)).catch((e: any) => { report(e) })
    }
    sd.__ideaSendErrorsCaught = true
}

let lastSendError = ''
/** Log a discovery send error once until a different one happens (not an EPERM flood). */
export const discoverySendError = (e: any, logger: (line: string) => void = log): void => {
    const line = `${e?.code ?? ''} ${e?.message ?? e}`.trim()
    if (line === lastSendError) return
    lastSendError = line
    logger(`***node-dns-sd*** engine discovery query could not be sent: ${line} (logged once until it changes; discovery keeps running)`)
}

/**
 * The interfaces the Engine's own mDNS service (ciao, `_engine._tcp`) is advertised on: the
 * school LAN only (every /sys/class/net name that isLanInterfaceName accepts: eth0, wlan0,
 * also while down), never docker0/br-* (pool idea03 advertised itself at 172.21.0.1 and
 * 172.22.0.1), veth*, tailscale*, lo. undefined (ciao: all interfaces) only when no LAN
 * interface exists at all, so discovery is never switched off.
 */
export const engineAdvertiseInterfaces = (names: () => string[] = () => readdirSync('/sys/class/net')): string[] | undefined => {
    let all: string[] = []
    try { all = names() } catch { return undefined }
    const lan = all.filter(isLanInterfaceName).sort()
    return lan.length > 0 ? lan : undefined
}

/** One log line per distinct discovery error, not one every 10 s round. */
let lastDiscoveryError = ''


/**
 * The TXT record this Engine advertises. `store` (StoreScope.ts storeTag: a short
 * prefix plus a hash, never the full store id) lets other Engines skip us without
 * dialling when we are not in their store (store-scoped peering).
 */
export const engineTxtRecord = (name: string, id: string, version: string, ownStoreTag: string): Record<string, string> => ({
    name, id, version, store: ownStoreTag,
})

export interface DiscoveredEngine { address: IPAddress, hostname: Hostname, engineId: EngineID, port?: number, store?: string }

/**
 * One node-dns-sd answer -> the Engine it describes, or undefined without a TXT record.
 * The TXT record is looked up in the additionals (as before) and then in the answers:
 * ciao puts it in the answer section when it answers a direct query (seen on a
 * loopback-only host), and an Engine skipped for that would never be store-checked.
 */
export const parseEngineDevice = (device: any): DiscoveredEngine | undefined => {
    const isTxt = (r: any) => typeof r == 'object' && r !== null && r.type === 'TXT' && r.rdata
    const txt = (device?.packet?.additionals ?? []).find(isTxt) ?? (device?.packet?.answers ?? []).find(isTxt)
    if (!txt) return undefined
    const t = txt.rdata
    return {
        address: device.address as IPAddress,
        hostname: t.name as Hostname,
        engineId: t.id as EngineID,
        port: device.service?.port,
        store: typeof t.store === 'string' && t.store ? t.store : undefined,
    }
}

const mdnsRefusalLog = new RefusalLog((line) => print(chalk.yellow(line)))

/**
 * Which discovered Engines may be dialled (store-scoped peering): only those whose
 * TXT `store` equals ours. A different tag, or none (an Engine older than this
 * change), is skipped and logged (rate-limited). The WS handshake check is the
 * authoritative one; this only saves the dial.
 */
export const selectStorePeers = (
    engines: DiscoveredEngine[], localEngineId: string, ownStoreTag: string,
    report: (key: string, line: string) => void = (k, l) => { mdnsRefusalLog.report(k, l) },
): Map<IPAddress, { hostname: Hostname, engineId: EngineID }> => {
    const peers = new Map<IPAddress, { hostname: Hostname, engineId: EngineID }>()
    for (const e of engines) {
        if (e.engineId && e.engineId === localEngineId) continue
        if (!(e.address && e.hostname && e.engineId)) continue
        if (e.store !== ownStoreTag) {
            const why = e.store ? `different store: theirs ${e.store}, ours ${ownStoreTag}` : `no store id in its mDNS TXT record (an Engine older than store-scoped peering); ours ${ownStoreTag}`
            report(`mdns|${e.address}|${e.store ?? ''}`, `[store-scope] REFUSED mDNS peer ${e.hostname} (${e.engineId}) at ${e.address}${e.port ? `:${e.port}` : ''}: ${why}. Not dialling it.`)
            continue
        }
        peers.set(e.address, { hostname: e.hostname, engineId: e.engineId })
    }
    return peers
}

export const startAdvertising = (store: Store): CiaoService => {
    const engine = getLocalEngine(store)
    if (!engine) {
        log(`No local engine found in the store`)
        throw new Error(`No local engine found in the store`)
    }
    const engineName = engine.hostname
    const engineVersion = engine.version
    const interfaces = engineAdvertiseInterfaces()
    const responder = ciao.getResponder(interfaces ? { interface: interfaces } : undefined)

    if (!engineName) {
        throw new Error(`No engine hostname found in the store`)
    }

    log(`Advertising on ${interfaces ? `LAN interfaces ${interfaces.join(', ')}` : 'all interfaces (no LAN interface found)'}`)
    const service = responder.createService({
        name: engineName.toString(),
        type: 'engine',
        port: config.settings.port,
        txt: engineTxtRecord(engineName, engine.id, engineVersion, storeTag(readStoreDocId()))
    })

    // Log name conflicts without updating the store — the (2) suffix is a service
    // advertisement detail, not the machine hostname.
    service.on('name-change', (newName: string) => {
        log(`mDNS service name changed to '${newName}' due to conflict — hostname in store unchanged`);
    });

    service.advertise().then(() => {
        log(`The following service is published on ${interfaces ? interfaces.join(', ') : 'all interfaces'}: ${engineName}._engine._tcp.local`);
    }).catch((err) => {
        error(`Error advertising mDNS service: ${err}`)
    })

    return service
}

/** One browse round: discover, keep Engines of our store (selectStorePeers), connect/prune. `discover` is injectable for tests. */
export const discoverEngines = async (storeHandle: DocHandle<Store>, repo:Repo, discover: (q: { name: string }) => Promise<any[]> = (q) => mDnsSd.discover(q)): Promise<void> => {
    const localEngine = getLocalEngine(storeHandle.doc());
    try {
        const deviceList = await discover({ name: '_engine._tcp.local' });
        const discovered: DiscoveredEngine[] = [];

        if (deviceList.length > 0) {
            log(chalk.bgBlackBright(`Discovered engines:`));
        }

        deviceList.forEach(device => {
            const e = parseEngineDevice(device);
            if (!e) {
                log(chalk.redBright(`  - No TXT record for ${device.modelName || device.address}. Skipping.`));
                return;
            }
            log(`  - Name: ${e.hostname || 'N/A'}, ID: ${e.engineId || 'N/A'}, Store: ${e.store || 'N/A'}, Address: ${e.address || 'N/A'}:${e.port || 'N/A'}`);
            discovered.push(e);
        });

        // Store-scoped peering: only Engines of our own store are dialled.
        const discoveredPeers = selectStorePeers(discovered, localEngine.id, storeTag(readStoreDocId()));

        await manageDiscoveredPeers(repo, discoveredPeers, storeHandle);

        if (deviceList.length === 0) {
            log(chalk.bgBlackBright(`No remote engines found`))
        }
        if (lastDiscoveryError) { log(`[mdns] engine discovery working again`); lastDiscoveryError = '' }
    } catch (error: any) {
        const line = `${error?.message ?? error}`
        if (line !== lastDiscoveryError) {
            log(`***node-dns-sd*** Error discovering engines: ${line} (logged once until it changes)`)
            lastDiscoveryError = line
        }
    }
}

export const enableMulticastDNSEngineMonitor = (storeHandle: DocHandle<Store>, repo: Repo): { end: () => Promise<void> } => {
    restrictDnsSdToLan()
    catchDnsSdSendErrors()
    const service = startAdvertising(storeHandle.doc())
    
    const runDiscovery = async () => {
        await discoverEngines(storeHandle, repo);
        setTimeout(runDiscovery, 10000);
    };

    runDiscovery();

    // Return shutdown handle so the caller can send mDNS goodbye packets on exit.
    return {
        end: () => service.end()
    }
}
