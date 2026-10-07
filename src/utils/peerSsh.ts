/**
 * peerSsh.ts — the ONE place that builds the ssh/rsync options for Engine-to-Engine
 * transfers (per-Pi Engine keys, design-per-pi-engine-key.md).
 *
 * Every Engine has its own ed25519 key (/home/pi/.ssh/idea_engine_ed25519, made at
 * first start) and publishes it, with its ssh host key, in its Engine entry in the
 * store (Engine.peerAccess). Each Engine writes its peers' keys into the root-owned
 * /etc/ssh/idea_authorized_keys/pi (restricted to /usr/local/sbin/idea-peer-gate)
 * and their host keys into /etc/idea/peer_known_hosts, both through
 * `idea-app-data sync-peers`. A peer is addressed by IP, but its host key is pinned
 * by Engine id (HostKeyAlias), so a changed IP never needs a known_hosts fix and a
 * host that is not the peer fails closed. Never StrictHostKeyChecking=no.
 *
 * The root helper's `send` (script/build_image_assets/idea-app-data) builds the
 * same option list itself; a test checks that the two stay equal.
 */

import crypto from 'crypto'

/** The Engine's private key (pi:pi 0600); `<path>.pub` holds the public key. */
export const PEER_KEY_PATH = '/home/pi/.ssh/idea_engine_ed25519'
/** Peers' host keys by Engine id, written by `idea-app-data sync-peers` (root:root 0644). */
export const PEER_KNOWN_HOSTS = '/etc/idea/peer_known_hosts'
/** Peers' Engine keys, each restricted to the gate, written by `sync-peers` (root:root 0644). */
export const PEER_AUTHORIZED_KEYS = '/etc/ssh/idea_authorized_keys/pi'
/** The forced command of every peer key (root-owned 0755, installed by build-engine). */
export const PEER_GATE = '/usr/local/sbin/idea-peer-gate'
/** This Pi's ssh host key (public part), published so peers can pin it. */
export const HOST_KEY_PUB = '/etc/ssh/ssh_host_ed25519_key.pub'
/** The remote user every peer connection logs in as. */
export const PEER_USER = 'pi'

/** Engine ids the peer files accept (also HostKeyAlias and the gate's argument). */
export const ENGINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
/** An ed25519 public key blob in base64: always 68 characters with this prefix. */
export const ED25519_B64_RE = /^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/

export const checkEngineId = (engineId: string): string => {
    if (!ENGINE_ID_RE.test(engineId)) throw new Error(`'${engineId}' is not an Engine id the peer files accept (${ENGINE_ID_RE})`)
    return engineId
}

/**
 * `ssh-ed25519 <base64> [comment]` → `ssh-ed25519 <base64>` (comment dropped), or
 * null when it is not exactly one well-formed ed25519 public key.
 */
export const normaliseEd25519 = (line: string | null | undefined): string | null => {
    if (typeof line !== 'string') return null
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2 || parts[0] !== 'ssh-ed25519' || !ED25519_B64_RE.test(parts[1])) return null
    const blob = Buffer.from(parts[1], 'base64')
    // uint32 11, "ssh-ed25519", uint32 32, 32 key bytes
    if (blob.length !== 51 || blob.readUInt32BE(0) !== 11 || blob.toString('latin1', 4, 15) !== 'ssh-ed25519' || blob.readUInt32BE(15) !== 32) return null
    if (blob.toString('base64').replace(/=+$/, '') !== parts[1]) return null
    return `ssh-ed25519 ${parts[1]}`
}

/** OpenSSH's fingerprint of a public key line: `SHA256:<base64, no padding>`. */
export const keyFingerprint = (keyLine: string): string => {
    const k = normaliseEd25519(keyLine)
    if (!k) throw new Error('not an ed25519 public key')
    const digest = crypto.createHash('sha256').update(Buffer.from(k.split(' ')[1], 'base64')).digest('base64')
    return `SHA256:${digest.replace(/=+$/, '')}`
}

/**
 * The ssh options for a connection to the peer Engine `engineId`: its own key only,
 * no prompts, the pinned host key (by Engine id) and nothing else.
 */
export const peerSshOptions = (engineId: string): string[] => [
    '-i', PEER_KEY_PATH,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${PEER_KNOWN_HOSTS}`,
    '-o', `HostKeyAlias=${checkEngineId(engineId)}`,
    '-o', 'ConnectTimeout=10',
]

/** The value for `rsync -e` (no option value holds a space, so this splits safely). */
export const peerRsyncShell = (engineId: string): string => ['ssh', ...peerSshOptions(engineId)].join(' ')

/** `user@host` for a peer; the host must be an IPv4 address or host name. */
export const peerTarget = (host: string): string => {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host) || host.includes('..')) throw new Error(`'${host}' is not a peer address`)
    return `${PEER_USER}@${host}`
}

/**
 * The ssh argv that runs ONE remote command on a peer. The remote command is a
 * single argument built from checked tokens; on the peer, the gate parses it.
 */
export const peerSshArgv = (host: string, engineId: string, remoteCommand: string[]): string[] => {
    for (const w of remoteCommand) {
        if (!/^[A-Za-z0-9._=,:+@/-]+$/.test(w)) throw new Error(`unsafe word '${w}' in a peer command`)
    }
    return ['ssh', ...peerSshOptions(engineId), peerTarget(host), '--', remoteCommand.join(' ')]
}
