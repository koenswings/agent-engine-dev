/**
 * Drop a second send of the same automerge-repo ephemeral message to the same
 * peer (engine#387). Checking idea/progress was arriving twice on the source
 * Engine (~1 ms apart, same senderId) while the target (the emitter) saw each
 * message once. automerge-repo relays an incoming ephemeral message to every
 * other peer of the doc; if that relay is applied twice, or both adapters send
 * the same envelope, a Console or listener on the receiving Engine sees
 * duplicates. Dedupe key is targetId + senderId + sessionId + count — the
 * library's own identity for one broadcast.
 */
import type { Message } from '@automerge/automerge-repo'

const DEFAULT_TTL_MS = 60_000
const PRUNE_EVERY = 64

export type EphemeralSendDedupe = {
    /** True when this envelope should go out (first time, or not ephemeral). */
    shouldSend: (message: Message | { type?: unknown, targetId?: unknown, senderId?: unknown, sessionId?: unknown, count?: unknown }) => boolean
}

export const ephemeralSendKey = (
    message: { type?: unknown, targetId?: unknown, senderId?: unknown, sessionId?: unknown, count?: unknown },
): string | null => {
    if (message?.type !== 'ephemeral') return null
    if (typeof message.senderId !== 'string' || message.senderId === '') return null
    const count = message.count
    if (typeof count !== 'number' || !Number.isFinite(count)) return null
    const target = typeof message.targetId === 'string' ? message.targetId : ''
    const session = typeof message.sessionId === 'string' ? message.sessionId : ''
    return `${target}\x1f${message.senderId}\x1f${session}\x1f${count}`
}

export const createEphemeralSendDedupe = (ttlMs: number = DEFAULT_TTL_MS): EphemeralSendDedupe => {
    const seen = new Map<string, number>()
    let ops = 0
    const prune = (now: number) => {
        for (const [k, at] of seen) {
            if (now - at >= ttlMs) seen.delete(k)
        }
    }
    return {
        shouldSend: (message) => {
            const key = ephemeralSendKey(message)
            if (key == null) return true
            const now = Date.now()
            if (++ops % PRUNE_EVERY === 0) prune(now)
            const prev = seen.get(key)
            if (prev != null && now - prev < ttlMs) return false
            seen.set(key, now)
            return true
        },
    }
}
