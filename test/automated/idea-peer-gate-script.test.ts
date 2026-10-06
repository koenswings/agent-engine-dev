/**
 * idea-peer-gate-script.test.ts — the forced command of every peer Engine key
 *
 * sshd runs `idea-peer-gate <peerEngineId>` (the id from the root-owned
 * authorized_keys line) with the peer's request in SSH_ORIGINAL_COMMAND. The gate
 * allows only these calls of this Pi's app-data helper and maps them:
 *   version, ensure-dirs <root>, receive → peer-receive <peer>, receive-files →
 *   peer-receive-files <peer>, receive-app, receive-service, delete → peer-delete <peer>
 * and refuses EVERYTHING else (exit 2, sudo never runs). Both `sudo` and
 * `/usr/bin/sudo` are accepted (rsync's --rsync-path and ssh send either).
 *
 * The sandbox's fake sudo records its argv and (unless FAKE_SUDO_EXIT is set) runs
 * the sandboxed helper, so the end-to-end cases go gate → sudo → helper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs, path } from 'zx'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'
import { remoteHelperCommand, remoteHelperRsyncPath, receiveAppArgs, receiveServiceArgs, receiveFilesArgs, deleteArgs, ensureDirsArgs, APP_DATA_HELPER } from '../../src/utils/appDataHelper.js'

let sb: AppDataSandbox
beforeEach(async () => { sb = await makeAppDataSandbox() })
afterEach(async () => { await fs.remove(sb.tmp) })

const H = '/usr/local/sbin/idea-app-data'
const SRV = '--server -logDtpre.iLsfxCIvu --numeric-ids . .'
const PEER = 'ENGINE_peer2'
const sudoArgv = async () => (await sb.calls('sudo')).map(c => c.argv)

describe('idea-peer-gate: the allow-list and its mapping', () => {
    const cases: [string, string[]][] = [
        [`sudo -n ${H} version`, ['version']],
        [`sudo -n ${H} ensure-dirs sdb1`, ['ensure-dirs', 'sdb1']],
        [`sudo -n ${H} receive sdb1 new1 ${SRV}`, ['peer-receive', PEER, 'sdb1', 'new1', ...SRV.split(' ')]],
        [`sudo -n ${H} receive-files sdb1 new1 ${SRV}`, ['peer-receive-files', PEER, 'sdb1', 'new1', ...SRV.split(' ')]],
        [`sudo -n ${H} receive-app system kolibri-1.0 ${SRV}`, ['receive-app', 'system', 'kolibri-1.0', ...SRV.split(' ')]],
        [`sudo -n ${H} receive-service sdb1 ${SRV}`, ['receive-service', 'sdb1', ...SRV.split(' ')]],
        [`sudo -n ${H} delete sdb1 new1`, ['peer-delete', PEER, 'sdb1', 'new1']],
        [`/usr/bin/sudo -n ${H} delete sdb1 new1`, ['peer-delete', PEER, 'sdb1', 'new1']],
    ]
    for (const [cmd, helperArgs] of cases) {
        it(`${cmd.slice(0, 70)} → idea-app-data ${helperArgs.slice(0, 3).join(' ')}`, async () => {
            const r = await sb.runGate([PEER], cmd, { FAKE_SUDO_EXIT: '0' })
            expect(r.exitCode, r.stderr).toBe(0)
            expect(await sudoArgv()).toEqual([['-n', H, ...helperArgs]])
            expect(await sb.journalText()).toMatch(new RegExp(`idea-peer-gate .*allowed peer=${PEER} from=10\\.0\\.0\\.9 helper=${helperArgs[0]}`))
        })
    }

    it('accepts exactly what an Engine sends (remoteHelperCommand, --rsync-path and the send of the helper, plus the rsync server args)', async () => {
        const sent = [
            remoteHelperCommand(ensureDirsArgs('sdb1')).join(' '),
            remoteHelperCommand(deleteArgs('sdb1', 'new1')).join(' '),
            `/usr/bin/sudo -n ${H} receive sdb1 new1 ${SRV}`,   // what the helper's send gives rsync as --rsync-path
            `${remoteHelperRsyncPath(receiveFilesArgs('sdb1', 'new1'))} ${SRV}`,
            `${remoteHelperRsyncPath(receiveAppArgs('sdb1', 'kolibri-1.0'))} ${SRV}`,
            `${remoteHelperRsyncPath(receiveServiceArgs('sdb1'))} ${SRV}`,
        ]
        expect(APP_DATA_HELPER).toBe(H)
        for (const cmd of sent) {
            const r = await sb.runGate([PEER], cmd, { FAKE_SUDO_EXIT: '0' })
            expect(r.exitCode, `${cmd}: ${r.stderr}`).toBe(0)
        }
        expect((await sudoArgv()).length).toBe(sent.length)
    })
})

describe('idea-peer-gate: everything outside the allow-list is refused, sudo never runs', () => {
    const refusals: [string | undefined, RegExp][] = [
        [undefined, /no command: a peer key gets no shell/],
        ['', /no command/],
        ['bash', /not a call of/],
        ['bash -i -c id x', /only \/usr\/local\/sbin\/idea-app-data may run/],
        ['/usr/lib/openssh/sftp-server', /not a call of/],
        ['scp -t /home/pi/x y', /not a call of|only/],
        ['rsync --server -logDtpre.iLsfxCIvu . /home/pi', /only \/usr\/local\/sbin\/idea-app-data may run/],
        [`sudo ${H} version x`, /only '\/usr\/bin\/sudo -n \/usr\/local\/sbin\/idea-app-data …' may run/],
        [`sudo -n /usr/local/sbin/idea-app-data2 version`, /only '\/usr\/bin\/sudo -n/],
        [`sudo -n /bin/sh -c id`, /only '\/usr\/bin\/sudo -n/],
        [`/tmp/sudo -n ${H} version`, /not '\/tmp\/sudo'/],
        [`sudo -n ${H} version; id`, /character outside/],
        [`sudo -n ${H} version && id`, /character outside/],
        [`sudo -n ${H} version | id`, /character outside/],
        [`sudo -n ${H} version $(id)`, /character outside/],
        [`sudo -n ${H} version \`id\``, /character outside/],
        [`sudo -n ${H} version > /etc/passwd`, /character outside/],
        [`sudo -n ${H} version\nid`, /character outside/],
        [`sudo -n ${H} delete sdb1 'new1'`, /character outside/],
        [`sudo -n ${H} delete sdb1 "new1"`, /character outside/],
        [`sudo -n ${H} delete sdb1 new1\\`, /character outside/],
        [`sudo -n ${H} delete sdb1 *`, /character outside/],
        [`sudo -n ${H} delete sdb1 ~`, /character outside/],
        [`sudo -n ${H} version x`, /version takes no arguments/],
        [`sudo -n ${H} ensure-dirs`, /ensure-dirs takes exactly <root>/],
        [`sudo -n ${H} ensure-dirs sdb1 sdc1`, /ensure-dirs takes exactly <root>/],
        [`sudo -n ${H} delete sdb1`, /delete takes exactly <root> <id>/],
        [`sudo -n ${H} delete sdb1 new1 new2`, /delete takes exactly <root> <id>/],
        [`sudo -n ${H} receive sdb1 new1`, /receive takes <root> <id> and the rsync server arguments/],
        [`sudo -n ${H} receive sdb1 new1 -e sh . .`, /receive needs the rsync server arguments/],
        [`sudo -n ${H} receive sdb1 new1 --server --sender -logDtpre.iLsfxCIvu . .`, /write-only: --sender is not allowed/],
        [`sudo -n ${H} receive-files sdb1 new1 --server --sender . .`, /write-only/],
        [`sudo -n ${H} receive-app sdb1 kolibri-1.0 --server --sender . .`, /write-only/],
        [`sudo -n ${H} receive-service sdb1 --server --sender . .`, /write-only/],
        [`sudo -n ${H} receive-service sdb1`, /receive-service takes <root>/],
        // helper subcommands a peer must never reach directly
        ...['send', 'copy', 'size', 'sync-peers', 'peer-delete', 'peer-receive', 'peer-receive-files',
            'borg-init', 'borg-info', 'borg-create', 'borg-extract', 'unknown'].map(s =>
            [`sudo -n ${H} ${s} sdb1 new1 x y z`, new RegExp(`subcommand '${s}' is not allowed for a peer Engine key`)] as [string, RegExp]),
        [`sudo -n ${H} peer-delete ENGINE_other sdb1 new1`, /subcommand 'peer-delete' is not allowed/],
        [`sudo -n ${H} ${'x'.repeat(4100)}`, /longer than 4096/],
    ]
    for (const [cmd, re] of refusals) {
        it(`refuses ${JSON.stringify(cmd)?.slice(0, 80)}`, async () => {
            const r = await sb.runGate([PEER], cmd)
            expect(r.exitCode).toBe(2)
            expect(r.stderr).toMatch(/^refused: /)
            expect(r.stderr).toMatch(re)
            expect(await sb.calls('sudo')).toEqual([])
            expect(await sb.journalText()).toMatch(/idea-peer-gate .*refused peer=ENGINE_peer2 from=10\.0\.0\.9/)
        })
    }

    it('refuses without exactly one valid peer id (a hand-edited authorized_keys line)', async () => {
        for (const args of [[], ['ENGINE_a', 'ENGINE_b'], ['-x'], ['ENGINE a'], ['ENGINE;id'], ['']]) {
            const r = await sb.runGate(args, `sudo -n ${H} version`)
            expect(r.exitCode, JSON.stringify(args)).toBe(2)
            expect(r.stderr).toMatch(/refused: (the gate takes exactly one argument|peer Engine id does not match)/)
        }
        expect(await sb.calls('sudo')).toEqual([])
    })
})

describe('idea-peer-gate end to end (gate → sudo → helper)', () => {
    it('version answers the helper protocol version (2)', async () => {
        const r = await sb.runGate([PEER], `sudo -n ${H} version`)
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe('idea-app-data 2')
    })

    it('a receive is recorded for the peer named by the key; only that peer may delete it', async () => {
        const root = await sb.addDisk('sdc1')
        const recv = await sb.runGate([PEER], `sudo -n ${H} receive sdc1 new1 ${SRV}`)
        expect(recv.exitCode, recv.stderr).toBe(0)
        expect(await fs.pathExists(path.join(root, 'instances', 'new1'))).toBe(true)
        expect(await fs.readFile(path.join(sb.ledgerDir, 'received'), 'utf8')).toMatch(new RegExp(`^\\d+ ${PEER} sdc1 new1\\n$`))

        const other = await sb.runGate(['ENGINE_peer3'], `sudo -n ${H} delete sdc1 new1`)
        expect(other.exitCode).toBe(2)
        expect(other.stderr).toMatch(/Engine ENGINE_peer3 did not create .* a peer may only delete its own partial copy/)
        expect(await fs.pathExists(path.join(root, 'instances', 'new1'))).toBe(true)

        const own = await sb.runGate([PEER], `sudo -n ${H} delete sdc1 new1`)
        expect(own.exitCode, own.stderr).toBe(0)
        expect(await fs.pathExists(path.join(root, 'instances', 'new1'))).toBe(false)
    })

    it('a peer cannot delete or overwrite an existing instance of this Engine', async () => {
        const root = await sb.addDisk('sdc1')
        await sb.addInstance(root, 'mine')
        const del = await sb.runGate([PEER], `sudo -n ${H} delete sdc1 mine`)
        expect(del.exitCode).toBe(2)
        const recv = await sb.runGate([PEER], `sudo -n ${H} receive sdc1 mine ${SRV}`)
        expect(recv.exitCode).toBe(2)
        expect(recv.stderr).toMatch(/already exists; a peer receive needs a new instance folder/)
        const files = await sb.runGate([PEER], `sudo -n ${H} receive-files sdc1 mine ${SRV}`)
        expect(files.exitCode).toBe(2)
        expect(await fs.readFile(path.join(root, 'instances', 'mine', 'compose.yaml'), 'utf8')).toBe('services: {}\n')
        expect(await sb.calls('rrsync')).toEqual([])
    })
})
