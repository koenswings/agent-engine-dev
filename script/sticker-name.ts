#!/usr/bin/env -S npx tsx
/**
 * Pick, check and save a sticker name WITHOUT renaming the system (idea#184).
 * Runs on the Pi. Same resolver and checks as build-engine.ts (LAN mDNS,
 * network database, tailnet), but never changes the system hostname, hosts file or tailnet name.
 *
 *   npx tsx script/sticker-name.ts --no-rename [--out DIR] [--hostname X]
 *       [--peer host,...] [--taken name,...] [--seed N]
 *
 * --out DIR    write sticker-name and STICKER.txt under DIR (default: a fresh /tmp dir)
 * --taken      extra names to treat as taken (to induce a collision in tests)
 * --seed N     deterministic pick order (tests)
 * Prints one JSON line with the result.
 */
import { $, argv } from 'zx'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { realStickerNameDeps, resolveStickerName, stickerText, writeStickerFile } from '../src/install/stickerName.js'

export const seeded = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const main = async () => {
    // minimist reads --no-rename as rename=false
    if (!(argv.rename === false || argv['no-rename'])) { console.error('this tool only runs with --no-rename (use build-engine.ts to install)'); process.exit(2) }
    $.verbose = false
    const out = argv.out ? String(argv.out) : mkdtempSync(join(tmpdir(), 'sticker-'))
    const stickerFile = join(out, 'sticker-name'), stickerTxt = join(out, 'STICKER.txt')
    const logs: string[] = []
    const peers = argv.peer ? String(argv.peer).split(',').map((s) => s.trim()).filter(Boolean) : undefined
    const taken = argv.taken ? String(argv.taken).split(',').map((s) => s.trim()).filter(Boolean) : []
    const deps = realStickerNameDeps($, { peers, stickerFile, log: (m) => { logs.push(m); console.error(m) } })
    const lanTaken = deps.lanTaken
    deps.lanTaken = async (n) => taken.includes(n) ? (logs.push(`induced: ${n} treated as taken`), true) : lanTaken(n)
    if (argv.seed !== undefined) deps.rand = seeded(Number(argv.seed))
    const r = await resolveStickerName(argv.hostname, deps)
    const text = stickerText(r.name, Number(argv.port ?? 80))
    await writeStickerFile($, text, stickerTxt)
    console.log(JSON.stringify({ ...r, stickerFile, stickerTxt, logs }))
    process.exit(0)
}
if (process.argv[1]?.endsWith('sticker-name.ts')) main().catch((e) => { console.error(e); process.exit(1) })
