/**
 * idea-peer-gate-script.test.ts — the forced command of every peer Engine key
 *
 * sshd runs `idea-peer-gate <peerEngineId>` (the id from the root-owned
 * authorized_keys line) with the peer's request in SSH_ORIGINAL_COMMAND. The gate
 * allows only these calls of this Pi's app-data helper and maps them:
 *   version, ensure-dirs → peer-ensure-dirs <peer>, size <root> <id> (read-only, no ticket), receive → peer-receive <peer>, receive-files →
 *   peer-receive-files <peer>, receive-app → peer-receive-app <peer>, receive-service →
 *   peer-receive-service <peer> (engine#595, helper v26), delete → peer-delete <peer>
 * and refuses EVERYTHING else (exit 2, sudo never runs). Both `sudo` and
 * `/usr/bin/sudo` are accepted (rsync's --rsync-path and ssh send either).
 *
 * The sandbox's fake sudo records its argv and (unless FAKE_SUDO_EXIT is set) runs
 * the sandboxed helper, so the end-to-end cases go gate → sudo → helper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs, path } from 'zx'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'
import { remoteHelperCommand, remoteHelperRsyncPath, receiveAppArgs, receiveServiceArgs, receiveFilesArgs, deleteArgs, ensureDirsArgs, sizeArgs, APP_DATA_HELPER, APP_DATA_HELPER_VERSION } from '../../src/utils/appDataHelper.js'

let sb: AppDataSandbox
beforeEach(async () => { sb = await makeAppDataSandbox() })
afterEach(async () => { await fs.remove(sb.tmp) })

const H = '/usr/local/sbin/idea-app-data'
const SRV = '--server -logDtpre.iLsfxCIvu --numeric-ids . .'
const PEER = 'ENGINE_peer2'
const sudoArgv = async () => (await sb.calls('sudo')).map(c => c.argv)
const OPID = 'Ab3dEf5hJk7mNp9qRs1'
// what rsync sends the server for verify-send (a dry, itemized push)
const VSRV = '--server -nlHogDtpAXrxe.iLsfxCIvu --log-format=%i --numeric-ids . .'

describe('idea-peer-gate: the allow-list and its mapping', () => {
    const cases: [string, string[]][] = [
        [`sudo -n ${H} version`, ['version']],
        [`sudo -n ${H} ensure-dirs sdb1`, ['peer-ensure-dirs', PEER, 'sdb1']],
        [`sudo -n ${H} size sdb1 new1`, ['size', 'sdb1', 'new1']],
        [`sudo -n ${H} receive sdb1 new1 ${SRV}`, ['peer-receive', PEER, 'sdb1', 'new1', ...SRV.split(' ')]],
        [`sudo -n ${H} receive-files sdb1 new1 ${SRV}`, ['peer-receive-files', PEER, 'sdb1', 'new1', ...SRV.split(' ')]],
        [`sudo -n ${H} receive-app system kolibri-1.0 ${SRV}`, ['peer-receive-app', PEER, 'system', 'kolibri-1.0', ...SRV.split(' ')]],
        [`sudo -n ${H} receive-service sdb1 ${SRV}`, ['peer-receive-service', PEER, 'sdb1', ...SRV.split(' ')]],
        [`sudo -n ${H} delete sdb1 new1`, ['peer-delete', PEER, 'sdb1', 'new1']],
        [`/usr/bin/sudo -n ${H} delete sdb1 new1`, ['peer-delete', PEER, 'sdb1', 'new1']],
        // engine#497 (a, v23): always with the gate's own peer id, never one the caller names
        [`sudo -n ${H} mark-in-flight sdb1 new1 ${OPID}`, ['peer-mark-in-flight', PEER, 'sdb1', 'new1', OPID]],
        [`sudo -n ${H} clear-in-flight sdb1 new1 ${OPID}`, ['peer-clear-in-flight', PEER, 'sdb1', 'new1', OPID]],
        [`sudo -n ${H} receive sdb1 new1 ${OPID} ${SRV}`, ['peer-resume-receive', PEER, 'sdb1', 'new1', OPID, ...SRV.split(' ')]],
        [`/usr/bin/sudo -n ${H} verify-receive sdb1 new1 ${OPID} ${VSRV}`, ['peer-verify-receive', PEER, 'sdb1', 'new1', OPID, ...VSRV.split(' ')]],
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
            remoteHelperCommand(sizeArgs('sdb1', 'new1')).join(' '),
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
        [`sudo -n ${H} size sdb1`, /size takes exactly <root> <id>/],
        [`sudo -n ${H} size sdb1 new1 extra`, /size takes exactly <root> <id>/],
        [`sudo -n ${H} delete sdb1`, /delete takes exactly <root> <id>/],
        [`sudo -n ${H} delete sdb1 new1 new2`, /delete takes exactly <root> <id>/],
        [`sudo -n ${H} receive sdb1 new1`, /receive takes <root> <id> \[<opId>\] and the rsync server arguments/],
        // engine#497 (a, v23): the resumable receive, the marker verbs and the dry-run verify
        [`sudo -n ${H} receive sdb1 new1 ${OPID}`, /receive takes <root> <id> \[<opId>\] and the rsync server arguments/],
        [`sudo -n ${H} receive sdb1 new1 ${OPID} --server --sender . .`, /write-only/],
        [`sudo -n ${H} mark-in-flight sdb1 new1`, /mark-in-flight takes exactly <root> <id> <opId>/],
        [`sudo -n ${H} mark-in-flight sdb1 new1 ${OPID} ENGINE_other`, /mark-in-flight takes exactly <root> <id> <opId>/],
        [`sudo -n ${H} clear-in-flight sdb1 new1`, /clear-in-flight takes exactly <root> <id> <opId>/],
        [`sudo -n ${H} verify-receive sdb1 new1 ${OPID}`, /verify-receive takes <root> <id> <opId> and the rsync server arguments/],
        [`sudo -n ${H} verify-receive sdb1 new1 ${OPID} --server --sender -n . .`, /write-only/],
        [`sudo -n ${H} receive sdb1 new1 ${OPID} --server -nlogDtpre.iLsfxCIvu --log-format=%i . .`, /only verify-receive may carry --log-format=%i/],
        [`sudo -n ${H} verify-receive sdb1 new1 ${OPID} --server -n --log-format=%n . .`, /character outside/],
        [`sudo -n ${H} verify-receive sdb1 new1 ${OPID} --server -n --log-format=%i%n . .`, /character outside/],
        [`sudo -n ${H} receive sdb1 new1 -e sh . .`, /receive needs the rsync server arguments/],
        [`sudo -n ${H} receive sdb1 new1 --server --sender -logDtpre.iLsfxCIvu . .`, /write-only: --sender is not allowed/],
        [`sudo -n ${H} receive-files sdb1 new1 --server --sender . .`, /write-only/],
        [`sudo -n ${H} receive-app sdb1 kolibri-1.0 --server --sender . .`, /write-only/],
        [`sudo -n ${H} receive-service sdb1 --server --sender . .`, /write-only/],
        [`sudo -n ${H} receive-service sdb1`, /receive-service takes <root>/],
        // helper subcommands a peer must never reach directly
        ...['send', 'verify-send', 'peer-mark-in-flight', 'peer-clear-in-flight', 'peer-resume-receive', 'peer-verify-receive', 'copy', 'sync-peers', 'clear-peers', 'install-usage-key', 'peer-delete', 'peer-receive', 'peer-receive-files',
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
    it('version answers the helper protocol version (APP_DATA_HELPER_VERSION)', async () => {
        const r = await sb.runGate([PEER], `sudo -n ${H} version`)
        expect(r.exitCode, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe(`idea-app-data ${APP_DATA_HELPER_VERSION}`)
    })

    it('a receive is recorded for the peer named by the key; only that peer may delete it', async () => {
        const root = await sb.addDisk('sdc1')
        await sb.addTicket(PEER, 'sdc1', 'instance', 'new1')
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

    it('engine#497 (a): the resumable receive end to end — marked by the peer, resumed only by that peer and op, verified dry, cleared', async () => {
        const root = await sb.addDisk('sdc1')
        await sb.addTicket(PEER, 'sdc1', 'instance', 'new1')
        await sb.addTicket('ENGINE_peer3', 'sdc1', 'instance', 'new1', '-', 600, 'GrantPeer3333333')
        const marker = path.join(root, 'instances', 'new1.idea-op-in-flight')
        const mark = await sb.runGate([PEER], `sudo -n ${H} mark-in-flight sdc1 new1 ${OPID}`)
        expect(mark.exitCode, mark.stderr).toBe(0)
        expect(await fs.readFile(marker, 'utf8')).toMatch(new RegExp(`^opId=${OPID}\nengineId=${PEER}\ncreated=`))
        // a plain receive (or another peer) cannot take the marked id
        const plain = await sb.runGate([PEER], `sudo -n ${H} receive sdc1 new1 ${SRV}`)
        expect(plain.exitCode).toBe(2)
        expect(plain.stderr).toMatch(/IN_FLIGHT: .* only that operation resumes it/)
        const other = await sb.runGate(['ENGINE_peer3'], `sudo -n ${H} receive sdc1 new1 ${OPID} ${SRV}`)
        expect(other.exitCode).toBe(2)
        expect(other.stderr).toMatch(/IN_FLIGHT: .* belongs to Engine ENGINE_peer2, not ENGINE_peer3/)
        const otherMark = await sb.runGate(['ENGINE_peer3'], `sudo -n ${H} mark-in-flight sdc1 new1 Other0p`)
        expect(otherMark.exitCode).toBe(2)
        // the first push, then a half-written folder, then the resumed push of the same op
        const first = await sb.runGate([PEER], `sudo -n ${H} receive sdc1 new1 ${OPID} ${SRV}`)
        expect(first.exitCode, first.stderr).toBe(0)
        await fs.writeFile(path.join(root, 'instances', 'new1', 'half'), 'x')
        const again = await sb.runGate([PEER], `sudo -n ${H} receive sdc1 new1 ${OPID} ${SRV}`)
        expect(again.exitCode, again.stderr).toBe(0)
        expect(again.stderr).toMatch(/resume: .*new1 is not empty; continuing operation/)
        const wrongOp = await sb.runGate([PEER], `sudo -n ${H} receive sdc1 new1 Other0p ${SRV}`)
        expect(wrongOp.exitCode).toBe(2)
        expect(wrongOp.stderr).toMatch(/IN_FLIGHT: .* marks operation Ab3dEf5hJk7mNp9qRs1, not Other0p/)
        // the verify is a dry run only
        const wet = await sb.runGate([PEER], `sudo -n ${H} verify-receive sdc1 new1 ${OPID} ${SRV}`)
        expect(wet.exitCode).toBe(2)
        expect(wet.stderr).toMatch(/runs only a dry run/)
        const dry = await sb.runGate([PEER], `sudo -n ${H} verify-receive sdc1 new1 ${OPID} ${VSRV}`)
        expect(dry.exitCode, dry.stderr).toBe(0)
        const rr = await sb.calls('rrsync')
        expect(rr.map(c => c.argv)).toEqual([0, 1, 2].map(() => ['-wo', path.join(root, 'instances', 'new1')]))
        expect(rr[2].env.SSH_ORIGINAL_COMMAND).toBe(`rsync ${VSRV}`)
        // only the marking peer clears it (another peer is refused; absent is fine)
        expect((await sb.runGate(['ENGINE_peer3'], `sudo -n ${H} clear-in-flight sdc1 new1 ${OPID}`)).exitCode).toBe(2)
        expect(await fs.pathExists(marker)).toBe(true)
        const clear = await sb.runGate([PEER], `sudo -n ${H} clear-in-flight sdc1 new1 ${OPID}`)
        expect(clear.exitCode, clear.stderr).toBe(0)
        expect(await fs.pathExists(marker)).toBe(false)
        expect((await sb.runGate([PEER], `sudo -n ${H} clear-in-flight sdc1 new1 ${OPID}`)).exitCode).toBe(0)
        // without its marker the folder is no longer the peer's to resume into
        const after = await sb.runGate([PEER], `sudo -n ${H} receive sdc1 new1 ${OPID} ${SRV}`)
        expect(after.exitCode).toBe(2)
        expect(after.stderr).toMatch(/no in-flight marker/)
    })

    it('engine#497 (a): a peer can never mark an existing instance of this Engine', async () => {
        const root = await sb.addDisk('sdc1')
        await sb.addInstance(root, 'mine')
        await sb.addTicket(PEER, 'sdc1', 'instance', 'mine')
        const mark = await sb.runGate([PEER], `sudo -n ${H} mark-in-flight sdc1 mine ${OPID}`)
        expect(mark.exitCode).toBe(2)
        expect(mark.stderr).toMatch(/mine already exists; a peer marks only a new instance folder/)
        expect(await fs.pathExists(path.join(root, 'instances', 'mine.idea-op-in-flight'))).toBe(false)
        const resume = await sb.runGate([PEER], `sudo -n ${H} receive sdc1 mine ${OPID} ${SRV}`)
        expect(resume.exitCode).toBe(2)
        expect(await fs.readFile(path.join(root, 'instances', 'mine', 'compose.yaml'), 'utf8')).toBe('services: {}\n')
        expect(await sb.calls('rrsync')).toEqual([])
    })

    it('a peer cannot delete or overwrite an existing instance of this Engine', async () => {
        const root = await sb.addDisk('sdc1')
        await sb.addInstance(root, 'mine')
        await sb.addTicket(PEER, 'sdc1', 'instance', 'mine')
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

describe('idea-peer-gate end to end, helper v26 (engine#595): transfer tickets', () => {
    it('size (read-only, as in #598) needs no ticket and answers whether the folder exists', async () => {
        const root = await sb.addDisk('sdc1')
        await sb.addInstance(root, 'mine')
        const present = await sb.runGate([PEER], remoteHelperCommand(sizeArgs('sdc1', 'mine')).join(' '))
        expect(present.exitCode, present.stderr).toBe(0)
        expect(present.stdout.trim()).toMatch(/^[0-9]+$/)
        const missing = await sb.runGate([PEER], remoteHelperCommand(sizeArgs('sdc1', 'gone')).join(' '))
        expect(missing.exitCode).not.toBe(0)
        expect(missing.stderr).toMatch(/instance folder/)
        expect(missing.stderr).not.toMatch(/GRANT_EXPIRED/)
    })
    it('without a ticket every write through the gate is refused GRANT_EXPIRED and nothing is written; with one it goes through', async () => {
        const root = await sb.addDisk('sdc1')
        await fs.ensureDir(path.join(root, 'apps')); await fs.ensureDir(path.join(root, 'services'))
        const writes = [
            `sudo -n ${H} ensure-dirs sdc1`,
            `sudo -n ${H} mark-in-flight sdc1 new1 ${OPID}`,
            `sudo -n ${H} receive sdc1 new1 ${SRV}`,
            `sudo -n ${H} receive sdc1 new1 ${OPID} ${SRV}`,
            `sudo -n ${H} receive-files sdc1 new1 ${SRV}`,
            `sudo -n ${H} receive-app sdc1 kolibri-1.0 ${SRV}`,
            `sudo -n ${H} receive-service sdc1 ${SRV}`,
        ]
        for (const cmd of writes) {
            const r = await sb.runGate([PEER], cmd)
            expect(r.exitCode, cmd).toBe(2)
            expect(r.stderr).toMatch(/refused: GRANT_EXPIRED: Engine ENGINE_peer2 has no live permission from this Engine/)
        }
        expect(await fs.readdir(path.join(root, 'instances'))).toEqual([])
        expect(await fs.readdir(path.join(root, 'apps'))).toEqual([])
        expect(await sb.calls('rrsync')).toEqual([])
        // the Engine accepts the grant: tickets for the instance, the app master and the service images
        await sb.addTicket(PEER, 'sdc1', 'instance', 'new1', OPID)
        await sb.addTicket(PEER, 'sdc1', 'app', 'kolibri-1.0', OPID)
        await sb.addTicket(PEER, 'sdc1', 'services', '-', OPID)
        for (const cmd of [writes[0], writes[1], writes[3], writes[4], writes[5], writes[6]]) {
            const r = await sb.runGate([PEER], cmd)
            expect(r.exitCode, `${cmd}: ${r.stderr}`).toBe(0)
        }
        // another peer's key still gets nothing
        const other = await sb.runGate(['ENGINE_peer3'], `sudo -n ${H} receive-app sdc1 kolibri-1.0 ${SRV}`)
        expect(other.exitCode).toBe(2)
        expect(other.stderr).toMatch(/GRANT_EXPIRED: Engine ENGINE_peer3/)
    })
})
