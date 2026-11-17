/**
 * install-root-helpers — the root-owned parts of an Engine install, on THIS Pi,
 * from THIS checkout (idea#168 follow-up, wizardly-hugle borg gap 2026-10-13).
 *
 * build-engine runs the same installRootHelpers at first install, but updates
 * (git pull / sync-engine + pnpm build + pm2 restart) never ran it, so a Pi that
 * was installed before borgbackup and idea-app-data were added, and got the helper
 * by hand, had no /usr/bin/borg. Run this after every update; it is idempotent.
 * It also installs the current udev docking rule (90-docking.rules) when it differs,
 * reloads udev and replays only devices without a /dev/engine link (engine#479), so
 * the first Engine start after an update passes the disk self-check without a reboot.
 *
 *   ./install-root-helpers          # from the Engine checkout on the Pi
 */
import { $, chalk } from 'zx'
import { installRootHelpers } from '../src/data/Engine.js'

$.verbose = false
const enginePath = process.cwd()
try {
    await installRootHelpers($, enginePath)
    console.log(chalk.green('install-root-helpers: done'))
} catch (e: any) {
    console.error(chalk.red(`install-root-helpers: FAILED: ${e?.message ?? e}`))
    process.exit(1)
}
