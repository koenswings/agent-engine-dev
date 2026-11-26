/**
 * peer-tickets.test.ts — peer transfer tickets on the Engine side (engine#595, helper v26)
 *
 *  - PeerTickets.ts: what the receiving Engine registers when it accepts a grant or asks for a
 *    Fetch, how long a ticket lives, and that an older helper registers nothing
 *  - InFlight.isPeerLinkFailure: a ticket refusal is never an interruption (no RESUME_WAITING park)
 *  - an Engine from before engine-03 (adfd9d3, the build happy-zebra may come back on) sending to a
 *    v26 Engine: its exact remote commands through the real gate and helper are refused at the
 *    first step, with exit 2 and one readable "refused: GRANT_EXPIRED: …" line that zx puts in the
 *    failed op's error, and nothing is written on the receiving Engine
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { $, fs, path } from 'zx'
import {
    registerTransferTickets, registerFetchTicket, resetPeerTickets, dropTickets, ticketSeconds, newTicketId, TicketDeps,
} from '../../src/data/PeerTickets.js'
import { peerTicketAddArgs, PEER_TICKET_MAX_SECONDS, isTicketRefusal } from '../../src/utils/appDataHelper.js'
import { isPeerLinkFailure } from '../../src/data/InFlight.js'
import { acceptGrantCheck } from '../../src/data/PeerTickets.js'
import { grantCheckCommand, ticketRefusal, PeerGrantRefusal } from '../../src/data/PeerCommands.js'
import { grantRefusalCode } from '../../src/data/Operations.js'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'

const G = 'GrantAaaaaaaaaaa'
const fakeDeps = (opts: { old?: string, fail?: (args: string[]) => boolean } = {}) => {
    const calls: string[][] = []
    const d: TicketDeps = {
        helperProblem: async () => opts.old ?? null,
        run: async (args) => {
            calls.push(args)
            if (opts.fail?.(args)) throw new Error('idea-app-data peer-ticket-add refused: TICKETS_FULL')
            return 'ok: dropped 2 ticket(s)\n'
        },
    }
    return { d, calls }
}

describe('PeerTickets (Engine side)', () => {
    it('registers instance, app and services tickets for a copy, for the time the grant still has (max 6 h)', async () => {
        const { d, calls } = fakeDeps()
        const r = await registerTransferTickets('ENGINE_a', G, 90_500, { root: 'sdc1', dstId: 'new1', appId: 'kolibri-1.0', opId: 'Op1' }, d)
        expect(r).toEqual({ ok: true, registered: 3 })
        expect(calls).toEqual([
            ['peer-ticket-add', 'ENGINE_a', 'sdc1', 'instance', 'new1', 'Op1', G, '90'],
            ['peer-ticket-add', 'ENGINE_a', 'sdc1', 'app', 'kolibri-1.0', 'Op1', G, '90'],
            ['peer-ticket-add', 'ENGINE_a', 'sdc1', 'services', '-', 'Op1', G, '90'],
        ])
        expect(ticketSeconds(0)).toBe(1)
        expect(ticketSeconds(48 * 3600_000)).toBe(PEER_TICKET_MAX_SECONDS)
        const noApp = fakeDeps()
        await registerTransferTickets('ENGINE_a', G, 60_000, { root: 'system', dstId: 'new2', services: false }, noApp.d)
        expect(noApp.calls).toEqual([['peer-ticket-add', 'ENGINE_a', 'system', 'instance', 'new2', '-', G, '60']])
    })

    it('below helper v26 nothing is registered (an older gate needs no ticket); a refusal is returned, never thrown', async () => {
        const old = fakeDeps({ old: 'needs v26' })
        expect(await registerTransferTickets('ENGINE_a', G, 60_000, { root: 'sdc1', dstId: 'new1' }, old.d)).toEqual({ ok: true, registered: 0, skipped: 'needs v26' })
        expect(await resetPeerTickets(old.d)).toBeNull()
        await dropTickets(G, old.d)
        expect(old.calls).toEqual([])
        const full = fakeDeps({ fail: a => a[3] === 'app' })
        const r = await registerTransferTickets('ENGINE_a', G, 60_000, { root: 'sdc1', dstId: 'new1', appId: 'k-1' }, full.d)
        expect(r.ok).toBe(false)
        expect((r as any).error).toMatch(/could not register the transfer permission for Engine ENGINE_a: .*TICKETS_FULL/)
    })

    it('a Fetch ticket names the request as its op; reset retries once and reports a lasting failure', async () => {
        const { d, calls } = fakeDeps()
        const id = newTicketId()
        expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/)
        await registerFetchTicket('ENGINE_src', 'sdc1', 'kolibri-2.0', '1b4e28ba-2fa1-11d2-883f-0016d3cca427', id, 21600, d)
        expect(calls[0]).toEqual(['peer-ticket-add', 'ENGINE_src', 'sdc1', 'app', 'kolibri-2.0', '1b4e28ba-2fa1-11d2-883f-0016d3cca427', id, '21600'])
        await dropTickets(id, d)
        expect(calls[1]).toEqual(['peer-ticket-drop', id])
        let n = 0
        const flaky: TicketDeps = { helperProblem: async () => null, run: async () => { if (n++ === 0) throw new Error('busy'); return 'ok: dropped 0 ticket(s)' } }
        expect(await resetPeerTickets(flaky)).toBeNull()
        const broken: TicketDeps = { helperProblem: async () => null, run: async () => { throw new Error('sudo: a password is required') } }
        expect(await resetPeerTickets(broken)).toMatch(/could not drop the transfer permissions of the previous run: sudo: a password is required/)
    })

    it('argument builders refuse anything the helper would refuse', () => {
        expect(() => peerTicketAddArgs('ENGINE_a', '/etc', 'instance', 'x', null, G, 5)).toThrow(/disk root/)
        expect(() => peerTicketAddArgs('ENGINE_a', 'sdc1', 'instance', '../x', null, G, 5)).toThrow(/instance id/)
        expect(() => peerTicketAddArgs('ENGINE_a', 'sdc1', 'app', 'a..b', null, G, 5)).toThrow(/app id/)
        expect(() => peerTicketAddArgs('ENGINE_a', 'sdc1', 'services', 'x', null, G, 5)).toThrow(/no id/)
        expect(() => peerTicketAddArgs('ENGINE_a', 'sdc1', 'instance', 'x', null, 'short', 5)).toThrow(/grant id/)
        expect(() => peerTicketAddArgs('ENGINE_a', 'sdc1', 'instance', 'x', null, G, 0)).toThrow(/1\.\.21600/)
        expect(() => peerTicketAddArgs('ENGINE_a', 'sdc1', 'instance', 'x', 'bad op!', G, 5)).toThrow(/operation id/)
    })
})

describe('grantCheck with a transfer (engine#595)', () => {
    const store = { diskDB: {
        'disk-b': { id: 'disk-b', device: 'sdc1', dockedTo: 'ENGINE_b' },
        'disk-away': { id: 'disk-away', device: 'sdd1', dockedTo: 'ENGINE_c' },
    } }
    const rootOf = async (d: any) => String(d.device)
    it('the source names what it will write; an issuer without engine#595 sees only extra words', () => {
        expect(grantCheckCommand()).toBe('grantCheck')
        expect(grantCheckCommand({ targetDiskId: 'disk-b', dstId: 'new1', appId: 'kolibri-1.0', opId: 'Op1', services: true })).toBe('grantCheck disk-b new1 kolibri-1.0 Op1 1')
        expect(grantCheckCommand({ targetDiskId: 'disk-b', dstId: 'new1', appId: null, opId: null, services: false })).toBe('grantCheck disk-b new1 - - 0')
    })
    it('the issuer registers tickets on ITS root for the disk docked to it, for what the grant still has', async () => {
        const { d, calls } = fakeDeps()
        const a = await acceptGrantCheck(store, 'ENGINE_b', 'ENGINE_a', G, 3_600_000, 'grantCheck disk-b new1 kolibri-1.0 Op1 0', d, rootOf)
        expect(a).toEqual({ ok: true, registered: 2 })
        expect(calls).toEqual([
            ['peer-ticket-add', 'ENGINE_a', 'sdc1', 'instance', 'new1', 'Op1', G, '3600'],
            ['peer-ticket-add', 'ENGINE_a', 'sdc1', 'app', 'kolibri-1.0', 'Op1', G, '3600'],
        ])
        const plain = fakeDeps()
        expect(await acceptGrantCheck(store, 'ENGINE_b', 'ENGINE_a', G, 3_600_000, 'grantCheck', plain.d, rootOf)).toEqual({ ok: true, registered: 0 })
        expect(plain.calls).toEqual([])
    })
    it('refuses, before anything runs as root: a disk not docked here, bad words, an expired grant, a failed registration', async () => {
        const none = fakeDeps()
        const r = (cmd: string, ms = 60_000, d = none.d) => acceptGrantCheck(store, 'ENGINE_b', 'ENGINE_a', G, ms, cmd, d, rootOf)
        expect(await r('grantCheck disk-away new1 - - 0')).toMatchObject({ ok: false, status: 409, code: 'TARGET_NOT_DOCKED' })
        expect(await r('grantCheck nope new1 - - 0')).toMatchObject({ ok: false, status: 409, code: 'TARGET_NOT_DOCKED' })
        expect(await r('grantCheck disk-b new1 - -')).toMatchObject({ ok: false, status: 400, code: 'BAD_REQUEST' })
        expect(await r('grantCheck disk-b ../x - - 0')).toMatchObject({ ok: false, status: 400, code: 'BAD_REQUEST' })
        expect(await r('grantCheck disk-b new1 a..b - 0')).toMatchObject({ ok: false, status: 400, code: 'BAD_REQUEST' })
        expect(await r('grantCheck disk-b new1 - - 2')).toMatchObject({ ok: false, status: 400, code: 'BAD_REQUEST' })
        expect(await r('grantCheck disk-b new1 - - 0', 0)).toMatchObject({ ok: false, status: 403, code: 'GRANT_EXPIRED' })
        expect(none.calls).toEqual([])
        const full = fakeDeps({ fail: () => true })
        expect(await r('grantCheck disk-b new1 - - 0', 60_000, full.d)).toMatchObject({ ok: false, status: 503, code: 'TRANSFER_PERMISSION_FAILED' })
    })
})

describe('a ticket refusal is never a link interruption (InFlight, engine#595)', () => {
    it('the source maps the helper refusal to GRANT_EXPIRED (the same as a refused grant check)', () => {
        const e = new Error('rsync to Engine ENGINE_b exited with code 12: refused: GRANT_EXPIRED: Engine ENGINE_a has no live permission from this Engine to write app k-1 on sdc1 (…)\nrsync: connection unexpectedly closed')
        const r = ticketRefusal(e, 'ENGINE_b', 'transfer')
        expect(r).toBeInstanceOf(PeerGrantRefusal)
        expect(r!.code).toBe('GRANT_EXPIRED')
        expect(r!.message).toBe('Engine ENGINE_b refused the transfer: Engine ENGINE_a has no live permission from this Engine to write app k-1 on sdc1 (…)')
        expect(r!.traceResult).toEqual({ code: 'GRANT_EXPIRED', issuerEngineId: 'ENGINE_b', dispatchedTo: 'ENGINE_b', step: 'transfer' })
        expect(ticketRefusal(new Error('rsync exited with code 12: connection unexpectedly closed'), 'ENGINE_b', 'transfer')).toBeNull()
        expect(grantRefusalCode(`RESUME_PENDING (1/3): ${e.message}`)).toBe('GRANT_EXPIRED')
        expect(grantRefusalCode('GRANT_INVALID: bad mac')).toBe('GRANT_INVALID')
        expect(grantRefusalCode('rsync exited with code 23')).toBeNull()
    })

    it('rsync reports exit 12 when the remote helper refuses; with GRANT_EXPIRED that is a refusal, not RESUME_WAITING', () => {
        const refused = 'rsync to Engine ENGINE_b (10.0.0.2, receive-app) exited with code 12: refused: GRANT_EXPIRED: Engine ENGINE_a has no live permission from this Engine to write app k-1 on sdc1 (…)\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]'
        expect(isPeerLinkFailure(refused)).toBe(false)
        expect(isTicketRefusal(refused)).toBe(true)
        expect(isPeerLinkFailure('rsync to Engine ENGINE_b exited with code 12: rsync: connection unexpectedly closed')).toBe(true)
        expect(isPeerLinkFailure('ssh: connect to host 10.0.0.2 port 22: Connection refused\nexit code: 255')).toBe(true)
    })
})

describe('an Engine from before engine-03 (adfd9d3) sending to a v26 Engine', () => {
    let sb: AppDataSandbox
    beforeEach(async () => { sb = await makeAppDataSandbox() })
    afterEach(async () => { await fs.remove(sb.tmp) })
    const H = '/usr/local/sbin/idea-app-data'
    const SRV = '--server -logDtpre.iLsfxCIvu --numeric-ids . .'
    // adfd9d3's copyApp, in its order (src/data/CopyMoveApp.ts:285 ensureRemoteDirs, :299 receive-app,
    // :310 rsyncInstanceData → helper send → receive, :333/:356 receive-files, :387 receive-service,
    // :470 delete in the catch); moveApp to another Engine is refused locally there (:507-510)
    const ADFD9D3_COMMANDS = [
        `sudo -n ${H} ensure-dirs sdc1`,
        `sudo -n ${H} receive-app sdc1 kolibri-1.0 ${SRV}`,
        `/usr/bin/sudo -n ${H} receive sdc1 new1 ${SRV}`,
        `sudo -n ${H} receive-files sdc1 new1 ${SRV}`,
        `sudo -n ${H} receive-service sdc1 ${SRV}`,
    ]

    it('its first remote step fails as a zx error with exit 2 and one readable line; nothing is created', async () => {
        const root = await sb.addDisk('sdc1')
        // what adfd9d3 does: `await $\`${remoteEnsureDirsSshArgs(…)}\`` — here the gate stands in for ssh
        let message = ''
        try {
            await $({ env: { ...process.env, SSH_ORIGINAL_COMMAND: ADFD9D3_COMMANDS[0], SSH_CLIENT: '10.0.0.9 50000 22' }, quiet: true })`${sb.gateScript} ENGINE_old`
        } catch (e: any) { message = String(e?.message ?? e) }
        expect(message).toMatch(/^refused: GRANT_EXPIRED: Engine ENGINE_old has no live permission from this Engine to write anything on sdc1 \(it expired, this Engine restarted, or Engine ENGINE_old is too old to ask for one and must be updated first\)\. Nothing was written; start the operation again from the Console/)
        expect(message).toMatch(/exit code: 2/)
        // the copy op ends Failed with that error (adfd9d3 catch, :447-456); createdInstanceDest is still
        // null, so it sends no delete; its finally restarts the source it stopped; Failed ops are not retried
        expect(await fs.readdir(root)).toEqual(['META.yaml', 'instances'])
        expect(await fs.readdir(path.join(root, 'instances'))).toEqual([])
    })

    it('every later step it could reach is refused the same way, before any folder, marker or ledger line', async () => {
        const root = await sb.addDisk('sdc1')
        await fs.ensureDir(path.join(root, 'apps')); await fs.ensureDir(path.join(root, 'services'))
        for (const cmd of ADFD9D3_COMMANDS) {
            const r = await sb.runGate(['ENGINE_old'], cmd)
            expect(r.exitCode, cmd).toBe(2)
            expect(r.stderr.trim().split('\n')).toHaveLength(1)
            expect(r.stderr).toMatch(/^refused: GRANT_EXPIRED: /)
        }
        expect(await fs.readdir(path.join(root, 'instances'))).toEqual([])
        expect(await fs.readdir(path.join(root, 'apps'))).toEqual([])
        expect(await fs.readdir(path.join(root, 'services'))).toEqual([])
        expect(await fs.pathExists(path.join(sb.ledgerDir, 'received'))).toBe(false)
        expect(await sb.calls('rrsync')).toEqual([])
        // its cleanup verb stays as before (ledger only): nothing of its own to delete
        const del = await sb.runGate(['ENGINE_old'], `sudo -n ${H} delete sdc1 new1`)
        expect(del.exitCode).toBe(2)
        expect(del.stderr).toMatch(/did not create/)
    })
})

describe('capability peerTickets1 (engine#595)', () => {
    afterEach(async () => {
        const { resetPeerTicketsCapabilityForTests, resetCrossEngineResumeCapabilityForTests } = await import('../../src/data/Engine.js')
        resetPeerTicketsCapabilityForTests(); resetCrossEngineResumeCapabilityForTests()
    })
    it('advertised only with helper v26+, beside crossEngineResume; the constant is the same everywhere', async () => {
        const { engineCapabilities, PEER_TICKETS_CAPABILITY, CROSS_ENGINE_RESUME_CAPABILITY } = await import('../../src/data/Engine.js')
        const { PEER_TICKETS_CAPABILITY: fromTickets } = await import('../../src/data/PeerTickets.js')
        expect(PEER_TICKETS_CAPABILITY).toBe('peerTickets1')
        expect(fromTickets).toBe(PEER_TICKETS_CAPABILITY)
        expect(engineCapabilities(false, false, false, false, true, false)).not.toContain(PEER_TICKETS_CAPABILITY)
        expect(engineCapabilities(false, false, false, false, true, true)).toEqual(expect.arrayContaining([CROSS_ENGINE_RESUME_CAPABILITY, PEER_TICKETS_CAPABILITY]))
        expect(engineCapabilities(false, false, false, false, false, true)).toContain(PEER_TICKETS_CAPABILITY)
    })
    it('one startup check: v26 → advertised; v25, missing, failing or hung → omitted; never throws', async () => {
        const { checkPeerTicketsCapability, engineCapabilities, PEER_TICKETS_CAPABILITY } = await import('../../src/data/Engine.js')
        expect(engineCapabilities(false)).not.toContain(PEER_TICKETS_CAPABILITY)          // not checked yet
        expect(await checkPeerTicketsCapability(async () => 'idea-app-data 26\n', 100)).toBe(true)
        expect(engineCapabilities(false)).toContain(PEER_TICKETS_CAPABILITY)
        expect(await checkPeerTicketsCapability(async () => 'idea-app-data 27', 100)).toBe(true)
        expect(await checkPeerTicketsCapability(async () => 'idea-app-data 25', 100)).toBe(false)
        expect(engineCapabilities(false)).not.toContain(PEER_TICKETS_CAPABILITY)
        expect(await checkPeerTicketsCapability(async () => { throw new Error('sudo: a password is required') }, 100)).toBe(false)
        const started = Date.now()
        expect(await checkPeerTicketsCapability(() => new Promise(() => { /* never settles */ }), 50)).toBe(false)
        expect(Date.now() - started).toBeLessThan(2000)
    })
    it('a loop stall while the check is in flight still advertises it (engine#521)', async () => {
        const { checkPeerTicketsCapability, engineCapabilities, PEER_TICKETS_CAPABILITY } = await import('../../src/data/Engine.js')
        const pending = checkPeerTicketsCapability(() => new Promise<string>((resolve) => { setTimeout(() => resolve('idea-app-data 26'), 150) }), 100)
        const end = Date.now() + 400; while (Date.now() < end) { /* busy */ }
        expect(await pending).toBe(true)
        expect(engineCapabilities(false)).toContain(PEER_TICKETS_CAPABILITY)
    })
})
