/**
 * NameCheck.ts — allow-list checks for app names and app ids that become path
 * components (apps/<appId>, /tmp/apps/<appName>, the app-<name> repo name).
 *
 * Names reach the Engine from commands (installApp, createInstance, updateApp) and
 * from the shared store, so they are checked before any shell or fs operation
 * builds a path from them, and the resolved path is checked to stay inside its base.
 *
 * Real names in use: kolibri, nextcloud, kiwix, kolibri-studio, usage-dashboard,
 * docker-console, sample-files; ids such as kolibri-1.0, nextcloud-1.8-31.0.14,
 * kiwix-release-1.0, kolibri-5ab9f64, <name>-<40-hex sha>.
 */
import path from 'path'

/** An app name (the part after app- in the GitHub repo name, x-app.name). */
export const APP_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * An app id as stored on a disk: <name>-<version>, one path component. The version
 * part may hold what versionDirName keeps of a git ref (A-Z, a-z, 0-9, . _ + -).
 */
export const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/

/** A GitHub account (user or organisation) name. */
export const GIT_ACCOUNT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export const isValidAppName = (name: unknown): boolean =>
    typeof name === 'string' && APP_NAME_RE.test(name) && !name.includes('..')

export const isValidAppId = (id: unknown): boolean =>
    typeof id === 'string' && APP_ID_RE.test(id) && !id.includes('..')

export const assertAppName = (name: unknown, what = 'app name'): string => {
    if (!isValidAppName(name)) throw new Error(`Invalid ${what} '${String(name)}': use lower-case letters, digits, '.', '_' or '-' (at most 64 characters)`)
    return name as string
}

export const assertAppId = (id: unknown, what = 'app id'): string => {
    if (!isValidAppId(id)) throw new Error(`Invalid ${what} '${String(id)}': use letters, digits, '.', '_', '+' or '-' (one path component, at most 128 characters)`)
    return id as string
}

export const assertGitAccount = (account: unknown): string => {
    if (typeof account !== 'string' || !GIT_ACCOUNT_RE.test(account)) throw new Error(`Invalid git account '${String(account)}'`)
    return account
}

/**
 * path.resolve(base, name) when that is strictly inside base (never base itself,
 * never outside it); throws otherwise. Use for every path built from a name that
 * is then removed, copied over or written.
 */
export const childPathInside = (base: string, name: string): string => {
    const root = path.resolve(base)
    const p = path.resolve(root, name)
    if (!p.startsWith(root + path.sep) || p === root) throw new Error(`Refusing path '${name}': it resolves outside ${root}`)
    return p
}
