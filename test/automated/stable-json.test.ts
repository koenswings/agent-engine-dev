/**
 * stable-json.test.ts: stableStringify compares a value read back from the
 * Automerge store (3.5: map keys sorted) with a freshly built plain object
 * (insertion order), and Automerge 3.5 change() proxies no longer expose
 * Object.prototype methods (upstream bd0dafa1), which getDisk/getApp/getInstance
 * relied on through hasOwnProperty.
 */
import { describe, it, expect } from 'vitest'
import { next as A } from '@automerge/automerge'
import { stableStringify } from '../../src/utils/stableJson.js'
import { getApp, getDisk, getInstance } from '../../src/data/Store.js'

describe('stableStringify', () => {
    it('ignores key order at every depth, keeps array order', () => {
        expect(stableStringify({ b: 1, a: { d: [2, 1], c: null } })).toBe(stableStringify({ a: { c: null, d: [2, 1] }, b: 1 }))
        expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
        expect(stableStringify(null)).toBe('null')
    })
    it('a list written to the doc compares equal to the plain list it was built from', () => {
        const list = [{ appId: 'k', version: '1.1', sumsListed: true, sizeBytes: 0 }]
        const d = A.change(A.from<any>({ diskDB: { dA: {} } }), x => { x.diskDB.dA.appBundles = list.map(b => ({ ...b })) })
        expect(stableStringify(d.diskDB.dA.appBundles)).toBe(stableStringify(list))
    })
})

describe('Store getters inside change()', () => {
    it('getDisk/getApp/getInstance work on change() proxies', () => {
        const d0 = A.from<any>({ diskDB: { d1: { id: 'd1' } }, appDB: { a1: { id: 'a1' } }, instanceDB: { i1: { id: 'i1' } } })
        A.change(d0, x => {
            expect(getDisk(x, 'd1' as any)?.id).toBe('d1')
            expect(getApp(x, 'a1' as any)?.id).toBe('a1')
            expect(getInstance(x, 'i1' as any)?.id).toBe('i1')
            expect(getInstance(x, 'nope' as any)).toBeUndefined()
        })
    })
})
