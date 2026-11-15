
import { doc } from 'lib0/dom.js'
import { Timestamp } from '../data/CommonTypes.js'
import { inspectEngine } from '../data/Engine.js'
import { Store, getLocalEngine } from '../data/Store.js'
import { log, contains, deepPrint } from '../utils/utils.js'

export const enableTimeMonitor = (interval, callback) => {
    setInterval(callback, interval)
}

export const logTimeCallback = () => {
    log(`Time callback at ${new Date()}`)
}

// The stored heartbeat (lastRun every 30 s) moved to data/Liveness.ts (store-design
// 2026-10-13): an ephemeral hb every 10 s plus a stored lastRun at boot and hourly.
