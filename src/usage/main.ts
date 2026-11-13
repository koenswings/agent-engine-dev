/**
 * Dedicated idea-usage process entry (idea#411). Separate pm2 app; never opens
 * Automerge. Always starts — do not gate on process.argv[1] or
 * IDEA_USAGE_AS_MAIN. Under pm2's ProcessContainerFork, argv[1] is pm2's own
 * file, so an as-main check silently no-ops (idea#416, found by Kid on idea03).
 * Idles when usageMonitoring is off; re-reads the switch at least once a minute
 * and on SIGHUP. Testable loop: `./process.ts` (importing it does not start).
 */
import { usageLog } from './log.js'
import { startUsageProcess } from './process.js'

const stop = { value: false }
process.on('SIGTERM', () => { stop.value = true })
process.on('SIGINT', () => { stop.value = true })
process.on('SIGHUP', () => { /* next tick re-reads settings.json */ })

startUsageProcess({ shouldStop: () => stop.value }).catch(err => {
    usageLog(`fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
})
