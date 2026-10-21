/**
 * AppSecrets.ts — per-instance app secrets the Engine writes to an instance's .env
 *
 * IDEA_NC_ADMIN_PASSWORD (idea#202): Nextcloud's admin password, kept apart from
 * `pass` (MariaDB root/user). app-nextcloud's compose reads
 * `NEXTCLOUD_ADMIN_PASSWORD=${IDEA_NC_ADMIN_PASSWORD:-${pass}}`, and Nextcloud
 * reads it only at its first install.
 *
 * Scope: written only for an instance whose compose.yaml references the
 * variable. That keys on what the app asks for, not on its name, so a renamed
 * or forked Nextcloud app still gets it and no other app gets a secret it
 * never reads.
 *
 * Lifecycle:
 *  - Generated once, when the instance is new (the start that also first
 *    generates `pass`), before compose up, so Nextcloud installs with it.
 *  - Never regenerated: an existing value is kept on every later start.
 *  - Copy and move carry it: move transfers the instance folder as is, and
 *    copy's prepared .env keeps every line but `port=` (InstanceCopy.ts).
 *  - An older instance (already has `pass`, no value) gets none: its
 *    Nextcloud was installed with `pass`, so the compose fallback stays right.
 *    A new value there would not match the real admin password.
 *
 * The value is never logged; only the variable name and the outcome are.
 */

import { fs } from 'zx'
import { addOrUpdateEnvVariable, log, readEnvVariable, secureRandomString } from '../utils/utils.js'

export const NC_ADMIN_PASSWORD_VAR = 'IDEA_NC_ADMIN_PASSWORD'

/** URL-safe and safe in the .env writer's sed/echo: letters and digits only. */
export const NC_ADMIN_PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** 32 characters of 62: about 190 bits. */
export const NC_ADMIN_PASSWORD_LENGTH = 32

export const generateNcAdminPassword = (): string =>
    secureRandomString(NC_ADMIN_PASSWORD_LENGTH, NC_ADMIN_PASSWORD_ALPHABET)

export const composeUsesNcAdminPassword = (composeText: string): boolean =>
    new RegExp(`\\b${NC_ADMIN_PASSWORD_VAR}\\b`).test(composeText)

export type NcAdminPasswordOutcome = 'not-used' | 'kept' | 'generated' | 'legacy-fallback'

/**
 * Make sure a new instance whose compose reads IDEA_NC_ADMIN_PASSWORD has one
 * in its .env. `newInstance` is true when this start is the instance's first
 * (no `pass` in .env before this start).
 */
export const ensureNcAdminPassword = async (instanceDir: string, newInstance: boolean): Promise<NcAdminPasswordOutcome> => {
    let composeText = ''
    try {
        composeText = await fs.readFile(`${instanceDir}/compose.yaml`, 'utf8')
    } catch {
        return 'not-used'
    }
    if (!composeUsesNcAdminPassword(composeText)) return 'not-used'
    const envPath = `${instanceDir}/.env`
    const existing = await readEnvVariable(envPath, NC_ADMIN_PASSWORD_VAR)
    if (existing) {
        log(`${NC_ADMIN_PASSWORD_VAR} already set for this instance; keeping it`)
        return 'kept'
    }
    if (!newInstance) {
        log(`${NC_ADMIN_PASSWORD_VAR} not set on an existing instance; not generating one (the app keeps its install-time fallback)`)
        return 'legacy-fallback'
    }
    await addOrUpdateEnvVariable(envPath, NC_ADMIN_PASSWORD_VAR, generateNcAdminPassword())
    log(`Generated ${NC_ADMIN_PASSWORD_VAR} for this new instance`)
    return 'generated'
}
