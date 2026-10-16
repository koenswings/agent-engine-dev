/**
 * AppIdParse.ts — the one rule for splitting an app id into name and version.
 * No imports, so App.ts and Store.ts can both use it (App.ts imports Store.ts).
 *
 * An app id on a disk is `<name>-<version>`: the folder apps/<name>-<version>/,
 * from repo koenswings/app-<name> at git ref <version> (a branch or SHA ref is
 * stored under its folder-safe form, see versionDirName in Instance.ts).
 * Rules, first match wins:
 *   1. `<name>@<ref>`: explicit, unambiguous. The ref may contain '-' and '/'
 *      (`nextcloud@feat/nextcloud-demo`, `nextcloud@21d7f75`). Only used as
 *      installApp input; on disk this becomes `<name>-<versionDirName(ref)>`.
 *   2. Numeric version from the FIRST '-' followed by digits:
 *      nextcloud-1.0-31.0.1 -> nextcloud / 1.0-31.0.1
 *   3. Trailing commit SHA (7–40 hex) or `latest` after the last '-':
 *      kolibri-channel-builder-2551b7d… -> kolibri-channel-builder / 2551b7d…
 *   4. Otherwise the last '-' (old behaviour; ambiguous for refs with '-', use rule 1).
 */
const NUMERIC_RE = /^(.+?)-(\d+(?:\.\d+)*(?:[-.+][0-9A-Za-z.+-]*)?)$/
const SHA_OR_LATEST_RE = /^(.+)-([0-9a-f]{7,40}|latest)$/

export const splitAppId = (appId: string): { name: string, version: string } => {
    const id = String(appId)
    const at = id.indexOf('@')
    if (at > 0) return { name: id.slice(0, at), version: id.slice(at + 1) }
    const m = NUMERIC_RE.exec(id) ?? SHA_OR_LATEST_RE.exec(id)
    if (m) return { name: m[1], version: m[2] }
    const dash = id.lastIndexOf('-')
    if (dash <= 0) return { name: id, version: '' }
    return { name: id.slice(0, dash), version: id.slice(dash + 1) }
}

/** True for a git commit SHA (7–40 lowercase hex), which `git clone --branch` cannot take. */
export const isCommitSha = (ref: string): boolean => /^[0-9a-f]{7,40}$/.test(ref)
