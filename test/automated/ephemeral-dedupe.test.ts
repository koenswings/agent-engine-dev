/**
 * ephemeral-dedupe.test.ts — engine#387: each ephemeral envelope reaches each peer once.
 */
import { describe, it, expect } from 'vitest'
import { createEphemeralSendDedupe, ephemeralSendKey } from '../../src/utils/ephemeralDedupe.js'

const envelope = (over: Record<string, unknown> = {}) => ({
    type: 'ephemeral',
    targetId: 'console-1',
    senderId: 'idea-engine/tag/ENGINE_idea04/e7966cf7',
    sessionId: 'sess-a',
    count: 7,
    documentId: 'doc-1',
    data: new Uint8Array([1, 2, 3]),
    ...over,
})

describe('ephemeral send dedupe (engine#387)', () => {
    it('ephemeralSendKey uses target + sender + session + count', () => {
        expect(ephemeralSendKey({ type: 'sync', senderId: 'a', count: 1 })).toBeNull()
        expect(ephemeralSendKey({ type: 'ephemeral', senderId: 'a' })).toBeNull()
        expect(ephemeralSendKey(envelope())).toBe(['console-1', 'idea-engine/tag/ENGINE_idea04/e7966cf7', 'sess-a', '7'].join('\x1f'))
    })

    it('the same envelope is sent only once per target; a later count or other peer still goes out', () => {
        const d = createEphemeralSendDedupe(60_000)
        const first = envelope()
        expect(d.shouldSend(first)).toBe(true)
        expect(d.shouldSend(first)).toBe(false)
        expect(d.shouldSend({ ...first })).toBe(false)
        expect(d.shouldSend(envelope({ targetId: 'console-2' }))).toBe(true)
        expect(d.shouldSend(envelope({ count: 8 }))).toBe(true)
        expect(d.shouldSend(envelope({ count: 8 }))).toBe(false)
        expect(d.shouldSend({ type: 'sync', senderId: 'a', targetId: 'console-1' } as any)).toBe(true)
    })
})
