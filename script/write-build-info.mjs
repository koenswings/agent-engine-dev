#!/usr/bin/env node
// write-build-info.mjs — run by `pnpm build` after tsc (idea#400 PR C, Steve Q12).
// Writes dist/build-info.json with the git commit and its commit time, which the
// scheduled-backup clock check uses as its floor (a wall clock before the commit
// time cannot be right). Without git (or outside a clone) nothing is written and
// the Engine skips that check.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const out = process.argv[2] ?? 'dist/build-info.json'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
try {
    const commit = git('rev-parse', 'HEAD')
    const commitTimeS = Number(git('log', '-1', '--format=%ct', 'HEAD'))
    if (!/^[0-9a-f]{40}$/.test(commit) || !Number.isSafeInteger(commitTimeS) || commitTimeS <= 0) throw new Error('unexpected git output')
    mkdirSync(out.replace(/\/[^/]*$/, '') || '.', { recursive: true })
    writeFileSync(out, JSON.stringify({ commit, commitTimeMs: commitTimeS * 1000 }) + '\n')
    process.stdout.write(`build-info: ${commit.slice(0, 7)} committed ${new Date(commitTimeS * 1000).toISOString()}\n`)
} catch (e) {
    rmSync(out, { force: true })
    process.stdout.write(`build-info: no git commit time (${e?.message ?? e}); the clock floor check is skipped\n`)
}
