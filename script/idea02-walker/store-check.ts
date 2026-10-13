// READ-ONLY READY gate, run on idea02: reads store doc STORE_DOC via each pool Engine (LAN), never writes.
// Usage: STORE_DOC=<docId> npx tsx script/idea02-walker/store-check.ts   (exit 0 PASS / 1 FAIL)
import { Repo } from '@automerge/automerge-repo'
import { BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { storeCheckVerdict, type StoreCheckDoc } from '../../test/duration/walkHost.js'
const HOSTS: Record<string, string> = { idea01: '10.99.0.11', idea03: '10.99.0.13', idea04: '10.99.0.14' }
const DOC = process.env.STORE_DOC, PORT = process.env.WS_PORT || '4321'
const WAIT = Number(process.env.DURATION_DOC_WAIT_MS || 45000)
if (!DOC) { console.error('STORE_DOC required'); process.exit(2) }
const fails: string[] = []
for (const [eng, ip] of Object.entries(HOSTS)) {
    const repo = new Repo({ network: [new BrowserWebSocketClientAdapter(`ws://${ip}:${PORT}`)] } as never)
    try {
        const h = await Promise.race([repo.find(DOC as never), new Promise<never>((_, r) => setTimeout(() => r(new Error(`timeout ${WAIT}ms`)), WAIT))])
        await (h as { whenReady?: () => Promise<void> }).whenReady?.()
        const d = (h as { doc: () => StoreCheckDoc }).doc()
        const n = Object.keys(d.instanceDB ?? {}).length
        console.log(`[via ${eng}] engines=${Object.values(d.engineDB ?? {}).map(e => `${e.hostname}(cmds=${(e.commands ?? []).length})`).join(',')} instances=${n}`)
        fails.push(...storeCheckVerdict(eng, d))
    } catch (e) { fails.push(`${eng}: ${e instanceof Error ? e.message : String(e)}`) } finally { (repo as { shutdown?: () => void }).shutdown?.() }
}
console.log(fails.length ? 'STORE_CHECK FAIL\n' + fails.join('\n') : 'STORE_CHECK PASS'); process.exit(fails.length ? 1 : 0)
