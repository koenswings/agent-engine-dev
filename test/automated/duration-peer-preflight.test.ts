/**
 * idea#168 — per-Pi peer-key preflight (exit 9) for walks with cross-Engine copy steps.
 *
 * Pair derivation runs on the real walk files; the verdict is checked against canned store
 * views (Engine.peerAccess as Engine feat/app-data-root-helper publishes it) and host probes;
 * the read-only probe script runs as real bash on the box; RealFleetOps.probePeerHost runs
 * against a canned ssh.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { loadWalk } from '../duration/scenario.js'
import {
    CROSS_ENGINE_COPY_ACTIONS,
    EXIT_PEER_PREFLIGHT,
    HOST_KEY_PUB,
    MIN_PEER_HELPER_VERSION,
    PEER_AUTHORIZED_KEYS,
    PEER_KEY_PUB,
    PEER_KNOWN_HOSTS,
    PEER_SKIP_NO_COPY,
    authorizedEntry,
    buildPeerProbeRemote,
    deriveCopyPairs,
    keyFingerprint,
    normaliseEd25519,
    parsePeerProbe,
    peerPreflightVerdict,
    requiredHelperVersion,
    type CopyPairPlan,
    type PeerHostProbe,
    type PeerStoreView,
} from '../duration/peerPreflight.js'
import { EXIT_CONSOLE_PIN_MISMATCH } from '../duration/consoleDeploy.js'
import { EXIT_STORE_PREFLIGHT } from '../duration/storePreflight.js'
import { EXIT_SLOT_PREFLIGHT, parseSlotLayoutProbe, requiredSlotNames, slotLayoutVerdict } from '../duration/slotLayout.js'
import { EXIT_FIXTURE_PREFLIGHT } from '../duration/fixtureDisks.js'
import { RealFleetOps } from '../duration/realFleetOps.js'

/** A well-formed ed25519 public key line, stable per seed (same shape as Engine test/harness/peerKeys.ts). */
const testKey = (seed: string): string => {
    const head = Buffer.alloc(4); head.writeUInt32BE(11)
    const len = Buffer.alloc(4); len.writeUInt32BE(32)
    const key = crypto.createHash('sha256').update(seed).digest()
    return `ssh-ed25519 ${Buffer.concat([head, Buffer.from('ssh-ed25519', 'latin1'), len, key]).toString('base64')}`
}

const POOL = ['idea01', 'idea03', 'idea04']
const HOSTS = { idea01: '100.99.231.94', idea03: '100.126.117.80', idea04: '100.108.39.45' }
/** Live engineDB keys differ from the logical pool ids (as on the fleet). */
const LIVE: Record<string, string> = { idea01: 'eng-a01', idea03: 'eng-a03', idea04: 'eng-a04' }
const keysOf = (e: string, gen = '') => ({ sshKey: testKey(`${e}-ssh${gen}`), hostKey: testKey(`${e}-host${gen}`) })

const coverAll = loadWalk('cover-all')
const skipCopy = loadWalk('cover-all-skip-copy')
const planOf = (steps = coverAll.steps, startIndex = 0, endIndex?: number, pool = POOL, exclude = ['idea02']): CopyPairPlan =>
    deriveCopyPairs({ steps, startIndex, endIndex, poolEngines: pool, excludeEngines: exclude })

/** Every pool Engine published and lists every other pool Engine with its current keys. */
const exchangedStore = (): PeerStoreView => {
    const engines: PeerStoreView['engines'] = {}
    for (const e of POOL) {
        engines[LIVE[e]!] = {
            liveId: LIVE[e]!, hostname: `${e}.local`, lastRun: 1,
            peerAccess: {
                ...keysOf(e), publishedAt: 1,
                authorized: POOL.filter(o => o !== e).map(o => authorizedEntry(LIVE[o]!, keysOf(o))).sort(),
            },
        }
    }
    return { via: 'idea01', engines, liveIdOf: { ...LIVE } }
}
const row = (s: PeerStoreView, e: string) => s.engines[LIVE[e]!]!.peerAccess as { sshKey: string; hostKey: string; authorized: string[] }

