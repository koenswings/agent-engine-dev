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
    const responder = ciao.getResponder()

    if (!engineName) {
        throw new Error(`No engine hostname found in the store`)
    }

    log(`Advertising on all interfaces`)
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
        log(`The following service is published on all interfaces: ${engineName}._engine._tcp.local`);
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
    } catch (error) {
        log(`***node-dns-sd*** Error discovering engines`)
        console.error(error);
    }
}

export const enableMulticastDNSEngineMonitor = (storeHandle: DocHandle<Store>, repo: Repo): { end: () => Promise<void> } => {
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
