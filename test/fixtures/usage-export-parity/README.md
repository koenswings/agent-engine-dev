# usage-export parity fixture (idea#411 / idea#412)

Shared on-disk tree and golden export streams so `idea-usage-export` on
`feat/idea-usage-export-412` (agent-engine-dev#309, standalone Python forced
command) and the TypeScript exporter on `feat/idea-usage-411`
(agent-engine-dev#308, `src/usage/exportCmd.ts`) produce the same bytes.

This directory lives on the #309 branch because #308's `src/usage/` is not
present there. Copy the whole `test/fixtures/usage-export-parity/` tree onto
#308 (or merge this commit) and add the test below.

## Fixture shapes (do not “fix” these to the older sample sketch)

- Nextcloud samples carry `office.documentIds`: an array of **16-character
  lowercase hex** strings. They do **not** have a top-level `documents` field
  and they do not use `office.documents` (the older 64-hex SHA-256 sketch).
- Role keys are singular everywhere: `admin`, `teacher`, `learner` (never
  `admins` / `teachers` / `learners`). Each role count is
  `{ "total": <n>, "beyondSeed": <n> }` in `setup`, `logins` and
  `office.byGroup`.
- Kolibri `signins` add `sessions` and `minutes` on the same object, plus
  extra role `coach`.
- `2026-11-12/bad.json` is deliberately not JSON (`end.errors === 1`).
- `.archive/2026-11-01-20261101T000000Z/2026-11-20/` is a pre-existing
  archive and must not appear in `since`.

## What the goldens cover

| File | How to reproduce |
|---|---|
| `expected/since-2026-11-11.ndjson` | `IDEA_USAGE_ENGINE=happy-zebra` (or `hostname: 'happy-zebra'`), `since 2026-11-11`, `usageMonitoring` on. Inclusive on-or-after; live tree only. |
| `expected/archive-before-2026-11-01.ndjson` | `archive-and-clear --before 2026-11-01`. Strictly-before: only `2026-10-31` moves (`days: 1`, `files: 1`). |
| `expected/disabled.stderr.txt` | `disabled\n`. Exit 10, empty stdout, no writes, for both verbs when the switch is `off` or `settings.json` is missing. |

Copy `tree/` to a temp directory before every case so archive does not mutate
the committed fixture.

## What #308 should add

Add `test/automated/usage-export-parity.test.ts` on `feat/idea-usage-411`
(do not import the Python script). Suggested body:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXIT_DISABLED, EXIT_OK, runExport } from '../../src/usage/exportCmd.js'

const TREE = path.resolve('test/fixtures/usage-export-parity/tree')
const EXPECTED = path.resolve('test/fixtures/usage-export-parity/expected')

let tmp = ''
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-parity-'))
    fs.cpSync(TREE, tmp, { recursive: true })
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

async function run(argv: string[]) {
    let stdout = ''
    let stderr = ''
    const code = await runExport({
        argv,
        root: tmp,
        hostname: 'happy-zebra',
        stdout: { write: (s: string) => { stdout += s } },
        stderr: { write: (s: string) => { stderr += s } },
        now: () => new Date('2026-11-10T20:30:45Z'),
    })
    return { code, stdout, stderr }
}

