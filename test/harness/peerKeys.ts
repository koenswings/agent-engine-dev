/**
 * peerKeys.ts — well-formed ed25519 public keys for tests (per-Pi Engine keys).
 * The 32 key bytes are derived from a seed, so each seed gives a stable, distinct key.
 */
import crypto from 'crypto'

export const testKey = (seed: string): string => {
    const head = Buffer.alloc(4); head.writeUInt32BE(11)
    const len = Buffer.alloc(4); len.writeUInt32BE(32)
    const key = crypto.createHash('sha256').update(seed).digest()
    return `ssh-ed25519 ${Buffer.concat([head, Buffer.from('ssh-ed25519', 'latin1'), len, key]).toString('base64')}`
}

/** '<engineId> <sshKey> <hostKey>' for sync-peers stdin */
export const peerLine = (engineId: string, seed = engineId): string => `${engineId} ${testKey(`${seed}-ssh`)} ${testKey(`${seed}-host`)}`
