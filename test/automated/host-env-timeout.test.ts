/** host-env-timeout.test.ts — envTimeoutMs: env override for slow-host setup budgets (idea#332). */
import { describe, it, expect } from 'vitest'
import { envTimeoutMs } from '../harness/hostEnv.js'

describe('envTimeoutMs', () => {
    it('uses a positive integer from the env', () => {
        expect(envTimeoutMs('X', 360_000, { X: '900000' })).toBe(900_000)
        expect(envTimeoutMs('X', 360_000, { X: ' 1200 ' })).toBe(1_200)
    })
    it('falls back when unset, empty, zero, negative, fractional or not a number', () => {
        for (const v of [undefined, '', '0', '-5', '1.5', 'abc', '1e6', '99999999999999999999']) {
            expect(envTimeoutMs('X', 360_000, v === undefined ? {} : { X: v })).toBe(360_000)
        }
    })
})