/** A host probe that agrees with exchangedStore(). */
const goodProbe = (e: string, over: Partial<PeerHostProbe> = {}): PeerHostProbe => {
    const peers = POOL.filter(o => o !== e)
    return {
        helper: 'present', versionRc: 0, versionOut: 'idea-app-data 2',
        authorizedKeys: { state: 'file', lines: peers.map(o => `restrict,command="/usr/local/sbin/idea-peer-gate ${LIVE[o]}" ${keysOf(o).sshKey} idea-peer:${LIVE[o]}`) },
        knownHosts: { state: 'file', lines: peers.map(o => `${LIVE[o]} ${keysOf(o).hostKey}`) },
        ownKeyPub: { state: 'file', lines: [`${keysOf(e).sshKey} idea-engine-${LIVE[e]}`] },
        hostKeyPub: { state: 'file', lines: [`${keysOf(e).hostKey} root@${e}`] },
        ...over,
    }
}
const goodProbes = (): Record<string, PeerHostProbe | Error> => Object.fromEntries(POOL.map(e => [e, goodProbe(e)]))

const verdict = (store = exchangedStore(), probes: Record<string, PeerHostProbe | Error> | undefined = goodProbes(), plan = planOf()) =>
    peerPreflightVerdict({ plan, store, hosts: HOSTS, probes })

describe('peer preflight: copy steps and engine pairs derived from the walk', () => {
    it('cover-all: copy_app@43 and @116 → every pool pair (never idea02), each needing both steps', () => {
        const p = planOf()
        // derived, not hard-coded: exactly the walk steps whose action is a cross-Engine copy action
        const expected = coverAll.steps.flatMap((s, i) => (CROSS_ENGINE_COPY_ACTIONS.includes(s.action) ? [{ step: i + 1, action: s.action }] : []))
        expect(p.copySteps).toEqual(expected)
        expect(p.copySteps).toEqual([{ step: 43, action: 'copy_app' }, { step: 116, action: 'copy_app' }])
        expect(p.engines).toEqual(['idea01', 'idea03', 'idea04'])
        expect(p.pairs).toEqual([
            { a: 'idea01', b: 'idea03', steps: [43, 116] },
            { a: 'idea01', b: 'idea04', steps: [43, 116] },
            { a: 'idea03', b: 'idea04', steps: [43, 116] },
        ])
        expect(p.fromStep).toBe(1)
        expect(requiredHelperVersion(p)).toBe(2)
    })

    it('cover-all-skip-copy: no copy step → no pair, helper floor stays 1, verdict skipped with the exact log line', () => {
        const p = planOf(skipCopy.steps)
        expect(p.copySteps).toEqual([])
        expect(p.pairs).toEqual([])
        expect(requiredHelperVersion(p)).toBe(1)
        // the shake-out mapping agrees: the copy steps it drops are cover-all's copy steps
        expect(skipCopy.shakeOut!.notCovered.filter(n => n.action === 'copy_app').map(n => n.step)).toEqual(planOf().copySteps.map(s => s.step))
        const v = peerPreflightVerdict({ plan: p, store: { via: 'idea01', engines: {}, liveIdOf: {} } })
        expect(v).toMatchObject({ ok: true, skipped: true, problems: [] })
        expect(v.message).toBe(PEER_SKIP_NO_COPY)
        expect(PEER_SKIP_NO_COPY).toBe('peer preflight skipped: no cross-engine copy steps')
    })

    it('--start-from N: only copy steps at or after N; --iterations truncation too', () => {
        expect(planOf(coverAll.steps, 42).copySteps.map(s => s.step)).toEqual([43, 116]) // --start-from 43
        expect(planOf(coverAll.steps, 43).copySteps.map(s => s.step)).toEqual([116]) // --start-from 44
        expect(planOf(coverAll.steps, 43).pairs.map(x => x.steps)).toEqual([[116], [116], [116]])
        expect(planOf(coverAll.steps, 43).fromStep).toBe(44)
        expect(planOf(coverAll.steps, 116).pairs).toEqual([]) // --start-from 117
        expect(planOf(coverAll.steps, 0, 100).copySteps.map(s => s.step)).toEqual([43]) // --iterations 100
    })

    it('pool edge cases: idea02 never joins a pair; a one-engine pool has copy steps but no pair (same-Pi only)', () => {
        expect(planOf(coverAll.steps, 0, undefined, ['idea01', 'idea02', 'idea03'], []).pairs.map(p => `${p.a}↔${p.b}`)).toEqual(['idea01↔idea03'])
        const one = planOf(coverAll.steps, 0, undefined, ['idea01'])
        expect(one.copySteps.length).toBe(2)
        expect(one.pairs).toEqual([])
        expect(requiredHelperVersion(one)).toBe(1)
        expect(peerPreflightVerdict({ plan: one, store: exchangedStore() }).message).toMatch(/^peer preflight skipped: copy_app@43, copy_app@116 but fewer than two pool engines/)
    })

    it('exit code 9 is new; existing preflight exit codes unchanged', () => {
        expect([EXIT_CONSOLE_PIN_MISMATCH, EXIT_STORE_PREFLIGHT, EXIT_SLOT_PREFLIGHT, EXIT_FIXTURE_PREFLIGHT, EXIT_PEER_PREFLIGHT]).toEqual([5, 6, 7, 8, 9])
        expect(MIN_PEER_HELPER_VERSION).toBe(2)
    })
})

