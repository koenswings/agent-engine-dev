/**
 * secure-random-ids.test.ts — app passwords and ids come from crypto, not Math.random (idea#114)
 *
 * uuid() generates disk, instance and operation ids and the app password that
 * startInstance writes to an instance's .env (`pass`).
 *
 *   1. Same shape as before: SECRET_ID_LENGTH (19) characters from [0-9a-z]
 *   2. Unique over many samples
 *   3. Uses the crypto source: still unique and well spread with Math.random
 *      stubbed to a constant; secureRandomString draws every character through
 *      the injected randomInt (crypto.randomInt by default, no modulo bias)
 *   4. The password step of startInstance uses uuid(), and nothing in uuid()'s
 *      code path calls Math.random
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'path'
import { fs } from 'zx'
import { uuid, uuidLight, secureRandomString, SECRET_ID_ALPHABET, SECRET_ID_LENGTH } from '../../src/utils/utils.js'

const ROOT = process.cwd()
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const SAMPLES = 20_000

afterEach(() => { vi.restoreAllMocks() })

describe('secure random ids and app passwords (idea#114)', () => {
    it('keeps the old shape: 19 characters of [0-9a-z]', () => {
        expect(SECRET_ID_ALPHABET).to.equal('0123456789abcdefghijklmnopqrstuvwxyz')
        expect(SECRET_ID_LENGTH).to.equal(19)
        for (let i = 0; i < 1000; i++) {
            expect(uuid()).to.match(/^[0-9a-z]{19}$/)
        }
        expect(uuidLight()).to.match(/^[0-9a-z]{8}$/)
    })

    it(`is unique over ${SAMPLES} samples and uses every character`, () => {
        const ids = new Set<string>()
        for (let i = 0; i < SAMPLES; i++) ids.add(uuid())
        expect(ids.size).to.equal(SAMPLES)
        const seen = new Set([...ids].join(''))
        expect(seen.size, 'all 36 characters appear').to.equal(36)
    })

    it('spreads characters evenly (no modulo bias)', () => {
        const counts = new Map<string, number>()
        for (let i = 0; i < SAMPLES; i++) for (const ch of uuid()) counts.set(ch, (counts.get(ch) ?? 0) + 1)
        const total = SAMPLES * SECRET_ID_LENGTH
        const expected = total / 36
        // Chi-square with 35 degrees of freedom: 99.99th percentile is about 80.
        let chi2 = 0
        for (const ch of SECRET_ID_ALPHABET) chi2 += ((counts.get(ch) ?? 0) - expected) ** 2 / expected
        expect(chi2).to.be.lessThan(80)
    })

    it('does not depend on Math.random', () => {
        const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const ids = new Set<string>()
        for (let i = 0; i < 1000; i++) ids.add(uuid())
        expect(ids.size, 'still unique with Math.random fixed').to.equal(1000)
        expect(spy).not.toHaveBeenCalled()
    })

    it('secureRandomString draws every character through randomInt (crypto.randomInt by default)', () => {
        const calls: number[] = []
        const fake = (max: number) => { calls.push(max); return calls.length % max }
        expect(secureRandomString(5, 'abc', fake)).to.equal('bcabc')
        expect(calls).to.deep.equal([3, 3, 3, 3, 3])
        const utils = src('src/utils/utils.ts')
        expect(utils).to.match(/randomInt: \(max: number\) => number = crypto\.randomInt/)
        const uuidBody = utils.slice(utils.indexOf('export const uuid = '), utils.indexOf('export const uuidLight'))
        expect(uuidBody).to.include('secureRandomString(SECRET_ID_LENGTH)')
        expect(uuidBody).to.not.include('Math.random')
    })

    it('startInstance generates the app password with uuid()', () => {
        expect(src('src/data/Instance.ts')).to.match(/pass = await uuid\(\)/)
    })
})
