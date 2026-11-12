/**
 * idea-usage process loop (idea#411). Importable: loading this module does not
 * start the process. The pm2 entry (`main.ts`) always calls startUsageProcess.
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
