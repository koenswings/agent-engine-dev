/**
 * hostEnv.ts — explicit, documented facts about the machine a test runs on.
 *
 * On-Pi triage (idea04, main 77693d1, 2026-10-25): `pnpm test:full` on a pool Pi
 * failed tests that silently assumed the dev box (no root helpers installed, a fast
 * CPU). Tests use these instead of assuming, so on a Pi they check the Pi's real state
 * rather than fail on it. Never use them to skip a product assertion.
 */
import fs from 'fs'
import net from 'net'

/** True when this machine is a Raspberry Pi (device-tree model). */
export const onRaspberryPi = (): boolean => {
    try { return /Raspberry Pi/i.test(fs.readFileSync('/proc/device-tree/model', 'utf8')) } catch { return false }
}

/**
 * Factor for wall-clock budgets that only measure speed (main-loop lag, setup hooks).
 * A Pi 4 under the full parallel suite is ~2x slower than the dev box. Use only for
 * timing margins, never for correctness assertions.
 */
export const PI_TIMING_FACTOR = onRaspberryPi() ? 2 : 1

/** Does this machine have a root helper installed at `p` (e.g. /usr/local/sbin/idea-app-data)? */
export const helperInstalledHere = (p: string): boolean => fs.existsSync(p)

/** A TCP port that is free on this machine right now (bound to 0, then released). */
export const freeTcpPort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, () => { const a = s.address(); const port = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(port)) })
})
