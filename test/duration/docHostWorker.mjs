// r86p: ONE worker thread hosting every walker Automerge connection (store doc per Engine + CommandLog
// per Engine). r86o FAIL@42 (rss-guard, idea02 MemAvailable 297 MB): each per-link worker held its own
// Automerge WASM instance (~535-550 MB external each); 5 live workers + a replaced store link put the
// walker at 2.5 GB RSS on a 3.8 GB Pi. Here all sessions share one WASM module/memory.
// Protocol: main → { ch, type:'open', kind:'store'|'commandLog', data } | { ch, msg } ; worker → { ch, msg } | { ch, exit: code }.
// A session "exits" by closing its channel; the thread lives on for the other sessions.
import { parentPort } from 'node:worker_threads'
import { startStoreDocSession } from './storeDocSession.mjs'
import { startCommandLogSession } from './commandLogSession.mjs'

const chans = new Map() // ch → { kind, handlers: [] }
const send = (m) => { try { parentPort.postMessage(m) } catch { /* parent gone */ } }

// The library's bare 60 s whenReady timeouts reject unawaited; never let them kill the host.
// The origin is unknown, so report it on every open store channel (same event as the per-link worker).
process.on('unhandledRejection', (r) => {
    const message = r instanceof Error ? `${r.name}: ${r.message}` : String(r)
    for (const [ch, c] of chans) if (c.kind === 'store') send({ ch, msg: { event: 'rejection', message } })
})

parentPort.on('message', (m) => {
    // r86q: liveness heartbeat. A pong only goes out when this thread's event loop runs, so a long
    // synchronous Automerge apply in ANY session shows up on the main thread as a silent host.
    if (m?.type === 'ping') { send({ pong: m.t }); return }
    if (m?.type === 'open') {
        const ch = m.ch
        const c = { kind: m.kind, handlers: [], closed: false }
        chans.set(ch, c)
        const io = {
            post: (msg) => { if (!c.closed) send({ ch, msg }) },
            onMessage: (fn) => { c.handlers.push(fn) },
            exit: (code) => { if (c.closed) return; c.closed = true; chans.delete(ch); send({ ch, exit: code ?? 0 }) },
        }
        const fail = (e) => { io.post({ event: 'rejection', message: `session: ${e?.message ?? e}` }); io.exit(1) }
        try {
            const p = m.kind === 'store' ? startStoreDocSession(m.data, io) : startCommandLogSession(m.data, io)
            Promise.resolve(p).catch(fail)
        } catch (e) { fail(e) }
        return
    }
    const c = chans.get(m?.ch)
    if (c) for (const fn of c.handlers) fn(m.msg)
})
