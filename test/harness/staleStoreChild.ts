/**
 * staleStoreChild.ts (engine#512): a child process that poisons its "store" doc the way
 * idea04 did on 11-17 and wires the guard exactly like start.ts. The parent test asserts
 * that it ends with STALE_STORE_EXIT_CODE (75) after the shutdown ran, never hangs on.
 */
import { Repo, PeerId } from '@automerge/automerge-repo'
import { installStaleDocGuard, staleStoreExit } from '../../src/data/StaleDocGuard.js'
import { PairAdapter, link, pump } from './pairAdapter.js'

const main = async () => {
    const pa = new PairAdapter(), pb = new PairAdapter()
    const repoA = new Repo({ network: [pa], peerId: 'a' as PeerId })
    const repoB = new Repo({ network: [pb], peerId: 'b' as PeerId })
    await link(pa, pb)
    const hA = repoA.create<{ lastRun: number }>({ lastRun: 0 })
    const found = repoB.find<{ lastRun: number }>(hA.url)
    await pump(pa, pb)
    const store = await found
    const guard = installStaleDocGuard(repoB, {
        storeDocId: store.documentId,
        onStaleStore: reason => { void staleStoreExit(reason, { shutdown: async () => { console.log('shutdown ran'); await repoB.shutdown().catch(() => {}) } }) },
    })
    guard.watchStoreHandle(store)
    pb.broken = true
    hA.change(d => { d.lastRun = 1 })
    await pump(pa, pb)
    pb.broken = false
    // the startup write that died on idea04 (writeLastSeen)
    try { store.change(d => { d.lastRun = Date.now() }) } catch (e) { console.log(`write threw: ${(e as Error).message}`) }
    await new Promise(r => setTimeout(r, 30_000))
    console.log('still alive: the guard did not exit')
    process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
