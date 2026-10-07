/**
 * idea-app-data-peers.test.ts — the helper's peer side (per-Pi Engine keys, helper v2)
 *
 *   - sync-peers: stdin full set, strict line checks, the restrict,command=gate
 *     prefix written by the helper, atomic swap of the root-owned authorized_keys
 *     and known_hosts, no-op when unchanged, the 256 cap, empty set empties both
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
const sync = (lines: string[] | string) => sb.run(['sync-peers'], { FAKE_STDIN: Array.isArray(lines) ? lines.map(l => l + '\n').join('') : lines })
const authLines = async () => (await fs.readFile(sb.peerAuthFile, 'utf8')).split('\n').filter(l => l && !l.startsWith('#'))
const knownLines = async () => (await fs.readFile(sb.peerKnownHosts, 'utf8')).split('\n').filter(l => l && !l.startsWith('#'))
const SERVER = ['--server', '-logDtpre.iLsfxCIvu', '--numeric-ids', '.', '.']

describe('idea-app-data sync-peers', () => {
    it('writes one restricted line per peer (prefix added by the helper) and pins each host key by Engine id', async () => {
        const r = await sync([peerLine('ENGINE_a'), peerLine('ENGINE_b')])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe('sync-peers: 2 peer(s); authorized_keys updated; known_hosts updated')
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
        expect(await sb.journalText()).toMatch(/sync-peers: 2 peer\(s\); authorized_keys updated; known_hosts updated; peers=\[ENGINE_a ENGINE_b \]/)
    })

    it('is a no-op when the set is unchanged (same inode, no temp files left); a changed set is swapped in by rename', async () => {
        await sync([peerLine('ENGINE_a')])
        const ino = (await fs.stat(sb.peerAuthFile)).ino
        const again = await sync([peerLine('ENGINE_a')])
        expect(again.stdout.trim()).toBe('sync-peers: 1 peer(s); authorized_keys unchanged; known_hosts unchanged')
        expect((await fs.stat(sb.peerAuthFile)).ino).toBe(ino)
        const changed = await sync([peerLine('ENGINE_a', 'rotated')])
        expect(changed.stdout.trim()).toBe('sync-peers: 1 peer(s); authorized_keys updated; known_hosts updated')
        expect((await fs.stat(sb.peerAuthFile)).ino).not.toBe(ino)
        expect((await authLines())[0]).toContain(testKey('rotated-ssh'))
        expect((await fs.readdir(sb.peerAuthDir)).filter(f => f.startsWith('.'))).toEqual([])
        expect((await fs.readdir(path.dirname(sb.peerKnownHosts))).filter(f => f.startsWith('.'))).toEqual([])
    })

    it('the empty set empties both files (store reset / fail-closed)', async () => {
        await sync([peerLine('ENGINE_a'), peerLine('ENGINE_b')])
        const r = await sync('')
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe('sync-peers: 0 peer(s); authorized_keys updated; known_hosts updated')
        expect(await authLines()).toEqual([])
        expect(await knownLines()).toEqual([])
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
        refused(await sb.run(['sync-peers', 'ENGINE_b'], { FAKE_STDIN: '' }), /sync-peers takes exactly 0 argument/)
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

    it('refuses a peer-file folder that is a symlink or group/other writable', async () => {
        await fs.ensureDir(sb.peerAuthDir)
        await fs.chmod(sb.peerAuthDir, 0o777)
        refused(await sync([peerLine('ENGINE_a')]), /authorized keys folder .* must not be group or other writable/)
        await fs.remove(sb.peerAuthDir)
        await fs.symlink(sb.tmp, sb.peerAuthDir)
        refused(await sync([peerLine('ENGINE_a')]), /authorized keys folder .* is missing or a symlink/)
    })
})

describe('idea-app-data peer-receive / peer-delete / peer-receive-files (the ledger)', () => {
    let dst: string
    beforeEach(async () => { dst = await sb.addDisk('sdc1') })

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
