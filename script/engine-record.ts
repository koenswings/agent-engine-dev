/**
 * engine-record.ts — compare and check deployment records (idea#322).
 *
 *   npx tsx script/engine-record.ts compare <expected-dir> <actual-dir> [--ignore-key K]... [--ignore-path P]... [--volatile-file F]
 *
 * --volatile-file (default $IDEA_VOLATILE_FILE, else $IDEA_REPO_DIR/tools/repro/volatile.txt if present)
 * adds the shared volatile-key list from the idea repo to the built-in VOLATILE_KEYS.
 *   npx tsx script/engine-record.ts check-secrets <dir>
 *
 * Exit 0 = content-identical / clean, 1 = differences / secrets found, 2 = usage.
 */
import { argv } from 'zx'
import { fs } from 'zx'
import path from 'path'
import { RECORD_FILES, Record, compareRecords, findSecrets, formatDifferences, parseVolatileList } from '../src/install/deploymentRecord.js'

export const readRecord = (dir: string): Record => {
    const r: Record = {}
    for (const f of RECORD_FILES) {
        const p = path.join(dir, f)
        if (fs.existsSync(p)) r[f] = fs.readFileSync(p, 'utf8')
    }
    return r
}

const list = (v: unknown): string[] => v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String)

export const volatileFile = (flag: unknown, env = process.env): string | undefined => {
    if (flag) return String(flag)
    if (env.IDEA_VOLATILE_FILE) return env.IDEA_VOLATILE_FILE
    const p = env.IDEA_REPO_DIR ? path.join(env.IDEA_REPO_DIR, 'tools/repro/volatile.txt') : ''
    return p && fs.existsSync(p) ? p : undefined
}

const main = () => {
    const [cmd, a, b] = argv._.map(String)
    if (cmd === 'compare' && a && b) {
        const vf = volatileFile(argv['volatile-file'])
        const shared = vf ? parseVolatileList(fs.readFileSync(vf, 'utf8')) : []
        const d = compareRecords(readRecord(a), readRecord(b), { ignoreKeys: [...shared, ...list(argv['ignore-key'])], ignorePaths: list(argv['ignore-path']) })
        process.stdout.write(formatDifferences(d))
        process.exit(d.length ? 1 : 0)
    }
    if (cmd === 'check-secrets' && a) {
        const hits = findSecrets(readRecord(a))
        process.stdout.write(hits.length ? hits.map(h => `SECRET ${h}`).join('\n') + '\n' : 'CLEAN\n')
        process.exit(hits.length ? 1 : 0)
    }
    process.stderr.write('usage: engine-record.ts compare <expected> <actual> | check-secrets <dir>\n')
    process.exit(2)
}
main()
