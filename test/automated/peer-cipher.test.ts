/**
 * peer-cipher.test.ts — rsyncToPeer pins chacha20-poly1305 (idea#351 §6, idea#354) and retries
 * once with the default ciphers only when the peer does not offer it; never hangs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { rsyncToPeer, rsyncToPeerArgs, peerRsyncRunner, PEER_CIPHER, isCipherNegotiationFailure, PeerRsyncRunner } from '../../src/utils/rsync.js'
import { receiveAppArgs } from '../../src/utils/appDataHelper.js'
import { peerSshOptions } from '../../src/utils/peerSsh.js'

const peer = { host: '10.0.0.4', engineId: 'ENGINE_d4' }
const helper = receiveAppArgs('sdb1', 'kolibri-1.0')
const shellOf = (args: string[]) => args[args.indexOf('-e') + 1]
const orig = peerRsyncRunner.run
afterEach(() => { peerRsyncRunner.run = orig })

const NEG = 'Unable to negotiate with 10.0.0.4 port 22: no matching cipher found. Their offer: aes128-ctr,aes256-gcm@openssh.com'
const fake = (results: (string | null)[], seen: string[][]): PeerRsyncRunner => async (args, fmt) => {
    seen.push(args)
    const r = results.shift()
    if (r) throw new Error(fmt(255, null, r))
}

describe('rsyncToPeer cipher pin (idea#354)', () => {
    it('pins the cipher with the usual peer options, ConnectTimeout included', () => {
        expect(PEER_CIPHER).toBe('chacha20-poly1305@openssh.com')
        const sh = shellOf(rsyncToPeerArgs('/apps/kolibri-1.0/', peer, helper))
        expect(sh).toBe(`ssh ${peerSshOptions('ENGINE_d4').join(' ')} -c chacha20-poly1305@openssh.com`)
        expect(sh).toContain('ConnectTimeout=10')
        const plain = shellOf(rsyncToPeerArgs('/apps/kolibri-1.0/', peer, helper, false))
        expect(plain).not.toContain(' -c ')
        expect(plain).toContain('ConnectTimeout=10')
    })
    it('pinned path: one attempt when the peer offers chacha20', async () => {
        const seen: string[][] = []
        peerRsyncRunner.run = fake([null], seen)
        await rsyncToPeer('/apps/kolibri-1.0/', peer, helper)
        expect(seen.length).toBe(1)
        expect(shellOf(seen[0])).toContain(`-c ${PEER_CIPHER}`)
    })
    it('fallback: a cipher negotiation failure retries once without -c', async () => {
        const seen: string[][] = []
        peerRsyncRunner.run = fake([NEG, null], seen)
        await rsyncToPeer('/apps/kolibri-1.0/', peer, helper)
        expect(seen.length).toBe(2)
        expect(shellOf(seen[1])).not.toContain(' -c ')
        expect(seen[1].filter(a => a !== shellOf(seen[1]))).toEqual(seen[0].filter(a => a !== shellOf(seen[0])))
    })
    it('fallback that also fails gives a clean error, no third attempt', async () => {
        const seen: string[][] = []
        peerRsyncRunner.run = fake([NEG, 'Connection timed out during banner exchange'], seen)
        await expect(rsyncToPeer('/apps/kolibri-1.0/', peer, helper)).rejects.toThrow(/rsync to Engine ENGINE_d4 \(10\.0\.0\.4, receive-app\) exited with code 255: Connection timed out/)
        expect(seen.length).toBe(2)
    })
    it('other failures are not retried', async () => {
        const seen: string[][] = []
        peerRsyncRunner.run = fake(['ssh: connect to host 10.0.0.4 port 22: Connection timed out'], seen)
        await expect(rsyncToPeer('/apps/kolibri-1.0/', peer, helper)).rejects.toThrow(/Connection timed out/)
        expect(seen.length).toBe(1)
    })
    it('recognises the ssh wording for a missing cipher', () => {
        expect(isCipherNegotiationFailure(NEG)).toBe(true)
        expect(isCipherNegotiationFailure('Bad SSH2 cipher spec \'chacha20-poly1305@openssh.com\'.')).toBe(true)
        expect(isCipherNegotiationFailure('Permission denied (publickey).')).toBe(false)
    })
})