describe('peer preflight verdict', () => {
    it('ok: keys published and mutually accepted for every pair, helper v2, peer files agree', () => {
        const v = verdict()
        expect(v.problems).toEqual([])
        expect(v.notes).toEqual([])
        expect(v.ok).toBe(true)
        expect(v.pairs.map(r => `${r.a}↔${r.b}:${r.aAcceptsB}/${r.bAcceptsA}:${r.ok}`)).toEqual(['idea01↔idea03:true/true:true', 'idea01↔idea04:true/true:true', 'idea03↔idea04:true/true:true'])
        expect(v.message).toBe(
            'peer preflight OK (copy_app@43, copy_app@116; from step 1): keys published and mutually accepted for ' +
            'idea01(100.99.231.94)↔idea03(100.126.117.80) @43,@116; idea01(100.99.231.94)↔idea04(100.108.39.45) @43,@116; ' +
            'idea03(100.126.117.80)↔idea04(100.108.39.45) @43,@116',
        )
    })

    it('the authorized entry format is the Engine\'s: "<engineId> SHA256:<key fp> SHA256:<hostkey fp>" (OpenSSH fingerprint)', () => {
        const k = keysOf('idea03')
        const fp = (line: string) => `SHA256:${crypto.createHash('sha256').update(Buffer.from(line.split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/, '')}`
        expect(authorizedEntry('eng-a03', k)).toBe(`eng-a03 ${fp(k.sshKey)} ${fp(k.hostKey)}`)
        expect(keyFingerprint(`${k.sshKey} some comment`)).toBe(fp(k.sshKey))
        expect(normaliseEd25519('ssh-rsa AAAA')).toBeNull()
    })

    it('unpublished: peerAccess null / absent / malformed / no Engine entry → FAIL naming the engine', () => {
        const s = exchangedStore()
        s.engines[LIVE.idea04!]!.peerAccess = null
        const v = verdict(s)
        expect(v.ok).toBe(false)
        expect(v.problems.filter(p => p.kind === 'unpublished')).toEqual([{
            kind: 'unpublished', subject: 'idea04',
            message: 'idea04 (100.108.39.45) (Engine eng-a04) has not published peerAccess (older Engine, peer access off, or fail-closed store) — cross-Engine copies to/from it are refused',
        }])
        expect(v.pairs.map(r => `${r.a}↔${r.b}:${r.ok}`)).toEqual(['idea01↔idea03:true', 'idea01↔idea04:false', 'idea03↔idea04:false'])

        const s2 = exchangedStore()
        row(s2, 'idea03').hostKey = 'ssh-ed25519 notakey'
        expect(verdict(s2).problems[0]).toMatchObject({ kind: 'unpublished', subject: 'idea03', message: expect.stringMatching(/malformed peerAccess \(sshKey ok, hostKey not one ed25519 key\)/) })

        const s3 = exchangedStore()
        s3.liveIdOf.idea03 = null
        expect(verdict(s3).problems[0]).toMatchObject({ kind: 'unpublished', subject: 'idea03', message: 'idea03 (100.126.117.80) has no Engine entry in the store read through idea01 — nothing published' })
    })

    it('one-sided: B lists A but A does not list B → FAIL naming the pair; neither side → not-exchanged', () => {
        const s = exchangedStore()
        row(s, 'idea01').authorized = row(s, 'idea01').authorized.filter(x => !x.startsWith('eng-a03 '))
        const v = verdict(s)
        expect(v.ok).toBe(false)
        expect(v.problems).toEqual([{
            kind: 'one-sided', subject: 'idea01↔idea03',
            message: 'idea01↔idea03 (@43,@116): one-sided — idea03 (100.126.117.80) lists idea01 but idea01 (100.99.231.94) does not list idea03 in peerAccess.authorized ' +
                '(idea01 neither accepts idea03\'s key nor pins its host key — the Engine refuses copies between them both ways)',
        }])
        expect(v.pairs.find(r => r.b === 'idea03' && r.a === 'idea01')).toMatchObject({ aAcceptsB: false, bAcceptsA: true, ok: false })
        expect(v.message).toMatch(/^peer preflight FAILED \(copy_app@43, copy_app@116; from step 1\): \[one-sided\] idea01↔idea03/)

        const s2 = exchangedStore()
        row(s2, 'idea03').authorized = row(s2, 'idea03').authorized.filter(x => !x.startsWith('eng-a04 '))
        row(s2, 'idea04').authorized = row(s2, 'idea04').authorized.filter(x => !x.startsWith('eng-a03 '))
        expect(verdict(s2).problems.map(p => `${p.kind} ${p.subject}`)).toEqual(['not-exchanged idea03↔idea04'])
    })

    it('fingerprint mismatch: A lists B with B\'s old key / host key (reimage) → FAIL quoting both fingerprints', () => {
        const s = exchangedStore()
        const old = authorizedEntry('eng-a01', keysOf('idea01', '-old'))
        row(s, 'idea04').authorized = [old, authorizedEntry('eng-a03', keysOf('idea03'))]
        const v = verdict(s, { ...goodProbes(), idea04: goodProbe('idea04', {}) })
        expect(v.ok).toBe(false)
        const m = v.problems.filter(p => p.kind === 'fingerprint-mismatch')
        expect(m).toEqual([{
            kind: 'fingerprint-mismatch', subject: 'idea04↔idea01',
            message: `idea04↔idea01 (@43,@116): idea04 (100.108.39.45) lists idea01 as '${old}' but idea01 publishes '${authorizedEntry('eng-a01', keysOf('idea01'))}' ` +
                '(stale key or host key — reimage / key rotation not yet re-synced) — the Engine refuses copies between them',
        }])
        expect(v.problems.some(p => p.kind === 'one-sided')).toBe(false) // a mismatch is not also reported one-sided
        expect(v.pairs.find(r => r.a === 'idea01' && r.b === 'idea04')).toMatchObject({ aAcceptsB: true, bAcceptsA: false, ok: false })
    })

    it('idea02 or a foreign / unknown id in a pool Engine\'s authorized list → FAIL', () => {
        const s = exchangedStore()
        s.engines['eng-golden'] = { liveId: 'eng-golden', hostname: 'idea02', peerAccess: { ...keysOf('idea02'), authorized: [] } }
        s.engines['eng-dev'] = { liveId: 'eng-dev', hostname: 'koen-laptop', peerAccess: { ...keysOf('dev'), authorized: [] } }
        row(s, 'idea01').authorized.push(authorizedEntry('eng-golden', keysOf('idea02')))
        row(s, 'idea03').authorized.push(authorizedEntry('eng-dev', keysOf('dev')))
        row(s, 'idea04').authorized.push(authorizedEntry('idea02', keysOf('x')), authorizedEntry('eng-gone', keysOf('gone')), 'garbage')
        const v = verdict(s)
        expect(v.ok).toBe(false)
        expect(v.problems.map(p => `${p.kind} ${p.subject}: ${p.message}`)).toEqual([
            'foreign-id idea01: idea01 (100.99.231.94) authorizes idea02 (Engine eng-golden) — never idea02: production must not be able to copy into the pool',
            'foreign-id idea03: idea03 (100.126.117.80) authorizes Engine eng-dev (\'koen-laptop\'), which is not a pool engine (idea01=eng-a01, idea03=eng-a03, idea04=eng-a04) — a foreign Engine in the shared store can copy into the pool',
            'foreign-id idea04: idea04 (100.108.39.45) authorizes idea02 (Engine idea02) — never idea02: production must not be able to copy into the pool',
            'foreign-id idea04: idea04 (100.108.39.45) authorizes Engine eng-gone (not in the store), which is not a pool engine (idea01=eng-a01, idea03=eng-a03, idea04=eng-a04) — a foreign Engine in the shared store can copy into the pool',
            "foreign-id idea04: idea04 (100.108.39.45) peerAccess.authorized has a malformed entry 'garbage' (want '<engineId> <SHA256:key fp> <SHA256:hostkey fp>')",
        ])
    })

    it('helper v1 (or absent / not answering) with copy steps → FAIL helper-too-old; and the slot layout needs v2 then (v1 otherwise)', () => {
        const v = verdict(exchangedStore(), { ...goodProbes(), idea03: goodProbe('idea03', { versionOut: 'idea-app-data 1' }) })
        expect(v.ok).toBe(false)
        expect(v.problems).toEqual([{
            kind: 'helper-too-old', subject: 'idea03',
            message: 'idea03 (100.126.117.80): helper too old — idea-app-data 1 < 2 (no sync-peers / peer gate) for idea03↔idea01, idea03↔idea04',
        }])
        const absent = verdict(exchangedStore(), { ...goodProbes(), idea04: goodProbe('idea04', { helper: 'absent', versionRc: null, versionOut: '' }) })
        expect(absent.problems[0]!.message).toBe('idea04 (100.108.39.45): helper too old — no /usr/local/sbin/idea-app-data (need idea-app-data >= 2 with sync-peers) for idea04↔idea01, idea04↔idea03')
        // no helper → no peer files either: one helper-too-old problem, the missing files are notes (live idea01 today)
        const bare = verdict(exchangedStore(), {
            ...goodProbes(),
            idea04: goodProbe('idea04', { helper: 'absent', versionRc: null, versionOut: '', authorizedKeys: { state: 'missing' }, knownHosts: { state: 'missing' } }),
        })
        expect(bare.problems.map(p => p.kind)).toEqual(['helper-too-old'])
        expect(bare.notes).toEqual([
            `idea04 (100.108.39.45): ${PEER_AUTHORIZED_KEYS} does not exist (expected: no idea-app-data v2 sync-peers on this Pi yet — reported as helper-too-old)`,
            `idea04 (100.108.39.45): ${PEER_KNOWN_HOSTS} does not exist (expected: no idea-app-data v2 sync-peers on this Pi yet — reported as helper-too-old)`,
        ])
        const sudo = verdict(exchangedStore(), { ...goodProbes(), idea01: goodProbe('idea01', { versionRc: 1, versionOut: 'sudo: a password is required' }) })
        expect(sudo.problems[0]).toMatchObject({ kind: 'helper-too-old', message: expect.stringMatching(/gave exit 1: sudo: a password is required \(need idea-app-data >= 2\)/) })

        // slot layout: the same v1 helper Pi passes without a copy step and fails (exit 7 path) with one
        const R = '/home/pi/idea/duration-disks'
        const probe = parseSlotLayoutProbe([
            'HELPER present', 'HELPER_VERSION 0 idea-app-data 1', 'ROOT dir 0 0 755 root:root',
            ...requiredSlotNames().map(n => `SLOT ${n} dir 1000 1000 755 pi:pi yes`),
            'BRIDGE file 0 0 644', ...requiredSlotNames().map(n => `BRIDGE_LINE ${R}/${n}`),
        ].join('\n'))
        expect(slotLayoutVerdict('idea03', 'h3', R, probe, requiredSlotNames(), requiredHelperVersion(planOf(skipCopy.steps))).ok).toBe(true)
        const withCopy = slotLayoutVerdict('idea03', 'h3', R, probe, requiredSlotNames(), requiredHelperVersion(planOf()))
        expect(withCopy.ok).toBe(false)
        expect(withCopy.problems).toEqual(['/usr/local/sbin/idea-app-data is version 1 but this walk needs >= 2 (it runs a cross-Engine copy: per-Pi peer keys need idea-app-data v2 sync-peers)'])
        expect(slotLayoutVerdict('idea03', 'h3', R, { ...probe, versionOut: 'idea-app-data 2' }, requiredSlotNames(), 2).ok).toBe(true)
        expect(slotLayoutVerdict('idea03', 'h3', R, probe).ok).toBe(true) // default floor 1: existing behaviour
    })

    it('peer files: gate line / pinned host key missing → one-sided; stale key → mismatch; foreign line → foreign-id; unreadable → note + store check only', () => {
        const p3 = goodProbe('idea03')
        const missing = verdict(exchangedStore(), {
            ...goodProbes(),
            idea03: { ...p3, authorizedKeys: { state: 'file', lines: (p3.authorizedKeys as { lines: string[] }).lines.filter(l => !l.includes('eng-a01')) } },
        })
        expect(missing.problems).toEqual([{
            kind: 'one-sided', subject: 'idea03↔idea01',
            message: `idea03↔idea01: idea03 (100.126.117.80) ${PEER_AUTHORIZED_KEYS} has no gate line for idea01 (Engine eng-a01) — idea01 → idea03 copies cannot log in`,
        }])
        const stale = verdict(exchangedStore(), { ...goodProbes(), idea01: goodProbe('idea01', { knownHosts: { state: 'file', lines: [`eng-a03 ${keysOf('idea03', '-old').hostKey}`, `eng-a04 ${keysOf('idea04').hostKey}`] } }) })
        expect(stale.problems).toEqual([{
            kind: 'fingerprint-mismatch', subject: 'idea01↔idea03',
            message: `idea01↔idea03: idea01 (100.99.231.94) ${PEER_KNOWN_HOSTS} has idea03's pinned host key as ${keyFingerprint(keysOf('idea03', '-old').hostKey)} but idea03 publishes ${keyFingerprint(keysOf('idea03').hostKey)}`,
        }])
        const foreign = verdict(exchangedStore(), { ...goodProbes(), idea04: goodProbe('idea04', { knownHosts: { state: 'file', lines: [...(goodProbe('idea04').knownHosts as { lines: string[] }).lines, `idea02 ${testKey('g')}`] } }) })
        expect(foreign.problems.map(p => p.message)).toEqual([`idea04 (100.108.39.45): ${PEER_KNOWN_HOSTS} holds a pinned host key for idea02 (Engine idea02) — never idea02`])
        const unreadable = verdict(exchangedStore(), { ...goodProbes(), idea01: goodProbe('idea01', { authorizedKeys: { state: 'unreadable' }, knownHosts: { state: 'unreadable' } }) })
        expect(unreadable.ok).toBe(true)
        expect(unreadable.notes).toEqual([
            `idea01 (100.99.231.94): ${PEER_AUTHORIZED_KEYS} not readable as pi — relying on the store check (peerAccess.authorized) for idea01↔idea03, idea01↔idea04`,
            `idea01 (100.99.231.94): ${PEER_KNOWN_HOSTS} not readable as pi — relying on the store check (peerAccess.authorized) for idea01↔idea03, idea01↔idea04`,
        ])
        const absentFile = verdict(exchangedStore(), { ...goodProbes(), idea01: goodProbe('idea01', { knownHosts: { state: 'missing' } }) })
        expect(absentFile.problems[0]).toMatchObject({ kind: 'one-sided', subject: 'idea01', message: expect.stringMatching(/peer_known_hosts does not exist — sync-peers has not written it/) })
    })

    it('own key files on the Pi differ from what the Engine publishes → mismatch; an ssh failure → probe-failed (never a silent pass)', () => {
        const v = verdict(exchangedStore(), { ...goodProbes(), idea03: goodProbe('idea03', { hostKeyPub: { state: 'file', lines: [`${keysOf('idea03', '-new').hostKey} root@idea03`] } }) })
        expect(v.problems).toEqual([{
            kind: 'fingerprint-mismatch', subject: 'idea03',
            message: `idea03 (100.126.117.80): its ssh host key on the Pi (${HOST_KEY_PUB}, ${keyFingerprint(keysOf('idea03', '-new').hostKey)}) differs from the one it publishes (${keyFingerprint(keysOf('idea03').hostKey)}) — peers pin the published one`,
        }])
        const e = verdict(exchangedStore(), { ...goodProbes(), idea04: new Error('ssh: connect to host 100.108.39.45 port 22: Connection timed out') })
        expect(e.problems).toEqual([{ kind: 'probe-failed', subject: 'idea04', message: 'idea04 (100.108.39.45): read-only peer probe failed over ssh (ssh: connect to host 100.108.39.45 port 22: Connection timed out) — pairs idea04↔idea01, idea04↔idea03 unverified' }])
        // store-only (no probes at all): still decides on the store
        expect(peerPreflightVerdict({ plan: planOf(), store: exchangedStore(), hosts: HOSTS }).ok).toBe(true)
    })
})

