/**
 * hw-flash-card-live.ts — drive a flash through the LIVE Engine the way the Console does
 * (idea#201 §10, engine#219): push `flashCard <candidateId> <version> <size>` onto the
 * Engine's command queue and follow Operation + Engine.clientCards / flashInProgress.
 *
 *   CARD_SERIAL=… npx tsx script/hw-flash-card-live.ts [--engine-dir <dir>] [--port 4321] [version]
 * The card is chosen by matching the reader's by-id serial via lsblk (never by device name).
 */
import { Repo, DocumentId } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { $, fs, sleep, argv } from 'zx'
import os from 'os'
import path from 'path'

const host = os.hostname()
if (['idea02', 'wizardly-hugle'].includes(host)) { console.error(`refusing on ${host}`); process.exit(2) }
const ENGINE_DIR = path.resolve(argv['engine-dir'] ?? '/home/pi/idea/agents/agent-engine-dev')
const PORT = String(argv.port ?? '4321')
const version = String(argv._[0] ?? 'current')
const serial = process.env.CARD_SERIAL
if (!serial) { console.error('CARD_SERIAL required'); process.exit(2) }
const out = (k: string, v: unknown) => console.log(`HW ${new Date().toISOString().slice(11, 19)} ${k} ${JSON.stringify(v)}`)

const storeUrl = fs.readFileSync(path.join(ENGINE_DIR, 'store-identity', 'store-url.txt'), 'utf8').trim()
const repo = new Repo({ network: [new WebSocketClientAdapter(`ws://127.0.0.1:${PORT}`)] })
const h = await repo.find<any>(storeUrl.replace('automerge:', '') as DocumentId)
await h.whenReady(); await sleep(1500)
const doc = () => h.doc() as any
const eng = () => Object.values(doc().engineDB ?? {}).find((e: any) => e.hostname === host) as any
const E = eng(); if (!E) { console.error('no engine record'); process.exit(1) }
out('capabilities', E.capabilities)
out('cardReaders', E.cardReaders); out('clientCards', E.clientCards); out('clientImages', E.clientImages)
const dev = (await $`lsblk -dn -o NAME,SERIAL`).stdout.split('\n').map(l => l.trim().split(/\s+/)).find(p => p[1] === serial)?.[0]
const size = Number((await $`lsblk -dbn -o SIZE /dev/${dev}`).stdout.trim())
const card = (E.clientCards ?? []).find((c: any) => c.sizeBytes === size && c.flashable)
if (!dev || !card) { out('FAIL', { dev, size, cards: E.clientCards }); process.exit(1) }
const v = version === 'current' ? E.clientImages?.current : version
out('card', card)
const since = Date.now() - 5000
const cmd = `flashCard ${card.candidateId} ${v} ${card.sizeBytes}`
out('send', cmd)
h.change((d: any) => { d.engineDB[E.id].commands.push(cmd) })
let opId: string | null = null, last = ''
for (let i = 0; i < 7200; i++) {
    await sleep(1000)
    if (!opId) {
        const op = Object.values(doc().operationDB ?? {}).find((o: any) => o?.kind === 'flashCard' && o.subject?.id === card.candidateId && o.startedAt >= since) as any
        if (op) { opId = op.id; out('operation', op.id) } else continue
    }
    const o = doc().operationDB[opId!]
    const s = `${o.status} ${o.stepLabel} ${o.progressPercent}`
    if (s !== last) { last = s; out('progress', { status: o.status, step: o.stepLabel, pct: o.progressPercent, fip: eng().flashInProgress?.step ?? null }) }
    if (o.status === 'Done' || o.status === 'Failed') {
        out('final', o)
        await sleep(6000)
        out('clientCardsAfter', eng().clientCards); out('cardReadersAfter', eng().cardReaders); out('flashInProgressAfter', eng().flashInProgress)
        process.exit(o.status === 'Done' && o.safeToRemove === true ? 0 : 1)
    }
}
out('FAIL', 'timeout'); process.exit(1)
