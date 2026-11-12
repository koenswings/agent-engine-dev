/**
 * commandLogDoc.ts — a command-log-like Automerge doc with N incremental changes.
 *
 * Used by ws-post-burst as the extra docs the Engine holds besides the store
 * (r34 POST-BURST-CPU). Building 6 000 sequential changes takes ~4 s on the box
 * and ~40 s on a Pi 4. Together with a cold largeStoreDoc() generate that blew
 * the 360 s beforeAll under test:full (idea#332). Sizes 1000 and 6000 load from
 * committed fixtures (`test/fixtures/ws-command-log-<N>.bin`); any other size
 * is generated in memory.
 */
import path from 'path'
import fs from 'fs'
import { next as A } from '@automerge/automerge'

export const commandLogFixturePath = (changes: number): string =>
    path.resolve(process.cwd(), 'test/fixtures', `ws-command-log-${changes}.bin`)

export const generateCommandLogDoc = (changes: number): Uint8Array => {
    let d = A.from<any>({ logs: [] })
    for (let i = 0; i < changes; i++) {
        d = A.change(d, (x: any) => {
            x.logs.push({ ts: 1791000000000 + i, msg: `step ${i}: docker compose pull kolibri ... ok` })
        })
    }
    return A.save(d)
}

export const commandLogDoc = (changes: number): Uint8Array => {
    const file = commandLogFixturePath(changes)
    if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file))
    return generateCommandLogDoc(changes)
}