describe('peer probe (read-only)', () => {
    it('only test/awk/sudo -n … version, no writes; on the box: helper absent, peer files missing', () => {
        const s = buildPeerProbeRemote()
        expect(s.replace(/2>\/dev\/null|2>&1|<\/dev\/null/g, '')).not.toMatch(/>/)
        expect(s).not.toMatch(/\b(rm|mv|cp|mkdir|tee|chmod|chown|sync-peers)\b/)
        expect(s).toContain(`_v=$(sudo -n '/usr/local/sbin/idea-app-data' version 2>&1 </dev/null)`)
        for (const f of [PEER_AUTHORIZED_KEYS, PEER_KNOWN_HOSTS, PEER_KEY_PUB, HOST_KEY_PUB]) expect(s).toContain(`'${f}'`)
        const r = spawnSync('bash', ['-c', s], { encoding: 'utf8' })
        expect(r.status).toBe(0)
        const p = parsePeerProbe(r.stdout)
        expect(p.helper).toBe('absent')
        expect(p.authorizedKeys.state).toBe('missing')
        expect(p.knownHosts.state).toBe('missing')
    })

    it('parses helper version, file lines (comments dropped by the remote awk) and unreadable/missing files', () => {
        const k = testKey('x')
        const p = parsePeerProbe([
            'HELPER present', 'HELPER_VERSION 0 idea-app-data 2',
            'FILE AUTH file', `AUTH_LINE restrict,command="/usr/local/sbin/idea-peer-gate eng-a03" ${k} idea-peer:eng-a03`,
            'FILE KNOWN unreadable', 'FILE OWNKEY missing', 'FILE HOSTKEY file', `HOSTKEY_LINE ${k} root@x`,
        ].join('\n'))
        expect(p).toMatchObject({ helper: 'present', versionRc: 0, versionOut: 'idea-app-data 2', knownHosts: { state: 'unreadable' }, ownKeyPub: { state: 'missing' } })
        expect(p.authorizedKeys).toEqual({ state: 'file', lines: [`restrict,command="/usr/local/sbin/idea-peer-gate eng-a03" ${k} idea-peer:eng-a03`] })
        expect(p.hostKeyPub).toEqual({ state: 'file', lines: [`${k} root@x`] })
        expect(() => parsePeerProbe('nonsense')).toThrow(/unparseable/)
    })
})

