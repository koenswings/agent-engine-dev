/**
 * removeTestDir — delete a test's own temp dir and say so when that fails.
 *
 * Why: docked fixture disks get files written by containers or the root helper (root-owned).
 * `fs.remove(...).catch(() => {})` then silently left /tmp/idea-test-* behind on pool Pis
 * (PR #248 re-run, idea01/idea03, 2026-10-25). Here a failed removal is retried with
 * `sudo -n rm -rf` (only where non-interactive sudo exists, e.g. on a Pi) and ONLY for paths
 * inside os.tmpdir() whose name starts with idea-test- / idea-1 (the test prefixes). Whatever
 * still remains is reported as a LEFTOVER line instead of being swallowed.
 */
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fs } from 'zx'

const TEST_PREFIX = /^(idea-test-|idea-\d+-fixture-)/

/** Is `dir` a test-owned temp dir (or inside one) that may be force-removed? */
export const isTestTempDir = (dir: string): boolean => {
    const rel = path.relative(os.tmpdir(), path.resolve(dir))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
    return TEST_PREFIX.test(rel.split(path.sep)[0])
}

export const removeTestDir = async (dir: string | undefined): Promise<void> => {
    if (!dir) return
    try { await fs.remove(dir); return } catch { /* retried below */ }
    if (isTestTempDir(dir) && spawnSync('sudo', ['-n', 'true']).status === 0) {
        spawnSync('sudo', ['-n', 'rm', '-rf', '--', path.resolve(dir)])
    }
    if (fs.existsSync(dir)) console.warn(`[test cleanup] LEFTOVER test dir (could not remove): ${dir}`)
}
