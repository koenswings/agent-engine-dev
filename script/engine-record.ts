/**
 * engine-record.ts — compare, check and secret-scan Engine deployment records (idea#322).
 *
 *   npx tsx script/engine-record.ts compare <expected-dir> <actual-dir> [--ignore-key K]... [--ignore-path P]... [--volatile F] [--ts]
 *   npx tsx script/engine-record.ts check <dir> [--ts]
 *   npx tsx script/engine-record.ts check-secrets <dir>
 *
 * Thin wrapper over the shared idea tool tools/repro/compare-record.py (idea#323): when python3 and an idea
 * checkout (--idea-repo, else $IDEA_REPO_DIR) are available, compare and check run that script. Otherwise
 * (or with --ts, or with --ignore-key, which the shared tool lacks) the same rules run here:
 * UNKNOWN never differs; a sidecar is compared only when the expected side has it; --ignore-path is an exact
 * path or a prefix ending in /; volatile keys = `key:` lines of tools/repro/volatile.txt, else VOLATILE_KEYS.
 *
 * Exit 0 = content-identical / valid / clean, 1 = differences / errors / secrets, 2 = usage.
 */
import { argv, fs } from 'zx'
import { spawnSync } from 'child_process'
import path from 'path'
import { RECORD_FILES, Record, compareRecords, findSecrets, formatDifferences, validateRecord, volatileKeys } from '../src/install/deploymentRecord.js'

export const readRecord = (dir: string): Record => {
    const r: Record = {}
    for (const f of RECORD_FILES) {
        const p = path.join(dir, f)
        if (fs.existsSync(p)) r[f] = fs.readFileSync(p, 'utf8')
    }
    return r
}

const list = (v: unknown): string[] => v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String)

/** The idea checkout's tools/repro, if present. */
export const ideaRepro = (ideaRepo: unknown, env = process.env): string | undefined => {
    const root = ideaRepo ? String(ideaRepo) : env.IDEA_REPO_DIR
    const p = root ? path.join(root, 'tools/repro') : ''
    return p && fs.existsSync(path.join(p, 'compare-record.py')) ? p : undefined
}

const hasPython = () => spawnSync('python3', ['--version']).status === 0

const runPython = (repro: string, args: string[]): number => {
    const r = spawnSync('python3', [path.join(repro, 'compare-record.py'), ...args], { stdio: 'inherit' })
    return r.status ?? 2
}

const main = () => {
    const [cmd, a, b] = argv._.map(String)
    const repro = ideaRepro(argv['idea-repo'])
    const usePy = !argv.ts && !!repro && hasPython()
    if (cmd === 'compare' && a && b) {
        const ignoreKeys = list(argv['ignore-key']), ignorePaths = list(argv['ignore-path'])
        const vf = argv.volatile ? String(argv.volatile) : repro ? path.join(repro, 'volatile.txt') : undefined
        if (usePy && ignoreKeys.length === 0) {
            process.exit(runPython(repro!, [a, b, ...(vf ? ['--volatile', vf] : []), ...ignorePaths.flatMap(p => ['--ignore-path', p])]))
        }
        const volatile = volatileKeys(vf && fs.existsSync(vf) ? fs.readFileSync(vf, 'utf8') : undefined)
        const d = compareRecords(readRecord(a), readRecord(b), { volatile, ignoreKeys, ignorePaths })
        process.stdout.write(formatDifferences(d))
        process.exit(d.length ? 1 : 0)
    }
    if (cmd === 'check' && a) {
        if (usePy) process.exit(runPython(repro!, ['--check', a]))
        const errs = validateRecord(readRecord(a)['record.txt'] ?? '')
        process.stdout.write(errs.length ? errs.join('\n') + '\n' : `record ok: ${a}\n`)
        process.exit(errs.length ? 1 : 0)
    }
    if (cmd === 'check-secrets' && a) {
        const hits = findSecrets(readRecord(a))
        process.stdout.write(hits.length ? hits.map(h => `SECRET ${h}`).join('\n') + '\n' : 'CLEAN\n')
        process.exit(hits.length ? 1 : 0)
    }
    process.stderr.write('usage: engine-record.ts compare <expected> <actual> | check <dir> | check-secrets <dir>\n')
    process.exit(2)
}
main()