/** RealFleetOps with a canned ssh per host (no network). */
class CannedFleet extends RealFleetOps {
    readonly calls: string[] = []
    constructor(private readonly answers: Record<string, string | Error>) {
        super({ poolEngines: POOL, excludeEngines: ['idea02'], hosts: { idea01: 'h1', idea03: 'h3', idea04: 'h4' }, sudoMode: 'never',
            disksRoot: '/home/pi/idea/duration-disks', watchDir: '/home/pi/idea/duration-watch' })
    }
    protected override async ssh(host: string, cmd: string): Promise<string> {
        this.calls.push(`${host}: ${cmd}`)
        const a = this.answers[host]
        if (a instanceof Error) throw a
        return a ?? ''
    }
}

describe('RealFleetOps.probePeerHost', () => {
    it('runs the read-only probe over ssh and parses it; never idea02', async () => {
        const ops = new CannedFleet({ h3: 'HELPER present\nHELPER_VERSION 0 idea-app-data 1\nFILE AUTH unreadable\nFILE KNOWN missing\nFILE OWNKEY missing\nFILE HOSTKEY missing\n' })
        const p = await ops.probePeerHost('idea03')
        expect(p).toMatchObject({ helper: 'present', versionOut: 'idea-app-data 1', authorizedKeys: { state: 'unreadable' } })
        expect(ops.calls).toEqual([`h3: ${buildPeerProbeRemote()}`])
        await expect(ops.probePeerHost('idea02')).rejects.toThrow(/idea02/)
        expect(ops.calls.length).toBe(1)
    })
})
