/**
 * idea-app-data-peers.test.ts — the helper's peer side (per-Pi Engine keys, helper v2)
 *
 *   - sync-peers <engineId> <storeDocId> (v15, engine#376): stdin full set, strict
 *     line checks, the restrict,command=gate prefix written by the helper, atomic swap
 *     of the root-owned authorized_keys and known_hosts, no-op when unchanged, the 256
 *     cap; owner stamp (PEER_OWNER_MISMATCH), never empties (PEER_SHRINK_TO_EMPTY),
 *     quarantine copy before every changing swap
 *   - clear-peers (v15, Ops only): the only way to empty the files
 *   - peer-receive: a NEW instance folder only, recorded in the root-owned ledger;
 *     the free-space floor on every receive
 *   - peer-delete / peer-receive-files: only for a folder that SAME peer's receive
 *     created in the last 24 h
 *   - receive-app / receive-service: rrsync -wo as pi into the folder built from tokens
 *
 * Same sandbox as idea-app-data-script.test.ts (test/harness/appDataSandbox.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs, path } from 'zx'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'
import { testKey, peerLine } from '../harness/peerKeys.js'

let sb: AppDataSandbox
beforeEach(async () => { sb = await makeAppDataSandbox() })
afterEach(async () => { await fs.remove(sb.tmp) })

const refused = (r: { exitCode: number | null, stderr: string }, re: RegExp) => {
    expect(r.exitCode, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/^refused: /m)
    expect(r.stderr).toMatch(re)
}
const ME = 'ENGINE_me'
const DOC = '2VroEUvDkmYsDAwE5oG9YeFNadWH'
const OTHER_DOC = '4uXisoLatedStore1111abcdefg'
const stdin = (lines: string[] | string) => Array.isArray(lines) ? lines.map(l => l + '\n').join('') : lines
const sync = (lines: string[] | string, id = ME, doc = DOC) => sb.run(['sync-peers', id, doc], { FAKE_STDIN: stdin(lines) })
const clear = (id = ME, doc = DOC) => sb.run(['clear-peers', id, doc])
const quarantined = async () => (await fs.pathExists(sb.peerQuarantineDir)) ? (await fs.readdir(sb.peerQuarantineDir)).sort() : []
const QNOTE = /; previous files copied to (\S+\/\.peer-quarantine\/[0-9]{8}T[0-9]+Z)$/
const authLines = async () => (await fs.readFile(sb.peerAuthFile, 'utf8')).split('\n').filter(l => l && !l.startsWith('#'))
const knownLines = async () => (await fs.readFile(sb.peerKnownHosts, 'utf8')).split('\n').filter(l => l && !l.startsWith('#'))
const SERVER = ['--server', '-logDtpre.iLsfxCIvu', '--numeric-ids', '.', '.']
// engine#595 (helper v26): the ledger and marker tests below run with live tickets for both peers,
// the way the receiving Engine registers them when it accepts a grant
const TICKET_IDS = ['new1', 'new2', 'new3', 'there', 'empty1', 'users-data', 'nomark']
const openTickets = async () => {
    for (const [peer, grant] of [['ENGINE_a', 'GrantAaaaaaaaaaa'], ['ENGINE_b', 'GrantBbbbbbbbbbb']]) {
        for (const id of TICKET_IDS) await sb.addTicket(peer, 'sdc1', 'instance', id, '-', 600, grant)
    }
}

describe('idea-app-data sync-peers', () => {
    it('writes one restricted line per peer (prefix added by the helper) and pins each host key by Engine id', async () => {
        const r = await sync([peerLine('ENGINE_a'), peerLine('ENGINE_b')])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe(`sync-peers: 2 peer(s); authorized_keys updated; known_hosts updated; owner ${ME} ${DOC} recorded`)
        expect(await fs.readFile(sb.peerOwner, 'utf8')).toBe(`${ME} ${DOC}\n`)
        expect(await quarantined()).toEqual([])   // nothing to copy on a fresh Pi
        expect(await authLines()).toEqual([
            `restrict,command="/usr/local/sbin/idea-peer-gate ENGINE_a" ${testKey('ENGINE_a-ssh')} idea-peer:ENGINE_a`,
            `restrict,command="/usr/local/sbin/idea-peer-gate ENGINE_b" ${testKey('ENGINE_b-ssh')} idea-peer:ENGINE_b`,
        ])
        expect(await knownLines()).toEqual([`ENGINE_a ${testKey('ENGINE_a-host')}`, `ENGINE_b ${testKey('ENGINE_b-host')}`])
        for (const f of [sb.peerAuthFile, sb.peerKnownHosts]) {
            const st = await fs.stat(f)
            expect(st.mode & 0o777).toBe(0o644)
            expect(st.uid).toBe(process.getuid!())   // the sandbox's "root"
        }
        expect(await sb.journalText()).toMatch(new RegExp(`sync-peers: 2 peer\\(s\\); authorized_keys updated; known_hosts updated; peers=\\[ENGINE_a ENGINE_b \\]; caller=${ME} ${DOC}; owner ${ME} ${DOC} recorded`))
    })

    it('is a no-op when the set is unchanged (same inode, no temp files left); a changed set is swapped in by rename', async () => {
        await sync([peerLine('ENGINE_a')])
        const ino = (await fs.stat(sb.peerAuthFile)).ino
        const again = await sync([peerLine('ENGINE_a')])
        expect(again.stdout.trim()).toBe('sync-peers: 1 peer(s); authorized_keys unchanged; known_hosts unchanged')
        expect((await fs.stat(sb.peerAuthFile)).ino).toBe(ino)
        expect(await quarantined()).toEqual([])   // unchanged: no copy
        const changed = await sync([peerLine('ENGINE_a', 'rotated')])
        expect(changed.stdout.trim()).toMatch(/^sync-peers: 1 peer\(s\); authorized_keys updated; known_hosts updated; previous files copied to /)
        expect(await quarantined()).toHaveLength(1)
        expect((await fs.stat(sb.peerAuthFile)).ino).not.toBe(ino)
        expect((await authLines())[0]).toContain(testKey('rotated-ssh'))
        expect((await fs.readdir(sb.peerAuthDir)).filter(f => f.startsWith('.'))).toEqual([])
        expect((await fs.readdir(path.dirname(sb.peerKnownHosts))).filter(f => f.startsWith('.') && f !== '.peer-quarantine')).toEqual([])
    })

    it('PEER_SHRINK_TO_EMPTY: an empty set never empties the files (engine#376); nothing changes, no copy is made', async () => {
        await sync([peerLine('ENGINE_a'), peerLine('ENGINE_b')])
        const auth = await fs.readFile(sb.peerAuthFile, 'utf8')
        const kh = await fs.readFile(sb.peerKnownHosts, 'utf8')
        const ino = (await fs.stat(sb.peerAuthFile)).ino
        const r = await sync('')
        refused(r, new RegExp(`PEER_SHRINK_TO_EMPTY: the peer set on stdin is empty, but \\S+ holds 2 peer key\\(s\\) and \\S+ 2 host key\\(s\\); sync-peers never empties them, nothing was changed\\. ` +
            `Only Ops empties them, by hand: idea-app-data clear-peers ${ME} ${DOC} \\(engine#376\\)`))
        expect(await fs.readFile(sb.peerAuthFile, 'utf8')).toBe(auth)
        expect(await fs.readFile(sb.peerKnownHosts, 'utf8')).toBe(kh)
        expect((await fs.stat(sb.peerAuthFile)).ino).toBe(ino)
        expect(await quarantined()).toEqual([])
        expect(await sb.journalText()).toMatch(/refused=.*PEER_SHRINK_TO_EMPTY/)
        // a known_hosts line alone also counts
        await fs.writeFile(sb.peerAuthFile, '# only comments\n')
        refused(await sync(''), /PEER_SHRINK_TO_EMPTY: .* holds 0 peer key\(s\) and \S+ 2 host key\(s\)/)
    })

    it('an empty set over empty or missing files is fine (fresh Pi): header-only files, owner recorded', async () => {
        const r = await sync('')
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe(`sync-peers: 0 peer(s); authorized_keys updated; known_hosts updated; owner ${ME} ${DOC} recorded`)
        expect(await authLines()).toEqual([])
        expect(await knownLines()).toEqual([])
    })

    it('a smaller, non-empty set is allowed (stale peers expire), with a copy of the previous files made BEFORE the swap', async () => {
        await sync([peerLine('ENGINE_a'), peerLine('ENGINE_b')])
        const auth = await fs.readFile(sb.peerAuthFile, 'utf8')
        const kh = await fs.readFile(sb.peerKnownHosts, 'utf8')
        const r = await sync([peerLine('ENGINE_b')])
        expect(r.exitCode, r.stderr).toBe(0)
        const m = r.stdout.trim().match(QNOTE)
        expect(m, r.stdout).toBeTruthy()
        const q = m![1]
        expect(path.dirname(q)).toBe(sb.peerQuarantineDir)
        expect(await fs.readFile(path.join(q, 'idea_authorized_keys-pi'), 'utf8')).toBe(auth)
        expect(await fs.readFile(path.join(q, 'peer_known_hosts'), 'utf8')).toBe(kh)
        expect((await fs.stat(sb.peerQuarantineDir)).mode & 0o777).toBe(0o700)
        expect((await fs.stat(q)).mode & 0o777).toBe(0o700)
        expect((await authLines()).map(l => l.split(' ').at(-1))).toEqual(['idea-peer:ENGINE_b'])
        // copies are never deleted: a second change adds a second folder
        await sync([peerLine('ENGINE_b'), peerLine('ENGINE_c')])
        expect(await quarantined()).toHaveLength(2)
        expect(await sb.journalText()).toMatch(/sync-peers: 1 peer\(s\); .*previous files copied to \S+\.peer-quarantine/)
    })

    it('PEER_OWNER_MISMATCH: another Engine id or another store is refused and nothing changes (engine#376)', async () => {
        await sync([peerLine('ENGINE_a'), peerLine('ENGINE_b')])
        const auth = await fs.readFile(sb.peerAuthFile, 'utf8')
        const owner = await fs.readFile(sb.peerOwner, 'utf8')
        for (const [id, doc] of [[ME, OTHER_DOC], ['ENGINE_second', DOC], ['ENGINE_second', OTHER_DOC]]) {
            refused(await sync([peerLine('ENGINE_x')], id, doc), new RegExp(
                `PEER_OWNER_MISMATCH: the peer files on this Pi belong to Engine ${ME} in store ${DOC} \\(\\S+peer-owner\\), not to Engine ${id} in store ${doc}; nothing was changed\\. ` +
                `After a store change Ops moves \\S+peer-owner aside by hand \\(engine#376\\)`))
            refused(await sync('', id, doc), /PEER_OWNER_MISMATCH/)   // the owner check comes before the shrink check
        }
        expect(await fs.readFile(sb.peerAuthFile, 'utf8')).toBe(auth)
        expect(await fs.readFile(sb.peerOwner, 'utf8')).toBe(owner)
        expect(await quarantined()).toEqual([])
        expect(await sb.journalText()).toMatch(/refused=.*PEER_OWNER_MISMATCH/)
    })

    it('ownership changes only by hand: once Ops moves peer-owner aside, the next sync-peers records the new owner', async () => {
        await sync([peerLine('ENGINE_a')])
        refused(await sync([peerLine('ENGINE_a')], ME, OTHER_DOC), /PEER_OWNER_MISMATCH/)
        await fs.move(sb.peerOwner, path.join(sb.tmp, 'peer-owner.aside'))
        const r = await sync([peerLine('ENGINE_a')], ME, OTHER_DOC)
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe(`sync-peers: 1 peer(s); authorized_keys unchanged; known_hosts unchanged; owner ${ME} ${OTHER_DOC} recorded`)
        expect(await fs.readFile(sb.peerOwner, 'utf8')).toBe(`${ME} ${OTHER_DOC}\n`)
    })

    it('refuses an owner file that is a symlink, group/other writable or not one owner line', async () => {
        await sync([peerLine('ENGINE_a')])
        await fs.chmod(sb.peerOwner, 0o666)
        refused(await sync([peerLine('ENGINE_a')]), /peer owner file \S+ \(mode 0666\) must not be group or other writable/)
        await fs.chmod(sb.peerOwner, 0o644)
        await fs.writeFile(sb.peerOwner, `${ME}\n`)
        refused(await sync([peerLine('ENGINE_a')]), /peer owner file \S+ is not one '<engineId> <storeDocId>' line; Ops must fix it by hand/)
        await fs.writeFile(sb.peerOwner, `${ME} ${DOC} extra\n`)
        refused(await sync([peerLine('ENGINE_a')]), /is not one '<engineId> <storeDocId>' line/)
        await fs.remove(sb.peerOwner)
        await fs.symlink(path.join(sb.tmp, 'elsewhere'), sb.peerOwner)
        refused(await sync([peerLine('ENGINE_a')]), /peer owner file \S+ is a symlink/)
    })

    it('checks the caller\'s Engine id and store document id', async () => {
        refused(await sync([peerLine('ENGINE_a')], ME, `automerge:${DOC}`), /store document id .* does not match/)
        refused(await sync([peerLine('ENGINE_a')], ME, '../etc/x'), /store document id .* does not match/)
        refused(await sync([peerLine('ENGINE_a')], ME, 'short'), /store document id .* does not match/)
        refused(await sync([peerLine('ENGINE_a')], ME, '2VroEUvDkmYsDAwE5oG9YeFNad0O'), /store document id .* does not match/)   // 0 and O are not base58
        refused(await sync([peerLine('ENGINE_a')], '-ENGINE', DOC), /Engine id '-ENGINE' does not match/)
        expect(await fs.pathExists(sb.peerOwner)).toBe(false)
    })

    it('refuses anything but exact lines, and leaves the files as they were', async () => {
        await sync([peerLine('ENGINE_a')])
        const before = await fs.readFile(sb.peerAuthFile, 'utf8')
        const k = testKey('x').split(' ')[1]
        const bad = [
            `ENGINE_b ssh-ed25519 ${k}`,                                                  // no host key
            `ENGINE_b ssh-ed25519 ${k} ssh-ed25519 ${k} extra`,                           // extra field
            `command="/bin/sh" ssh-ed25519 ${k} ssh-ed25519 ${k}`,                         // option injection
            `ENGINE_b ssh-rsa ${k} ssh-ed25519 ${k}`,                                      // not ed25519
            `ENGINE_b ssh-ed25519 ${k.slice(0, -1)} ssh-ed25519 ${k}`,                      // short key
            `ENGINE_b ssh-ed25519 ${k}== ssh-ed25519 ${k}`,
            `-ENGINE ssh-ed25519 ${k} ssh-ed25519 ${k}`,                                   // option-looking id
            `ENGINE,b ssh-ed25519 ${k} ssh-ed25519 ${k}`,                                  // known_hosts pattern chars
            `ENGINE*b ssh-ed25519 ${k} ssh-ed25519 ${k}`,
            `ENGINE_b  ssh-ed25519 ${k} ssh-ed25519 ${k}`,                                 // double space
            `ENGINE_b\tssh-ed25519 ${k} ssh-ed25519 ${k}`,
            '',                                                                           // empty line
            '# comment',
        ]
        for (const line of bad) refused(await sync(line + '\n'), /peer line 1 is not '<engineId> ssh-ed25519 <key> ssh-ed25519 <hostkey>'/)
        refused(await sync([peerLine('ENGINE_b'), peerLine('ENGINE_b', 'other')]), /Engine ENGINE_b is listed twice/)
        refused(await sync([peerLine('ENGINE_b', 'same'), peerLine('ENGINE_c', 'same')]), /the key of Engine ENGINE_c is listed for another Engine too/)
        refused(await sb.run(['sync-peers'], { FAKE_STDIN: stdin([peerLine('ENGINE_b')]) }), /sync-peers takes exactly 2 argument/)
        refused(await sb.run(['sync-peers', ME], { FAKE_STDIN: stdin([peerLine('ENGINE_b')]) }), /sync-peers takes exactly 2 argument/)
        expect(await fs.readFile(sb.peerAuthFile, 'utf8')).toBe(before)
    })

    it('caps the set at 256 peers', async () => {
        const lines = Array.from({ length: 256 }, (_, i) => peerLine(`ENGINE_${i}`))
        const ok = await sync(lines)
        expect(ok.exitCode, ok.stderr).toBe(0)
        expect((await authLines()).length).toBe(256)
        refused(await sync([...lines, peerLine('ENGINE_256')]), /more than 256 peers on stdin/)
        expect((await authLines()).length).toBe(256)
    }, 60_000)

    it('does not wipe or rewrite the usage key file (idea#412)', async () => {
        await fs.ensureDir(sb.usageAuthDir)
        const planted = `restrict,from="100.64.1.2",command="/usr/local/sbin/idea-usage-export" ${testKey('planted')} idea-usage\n`
        await fs.writeFile(sb.usageAuthFile, planted)
        const ino = (await fs.stat(sb.usageAuthFile)).ino
        const r = await sync([peerLine('ENGINE_a')])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(await fs.readFile(sb.usageAuthFile, 'utf8')).toBe(planted)
        expect((await fs.stat(sb.usageAuthFile)).ino).toBe(ino)
        expect(await authLines()).toHaveLength(1)
    })

    it('refuses a peer-file folder that is a symlink or group/other writable', async () => {
        await fs.ensureDir(sb.peerAuthDir)
        await fs.chmod(sb.peerAuthDir, 0o777)
        refused(await sync([peerLine('ENGINE_a')]), /authorized keys folder .* must not be group or other writable/)
        await fs.remove(sb.peerAuthDir)
        await fs.symlink(sb.tmp, sb.peerAuthDir)
        refused(await sync([peerLine('ENGINE_a')]), /authorized keys folder .* is missing or a symlink/)
    })
})

describe('idea-app-data clear-peers (v15, engine#376: Ops only, the only way to empty the peer files)', () => {
    it('empties both files after a copy to .peer-quarantine, journaled; sync-peers works again afterwards', async () => {
        await sync([peerLine('ENGINE_a'), peerLine('ENGINE_b')])
        const auth = await fs.readFile(sb.peerAuthFile, 'utf8')
        const kh = await fs.readFile(sb.peerKnownHosts, 'utf8')
        const r = await clear()
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toMatch(/^clear-peers: removed 2 peer key\(s\) and 2 host key\(s\); authorized_keys updated; known_hosts updated; previous files copied to /)
        const q = r.stdout.trim().match(QNOTE)![1]
        expect(await fs.readFile(path.join(q, 'idea_authorized_keys-pi'), 'utf8')).toBe(auth)
        expect(await fs.readFile(path.join(q, 'peer_known_hosts'), 'utf8')).toBe(kh)
        expect(await authLines()).toEqual([])
        expect(await knownLines()).toEqual([])
        expect(await fs.readFile(sb.peerOwner, 'utf8')).toBe(`${ME} ${DOC}\n`)   // owner unchanged
        expect(await sb.journalText()).toMatch(new RegExp(`clear-peers: by \\S+ for Engine ${ME} store ${DOC}: removed 2 peer key\\(s\\) and 2 host key\\(s\\)`))
        const again = await clear()
        expect(again.stdout.trim()).toBe('clear-peers: removed 0 peer key(s) and 0 host key(s); authorized_keys unchanged; known_hosts unchanged')
        const back = await sync([peerLine('ENGINE_a')])
        expect(back.exitCode, back.stderr).toBe(0)
        expect(await authLines()).toHaveLength(1)
    })

    it('checks the owner and its arguments like sync-peers', async () => {
        await sync([peerLine('ENGINE_a')])
        const auth = await fs.readFile(sb.peerAuthFile, 'utf8')
        refused(await clear('ENGINE_second', DOC), /PEER_OWNER_MISMATCH/)
        refused(await clear(ME, OTHER_DOC), /PEER_OWNER_MISMATCH/)
        refused(await sb.run(['clear-peers']), /clear-peers takes exactly 2 argument/)
        refused(await clear(ME, 'automerge:x'), /store document id .* does not match/)
        expect(await fs.readFile(sb.peerAuthFile, 'utf8')).toBe(auth)
        expect(await quarantined()).toEqual([])
    })
})

describe('idea-app-data peer-receive / peer-delete / peer-receive-files (the ledger)', () => {
    let dst: string
    beforeEach(async () => { dst = await sb.addDisk('sdc1'); await openTickets() })

    it('peer-receive creates a NEW folder, records <time> <peer> <root> <id>, then runs rrsync -wo there', async () => {
        const r = await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new1', ...SERVER], { FAKE_STDIN: 'bytes' })
        expect(r.exitCode, r.stderr).toBe(0)
        const [call] = await sb.calls('rrsync')
        expect(call.argv).toEqual(['-wo', path.join(dst, 'instances', 'new1')])
        expect(call.env.SSH_ORIGINAL_COMMAND).toBe(`rsync ${SERVER.join(' ')}`)
        const ledger = await fs.readFile(path.join(sb.ledgerDir, 'received'), 'utf8')
        expect(ledger).toMatch(/^\d+ ENGINE_a sdc1 new1\n$/)
        expect((await fs.stat(sb.ledgerDir)).mode & 0o777).toBe(0o700)
        expect((await fs.stat(path.join(sb.ledgerDir, 'received'))).mode & 0o777).toBe(0o600)
    })

    it('peer-receive refuses an existing folder (even empty), --sender, and a disk below the free-space floor', async () => {
        await fs.ensureDir(path.join(dst, 'instances', 'there'))
        refused(await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'there', ...SERVER]), /already exists; a peer receive needs a new instance folder/)
        refused(await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new2', '--server', '--sender', '.', '.']), /write-only: --sender is not allowed/)
        refused(await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new3', ...SERVER], { FAKE_DF_AVAIL_KB: '1000' }), /only 1000 KB free .* receives need at least 1048576 KB/)
        refused(await sb.run(['peer-receive', 'ENGINE a', 'sdc1', 'new4', ...SERVER]), /Engine id 'ENGINE a' does not match/)
        expect(await fs.pathExists(path.join(dst, 'instances', 'new3'))).toBe(false)
        expect(await sb.calls('rrsync')).toEqual([])
    })

    it('the plain receive, receive-app and receive-service honour the floor too', async () => {
        await sb.run(['ensure-dirs', 'sdc1'])
        const low = { FAKE_DF_AVAIL_KB: '5' }
        refused(await sb.run(['receive', 'sdc1', 'n1', ...SERVER], low), /only 5 KB free/)
        refused(await sb.run(['receive-app', 'sdc1', 'kolibri-1.0', ...SERVER], low), /only 5 KB free/)
        refused(await sb.run(['receive-service', 'sdc1', ...SERVER], low), /only 5 KB free/)
    })

    it('peer-delete removes only a folder the SAME peer received (and clears its ledger line)', async () => {
        expect((await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new1', ...SERVER])).exitCode).toBe(0)
        await fs.writeFile(path.join(dst, 'instances', 'new1', 'partial'), 'x')
        await sb.addInstance(dst, 'users-data')
        refused(await sb.run(['peer-delete', 'ENGINE_b', 'sdc1', 'new1']), /Engine ENGINE_b did not create .*new1 with a receive in the last 24 h/)
        refused(await sb.run(['peer-delete', 'ENGINE_a', 'sdc1', 'users-data']), /Engine ENGINE_a did not create .*users-data/)
        expect(await fs.pathExists(path.join(dst, 'instances', 'users-data', 'compose.yaml'))).toBe(true)
        const ok = await sb.run(['peer-delete', 'ENGINE_a', 'sdc1', 'new1'])
        expect(ok.exitCode, ok.stderr).toBe(0)
        expect(await fs.pathExists(path.join(dst, 'instances', 'new1'))).toBe(false)
        expect(await fs.readFile(path.join(sb.ledgerDir, 'received'), 'utf8')).toBe('')
        refused(await sb.run(['peer-delete', 'ENGINE_a', 'sdc1', 'new1']), /did not create/)   // once
    })

    it('a ledger line older than 24 h no longer allows delete or receive-files (and is pruned)', async () => {
        expect((await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new1', ...SERVER])).exitCode).toBe(0)
        const old = Math.floor(Date.now() / 1000) - 86400 - 60
        await fs.writeFile(path.join(sb.ledgerDir, 'received'), `${old} ENGINE_a sdc1 new1\n`)
        refused(await sb.run(['peer-delete', 'ENGINE_a', 'sdc1', 'new1']), /did not create/)
        refused(await sb.run(['peer-receive-files', 'ENGINE_a', 'sdc1', 'new1', ...SERVER]), /did not create/)
        expect((await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new2', ...SERVER])).exitCode).toBe(0)
        expect(await fs.readFile(path.join(sb.ledgerDir, 'received'), 'utf8')).toMatch(/^\d+ ENGINE_a sdc1 new2\n$/)
    })

    it('peer-receive-files writes into the received folder of that peer only', async () => {
        expect((await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new1', ...SERVER])).exitCode).toBe(0)
        const ok = await sb.run(['peer-receive-files', 'ENGINE_a', 'sdc1', 'new1', ...SERVER])
        expect(ok.exitCode, ok.stderr).toBe(0)
        expect((await sb.calls('rrsync')).at(-1)!.argv).toEqual(['-wo', path.join(dst, 'instances', 'new1')])
        refused(await sb.run(['peer-receive-files', 'ENGINE_b', 'sdc1', 'new1', ...SERVER]), /Engine ENGINE_b did not create/)
    })

    it('refuses an unsafe ledger folder', async () => {
        await fs.ensureDir(sb.ledgerDir)
        await fs.chmod(sb.ledgerDir, 0o755)
        refused(await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new1', ...SERVER]), /ledger folder .* must have mode 0700/)
    })
})

describe('idea-app-data receive-app / receive-service (written as pi)', () => {
    it('receive-app: runuser -u <pi> -- rrsync -wo <root>/apps/<appId>, the folder made and given to pi', async () => {
        const root = await sb.addDisk('sdc1')
        expect((await sb.run(['ensure-dirs', 'sdc1'])).exitCode).toBe(0)
        const r = await sb.run(['receive-app', 'sdc1', 'kolibri-1.0', ...SERVER])
        expect(r.exitCode, r.stderr).toBe(0)
        const [ru] = await sb.calls('runuser')
        expect(ru.argv.slice(0, 3)).toEqual(['-u', expect.any(String), '--'])
        expect((await sb.calls('rrsync'))[0].argv).toEqual(['-wo', path.join(root, 'apps', 'kolibri-1.0')])
        expect((await fs.stat(path.join(root, 'apps', 'kolibri-1.0'))).isDirectory()).toBe(true)
    })

    it('receive-app refuses bad app ids and a symlinked app folder; receive-service writes services/', async () => {
        const root = await sb.addDisk('sdc1')
        await sb.run(['ensure-dirs', 'sdc1'])
        for (const app of ['../x', 'kolibri..1', '-rf', 'a/b', '.hidden']) {
            refused(await sb.run(['receive-app', 'sdc1', app, ...SERVER]), /app id '.*' does not match/)
        }
        await fs.symlink('/tmp', path.join(root, 'apps', 'evil-1.0'))
        refused(await sb.run(['receive-app', 'sdc1', 'evil-1.0', ...SERVER]), /app master folder .* is a symlink/)
        const s = await sb.run(['receive-service', 'sdc1', ...SERVER])
        expect(s.exitCode, s.stderr).toBe(0)
        expect((await sb.calls('rrsync')).at(-1)!.argv).toEqual(['-wo', path.join(root, 'services')])
        refused(await sb.run(['receive-service', 'sdc1', '-e', 'sh', '.', '.']), /first server argument must be --server/)
    })
})

describe('idea-app-data v23 (engine#497 a): the peer in-flight marker, resume and verify on the receiving side', () => {
    const OP = 'Ab3dEf5hJk7mNp9qRs1'
    const DRY = ['--server', '-nlHogDtpAXrxe.iLsfxCIvu', '--log-format=%i', '--numeric-ids', '.', '.']
    let dst: string
    beforeEach(async () => { dst = await sb.addDisk('sdc1'); await openTickets() })
    const marker = () => path.join(dst, 'instances', 'new1.idea-op-in-flight')

    it('peer-mark-in-flight writes a root-owned 0644 marker naming the PEER (not the caller) and is journaled; the same op again is fine', async () => {
        const r = await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])
        expect(r.exitCode, r.stderr).toBe(0)
        expect((await fs.stat(marker())).mode & 0o777).toBe(0o644)
        expect(await fs.readFile(marker(), 'utf8')).toMatch(new RegExp(`^opId=${OP}\nengineId=ENGINE_a\ncreated=\\d{4}-`))
        expect(await sb.journalText()).toMatch(/peer-mark-in-flight: .*new1\.idea-op-in-flight for operation Ab3dEf5hJk7mNp9qRs1 of Engine ENGINE_a/)
        expect((await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        refused(await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', 'Other0p']), /IN_FLIGHT: .* marks operation Ab3dEf5hJk7mNp9qRs1, not Other0p/)
        refused(await sb.run(['peer-mark-in-flight', 'ENGINE_b', 'sdc1', 'new1', OP]), /IN_FLIGHT: .* belongs to Engine ENGINE_a, not ENGINE_b/)
        expect(await fs.pathExists(path.join(dst, 'instances', 'new1'))).toBe(false)   // marking writes no folder
    })

    it('peer-mark-in-flight refuses an existing folder (an instance of this Engine, or any leftover)', async () => {
        await sb.addInstance(dst, 'users-data')
        refused(await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'users-data', OP]), /users-data already exists; a peer marks only a new instance folder/)
        await fs.ensureDir(path.join(dst, 'instances', 'empty1'))
        refused(await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'empty1', OP]), /already exists/)
        refused(await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', 'bad op']), /operation id 'bad op' does not match/)
        expect(await fs.pathExists(path.join(dst, 'instances', 'users-data.idea-op-in-flight'))).toBe(false)
    })

    it('peer-receive refuses a marked id; peer-resume-receive writes only under that peer\'s marker of that op (rrsync -wo, ledger line)', async () => {
        expect((await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        refused(await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new1', ...SERVER]), /IN_FLIGHT: .* only that operation resumes it/)
        refused(await sb.run(['peer-resume-receive', 'ENGINE_b', 'sdc1', 'new1', OP, ...SERVER]), /belongs to Engine ENGINE_a, not ENGINE_b/)
        refused(await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', 'Other0p', ...SERVER]), /marks operation .*, not Other0p/)
        refused(await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'nomark', OP, ...SERVER]), /no in-flight marker/)
        refused(await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, '--server', '--sender', '.', '.']), /--sender is not allowed/)
        expect(await sb.calls('rrsync')).toEqual([])
        const r = await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER])
        expect(r.exitCode, r.stderr).toBe(0)
        await fs.writeFile(path.join(dst, 'instances', 'new1', 'half'), 'x')
        const again = await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER])
        expect(again.exitCode, again.stderr).toBe(0)
        expect((await sb.calls('rrsync')).map(c => c.argv)).toEqual([['-wo', path.join(dst, 'instances', 'new1')], ['-wo', path.join(dst, 'instances', 'new1')]])
        expect(await fs.readFile(path.join(sb.ledgerDir, 'received'), 'utf8')).toMatch(/^\d+ ENGINE_a sdc1 new1\n$/)
        // the free-space floor holds here too
        refused(await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER], { FAKE_DF_AVAIL_KB: '5' }), /only 5 KB free/)
    })

    it('peer-receive-files is allowed by that peer\'s marker (no 24 h ledger TTL), never by another peer\'s', async () => {
        expect((await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        expect((await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER])).exitCode).toBe(0)
        await fs.writeFile(path.join(sb.ledgerDir, 'received'), '')                       // ledger line gone (e.g. > 24 h)
        const ok = await sb.run(['peer-receive-files', 'ENGINE_a', 'sdc1', 'new1', ...SERVER])
        expect(ok.exitCode, ok.stderr).toBe(0)
        refused(await sb.run(['peer-receive-files', 'ENGINE_b', 'sdc1', 'new1', ...SERVER]), /did not create .*its in-flight marker belongs to Engine ENGINE_a/)
    })

    it('peer-verify-receive: a dry run only, under the marker, into an existing folder; the one exact --log-format=%i token', async () => {
        expect((await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        refused(await sb.run(['peer-verify-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...DRY]), /instance folder .* is not a folder/)
        expect((await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER])).exitCode).toBe(0)
        refused(await sb.run(['peer-verify-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER]), /runs only a dry run/)
        refused(await sb.run(['peer-verify-receive', 'ENGINE_a', 'sdc1', 'new1', OP, '--server', '-n', '--log-format=%n', '.', '.']), /unsafe rsync server argument/)
        refused(await sb.run(['peer-verify-receive', 'ENGINE_a', 'sdc1', 'new1', OP, '--server', '-n', '--sender', '.', '.']), /--sender is not allowed/)
        refused(await sb.run(['peer-verify-receive', 'ENGINE_b', 'sdc1', 'new1', OP, ...DRY]), /belongs to Engine ENGINE_a/)
        const n = (await sb.calls('rrsync')).length
        const r = await sb.run(['peer-verify-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...DRY])
        expect(r.exitCode, r.stderr).toBe(0)
        const calls = await sb.calls('rrsync')
        expect(calls.length).toBe(n + 1)
        expect(calls.at(-1)!.argv).toEqual(['-wo', path.join(dst, 'instances', 'new1')])
        expect(calls.at(-1)!.env.SSH_ORIGINAL_COMMAND).toBe(`rsync ${DRY.join(' ')}`)
    })

    it('peer-clear-in-flight removes only that peer\'s marker of that op; an absent marker is fine', async () => {
        expect((await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        refused(await sb.run(['peer-clear-in-flight', 'ENGINE_b', 'sdc1', 'new1', OP]), /belongs to Engine ENGINE_a/)
        refused(await sb.run(['peer-clear-in-flight', 'ENGINE_a', 'sdc1', 'new1', 'Other0p']), /not Other0p/)
        expect(await fs.pathExists(marker())).toBe(true)
        expect((await sb.run(['peer-clear-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        expect(await fs.pathExists(marker())).toBe(false)
        expect((await sb.run(['peer-clear-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        expect(await sb.journalText()).toMatch(/peer-clear-in-flight: .*new1\.idea-op-in-flight of operation Ab3dEf5hJk7mNp9qRs1 of Engine ENGINE_a/)
    })
})

describe('idea-app-data v26 (engine#595): peer transfer tickets', () => {
    const OP = 'Ab3dEf5hJk7mNp9qRs1'
    const G = 'GrantAaaaaaaaaaa'
    let dst: string
    beforeEach(async () => { dst = await sb.addDisk('sdc1') })
    const files = async () => (await fs.pathExists(sb.ticketDir)) ? (await fs.readdir(sb.ticketDir)).sort() : []
    const nothingWritten = async () => {
        expect(await fs.readdir(path.join(dst, 'instances'))).toEqual([])
        expect(await fs.pathExists(path.join(sb.ledgerDir, 'received'))).toBe(false)
        expect(await sb.calls('rrsync')).toEqual([])
    }

    it('every peer write verb refuses GRANT_EXPIRED without a ticket, before it writes anything', async () => {
        await fs.ensureDir(path.join(dst, 'apps')); await fs.ensureDir(path.join(dst, 'services'))
        const cases: string[][] = [
            ['peer-ensure-dirs', 'ENGINE_a', 'sdc1'],
            ['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP],
            ['peer-receive', 'ENGINE_a', 'sdc1', 'new1', ...SERVER],
            ['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER],
            ['peer-verify-receive', 'ENGINE_a', 'sdc1', 'new1', OP, '--server', '-n', '.', '.'],
            ['peer-receive-files', 'ENGINE_a', 'sdc1', 'new1', ...SERVER],
            ['peer-receive-app', 'ENGINE_a', 'sdc1', 'kolibri-1.0', ...SERVER],
            ['peer-receive-service', 'ENGINE_a', 'sdc1', ...SERVER],
        ]
        for (const c of cases) refused(await sb.run(c), /GRANT_EXPIRED: Engine ENGINE_a has no live permission from this Engine/)
        expect(await fs.readdir(path.join(dst, 'apps'))).toEqual([])
        await fs.remove(path.join(dst, 'apps')); await fs.remove(path.join(dst, 'services'))
        await nothingWritten()
    })

    it('a ticket covers only its peer, root, kind and id (and its op when it names one)', async () => {
        await sb.addDisk('sdd1')
        await sb.addTicket('ENGINE_a', 'sdc1', 'instance', 'new1', OP, 600, G)
        refused(await sb.run(['peer-receive', 'ENGINE_b', 'sdc1', 'new1', ...SERVER]), /GRANT_EXPIRED: Engine ENGINE_b/)
        refused(await sb.run(['peer-receive', 'ENGINE_a', 'sdd1', 'new1', ...SERVER]), /GRANT_EXPIRED/)
        refused(await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new2', ...SERVER]), /GRANT_EXPIRED/)
        refused(await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', 'Other0p']), /GRANT_EXPIRED/)
        refused(await sb.run(['peer-receive-app', 'ENGINE_a', 'sdc1', 'new1', ...SERVER]), /GRANT_EXPIRED/)
        await nothingWritten()
        const ok = await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])
        expect(ok.exitCode, ok.stderr).toBe(0)
        expect((await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER])).exitCode).toBe(0)
        expect((await sb.run(['peer-receive-files', 'ENGINE_a', 'sdc1', 'new1', ...SERVER])).exitCode).toBe(0)
        // any ticket of the peer for that root allows ensure-dirs
        expect((await sb.run(['peer-ensure-dirs', 'ENGINE_a', 'sdc1'])).exitCode).toBe(0)
        refused(await sb.run(['peer-ensure-dirs', 'ENGINE_a', 'sdd1']), /GRANT_EXPIRED/)
    })

    it('expires on the uptime clock, dies with a reboot (boot id) and with an Engine start (peer-tickets-reset)', async () => {
        await sb.addTicket('ENGINE_a', 'sdc1', 'instance', 'new1', '-', 60, G)   // uptime 1000 → deadline 1060
        await sb.setUptime(1059)
        expect((await sb.run(['peer-mark-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        await sb.setUptime(1060)
        refused(await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER]), /GRANT_EXPIRED/)
        await sb.setUptime(1000)
        await sb.setBootId('0b1d2c3e-aaaa-bbbb-cccc-000000000002')
        refused(await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER]), /GRANT_EXPIRED/)
        await sb.setBootId('0b1d2c3e-aaaa-bbbb-cccc-000000000001')
        expect((await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER])).exitCode).toBe(0)
        const reset = await sb.run(['peer-tickets-reset'])
        expect(reset.exitCode, reset.stderr).toBe(0)
        expect(reset.stdout.trim()).toBe('ok: dropped 1 ticket(s)')
        expect(await files()).toEqual([])
        refused(await sb.run(['peer-resume-receive', 'ENGINE_a', 'sdc1', 'new1', OP, ...SERVER]), /GRANT_EXPIRED/)
        // cleanup of the peer's own partial copy stays possible without a ticket
        expect((await sb.run(['peer-clear-in-flight', 'ENGINE_a', 'sdc1', 'new1', OP])).exitCode).toBe(0)
        const del = await sb.run(['peer-delete', 'ENGINE_a', 'sdc1', 'new1'])
        expect(del.exitCode, del.stderr).toBe(0)
        expect(await fs.pathExists(path.join(dst, 'instances', 'new1'))).toBe(false)
        expect(await sb.journalText()).toMatch(/peer-tickets-reset: 1 ticket\(s\) dropped/)
    })

    it('peer-ticket-add: root 0700 folder, 0600 files, strict arguments; drop by grant; limits', async () => {
        await sb.addTicket('ENGINE_a', 'sdc1', 'instance', 'new1', OP, 600, G)
        await sb.addTicket('ENGINE_a', 'sdc1', 'app', 'kolibri-1.0', OP, 600, G)
        await sb.addTicket('ENGINE_a', 'sdc1', 'services', '-', OP, 600, G)
        expect((await fs.stat(sb.ticketDir)).mode & 0o777).toBe(0o700)
        expect(await files()).toEqual([`${G}.app.kolibri-1.0.ticket`, `${G}.instance.new1.ticket`, `${G}.services.-.ticket`])
        const line = await fs.readFile(path.join(sb.ticketDir, `${G}.instance.new1.ticket`), 'utf8')
        expect(line).toBe(`v1 ENGINE_a sdc1 instance new1 ${OP} ${G} 0b1d2c3e-aaaa-bbbb-cccc-000000000001 1600\n`)
        expect((await fs.stat(path.join(sb.ticketDir, `${G}.instance.new1.ticket`))).mode & 0o777).toBe(0o600)
        const add = (...a: string[]) => sb.run(['peer-ticket-add', ...a])
        refused(await add('ENGINE_a', 'sdc1', 'instance', '../x', '-', G, '60'), /instance id/)
        refused(await add('ENGINE_a', 'sdc1', 'app', 'a..b', '-', G, '60'), /app id/)
        refused(await add('ENGINE_a', 'sdc1', 'services', 'x', '-', G, '60'), /services ticket takes '-'/)
        refused(await add('ENGINE_a', 'sdc1', 'root', 'x', '-', G, '60'), /not instance, app or services/)
        refused(await add('ENGINE_a', 'sdc1', 'instance', 'new1', '-', 'short', '60'), /grant id/)
        refused(await add('ENGINE_a', 'sdc1', 'instance', 'new1', '-', G, '0'), /must be 1\.\.21600/)
        refused(await add('ENGINE_a', 'sdc1', 'instance', 'new1', '-', G, '21601'), /must be 1\.\.21600/)
        refused(await add('ENGINE_a', '/etc', 'instance', 'new1', '-', G, '60'), /root/)
        refused(await add('-x', 'sdc1', 'instance', 'new1', '-', G, '60'), /Engine id/)
        refused(await add('ENGINE_a', 'sdc1', 'instance', 'new1', '-', G), /takes exactly 7 argument/)
        const drop = await sb.run(['peer-ticket-drop', G])
        expect(drop.stdout.trim()).toBe('ok: dropped 3 ticket(s)')
        expect(await files()).toEqual([])
        refused(await sb.run(['peer-ticket-drop', '../../etc/x']), /grant id/)
        // an expired or other-boot ticket is pruned at the next add
        await sb.addTicket('ENGINE_a', 'sdc1', 'instance', 'old1', '-', 5, 'GrantOldddddddd1')
        await sb.setUptime(2000)
        await sb.addTicket('ENGINE_a', 'sdc1', 'instance', 'new1', '-', 5, G)
        expect(await files()).toEqual([`${G}.instance.new1.ticket`])
    })

    it('refuses an untrustworthy ticket folder', async () => {
        await sb.addTicket('ENGINE_a', 'sdc1', 'instance', 'new1', '-', 600, G)
        await fs.chmod(sb.ticketDir, 0o755)
        refused(await sb.run(['peer-receive', 'ENGINE_a', 'sdc1', 'new1', ...SERVER]), /ticket folder .* must be root-owned 0700/)
        await nothingWritten()
    })

    it('peer-receive-app: as pi, never deletes, keeps existing files (rrsync flags or --ignore-existing)', async () => {
        await fs.ensureDir(path.join(dst, 'apps'))
        await sb.addTicket('ENGINE_a', 'sdc1', 'app', 'kolibri-1.0', OP, 600, G)
        refused(await sb.run(['peer-receive-app', 'ENGINE_a', 'sdc1', 'kolibri-1.0', '--server', '-logDtpre.iLsfxCIvu', '--delete', '.', '.']), /never deletes, moves or backs up files: rsync option --delete/)
        refused(await sb.run(['peer-receive-app', 'ENGINE_a', 'sdc1', 'kolibri-1.0', '--server', '-blogDtpre.iLsfxCIvu', '.', '.']), /rsync flag -b is not allowed/)
        refused(await sb.run(['peer-receive-app', 'ENGINE_a', 'sdc1', 'kolibri-1.0', '--server', '-logDtpr', '--backup-dir=x', '.', '.']), /--backup-dir/)
        // the fake rrsync has none of the flags: the helper adds --ignore-existing itself
        const r = await sb.run(['peer-receive-app', 'ENGINE_a', 'sdc1', 'kolibri-1.0', ...SERVER])
        expect(r.exitCode, r.stderr).toBe(0)
        let call = (await sb.calls('rrsync')).at(-1)!
        expect(call.argv).toEqual(['-wo', path.join(dst, 'apps', 'kolibri-1.0')])
        expect(call.env.SSH_ORIGINAL_COMMAND).toBe(`rsync --server --ignore-existing ${SERVER.slice(1).join(' ')}`)
        expect((await sb.calls('runuser')).at(-1)!.argv.slice(0, 3)).toEqual(['-u', expect.any(String), '--'])
        // an rrsync with the flags (3.2.4+; idea03 has rsync 3.4.1) gets them instead
        await sb.fake('rrsync', `# arg_parser.add_argument('-no-del') ('-no-overwrite') ('-munge')
${process.execPath} -e 'const fs=require("fs");fs.appendFileSync(process.argv[1], JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),env:{SSH_ORIGINAL_COMMAND:process.env.SSH_ORIGINAL_COMMAND}})+"\\n")' ${path.join(sb.tmp, 'calls')}/rrsync.log "$@"`)
        expect((await sb.run(['peer-receive-app', 'ENGINE_a', 'sdc1', 'kolibri-1.0', ...SERVER])).exitCode).toBe(0)
        call = (await sb.calls('rrsync')).at(-1)!
        expect(call.argv).toEqual(['-wo', '-no-del', '-no-overwrite', path.join(dst, 'apps', 'kolibri-1.0')])
        expect(call.env.SSH_ORIGINAL_COMMAND).toBe(`rsync ${SERVER.join(' ')}`)
    })

    it('peer-receive-app overwrites only into this Engine\'s own Fetch (.idea-fetching names the ticket op)', async () => {
        const REQ = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
        const app = path.join(dst, 'apps', 'kolibri-2.0')
        await fs.ensureDir(app)
        await fs.writeFile(path.join(app, '.idea-fetching'), `${REQ}\n`)
        await sb.addTicket('ENGINE_a', 'sdc1', 'app', 'kolibri-2.0', REQ, 600, 'FetchTicket00001')
        expect((await sb.run(['peer-receive-app', 'ENGINE_a', 'sdc1', 'kolibri-2.0', '--server', '-logDtpre.iLsfxCIvu', '--partial', '.', '.'])).exitCode).toBe(0)
        expect((await sb.calls('rrsync')).at(-1)!.env.SSH_ORIGINAL_COMMAND).toBe('rsync --server -logDtpre.iLsfxCIvu --partial . .')
        await fs.writeFile(path.join(app, '.idea-fetching'), 'another-request\n')
        expect((await sb.run(['peer-receive-app', 'ENGINE_a', 'sdc1', 'kolibri-2.0', ...SERVER])).exitCode).toBe(0)
        expect((await sb.calls('rrsync')).at(-1)!.env.SSH_ORIGINAL_COMMAND).toMatch(/--ignore-existing/)
        expect(await sb.journalText()).toMatch(/peer-receive-app: .*kolibri-2\.0 for Engine ENGINE_a \(overwrite=yes\)/)
    })

    it('peer-receive-service: under a services ticket, never deletes or overwrites, symlinks munged', async () => {
        await fs.ensureDir(path.join(dst, 'services'))
        await sb.addTicket('ENGINE_a', 'sdc1', 'services', '-', OP, 600, G)
        refused(await sb.run(['peer-receive-service', 'ENGINE_b', 'sdc1', ...SERVER]), /GRANT_EXPIRED: Engine ENGINE_b has no live permission from this Engine to write service images/)
        refused(await sb.run(['peer-receive-service', 'ENGINE_a', 'sdc1', '--server', '-logDtpr', '--remove-source-files', '.', '.']), /--remove-source-files/)
        const r = await sb.run(['peer-receive-service', 'ENGINE_a', 'sdc1', ...SERVER])
        expect(r.exitCode, r.stderr).toBe(0)
        const call = (await sb.calls('rrsync')).at(-1)!
        expect(call.argv).toEqual(['-wo', path.join(dst, 'services')])
        expect(call.env.SSH_ORIGINAL_COMMAND).toBe(`rsync --server --ignore-existing --munge-links ${SERVER.slice(1).join(' ')}`)
    })
})
