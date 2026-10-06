/**
 * peer-access.test.ts — per-Pi Engine keys (design-per-pi-engine-key.md)
 *
 *   - peerSsh: the ONE ssh-options builder (-i, IdentitiesOnly, StrictHostKeyChecking=yes,
 *     the pinned known_hosts, HostKeyAlias=<engineId>), key parsing, fingerprints
 *   - computePeerSet / describePeerChanges / peerCopyRefusal (pure)
 *   - ensurePeerKey with the real ssh-keygen; publishPeerAccess
 *   - PeerAccessController with a recording runner: helper called once per change
 *     (idempotence), stale expiry after 7 days without heartbeat, deleted entries,
 *     heartbeat repair of a missing peerAccess, key-change logging, debounced store
 *     changes, helper failure retried, fail-closed and off
 *   - StoreIdentity: the store-url.restored marker that makes peer access fail closed
 *   - a two-engine store simulation: two Repos, each Engine with its own sandboxed
 *     root helper writing real authorized_keys/known_hosts files, merged both ways
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { next as A } from '@automerge/automerge'
import { fs, path, $ } from 'zx'
import os from 'os'
import type { Store } from '../../src/data/Store.js'
import {
    computePeerSet, peerSetInput, describePeerChanges, peerCopyRefusal, authorizedEntry,
    ensurePeerKey, readHostKey, publishPeerAccess, PeerAccessController, startPeerAccess,
    peerAccessProblem, setPeerAccessProblem, PEER_STALE_MS, PEER_SET_MAX, PeerLine,
} from '../../src/data/PeerAccess.js'
import {
    peerSshOptions, peerRsyncShell, peerSshArgv, peerTarget, checkEngineId, normaliseEd25519, keyFingerprint,
    PEER_KEY_PATH, PEER_KNOWN_HOSTS, PEER_GATE, PEER_AUTHORIZED_KEYS,
} from '../../src/utils/peerSsh.js'
import { prepareStoreIdentity, restoredMarkerPath, FLEET_STORE_URL } from '../../src/data/StoreIdentity.js'
import { makeAppDataSandbox, AppDataSandbox, HELPER_SOURCE } from '../harness/appDataSandbox.js'
import { rsyncToPeerArgs } from '../../src/utils/rsync.js'
import { receiveAppArgs, receiveFilesArgs, receiveServiceArgs } from '../../src/utils/appDataHelper.js'
import { peerAccessEnabled, peerStaleMs, PEER_STALE_HOURS_DEFAULT } from '../../src/data/Config.js'
import { testKey } from '../harness/peerKeys.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0)

let tmp: string
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-access-')); setPeerAccessProblem(null) })
afterEach(async () => { await fs.remove(tmp) })

const pa = (seed: string, authorized: string[] = []) => ({ sshKey: testKey(`${seed}-ssh`), hostKey: testKey(`${seed}-host`), publishedAt: T0, authorized })
const eng = (id: string, extra: Record<string, unknown> = {}) => ({ id, hostname: id.toLowerCase().replace('engine_', 'idea-'), lastRun: T0, ...extra })
const store = (engines: Record<string, any>): Store => ({ engineDB: engines, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
const newHandle = (engines: Record<string, any>): DocHandle<Store> => new Repo({ network: [], storage: undefined }).create<Store>(store(engines))

// ── peerSsh ──────────────────────────────────────────────────────────────────

describe('peerSsh: one ssh-options builder for every peer call', () => {
    it('pins the key, the known_hosts file and the host key alias (= the peer Engine id)', () => {
        expect(peerSshOptions('ENGINE_a1')).toEqual([
            '-i', '/home/pi/.ssh/idea_engine_ed25519',
            '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=/etc/idea/peer_known_hosts', '-o', 'HostKeyAlias=ENGINE_a1', '-o', 'ConnectTimeout=10',
        ])
        expect(peerRsyncShell('ENGINE_a1')).toBe(`ssh ${peerSshOptions('ENGINE_a1').join(' ')}`)
        expect(peerSshOptions('x').join(' ')).not.toMatch(/StrictHostKeyChecking=no|accept-new|UserKnownHostsFile=\/dev\/null/)
    })

    it('refuses ids, hosts and remote words that are not plain tokens', () => {
        for (const id of ['', 'ENGINE a', '-oProxyCommand=x', 'a,b', 'a*', 'ENGINE_a\n']) expect(() => checkEngineId(id)).toThrow(/not an Engine id/)
        for (const h of ['', '-oProxyCommand=x', 'a..b', 'host name', 'pi@host', 'h;id']) expect(() => peerTarget(h)).toThrow(/not a peer address/)
        expect(peerSshArgv('10.0.0.2', 'ENGINE_b', ['sudo', '-n', '/usr/local/sbin/idea-app-data', 'version']))
            .toEqual(['ssh', ...peerSshOptions('ENGINE_b'), 'pi@10.0.0.2', '--', 'sudo -n /usr/local/sbin/idea-app-data version'])
        for (const w of ['a;b', '$(id)', 'a b', "'", '', '`id`', 'a|b']) expect(() => peerSshArgv('10.0.0.2', 'ENGINE_b', ['sudo', w])).toThrow(/unsafe word/)
    })

    it('the helper and the gate use the same paths, and the helper send uses the same options', async () => {
        const helper = await fs.readFile(HELPER_SOURCE, 'utf8')
        expect(helper).toMatch(new RegExp(`^PEER_KEY=${PEER_KEY_PATH}$`, 'm'))
        expect(helper).toMatch(new RegExp(`^PEER_KNOWN_HOSTS=${PEER_KNOWN_HOSTS}$`, 'm'))
        expect(helper).toMatch(new RegExp(`^PEER_GATE=${PEER_GATE}$`, 'm'))
        expect(helper).toMatch(new RegExp(`^PEER_AUTH_DIR=${path.dirname(PEER_AUTHORIZED_KEYS)}$`, 'm'))
        expect(helper).toContain('$SSH -i $PEER_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$PEER_KNOWN_HOSTS -o HostKeyAlias=$5 -o ConnectTimeout=10')
        expect(['ssh', ...peerSshOptions('X')].join(' ').replace(PEER_KEY_PATH, '$PEER_KEY').replace(PEER_KNOWN_HOSTS, '$PEER_KNOWN_HOSTS').replace('HostKeyAlias=X', 'HostKeyAlias=$5'))
            .toBe('ssh -i $PEER_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$PEER_KNOWN_HOSTS -o HostKeyAlias=$5 -o ConnectTimeout=10')
    })

    it('rsyncToPeerArgs: rsync as pi with the peer options as -e, the peer helper call as --rsync-path, target pi@host:.', () => {
        const peer = { host: '10.0.0.4', engineId: 'ENGINE_d4' }
        expect(rsyncToPeerArgs('/apps/kolibri-1.0/', peer, receiveAppArgs('sdb1', 'kolibri-1.0'))).toEqual([
            '-a', '--info=progress2', '--no-inc-recursive',
            '-e', `ssh ${peerSshOptions('ENGINE_d4').join(' ')}`,
            '--rsync-path=sudo -n /usr/local/sbin/idea-app-data receive-app sdb1 kolibri-1.0',
            '--', '/apps/kolibri-1.0/', 'pi@10.0.0.4:.',
        ])
        expect(rsyncToPeerArgs(['/tmp/idea-copy-x/compose.yaml', '/tmp/idea-copy-x/.env'], peer, receiveFilesArgs('system', 'new1')).slice(-4))
            .toEqual(['--rsync-path=sudo -n /usr/local/sbin/idea-app-data receive-files system new1', '--', '/tmp/idea-copy-x/compose.yaml', '/tmp/idea-copy-x/.env', 'pi@10.0.0.4:.'].slice(-4))
        expect(rsyncToPeerArgs('/services/x.tar', peer, receiveServiceArgs('sdb1'))).toContain('--rsync-path=sudo -n /usr/local/sbin/idea-app-data receive-service sdb1')
        expect(() => rsyncToPeerArgs('/x/', { host: '-oProxyCommand=x', engineId: 'ENGINE_d4' }, receiveServiceArgs('sdb1'))).toThrow(/not a peer address/)
        expect(() => rsyncToPeerArgs('/x/', { host: '10.0.0.4', engineId: 'ENGINE d4' }, receiveServiceArgs('sdb1'))).toThrow(/not an Engine id/)
    })

    it('config: off in test mode by default; 7 days stale threshold unless settings.peerStaleHours says otherwise', () => {
        expect(peerAccessEnabled()).toBe(false)
        expect(PEER_STALE_HOURS_DEFAULT * 60 * 60 * 1000).toBe(PEER_STALE_MS)
        expect(peerStaleMs()).toBe(PEER_STALE_MS)
    })

    it('no plain ssh/rsync -e/StrictHostKeyChecking=no left in the cross-Engine code paths', async () => {
        for (const f of ['src/data/CopyMoveApp.ts', 'src/utils/rsync.ts', 'src/utils/appDataHelper.ts']) {
            const text = await fs.readFile(path.resolve(f), 'utf8')
            expect(text, f).not.toMatch(/StrictHostKeyChecking=no|\$`ssh |'ssh', `pi@|rsync -a -e/)
        }
    })

    it('normaliseEd25519 accepts exactly one well-formed ed25519 public key; keyFingerprint matches ssh-keygen -l', async () => {
        const k = testKey('n')
        expect(normaliseEd25519(`${k} some comment`)).toBe(k)
        expect(normaliseEd25519(`  ${k}\n`)).toBe(k)
        for (const bad of [undefined, null, '', 'ssh-ed25519', `command="x" ${k}`, k.replace('ssh-ed25519', 'ssh-rsa'),
            k.slice(0, -1), `${k.slice(0, -1)}=`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI' + 'A'.repeat(42) + '!']) {
            expect(normaliseEd25519(bad as any), String(bad)).toBeNull()
        }
        // right prefix, wrong inner length field
        const blob = Buffer.from(k.split(' ')[1], 'base64'); blob.writeUInt32BE(31, 15)
        expect(normaliseEd25519(`ssh-ed25519 ${blob.toString('base64')}`)).toBeNull()

        await $`ssh-keygen -q -t ed25519 -N '' -C test -f ${path.join(tmp, 'k')}`
        const pub = await fs.readFile(path.join(tmp, 'k.pub'), 'utf8')
        const out = (await $`ssh-keygen -l -E sha256 -f ${path.join(tmp, 'k.pub')}`).stdout
        expect(out.split(' ')[1]).toBe(keyFingerprint(pub))
    })
})

// ── pure parts ───────────────────────────────────────────────────────────────

describe('computePeerSet', () => {
    it('every OTHER Engine with a well-formed peerAccess and a heartbeat in the last 7 days, sorted', () => {
        const s = store({
            ENGINE_me: eng('ENGINE_me', { peerAccess: pa('me') }),
            ENGINE_c: eng('ENGINE_c', { peerAccess: pa('c') }),
            ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b'), lastRun: T0 - 7 * DAY + 1000 }),
            ENGINE_old: eng('ENGINE_old'),                                                        // older Engine: silently left out
            ENGINE_off: eng('ENGINE_off', { peerAccess: null }),
        })
        const { peers, skipped } = computePeerSet(s, 'ENGINE_me', T0)
        expect(peers.map(p => p.engineId)).toEqual(['ENGINE_b', 'ENGINE_c'])
        expect(peers[0]).toEqual({ engineId: 'ENGINE_b', sshKey: testKey('b-ssh'), hostKey: testKey('b-host') })
        expect(skipped).toEqual([])
        expect(peerSetInput(peers)).toBe(`ENGINE_b ${testKey('b-ssh')} ${testKey('b-host')}\nENGINE_c ${testKey('c-ssh')} ${testKey('c-host')}\n`)
    })

    it('skips (with a reason) stale, malformed, mismatched, cloned and own-key entries', () => {
        const s = store({
            ENGINE_me: eng('ENGINE_me', { peerAccess: pa('me') }),
            ENGINE_stale: eng('ENGINE_stale', { peerAccess: pa('stale'), lastRun: T0 - 8 * DAY }),
            ENGINE_never: eng('ENGINE_never', { peerAccess: pa('never'), lastRun: undefined }),
            'ENGINE bad': eng('ENGINE bad', { peerAccess: pa('bad') }),
            ENGINE_mis: eng('ENGINE_other', { peerAccess: pa('mis') }),
            ENGINE_key: eng('ENGINE_key', { peerAccess: { ...pa('key'), sshKey: 'ssh-rsa AAAA' } }),
            ENGINE_host: eng('ENGINE_host', { peerAccess: { ...pa('host'), hostKey: `command="x" ${testKey('h')}` } }),
            ENGINE_clone1: eng('ENGINE_clone1', { peerAccess: pa('clone') }),
            ENGINE_clone2: eng('ENGINE_clone2', { peerAccess: pa('clone') }),
            ENGINE_mine: eng('ENGINE_mine', { peerAccess: { ...pa('x'), sshKey: testKey('me-ssh') } }),
            ENGINE_ok: eng('ENGINE_ok', { peerAccess: pa('ok') }),
        })
        const { peers, skipped } = computePeerSet(s, 'ENGINE_me', T0)
        expect(peers.map(p => p.engineId)).toEqual(['ENGINE_ok'])
        const why = Object.fromEntries(skipped.map(x => [x.engineId, x.reason]))
        expect(why.ENGINE_stale).toBe('stale: no heartbeat for 8 days')
        expect(why.ENGINE_never).toBe('stale: no heartbeat recorded')
        expect(why['ENGINE bad']).toMatch(/Engine id is not one the peer files accept/)
        expect(why.ENGINE_mis).toMatch(/id field 'ENGINE_other' differs/)
        expect(why.ENGINE_key).toMatch(/sshKey is not one ed25519 public key/)
        expect(why.ENGINE_host).toMatch(/hostKey is not one ed25519 public key/)
        expect(why.ENGINE_clone1).toMatch(/shares its key with ENGINE_clone2/)
        expect(why.ENGINE_clone2).toMatch(/shares its key with ENGINE_clone1/)
        expect(why.ENGINE_mine).toMatch(/THIS Engine's own key/)
    })

    it('caps at 256 peers (the helper refuses more)', () => {
        const engines: Record<string, any> = {}
        for (let i = 0; i < PEER_SET_MAX + 3; i++) engines[`ENGINE_${String(i).padStart(3, '0')}`] = eng(`ENGINE_${String(i).padStart(3, '0')}`, { peerAccess: pa(`p${i}`) })
        const { peers, skipped } = computePeerSet(store(engines), 'ENGINE_me', T0)
        expect(peers.length).toBe(256)
        expect(skipped.map(s => s.reason)).toEqual(Array(3).fill('more than 256 peers'))
    })
})

describe('describePeerChanges (key-change logging)', () => {
    const p = (id: string, seed = id): PeerLine => ({ engineId: id, sshKey: testKey(`${seed}-ssh`), hostKey: testKey(`${seed}-host`) })
    it('added, ssh key changed, host key changed, removed with the reason', () => {
        const before = [p('ENGINE_a'), p('ENGINE_b'), p('ENGINE_c'), p('ENGINE_d')]
        const after = [p('ENGINE_a'), { ...p('ENGINE_b'), sshKey: testKey('b2') }, { ...p('ENGINE_c'), hostKey: testKey('c2') }, p('ENGINE_e')]
        expect(describePeerChanges(before, after, [{ engineId: 'ENGINE_d', reason: 'stale: no heartbeat for 9 days' }])).toEqual([
            `PEER KEY CHANGED: Engine ENGINE_b ssh key ${keyFingerprint(testKey('ENGINE_b-ssh'))} -> ${keyFingerprint(testKey('b2'))}`,
            `PEER HOST KEY CHANGED: Engine ENGINE_c host key ${keyFingerprint(testKey('ENGINE_c-host'))} -> ${keyFingerprint(testKey('c2'))}`,
            `peer key added: Engine ENGINE_e (key ${keyFingerprint(testKey('ENGINE_e-ssh'))}, host key ${keyFingerprint(testKey('ENGINE_e-host'))})`,
            `peer key removed: Engine ENGINE_d (key ${keyFingerprint(testKey('ENGINE_d-ssh'))}): stale: no heartbeat for 9 days`,
        ])
        expect(describePeerChanges([p('ENGINE_x')], [])).toEqual([`peer key removed: Engine ENGINE_x (key ${keyFingerprint(testKey('ENGINE_x-ssh'))}): its Engine entry or peer key is gone`])
        expect(describePeerChanges(before, before)).toEqual([])
    })
})

describe('peerCopyRefusal (copy validate())', () => {
    const both = () => {
        const a = pa('a'); const b = pa('b')
        a.authorized = [authorizedEntry('ENGINE_b', b)]
        b.authorized = [authorizedEntry('ENGINE_a', a)]
        return { a, b }
    }
    it('null once both sides list each other\'s CURRENT keys', () => {
        const { a, b } = both()
        expect(peerCopyRefusal(store({ ENGINE_a: eng('ENGINE_a', { peerAccess: a }), ENGINE_b: eng('ENGINE_b', { peerAccess: b }) }), 'ENGINE_a', 'ENGINE_b')).toBeNull()
    })
    it('a clear reason for each missing step', () => {
        const { a, b } = both()
        const s = (x: any, y: any) => store({ ENGINE_a: eng('ENGINE_a', { peerAccess: x }), ENGINE_b: eng('ENGINE_b', { peerAccess: y }) })
        expect(peerCopyRefusal(s(a, b), 'ENGINE_a', 'ENGINE_b', 'store-url.txt was missing')).toBe('Cross-Engine copy is off on this Engine: store-url.txt was missing')
        expect(peerCopyRefusal(s(null, b), 'ENGINE_a', 'ENGINE_b')).toMatch(/^This Engine has not published its Engine key yet/)
        expect(peerCopyRefusal(s(a, undefined), 'ENGINE_a', 'ENGINE_b')).toMatch(/^Engine 'idea-b' \(ENGINE_b\) has not published an Engine key \(it runs an older Engine/)
        expect(peerCopyRefusal(store({ ENGINE_a: eng('ENGINE_a', { peerAccess: a }) }), 'ENGINE_a', 'ENGINE_b')).toMatch(/^Engine 'ENGINE_b' has not published an Engine key/)
        expect(peerCopyRefusal(s(a, { ...b, authorized: [] }), 'ENGINE_a', 'ENGINE_b')).toMatch(/^Engine 'idea-b' \(ENGINE_b\) has not accepted this Engine's key yet .* Try again in a minute\.$/)
        // the target still lists our OLD key (we were reimaged): not accepted yet
        expect(peerCopyRefusal(s({ ...a, sshKey: testKey('a-new') }, b), 'ENGINE_a', 'ENGINE_b')).toMatch(/has not accepted this Engine's key yet/)
        expect(peerCopyRefusal(s({ ...a, authorized: [] }, b), 'ENGINE_a', 'ENGINE_b')).toMatch(/^This Engine has not pinned the host key of Engine 'idea-b' \(ENGINE_b\) yet/)
    })
})

// ── key files and publish ────────────────────────────────────────────────────

describe('ensurePeerKey (real ssh-keygen) and readHostKey', () => {
    it('makes an ed25519 key once (0600 in a 0700 folder), then reuses it', async () => {
        const keyPath = path.join(tmp, 'home-pi-ssh', 'idea_engine_ed25519')
        const first = await ensurePeerKey('ENGINE_a', keyPath)
        expect(first.created).toBe(true)
        expect(normaliseEd25519(first.sshKey)).toBe(first.sshKey)
        expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(path.dirname(keyPath))).mode & 0o777).toBe(0o700)
        expect(await fs.readFile(`${keyPath}.pub`, 'utf8')).toMatch(/ idea-engine-ENGINE_a\n$/)
        const second = await ensurePeerKey('ENGINE_a', keyPath)
        expect(second).toEqual({ sshKey: first.sshKey, created: false })
    })

    it('fixes a too-open key mode and rebuilds a missing or broken .pub from the private key', async () => {
        const keyPath = path.join(tmp, 'k')
        const { sshKey } = await ensurePeerKey('ENGINE_a', keyPath)
        await fs.chmod(keyPath, 0o644)
        await fs.writeFile(`${keyPath}.pub`, 'garbage\n')
        const again = await ensurePeerKey('ENGINE_a', keyPath)
        expect(again).toEqual({ sshKey, created: false })
        expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600)
        expect(normaliseEd25519(await fs.readFile(`${keyPath}.pub`, 'utf8'))).toBe(sshKey)
    })

    it('readHostKey: the ed25519 host key, or null', async () => {
        await fs.writeFile(path.join(tmp, 'host.pub'), `${testKey('h')} root@idea01\n`)
        expect(await readHostKey(path.join(tmp, 'host.pub'))).toBe(testKey('h'))
        expect(await readHostKey(path.join(tmp, 'missing.pub'))).toBeNull()
        await fs.writeFile(path.join(tmp, 'rsa.pub'), 'ssh-rsa AAAAB3Nza root@x\n')
        expect(await readHostKey(path.join(tmp, 'rsa.pub'))).toBeNull()
    })
})

describe('publishPeerAccess', () => {
    it('writes keys, keeps authorized while the keys stay, logs a change of this Engine\'s own keys, clears with null', () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me') })
        const said: string[] = []
        const say = (l: string) => said.push(l)
        const keys = { sshKey: testKey('me-ssh'), hostKey: testKey('me-host') }
        expect(publishPeerAccess(h, 'ENGINE_me', keys, T0, say)).toBe(true)
        expect((h.doc().engineDB as any).ENGINE_me.peerAccess).toEqual({ ...keys, publishedAt: T0, authorized: [] })
        h.change(d => { (d.engineDB as any).ENGINE_me.peerAccess.authorized = ['x'] })
        expect(publishPeerAccess(h, 'ENGINE_me', keys, T0 + 1, say)).toBe(false)
        expect(said).toEqual([])
        expect(publishPeerAccess(h, 'ENGINE_me', { ...keys, sshKey: testKey('me-ssh2') }, T0 + 2, say)).toBe(true)
        expect(publishPeerAccess(h, 'ENGINE_me', { sshKey: testKey('me-ssh2'), hostKey: testKey('me-host2') }, T0 + 3, say)).toBe(true)
        expect(said.join('\n')).toMatch(/THIS Engine's key changed: SHA256:\S+ -> SHA256:\S+/)
        expect(said.join('\n')).toMatch(/THIS Engine's ssh host key changed/)
        expect((h.doc().engineDB as any).ENGINE_me.peerAccess.authorized).toEqual(['x'])
        expect(publishPeerAccess(h, 'ENGINE_me', null)).toBe(true)
        expect((h.doc().engineDB as any).ENGINE_me.peerAccess).toBeNull()
        expect(publishPeerAccess(h, 'ENGINE_me', null)).toBe(false)
        expect(publishPeerAccess(h, 'ENGINE_gone', keys)).toBe(false)
    })
})

// ── the controller ───────────────────────────────────────────────────────────

const recorder = () => {
    const calls: { args: string[], input: string }[] = []
    let fail: string | null = null
    const run = async (args: string[], input: string) => {
        calls.push({ args, input })
        if (fail) throw new Error(fail)
        return `sync-peers: ${input.split('\n').filter(Boolean).length} peer(s); authorized_keys updated; known_hosts updated`
    }
    return { calls, run, setFail: (f: string | null) => { fail = f } }
}

describe('PeerAccessController', () => {
    let clock: number
    let said: string[]
    let rec: ReturnType<typeof recorder>
    let hostKeyPath: string
    let keyPath: string
    const make = (h: DocHandle<Store>, mode: 'on' | 'fail-closed' | 'off' = 'on', extra: Record<string, unknown> = {}) =>
        new PeerAccessController(h, 'ENGINE_me', { mode, run: rec.run, now: () => clock, keyPath, hostKeyPath, debounceMs: 20, logger: l => said.push(l), ...extra })
    const me = (h: DocHandle<Store>) => (h.doc().engineDB as any).ENGINE_me
    const text = () => said.join('\n')

    beforeEach(async () => {
        clock = T0; said = []; rec = recorder()
        keyPath = path.join(tmp, 'ssh', 'idea_engine_ed25519')
        hostKeyPath = path.join(tmp, 'ssh_host_ed25519_key.pub')
        await fs.writeFile(hostKeyPath, `${testKey('me-host')} root@me\n`)
    })

    it('start: makes and publishes the key, syncs the full set once, lists what it authorized', async () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me'), ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b') }), ENGINE_c: eng('ENGINE_c', { peerAccess: pa('c') }) })
        const c = make(h)
        await c.start()
        c.stop()
        const mine = me(h).peerAccess
        expect(normaliseEd25519(mine.sshKey)).toBe(mine.sshKey)
        expect(mine.hostKey).toBe(testKey('me-host'))
        expect(mine.publishedAt).toBe(T0)
        expect(rec.calls).toEqual([{ args: ['sync-peers'], input: `ENGINE_b ${testKey('b-ssh')} ${testKey('b-host')}\nENGINE_c ${testKey('c-ssh')} ${testKey('c-host')}\n` }])
        expect([...mine.authorized]).toEqual([authorizedEntry('ENGINE_b', pa('b')), authorizedEntry('ENGINE_c', pa('c'))])
        expect(text()).toMatch(/peer access: published this Engine's key SHA256:/)
        expect(text()).toMatch(/peer key added: Engine ENGINE_b/)
        expect(peerAccessProblem()).toBeNull()
    })

    it('idempotent: an unchanged set never calls the helper again (heartbeats, unrelated changes)', async () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me'), ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b') }) })
        const c = make(h)
        await c.start()
        for (let i = 0; i < 5; i++) {
            clock += 50_000
            h.change(d => { (d.engineDB as any).ENGINE_b.lastRun = clock; (d.engineDB as any).ENGINE_me.lastRun = clock })
            await c.onHeartbeat()
        }
        await new Promise(r => setTimeout(r, 80))   // the debounced sync of those changes
        await c.syncNow()
        c.stop()
        expect(rec.calls.length).toBe(1)
    })

    it('stale expiry: a peer without a heartbeat for 7 days is removed at the next heartbeat; it comes back when it beats again', async () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me'), ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b') }), ENGINE_c: eng('ENGINE_c', { peerAccess: pa('c') }) })
        const c = make(h)
        await c.start()
        c.stop()   // no store-change syncs: only the heartbeat here
        clock = T0 + PEER_STALE_MS - 1000
        h.change(d => { (d.engineDB as any).ENGINE_c.lastRun = clock })
        await c.onHeartbeat()
        expect(rec.calls.length).toBe(1)
        clock = T0 + PEER_STALE_MS + 1000
        await c.onHeartbeat()
        expect(rec.calls.length).toBe(2)
        expect(rec.calls[1].input).toBe(`ENGINE_c ${testKey('c-ssh')} ${testKey('c-host')}\n`)
        expect(text()).toMatch(/peer key removed: Engine ENGINE_b \(key SHA256:\S+\): stale: no heartbeat for 7 days/)
        expect([...me(h).peerAccess.authorized]).toEqual([authorizedEntry('ENGINE_c', pa('c'))])
        await c.onHeartbeat()
        expect(rec.calls.length).toBe(2)   // still idempotent
        h.change(d => { (d.engineDB as any).ENGINE_b.lastRun = clock })
        await c.onHeartbeat()
        expect(rec.calls.length).toBe(3)
        expect(rec.calls[2].input.split('\n').filter(Boolean).length).toBe(2)
    })

    it('a deleted Engine entry drops out (store change, debounced); the set going to 0 is logged', async () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me'), ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b') }) })
        const c = make(h)
        await c.start()
        h.change(d => { delete (d.engineDB as any).ENGINE_b })
        await new Promise(r => setTimeout(r, 100))
        await c.syncNow()
        c.stop()
        expect(rec.calls.map(x => x.input)).toEqual([`ENGINE_b ${testKey('b-ssh')} ${testKey('b-host')}\n`, ''])
        expect(text()).toMatch(/peer key removed: Engine ENGINE_b .*its Engine entry or peer key is gone/)
        expect(text()).toMatch(/the peer set went from 1 to 0/)
        expect([...me(h).peerAccess.authorized]).toEqual([])
    })

    it('a peer key or host key change is synced and logged loudly', async () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me'), ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b') }) })
        const c = make(h)
        await c.start()
        c.stop()
        h.change(d => { (d.engineDB as any).ENGINE_b.peerAccess.sshKey = testKey('b-new'); (d.engineDB as any).ENGINE_b.peerAccess.hostKey = testKey('b-host-new') })
        await c.syncNow()
        expect(rec.calls.length).toBe(2)
        expect(text()).toMatch(/PEER KEY CHANGED: Engine ENGINE_b ssh key SHA256:\S+ -> SHA256:\S+/)
        expect(text()).toMatch(/PEER HOST KEY CHANGED: Engine ENGINE_b host key/)
    })

    it('heartbeat repair: a missing peerAccess (store reset, entry re-created) is re-published', async () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me'), ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b') }) })
        const c = make(h)
        await c.start()
        c.stop()
        const key = me(h).peerAccess.sshKey
        h.change(d => { (d.engineDB as any).ENGINE_me = eng('ENGINE_me') })   // what createOrUpdateEngine makes after a reset
        clock += 50_000
        await c.onHeartbeat()
        expect(me(h).peerAccess.sshKey).toBe(key)
        expect(me(h).peerAccess.publishedAt).toBe(clock)
        expect([...me(h).peerAccess.authorized]).toEqual([authorizedEntry('ENGINE_b', pa('b'))])
        expect(text()).toMatch(/peerAccess was missing from the store; re-published/)
        expect(rec.calls.length).toBe(1)   // the peer set itself did not change
    })

    it('helper failure: logged, authorized not updated, retried on the next heartbeat', async () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me'), ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b') }) })
        rec.setFail('idea-app-data sync-peers exited with code 1: sudo: a password is required')
        const c = make(h)
        await c.start()
        c.stop()
        expect(text()).toMatch(/idea-app-data sync-peers failed \(1 peer\(s\)\); retrying/)
        expect([...me(h).peerAccess.authorized]).toEqual([])
        rec.setFail(null)
        await c.onHeartbeat()
        expect(rec.calls.length).toBe(2)
        expect([...me(h).peerAccess.authorized]).toEqual([authorizedEntry('ENGINE_b', pa('b'))])
    })

    it('no host key: publishes nothing (peerAccess null) and says why', async () => {
        await fs.remove(hostKeyPath)
        const h = newHandle({ ENGINE_me: eng('ENGINE_me', { peerAccess: pa('me') }) })
        const c = make(h)
        await c.start()
        c.stop()
        expect(me(h).peerAccess).toBeNull()
        expect(peerAccessProblem()).toMatch(/no readable ed25519 ssh host key/)
    })

    it('fail-closed: removes this Engine\'s key from the store, authorizes nobody, keeps it that way on heartbeats', async () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me', { peerAccess: pa('me') }), ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b') }) })
        const c = make(h, 'fail-closed', { reason: 'store-url.txt was missing' })
        await c.start()
        expect(me(h).peerAccess).toBeNull()
        expect(rec.calls).toEqual([{ args: ['sync-peers'], input: '' }])
        expect(text()).toMatch(/PEER ACCESS FAIL-CLOSED: store-url.txt was missing\. This Engine publishes no Engine key and authorizes no peer\./)
        expect(peerAccessProblem()).toBe('store-url.txt was missing')
        expect(await fs.pathExists(keyPath)).toBe(false)
        h.change(d => { (d.engineDB as any).ENGINE_me.peerAccess = pa('me') })
        await c.onHeartbeat()
        expect(me(h).peerAccess).toBeNull()
        expect(rec.calls.length).toBe(1)
    })

    it('off (dev/test, or settings.peerAccess=false): no key, no publish, no helper call', async () => {
        const h = newHandle({ ENGINE_me: eng('ENGINE_me'), ENGINE_b: eng('ENGINE_b', { peerAccess: pa('b') }) })
        const c = await startPeerAccess(h, 'ENGINE_me', { enabled: false, fallbackStore: true })
        await c.onHeartbeat()
        expect(c.mode).toBe('off')
        expect(me(h).peerAccess).toBeUndefined()
        expect(peerAccessProblem()).toMatch(/peer access is off on this machine/)
    })
})

// ── store identity: the fail-closed marker ───────────────────────────────────

describe('StoreIdentity: store-url.restored (fail closed)', () => {
    it('a restored store-url.txt sets fallback until Ops deletes the marker; a changed URL drops the marker', async () => {
        const dir = path.join(tmp, 'store-identity')
        await fs.ensureDir(dir)
        await fs.writeFile(path.join(dir, 'store-template.json'), '{}')
        const paths = { identityDir: dir, templatePath: path.join(dir, 'store-template.json'), urlPath: path.join(dir, 'store-url.txt') } as any
        const first = await prepareStoreIdentity(paths)
        expect(first).toMatchObject({ restored: true, fallback: true })
        expect(await fs.readFile(restoredMarkerPath(paths), 'utf8')).toBe(FLEET_STORE_URL + '\n')
        expect(await prepareStoreIdentity(paths)).toMatchObject({ restored: false, fallback: true })
        await fs.remove(restoredMarkerPath(paths))
        expect(await prepareStoreIdentity(paths)).toMatchObject({ restored: false, fallback: false })
        await fs.writeFile(paths.urlPath, FLEET_STORE_URL)
        await fs.writeFile(restoredMarkerPath(paths), FLEET_STORE_URL + '\n')
        await fs.writeFile(paths.urlPath, 'automerge:2Own1StoreUrlForIdea03xxxxxxxx')
        expect(await prepareStoreIdentity(paths)).toMatchObject({ restored: false, fallback: false })
        expect(await fs.pathExists(restoredMarkerPath(paths))).toBe(false)
    })
})

// ── two Engines, two stores, real helpers ────────────────────────────────────

describe('two-engine store simulation (per-Pi keys exchanged through the store)', () => {
    let sbA: AppDataSandbox
    let sbB: AppDataSandbox
    beforeEach(async () => { sbA = await makeAppDataSandbox(); sbB = await makeAppDataSandbox() })
    afterEach(async () => { await fs.remove(sbA.tmp); await fs.remove(sbB.tmp) })

    const helperRunner = (sb: AppDataSandbox) => async (args: string[], input: string) => {
        const r = await sb.run(args, { FAKE_STDIN: input })
        if (r.exitCode !== 0) throw new Error(`idea-app-data ${args[0]} exited with code ${r.exitCode}: ${r.stderr.trim()}`)
        return r.stdout
    }
    const authIds = async (sb: AppDataSandbox) => (await fs.pathExists(sb.peerAuthFile))
        ? (await fs.readFile(sb.peerAuthFile, 'utf8')).split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(' ').at(-1)!.replace('idea-peer:', ''))
        : []
    const authLine = async (sb: AppDataSandbox, id: string) => (await fs.readFile(sb.peerAuthFile, 'utf8')).split('\n').find(l => l.endsWith(`idea-peer:${id}`))
    const known = async (sb: AppDataSandbox) => (await fs.readFile(sb.peerKnownHosts, 'utf8')).split('\n').filter(l => l && !l.startsWith('#'))

    it('A and B each authorize exactly the other, pin its host key, and both see the copy as allowed', async () => {
        let clock = T0
        const said: string[] = []
        const hA = new Repo({ network: [], storage: undefined }).create<Store>(store({}))
        const hB = new Repo({ network: [], storage: undefined }).import<Store>(A.save(hA.doc()))
        hA.change(d => { (d.engineDB as any).ENGINE_a = eng('ENGINE_a') })
        hB.change(d => { (d.engineDB as any).ENGINE_b = eng('ENGINE_b') })
        await fs.writeFile(path.join(sbA.tmp, 'host.pub'), `${testKey('a-host')} root@idea-a\n`)
        await fs.writeFile(path.join(sbB.tmp, 'host.pub'), `${testKey('b-host')} root@idea-b\n`)
        const ctl = (h: DocHandle<Store>, id: string, sb: AppDataSandbox) => new PeerAccessController(h, id, {
            mode: 'on', run: helperRunner(sb), now: () => clock, debounceMs: 10,
            keyPath: path.join(sb.tmp, 'pi-ssh', 'idea_engine_ed25519'), hostKeyPath: path.join(sb.tmp, 'host.pub'),
            logger: l => said.push(`${id}: ${l}`),
        })
        const a = ctl(hA, 'ENGINE_a', sbA)
        const b = ctl(hB, 'ENGINE_b', sbB)
        await a.start(); await b.start()
        expect(await authIds(sbA)).toEqual([])
        expect(peerCopyRefusal(hA.doc(), 'ENGINE_a', 'ENGINE_b')).toMatch(/^Engine 'ENGINE_b' has not published an Engine key/)

        // B's entry reaches A; A authorizes B, but B has not seen A yet
        hA.merge(hB)
        await a.syncNow()
        expect(await authIds(sbA)).toEqual(['ENGINE_b'])
        expect(peerCopyRefusal(hA.doc(), 'ENGINE_a', 'ENGINE_b')).toMatch(/has not accepted this Engine's key yet/)

        // A's entry (and what it authorized) reaches B; B authorizes A; back to A
        hB.merge(hA)
        await b.syncNow()
        hA.merge(hB)
        await a.syncNow()
        await new Promise(r => setTimeout(r, 50))
        await a.syncNow(); await b.syncNow()
        a.stop(); b.stop()

        expect(await authIds(sbA)).toEqual(['ENGINE_b'])
        expect(await authIds(sbB)).toEqual(['ENGINE_a'])
        const keyA = await fs.readFile(path.join(sbA.tmp, 'pi-ssh', 'idea_engine_ed25519.pub'), 'utf8')
        const keyB = await fs.readFile(path.join(sbB.tmp, 'pi-ssh', 'idea_engine_ed25519.pub'), 'utf8')
        expect(await authLine(sbB, 'ENGINE_a')).toBe(`restrict,command="/usr/local/sbin/idea-peer-gate ENGINE_a" ${normaliseEd25519(keyA)} idea-peer:ENGINE_a`)
        expect(await authLine(sbA, 'ENGINE_b')).toBe(`restrict,command="/usr/local/sbin/idea-peer-gate ENGINE_b" ${normaliseEd25519(keyB)} idea-peer:ENGINE_b`)
        expect(await known(sbA)).toEqual([`ENGINE_b ${testKey('b-host')}`])
        expect(await known(sbB)).toEqual([`ENGINE_a ${testKey('a-host')}`])
        expect(peerCopyRefusal(hA.doc(), 'ENGINE_a', 'ENGINE_b')).toBeNull()
        expect(peerCopyRefusal(hB.doc(), 'ENGINE_b', 'ENGINE_a')).toBeNull()

        // what A's key may do on B: the gate named in B's file, with A's id
        const v = await sbB.runGate(['ENGINE_a'], 'sudo -n /usr/local/sbin/idea-app-data version')
        expect(v.stdout.trim()).toBe('idea-app-data 3')

        // B is reimaged: new Engine key. A re-authorizes it from the store and logs it loudly
        await fs.remove(path.join(sbB.tmp, 'pi-ssh'))
        const b2 = ctl(hB, 'ENGINE_b', sbB)
        await b2.start(); b2.stop()
        expect(peerCopyRefusal(hB.doc(), 'ENGINE_b', 'ENGINE_a')).toMatch(/Engine 'idea-a' \(ENGINE_a\) has not accepted this Engine's key yet/)
        hA.merge(hB)
        await a.syncNow()
        hB.merge(hA)
        expect(said.join('\n')).toMatch(/ENGINE_a: .*PEER KEY CHANGED: Engine ENGINE_b/)
        expect(said.join('\n')).toMatch(/ENGINE_b: .*THIS Engine's key changed/)
        const keyB2 = await fs.readFile(path.join(sbB.tmp, 'pi-ssh', 'idea_engine_ed25519.pub'), 'utf8')
        expect(await authLine(sbA, 'ENGINE_b')).toContain(normaliseEd25519(keyB2)!)
        expect(peerCopyRefusal(hB.doc(), 'ENGINE_b', 'ENGINE_a')).toBeNull()

        // B goes away for 8 days: A drops its key at a heartbeat
        clock = T0 + 8 * DAY
        hA.change(d => { (d.engineDB as any).ENGINE_a.lastRun = clock })
        await a.onHeartbeat()
        expect(await authIds(sbA)).toEqual([])
        expect(await known(sbA)).toEqual([])
        expect(said.join('\n')).toMatch(/ENGINE_a: peer access: peer key removed: Engine ENGINE_b .*stale: no heartbeat for 8 days/)
    }, 60_000)
})
