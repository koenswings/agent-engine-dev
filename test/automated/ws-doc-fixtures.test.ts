/**
 * ws-doc-fixtures.test.ts — idea#332: WS setup docs load from committed fixtures.
 *
 * A cold generate of largeStoreDoc (~96 000 changes) plus extraDoc(6000) in
 * ws-post-burst beforeAll timed out at 360 s on idea04 under test:full; an
 * isolated retry then passed because /tmp already held the cache. These checks
 * pin the fixtures in git so setup never depends on os.tmpdir().
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { next as A } from '@automerge/automerge'
import { largeStoreDoc, defaultLargeStoreFixturePath } from '../harness/largeStoreDoc.js'
import { commandLogDoc, commandLogFixturePath, generateCommandLogDoc } from '../harness/commandLogDoc.js'

describe('idea#332: committed WS doc fixtures', () => {
    it('default largeStoreDoc reads the committed fixture and does not write the old /tmp cache', () => {
        const fixture = defaultLargeStoreFixturePath()
        expect(fs.existsSync(fixture), fixture).toBe(true)
        const stale = path.join(os.tmpdir(), 'idea-wsconc-store-v1-d-d-d.bin')
        const existed = fs.existsSync(stale)
        const bin = largeStoreDoc()
        if (!existed) expect(fs.existsSync(stale), 'must not generate into os.tmpdir()').toBe(false)
        expect(bin.byteLength).toBe(fs.statSync(fixture).size)
        expect(bin.byteLength).toBeGreaterThan(100_000)
        const doc = A.load(bin) as { engineDB: Record<string, unknown>, operationDB: Record<string, unknown> }
        expect(Object.keys(doc.engineDB).length).toBe(3)
        expect(Object.keys(doc.operationDB).length).toBeGreaterThan(100)
    })

    it('commandLogDoc(6000) and commandLogDoc(1000) read committed fixtures', () => {
        for (const n of [1_000, 6_000]) {
            const file = commandLogFixturePath(n)
            expect(fs.existsSync(file), file).toBe(true)
            const bin = commandLogDoc(n)
            expect(bin.byteLength).toBe(fs.statSync(file).size)
            const doc = A.load(bin) as { logs: unknown[] }
            expect(doc.logs.length).toBe(n)
        }
    })

    it('commandLogDoc generates in memory when there is no fixture (size 3)', () => {
        expect(fs.existsSync(commandLogFixturePath(3))).toBe(false)
        const generated = generateCommandLogDoc(3)
        const loaded = commandLogDoc(3)
        const doc = A.load(loaded) as { logs: unknown[] }
        expect(doc.logs.length).toBe(3)
        expect(loaded.byteLength).toBe(generated.byteLength)
    })
})
