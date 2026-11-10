/**
 * idea-usage process entry (idea#411). Separate pm2 app; never opens Automerge.
 * Idles when usageMonitoring is off; re-reads the switch at least once a minute
 * and on SIGHUP.
 */
import { usageLog } from './log.js'
import { SETTINGS_POLL_MS, usageRoot } from './paths.js'
import { processTick, type TickState } from './scheduler.js'

const sleep = (ms: number, shouldStop: () => boolean): Promise<void> =>
    new Promise(resolve => {
        const started = Date.now()
        const tick = () => {
            if (shouldStop() || Date.now() - started >= ms) {
                resolve()
                return
            }
            setTimeout(tick, Math.min(1000, ms - (Date.now() - started)))
        }
        setTimeout(tick, Math.min(1000, ms))
    })

export async function startUsageProcess(opts: {
    shouldStop?: () => boolean
    sleepMs?: number
    root?: string
} = {}): Promise<void> {
    const shouldStop = opts.shouldStop ?? (() => false)
    const state: TickState = {}
    usageLog(`starting (root ${opts.root ?? usageRoot()})`)
    while (!shouldStop()) {
        try {
            await processTick(state, { root: opts.root })
        } catch (e) {
            usageLog(`tick failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        await sleep(opts.sleepMs ?? SETTINGS_POLL_MS, shouldStop)
    }
    usageLog('stopped')
}

const stop = { value: false }
process.on('SIGTERM', () => { stop.value = true })
process.on('SIGINT', () => { stop.value = true })
process.on('SIGHUP', () => { /* next tick re-reads settings.json */ })

const isMain = process.argv[1] && process.argv[1].endsWith('src/usage/main.js')
if (isMain || process.env.IDEA_USAGE_AS_MAIN === '1') {
    startUsageProcess({ shouldStop: () => stop.value }).catch(err => {
        usageLog(`fatal: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
    })
}
