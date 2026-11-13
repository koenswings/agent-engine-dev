/**
 * igmpSelfCheck.ts — startup warning when net.ipv4.igmp_max_memberships is
 * below 1024 (idea#467). Kolibri's zeroconf joins multicast on every
 * interface; the kernel default of 20 is exhausted at about 18 Docker
 * networks (OSError 105). The live value is read from proc (no root).
 * Startup is never blocked. Skipped in test runs (IDEA_WATCH_DIR is set).
 */
import { readFileSync } from 'fs'
import { chalk } from 'zx'
import { log, print } from '../utils/utils.js'

export const IGMP_MAX_MEMBERSHIPS_PATH = '/proc/sys/net/ipv4/igmp_max_memberships'
export const IGMP_MAX_MEMBERSHIPS_MIN = 1024

export type IgmpReadFile = (path: string, encoding: 'utf8') => string

/** Read the live sysctl value. Returns null if the file is missing or not a non-negative integer. */
export const readIgmpMaxMemberships = (readFile: IgmpReadFile = readFileSync): number | null => {
    try {
        const raw = readFile(IGMP_MAX_MEMBERSHIPS_PATH, 'utf8').trim()
        if (!/^\d+$/.test(raw)) return null
        return Number(raw)
    } catch {
        return null
    }
}

/** Warning text when the live value is below 1024 or cannot be read; null when OK. */
export const igmpMaxMembershipsWarning = (value: number | null): string | null => {
    if (value === null) {
        return `IGMP max memberships could not be read from ${IGMP_MAX_MEMBERSHIPS_PATH}. ` +
            `If the live value is below ${IGMP_MAX_MEMBERSHIPS_MIN}, containers that join multicast ` +
            `on every interface (e.g. Kolibri zeroconf) can crash with OSError 105 once the host ` +
            `has many Docker networks. Run ./install-root-helpers (idea#467).`
    }
    if (value < IGMP_MAX_MEMBERSHIPS_MIN) {
        return `IGMP max memberships is ${value} (want >= ${IGMP_MAX_MEMBERSHIPS_MIN}). ` +
            `Containers that join multicast on every interface (e.g. Kolibri zeroconf) can crash ` +
            `with OSError 105 once the host has many Docker networks. Run ./install-root-helpers (idea#467).`
    }
    return null
}

/**
 * Engine startup self-check for igmp_max_memberships. Warns only; does not fail
 * startup. Skipped when IDEA_WATCH_DIR is set (tests). Returns the warning or null.
 */
export const runIgmpMaxMembershipsSelfCheck = (opts: {
    readFile?: IgmpReadFile
    skip?: boolean
} = {}): string | null => {
    if (opts.skip ?? Boolean(process.env.IDEA_WATCH_DIR)) {
        log('[selfCheck] IDEA_WATCH_DIR is set — skipping the IGMP max memberships check')
        return null
    }
    const value = readIgmpMaxMemberships(opts.readFile)
    const warning = igmpMaxMembershipsWarning(value)
    if (warning) {
        print(chalk.red(`  - WARNING: ${warning}`))
        log(`[selfCheck] WARNING: ${warning}`)
        return warning
    }
    log(`[selfCheck] igmp_max_memberships=${value}`)
    return null
}
