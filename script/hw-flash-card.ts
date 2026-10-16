/**
 * hw-flash-card.ts — on-Pi hardware proof for idea#201 §10 / engine#219.
 * Runs the real scanner, image store, flashCard/cancelFlash and the real root helper
 * against ONE card identified by its reader serial, with an in-memory store (never the
 * fleet store). Card must be backed up first.
 *
 *   CARD_SERIAL=121220160204 npx tsx script/hw-flash-card.ts <scan|refusals|flash|cancel|pull> [version]
 */
import { Repo } from '@automerge/automerge-repo'
import { $, sleep } from 'zx'
import { Store } from '../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../src/data/Engine.js'
import { refreshClientCards, ScannedCard } from '../src/data/ClientCards.js'
import { refreshClientImages } from '../src/data/ClientImages.js'
import { flashCard, cancelFlash } from '../src/data/FlashCard.js'

const mode = process.argv[2] ?? 'scan'
const versionArg = process.argv[3] ?? 'current'
const serial = process.env.CARD_SERIAL
if (!serial) { console.error('CARD_SERIAL required'); process.exit(2) }
const h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
await h.whenReady()
await createOrUpdateEngine(h, localEngineId)
const out = (k: string, v: unknown) => console.log(`HW ${k} ${JSON.stringify(v)}`)

const scan = await refreshClientCards(h)
const imgs = await refreshClientImages(h)
const e: any = h.doc()!.engineDB[localEngineId]
out('cardReaders', e.cardReaders); out('clientCards', e.clientCards); out('newDisks', e.newDisks.map((d: any) => ({ device: d.device, candidateId: d.candidateId, removable: d.removable })))
out('clientImages', imgs)
const card = scan.clientCards.find((c: ScannedCard) => c.serial === serial)
if (!card) { out('FAIL', `no client card with serial ${serial}`); process.exit(1) }
out('card', { candidateId: card.candidateId, device: card.device, byId: card.byId, sizeBytes: card.sizeBytes, contents: card.contents, refusal: card.refusal })
const opOf = (id: string) => JSON.parse(JSON.stringify(h.doc()!.operationDB[id]))
const tryCode = async (label: string, p: () => Promise<unknown>) => {
    try { await p(); out(`refusal ${label}`, 'NOT REFUSED'); return null } catch (err: any) { out(`refusal ${label}`, err.message); return err.code }
}
const waitStep = async (id: string, step: string, minPct = 0) => {
    for (let i = 0; i < 1800; i++) { const o = opOf(id); if (o.status !== 'Running') return o; if (o.stepLabel === step && (o.progressPercent ?? 0) >= minPct) return o; await sleep(500) }
}

if (mode === 'scan') process.exit(0)
if (mode === 'refusals') {
    await tryCode('SIZE_CHANGED', () => flashCard(h, card.candidateId, versionArg, String(card.sizeBytes - 512)))
    await tryCode('IMAGE_NOT_FOUND', () => flashCard(h, card.candidateId, '26.04-20990101-abcdef0', String(card.sizeBytes)))
    await tryCode('NOT_FOUND', () => flashCard(h, 'card-0000000000000000', versionArg, String(card.sizeBytes)))
    for (const d of scan.newDisks) await tryCode(`NOT_REMOVABLE ${d.device}`, () => flashCard(h, d.candidateId, versionArg, String(d.sizeBytes)))
    process.exit(0)
}
const { operationId, done } = await flashCard(h, card.candidateId, versionArg, String(card.sizeBytes))
out('started', { operationId })
if (mode === 'cancel') {
    const o = await waitStep(operationId, 'writing', 5); out('beforeCancel', o)
    cancelFlash(h, operationId)
}
if (mode === 'pull') {
    const o = await waitStep(operationId, 'writing', 5); out('beforePull', o)
    const sys = (await $`readlink -f /sys/block/${card.device}`).stdout.trim()
    const port = sys.split('/').filter(s => /^\d+-[\d.]+$/.test(s)).pop()!
    out('unbind', port)
    await $`echo ${port} | sudo tee /sys/bus/usb/drivers/usb/unbind`
    await sleep(3000)
    await $`echo ${port} | sudo tee /sys/bus/usb/drivers/usb/bind`
}
let last = ''
const tick = setInterval(() => { const o = opOf(operationId); const s = `${o.status} ${o.stepLabel} ${o.progressPercent}`; if (s !== last) { last = s; out('progress', s) } }, 1000)
const res = await done
clearInterval(tick)
out('result', res); out('operation', opOf(operationId))
process.exit(0)
