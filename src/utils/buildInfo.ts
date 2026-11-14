/**
 * buildInfo.ts — the Engine build's git commit time (idea#400 PR C, Steve Q12)
 *
 * `pnpm build` runs script/write-build-info.mjs after tsc, which writes
 * dist/build-info.json: { commit, commitTimeMs }. The scheduled-backup clock check
 * uses commitTimeMs as its floor (BEFORE_BUILD). A missing or malformed file (a
 * dev run, dist-test, a build without git) gives null and the check is skipped.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export interface BuildInfo {
    commit: string
    commitTimeMs: number
}

/** dist/build-info.json, next to dist/src/ (this module is dist/src/utils/buildInfo.js). */
export const defaultBuildInfoPath = (): string =>
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build-info.json')

export const parseBuildInfo = (raw: unknown): BuildInfo | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (typeof r.commit !== 'string' || !/^[0-9a-f]{40}$/.test(r.commit)) return null
    if (typeof r.commitTimeMs !== 'number' || !Number.isSafeInteger(r.commitTimeMs) || r.commitTimeMs <= 0) return null
    return { commit: r.commit, commitTimeMs: r.commitTimeMs }
}

export const readBuildInfo = (file: string = defaultBuildInfoPath()): BuildInfo | null => {
    try {
        return parseBuildInfo(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
        return null
    }
}
