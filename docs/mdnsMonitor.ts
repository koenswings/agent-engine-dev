import mDnsSd from 'node-dns-sd'
import { deepPrint, log, error } from '../utils/utils.js';
import { chalk } from 'zx';
import { Store, getLocalEngine } from '../data/Store.js';
import { manageDiscoveredPeers } from '../data/Network.js'
import ciao from '@homebridge/ciao'
import { DocHandle, DocumentId, Repo } from '@automerge/automerge-repo';
import { EngineID, Hostname, IPAddress } from '../data/CommonTypes.js';
import { config } from '../data/Config.js';

export const startAdvertising = (store: Store): void => {
    const engine = getLocalEngine(store)
    if (!engine) {
        log(`No local engine found in the store`)
        throw new Error(`No local engine found in the store`)
    }
    const engineName = engine.hostname
    const engineVersion = engine.version
    const responder = ciao.getResponder()
    let service

    if (engineName) {
        log(`Advertising on all interfaces  `)
        service = responder.createService({
            name: engineName.toString(),
            type: 'engine',
            port: config.settings.port,
            txt: {
                name: engineName,
                id: engine.id,
                version: engineVersion
            }
        })
    } 

    service.advertise().then(() => {
        log(`The following service is published on all interfaces: ${service.name}._engine._tcp.local`);
    }).catch((err) => {
        error(`Error advertising mDNS service: ${err}`)
    })
}

const discoverEngines = async (storeHandle: DocHandle<Store>, repo:Repo): Promise<void> => {
    const localEngine = getLocalEngine(storeHandle.doc());
    try {
        const deviceList = await mDnsSd.discover({ name: '_engine._tcp.local' });
        const discoveredPeers = new Map<IPAddress, {hostname: Hostname, engineId: EngineID}>();

        if (deviceList.length > 0) {
            log(chalk.bgBlackBright(`Discovered engines:`));
        }

        deviceList.forEach(device => {
            const txt = device.packet.additionals.find((add: any) => ((typeof add == 'object') && add.hasOwnProperty('type') && add.type === 'TXT'));

            if (!txt || !txt.rdata) {
                log(chalk.redBright(`  - No TXT record for ${device.modelName || device.address}. Skipping.`));
                return;
            }

            const txtRecord = txt.rdata;
            const engineId = txtRecord.id as EngineID;
            const hostname = txtRecord.name as Hostname;
            const address = device.address as IPAddress;
            const port = device.service?.port;

            log(`  - Name: ${hostname || 'N/A'}, ID: ${engineId || 'N/A'}, Address: ${address || 'N/A'}:${port || 'N/A'}`);

            if (engineId && engineId === localEngine.id) {
                return; // Skip local engine
            }

            if (address && hostname && engineId) {
                discoveredPeers.set(address, { hostname, engineId });
            }
        });

        await manageDiscoveredPeers(repo, discoveredPeers, storeHandle);

        if (deviceList.length === 0) {
            log(chalk.bgBlackBright(`No remote engines found`))
        }
    } catch (error) {
        log(`***node-dns-sd*** Error discovering engines`)
        console.error(error);
    }
}

export const enableMulticastDNSEngineMonitor = (storeHandle: DocHandle<Store>, repo:Repo): void => {
    startAdvertising(storeHandle.doc())
    
    const runDiscovery = async () => {
        await discoverEngines(storeHandle, repo);
        setTimeout(runDiscovery, 10000);
    };

    runDiscovery();
}
