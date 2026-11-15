/**
 * AppSecrets.ts — per-instance app secrets the Engine writes to an instance's .env
 *
 * IDEA_NC_ADMIN_PASSWORD (agent-engine-dev#202, #450): Nextcloud's admin
 * password, kept apart from `pass` (MariaDB root/user). app-nextcloud's compose
 * reads `NEXTCLOUD_ADMIN_PASSWORD=${IDEA_NC_ADMIN_PASSWORD:-admin911!}`, and
 * Nextcloud reads it only at its first install.
 *
 * Scope: written only for an instance whose compose.yaml references the
 * variable. That keys on what the app asks for, not on its name, so a renamed
 * or forked Nextcloud app still gets it and no other app gets a secret it
 * never reads.
 *
 * Lifecycle:
 *  - Written once, when the instance is new (the start that also first
 *    generates `pass`), before compose up, so Nextcloud installs with it.
 *    New instances get the documented IDEA default `admin911!` (Koen's
 *    standing rule: every app account defaults to <account>911!; #450).
 *  - Never regenerated or rotated: a present key is kept on every later start, including an empty value.
 *  - Copy and move carry it: move transfers the instance folder as is, and
 *    copy's prepared .env keeps every line but `port=` (InstanceCopy.ts).
 *  - An older instance (already has `pass`, no value) gets none: its
 *    Nextcloud was installed with whatever the then-current fallback was
 *    (historically `pass`), so leaving the variable unset stays right.
 *    A new value there would not match the real admin password.
 *
 * The value is never logged; only the variable name and the outcome are.
 */

import { fs } from 'zx'
import { log, readEnvVariable } from '../utils/utils.js'
import { setEnvLines } from './HostIdentity.js'

export const NC_ADMIN_PASSWORD_VAR = 'IDEA_NC_ADMIN_PASSWORD'

/** Documented IDEA default for the Nextcloud admin account (`<account>911!`). */
export const NC_ADMIN_PASSWORD_DEFAULT = 'admin911!'

export const composeUsesNcAdminPassword = (composeText: string): boolean =>
    new RegExp(`\\b${NC_ADMIN_PASSWORD_VAR}\\b`).test(composeText)

export type NcAdminPasswordOutcome = 'not-used' | 'kept' | 'defaulted' | 'legacy-fallback'

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
    // Keep any present key, including an empty value. readEnvVariable returns
    // "" when the key is present and empty, and null when it or the file is missing.
    if (existing !== null) {
        log(`${NC_ADMIN_PASSWORD_VAR} already set for this instance; keeping it`)
        return 'kept'
    }
    if (!newInstance) {
        log(`${NC_ADMIN_PASSWORD_VAR} not set on an existing instance; not writing one (the app keeps its install-time fallback)`)
        return 'legacy-fallback'
    }
    // setEnvLines writes with fs. addOrUpdateEnvVariable goes through zx's
    // shell quoting and would store admin911! as $'admin911!' in the file.
    await setEnvLines(envPath, { [NC_ADMIN_PASSWORD_VAR]: NC_ADMIN_PASSWORD_DEFAULT })
    log(`Wrote ${NC_ADMIN_PASSWORD_VAR} for this new instance`)
    return 'defaulted'
}