describe('usage-export parity with idea#412 goldens', () => {
    it('since matches the golden NDJSON byte-for-byte', async () => {
        const r = await run(['since', '2026-11-11'])
        expect(r.code).toBe(EXIT_OK)
        expect(r.stderr).toBe('')
        expect(r.stdout).toBe(fs.readFileSync(path.join(EXPECTED, 'since-2026-11-11.ndjson'), 'utf8'))
    })

    it('archive-and-clear matches the golden stdout and moves only strictly-before days', async () => {
        const settings = fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')
        const r = await run(['archive-and-clear', '--before', '2026-11-01'])
        expect(r.code).toBe(EXIT_OK)
        expect(r.stderr).toBe('')
        expect(r.stdout).toBe(fs.readFileSync(path.join(EXPECTED, 'archive-before-2026-11-01.ndjson'), 'utf8'))
        expect(fs.existsSync(path.join(tmp, '2026-10-31'))).toBe(false)
        expect(fs.existsSync(path.join(tmp, '2026-11-01', 'boundary.json'))).toBe(true)
        expect(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')).toBe(settings)
        expect(fs.existsSync(path.join(tmp, '.archive', '2026-11-01-20261101T000000Z', '2026-11-20', 'hidden.json'))).toBe(true)
        // With the frozen `now` above the dest name is 2026-11-01-20261110T203045Z.
        expect(fs.existsSync(path.join(tmp, '.archive', '2026-11-01-20261110T203045Z', '2026-10-31', 'old.json'))).toBe(true)
    })

    it('disabled path: empty stdout, stderr disabled, no writes (off and missing settings)', async () => {
        const disabledErr = fs.readFileSync(path.join(EXPECTED, 'disabled.stderr.txt'), 'utf8')
        fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ usageMonitoring: 'off' }) + '\n')
        const before = snapshot(tmp)
        for (const argv of [['since', '2026-11-11'], ['archive-and-clear', '--before', '2026-11-01']]) {
            const r = await run(argv)
            expect(r).toEqual({ code: EXIT_DISABLED, stdout: '', stderr: disabledErr })
        }
        expect(snapshot(tmp)).toEqual(before)

        fs.rmSync(path.join(tmp, 'settings.json'))
        const missing = await run(['since', '2026-11-11'])
        expect(missing).toEqual({ code: EXIT_DISABLED, stdout: '', stderr: disabledErr })
        expect(fs.existsSync(path.join(tmp, '2026-10-31', 'old.json'))).toBe(true)
    })
})

function snapshot(dir: string): string[] {
    const out: string[] = []
    const walk = (d: string) => {
        for (const name of fs.readdirSync(d).sort()) {
            const p = path.join(d, name)
            const st = fs.lstatSync(p)
            out.push(`${path.relative(dir, p)} ${st.isDirectory() ? 'dir' : st.size}`)
            if (st.isDirectory() && !st.isSymbolicLink()) walk(p)
        }
    }
    walk(dir)
    return out
}
```

`hostname` must be `'happy-zebra'` (the Engine field in the `end` marker).
`JSON.stringify(obj)` (no space argument) already matches the golden
spelling: compact separators, UTF-8, `52` not `52.0`. Do not pretty-print
the stream.

## Differences #308 should be aware of (not hidden by the goldens)

1. **Empty archive dest.** `archiveAndClear` in `exportCmd.ts` always
   `mkdirSync`s `.archive/<before>-<stamp>/` even when `days` is 0. The
   Python forced command only creates that directory when it actually moves
   a day (contract §7.3: move selected live days; nothing selected → no
   write). This fixture moves one day, so both sides create a dest. A
   separate no-op archive case would disagree unless #308 skips the mkdir
   when nothing is selected.
2. **Unreadable settings.** Contract §7.2: exit 1, short stderr reason.
   Python exits 1 with `unreadable settings`. `readUsageMonitoring` on #308
   currently catches parse/IO errors and returns `off` (exit 10). Missing
   file = off is correct (that case is in the goldens). Unreadable file
   should become exit 1 to match the contract.
3. **`--before=YYYY-MM-DD`.** #308 already accepts the `=` form as well as
   `--before YYYY-MM-DD`. The golden uses the space form from the contract.
4. **Day sort key.** Contract §7.1: day files sorted by `instance`. #308
   sorts filenames and then sets `instance` from `payload.instance` when it
   is a string. That matches these fixtures because every day file is named
   `<instance>.json`. Sorting by the envelope instance is the safer rule if
   a filename and `payload.instance` ever diverge.
5. **Schema vs export.** Export must wrap stored JSON as `payload`
   unchanged. `src/usage/schema.ts` / `merge.ts` on #308 still describe
   `office.documents` as 64-hex SHA-256 digests and `office.byGroup` values
   as plain integers. Update those to `office.documentIds` (16-hex) and
   singular `{total, beyondSeed}` role counts if that work is not already
   queued — it is independent of matching these goldens.

Engine: `happy-zebra`. `since` cut: `2026-11-11`. Archive cut: `2026-11-01`.
