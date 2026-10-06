/**
 * app-data-helper.test.ts — the Engine side of the app-data root helper (idea#168)
 *
 *   - the helper argv builders refuse what the helper would refuse
 *   - runAppData runs `sudo -n /usr/local/sbin/idea-app-data …` (no shell) and turns
 *     failures into clear errors, with the "ask Ops to update" hint when sudo cannot run it
 *   - the startup version check (match / mismatch / missing; isDev skips)
 *   - rsyncInstanceData: argv, progress, errors, and cancel through cancelOperation
 *     (fake sudo execs the sandboxed helper, whose rsync sleeps)
 *   - the peer ssh argv (remote delete, remote ensure-dirs) with this Engine's own key
 *     and the peer's pinned host key (per-Pi Engine keys)
 *   - runAppDataWithInput (sync-peers): the peer set goes over stdin
 *
 * A fake `sudo` and `ssh` are first on PATH for this file.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { fs, os, path } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import {
    APP_DATA_HELPER, APP_DATA_HELPER_VERSION, sizeArgs, copyArgs, sendArgs, deleteArgs, eraseSlotArgs,
    borgInitArgs, borgInfoArgs, borgCreateArgs, borgExtractArgs, appDataSudoArgv, remoteDeleteSshArgs,
    runAppData, appDataErrorMessage, appDataHelperProblem, assertAppDataHelper,
    instanceDataBytes, deleteInstanceData, deleteRemoteInstanceData,
    remoteEnsureDirsSshArgs, ensureDirsArgs, receiveAppArgs, receiveServiceArgs, receiveFilesArgs,
    remoteHelperCommand, remoteHelperRsyncPath, runAppDataWithInput,
} from '../../src/utils/appDataHelper.js'
import { peerSshOptions } from '../../src/utils/peerSsh.js'
import { rsyncInstanceData, instanceDataTransferArgs } from '../../src/utils/rsync.js'
import { config } from '../../src/data/Config.js'
import { Store } from '../../src/data/Store.js'
import { EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { cancelOperation } from '../../src/data/Operations.js'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'

let tmp = ''
let savedPath = ''
const savedEnv: Record<string, string | undefined> = {}
const FAKE_VARS = ['FAKE_HELPER', 'FAKE_SUDO_OUT', 'FAKE_SUDO_ERR', 'FAKE_SUDO_EXIT', 'FAKE_RSYNC_SLEEP', 'FAKE_SSH_EXIT']

const sudoCalls = async (): Promise<string[][]> => {
    const f = path.join(tmp, 'sudo.log')
    if (!await fs.pathExists(f)) return []
    return (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
}

beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'app-data-helper-'))
    const bin = path.join(tmp, 'bin')
    await fs.ensureDir(bin)
    const record = (name: string) =>
        `${process.execPath} -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' ${path.join(tmp, name + '.log')} "$@"`
    await fs.writeFile(path.join(bin, 'sudo'), `#!/bin/bash
${record('sudo')}
[[ "$1" == -n && "$2" == ${APP_DATA_HELPER} ]] || exec /usr/bin/sudo "$@"
if [[ -n "\${FAKE_HELPER:-}" ]]; then shift 2; exec "$FAKE_HELPER" "$@"; fi
[[ -n "\${FAKE_SUDO_OUT:-}" ]] && printf '%s\\n' "$FAKE_SUDO_OUT"
[[ -n "\${FAKE_SUDO_ERR:-}" ]] && printf '%s\\n' "$FAKE_SUDO_ERR" >&2
exit \${FAKE_SUDO_EXIT:-0}
`, { mode: 0o755 })
    await fs.writeFile(path.join(bin, 'ssh'), `#!/bin/bash
${record('ssh')}
exit \${FAKE_SSH_EXIT:-0}
`, { mode: 0o755 })
    savedPath = process.env.PATH ?? ''
    process.env.PATH = `${bin}:${savedPath}`
    for (const v of FAKE_VARS) savedEnv[v] = process.env[v]
})

afterAll(async () => {
    process.env.PATH = savedPath
    await fs.remove(tmp)
})

beforeEach(async () => {
    for (const v of FAKE_VARS) delete process.env[v]
    await fs.remove(path.join(tmp, 'sudo.log'))
    await fs.remove(path.join(tmp, 'ssh.log'))
})
afterEach(() => {
    for (const v of FAKE_VARS) { if (savedEnv[v] === undefined) delete process.env[v]; else process.env[v] = savedEnv[v] }
})

describe('helper argv builders', () => {
    it('build the subcommand argv from tokens', () => {
        expect(sizeArgs('sdb1', 'inst-1')).toEqual(['size', 'sdb1', 'inst-1'])
        expect(copyArgs('system', 'inst-1', 'idea-test-2', 'abc123')).toEqual(['copy', 'system', 'inst-1', 'idea-test-2', 'abc123'])
        expect(sendArgs('sdb1', 'inst-1', 'idea04.local', 'ENGINE_idea04', 'sdc1', 'new1')).toEqual(['send', 'sdb1', 'inst-1', 'idea04.local', 'ENGINE_idea04', 'sdc1', 'new1'])
        expect(ensureDirsArgs('system')).toEqual(['ensure-dirs', 'system'])
        expect(receiveAppArgs('sdb1', 'kolibri-1.0')).toEqual(['receive-app', 'sdb1', 'kolibri-1.0'])
        expect(receiveServiceArgs('idea-test-2')).toEqual(['receive-service', 'idea-test-2'])
        expect(receiveFilesArgs('sdb1', 'new1')).toEqual(['receive-files', 'sdb1', 'new1'])
        expect(remoteHelperCommand(['version'])).toEqual(['sudo', '-n', '/usr/local/sbin/idea-app-data', 'version'])
        expect(remoteHelperRsyncPath(receiveAppArgs('sdb1', 'kolibri-1.0'))).toBe('sudo -n /usr/local/sbin/idea-app-data receive-app sdb1 kolibri-1.0')
        expect(deleteArgs('sdb2', 'x')).toEqual(['delete', 'sdb2', 'x'])
        expect(eraseSlotArgs('idea-test-4', '/home/pi/.local/state/idea-engine/erase-staging/id1')).toEqual(['erase-slot', 'idea-test-4', '/home/pi/.local/state/idea-engine/erase-staging/id1'])
        expect(() => eraseSlotArgs('sdb1', '/tmp/x')).toThrow(/not a test slot/)
        expect(borgInitArgs('sdc1', 'inst-1')).toEqual(['borg-init', 'sdc1', 'inst-1'])
        expect(borgInfoArgs('sdc1', 'inst-1')).toEqual(['borg-info', 'sdc1', 'inst-1'])
        expect(borgCreateArgs('sdc1', 'inst-1', '2026-10-06T10-18-00-123Z', 'system')).toEqual(['borg-create', 'sdc1', 'inst-1', '2026-10-06T10-18-00-123Z', 'system'])
        expect(borgExtractArgs('sdc1', 'inst-1', '2026-10-06T10-18-00-123Z', 3, 'sdb1')).toEqual(['borg-extract', 'sdc1', 'inst-1', '2026-10-06T10-18-00-123Z', '3', 'sdb1'])
        expect(appDataSudoArgv(['size', 'sdb1', 'x'])).toEqual(['-n', '/usr/local/sbin/idea-app-data', 'size', 'sdb1', 'x'])
    })

    it('the archive names backupInstance makes are accepted', () => {
        const name = new Date().toISOString().replace(/[:.]/g, '-')
        expect(borgCreateArgs('sdc1', 'inst-1', name, 'sdb1')[3]).toBe(name)
    })

    it('refuse paths, option-looking tokens and bad archives/strips before anything runs', () => {
        expect(() => sizeArgs('/disks/sdb1', 'x')).toThrow(/not a disk root/)
        expect(() => sizeArgs('..', 'x')).toThrow(/not a disk root/)
        expect(() => sizeArgs('sdb1', '../etc')).toThrow(/not an instance id/)
        expect(() => sizeArgs('sdb1', '-rf')).toThrow(/not an instance id/)
        expect(() => sendArgs('sdb1', 'x', '-oProxyCommand=x', 'ENGINE_a', 'sdc1', 'y')).toThrow(/not a host/)
        expect(() => sendArgs('sdb1', 'x', 'a b', 'ENGINE_a', 'sdc1', 'y')).toThrow(/not a host/)
        expect(() => sendArgs('sdb1', 'x', '10.0.0.4', '-oProxyCommand=x', 'sdc1', 'y')).toThrow(/not an Engine id/)
        expect(() => sendArgs('sdb1', 'x', '10.0.0.4', 'ENGINE a', 'sdc1', 'y')).toThrow(/not an Engine id/)
        expect(() => receiveAppArgs('sdb1', '../etc')).toThrow(/not an app id/)
        expect(() => receiveAppArgs('sdb1', 'kolibri..1')).toThrow(/not an app id/)
        expect(() => receiveAppArgs('sdb1', '-rf')).toThrow(/not an app id/)
        expect(() => receiveFilesArgs('sdb1', 'a/b')).toThrow(/not an instance id/)
        expect(() => borgCreateArgs('sdc1', 'x', 'latest', 'sdb1')).toThrow(/not a backup archive name/)
        expect(() => borgExtractArgs('sdc1', 'x', '2026-10-06T10-18-00-123Z', 0, 'sdb1')).toThrow(/out of range/)
        expect(() => borgExtractArgs('sdc1', 'x', '2026-10-06T10-18-00-123Z', 10, 'sdb1')).toThrow(/out of range/)
        expect(() => borgExtractArgs('sdc1', 'x', '2026-10-06T10-18-00-123Z', 1.5, 'sdb1')).toThrow(/out of range/)
    })

    it('instanceDataTransferArgs maps copy and send', () => {
        expect(instanceDataTransferArgs({ kind: 'copy', srcRoot: 'sdb1', srcId: 'a', dstRoot: 'sdc1', dstId: 'b' })).toEqual(['copy', 'sdb1', 'a', 'sdc1', 'b'])
        expect(instanceDataTransferArgs({ kind: 'send', srcRoot: 'sdb1', srcId: 'a', host: '192.168.1.4', peerEngineId: 'ENGINE_p', dstRoot: 'sdc1', dstId: 'b' })).toEqual(['send', 'sdb1', 'a', '192.168.1.4', 'ENGINE_p', 'sdc1', 'b'])
    })

    it('remoteDeleteSshArgs: ssh <Engine key, pinned host key> pi@host -- one remote command built from checked tokens', () => {
        expect(remoteDeleteSshArgs('idea04.local', 'ENGINE_idea04', 'idea-test-3', 'abc')).toEqual([
            'ssh', '-i', '/home/pi/.ssh/idea_engine_ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/etc/idea/peer_known_hosts',
            '-o', 'HostKeyAlias=ENGINE_idea04', '-o', 'ConnectTimeout=10', 'pi@idea04.local', '--',
            'sudo -n /usr/local/sbin/idea-app-data delete idea-test-3 abc',
        ])
        expect(() => remoteDeleteSshArgs('idea04', 'ENGINE_idea04', 'sdb1', 'x;reboot')).toThrow(/not an instance id/)
        expect(() => remoteDeleteSshArgs('idea04', 'ENGINE_idea04', '$(id)', 'x')).toThrow(/not a disk root/)
        expect(() => remoteDeleteSshArgs('idea04', 'ENGINE;id', 'sdb1', 'x')).toThrow(/not an Engine id/)
        expect(() => remoteDeleteSshArgs('-oProxyCommand=x', 'ENGINE_idea04', 'sdb1', 'x')).toThrow(/not a peer address/)
    })

    it('remoteEnsureDirsSshArgs: the peer helper\'s ensure-dirs <root>, never a plain mkdir/chown', () => {
        for (const root of ['system', 'sdb1', 'idea-test-2']) {
            const args = remoteEnsureDirsSshArgs('10.0.0.2', 'ENGINE_b', root)
            expect(args).toEqual(['ssh', ...peerSshOptions('ENGINE_b'), 'pi@10.0.0.2', '--', `sudo -n /usr/local/sbin/idea-app-data ensure-dirs ${root}`])
            expect(args.join(' ')).not.toMatch(/mkdir|chown|StrictHostKeyChecking=no/)
        }
    })
})

describe('runAppData (fake sudo)', () => {
    it('runs sudo -n /usr/local/sbin/idea-app-data <args> and returns stdout', async () => {
        process.env.FAKE_SUDO_OUT = '1234'
        expect(await runAppData(['size', 'sdb1', 'inst-1'])).toBe('1234\n')
        expect(await sudoCalls()).toEqual([['-n', '/usr/local/sbin/idea-app-data', 'size', 'sdb1', 'inst-1']])
    })

    it('instanceDataBytes is KB × 1024; garbage is an error', async () => {
        process.env.FAKE_SUDO_OUT = '2048'
        expect(await instanceDataBytes('sdb1', 'inst-1')).toBe(2048 * 1024)
        process.env.FAKE_SUDO_OUT = 'oops'
        await expect(instanceDataBytes('sdb1', 'inst-1')).rejects.toThrow(/gave no size: 'oops'/)
    })

    it('a refusal surfaces the helper\'s refused: line', async () => {
        process.env.FAKE_SUDO_ERR = 'idea-app-data: test-only root bridge: idea-test-1 -> /x\nrefused: destination /disks/sdc1/instances/x already exists and is not empty'
        process.env.FAKE_SUDO_EXIT = '2'
        await expect(deleteInstanceData('sdc1', 'x')).rejects.toThrow('idea-app-data delete refused: destination /disks/sdc1/instances/x already exists and is not empty')
    })

    it('sudo that cannot run the helper adds the "ask Ops to update" hint', async () => {
        process.env.FAKE_SUDO_ERR = 'sudo: a password is required'
        process.env.FAKE_SUDO_EXIT = '1'
        await expect(runAppData(['size', 'sdb1', 'x'])).rejects.toThrow(/exited with code 1: sudo: a password is required — ask Ops to update the Engine's root helper/)
    })

    it('appDataErrorMessage: signal, plain failure, bridge notes dropped', () => {
        expect(appDataErrorMessage('copy', null, 'SIGTERM', '')).toBe('idea-app-data copy stopped by SIGTERM')
        expect(appDataErrorMessage('copy', 23, null, 'idea-app-data: test-only root bridge: a -> b\nrsync error: some files could not be transferred')).toBe('idea-app-data copy exited with code 23: rsync error: some files could not be transferred')
        expect(appDataErrorMessage('send', 1, null, 'sudo: /usr/local/sbin/idea-app-data: command not found')).toMatch(/ask Ops to update/)
    })
})

describe('startup version check', () => {
    let wasDev: boolean
    beforeEach(() => { wasDev = config.settings.isDev; config.settings.isDev = false })
    afterEach(() => { config.settings.isDev = wasDev })

    it('passes when the helper reports this version', async () => {
        process.env.FAKE_SUDO_OUT = `idea-app-data ${APP_DATA_HELPER_VERSION}`
        expect(await appDataHelperProblem()).toBeNull()
        await expect(assertAppDataHelper()).resolves.toBeUndefined()
        expect((await sudoCalls())[0]).toEqual(['-n', '/usr/local/sbin/idea-app-data', 'version'])
    })

    it('refuses to start on a version mismatch, saying ask Ops to update', async () => {
        process.env.FAKE_SUDO_OUT = 'idea-app-data 0'
        await expect(assertAppDataHelper()).rejects.toThrow(new RegExp(
            `needs the app-data root helper /usr/local/sbin/idea-app-data version ${APP_DATA_HELPER_VERSION}, but the installed one reports 'idea-app-data 0'; ask Ops to update`,
        ))
    })

    it('refuses to start when the helper is missing or sudo will not run it', async () => {
        process.env.FAKE_SUDO_ERR = 'sudo: a password is required'
        process.env.FAKE_SUDO_EXIT = '1'
        await expect(assertAppDataHelper()).rejects.toThrow(/cannot be run with sudo -n .*ask Ops to update the Engine's root helper/)
    })

    it('the real helper script passes the check (fake sudo execs it)', async () => {
        const sb = await makeAppDataSandbox()
        try {
            process.env.FAKE_HELPER = sb.script
            expect(await appDataHelperProblem()).toBeNull()
        } finally { await fs.remove(sb.tmp) }
    })

    it('isDev skips the check (dev containers have no helper)', async () => {
        config.settings.isDev = true
        process.env.FAKE_SUDO_EXIT = '1'
        await expect(assertAppDataHelper()).resolves.toBeUndefined()
        expect(await sudoCalls()).toEqual([])
    })
})

describe('remote delete', () => {
    it('ssh <peer options> pi@<host> -- "sudo -n /usr/local/sbin/idea-app-data delete <root> <id>"', async () => {
        await deleteRemoteInstanceData('192.168.1.44', 'ENGINE_idea04', 'sdb1', 'new1')
        const calls = (await fs.readFile(path.join(tmp, 'ssh.log'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
        expect(calls).toEqual([[...peerSshOptions('ENGINE_idea04'), 'pi@192.168.1.44', '--', 'sudo -n /usr/local/sbin/idea-app-data delete sdb1 new1']])
    })
    it('a failing ssh rejects', async () => {
        process.env.FAKE_SSH_EXIT = '255'
        await expect(deleteRemoteInstanceData('192.168.1.44', 'ENGINE_idea04', 'sdb1', 'new1')).rejects.toThrow()
    })
})

describe('runAppDataWithInput (sync-peers)', () => {
    it('sudo -n idea-app-data sync-peers with the peer set on stdin; a refusal rejects with the refused: line', async () => {
        const sb = await makeAppDataSandbox()
        try {
            process.env.FAKE_HELPER = sb.script
            process.env.SUDO_USER = 'pi'
            const out = await runAppDataWithInput(['sync-peers'], '')
            expect(out.trim()).toBe('sync-peers: 0 peer(s); authorized_keys updated; known_hosts updated')
            expect(await sudoCalls()).toEqual([['-n', '/usr/local/sbin/idea-app-data', 'sync-peers']])
            await expect(runAppDataWithInput(['sync-peers'], 'garbage\n')).rejects.toThrow(/^idea-app-data sync-peers refused: peer line 1 is not/)
        } finally { await fs.remove(sb.tmp) }
    })
})

describe('rsyncInstanceData', () => {
    let sb: AppDataSandbox
    beforeEach(async () => {
        sb = await makeAppDataSandbox()
        process.env.FAKE_HELPER = sb.script
        process.env.SUDO_USER = 'pi'
        await sb.addInstance(await sb.addDisk('sdb1'), 'inst-1')
        await sb.addDisk('sdc1')
    })
    afterEach(async () => { await fs.remove(sb.tmp) })

    it('copy: sudo -n idea-app-data copy …, progress reported, data lands', async () => {
        const progress: number[] = []
        await rsyncInstanceData({ kind: 'copy', srcRoot: 'sdb1', srcId: 'inst-1', dstRoot: 'sdc1', dstId: 'new1' }, p => progress.push(p.progressPercent))
        expect(await sudoCalls()).toEqual([['-n', '/usr/local/sbin/idea-app-data', 'copy', 'sdb1', 'inst-1', 'sdc1', 'new1']])
        expect(progress).toContain(100)
        expect(await fs.pathExists(path.join(sb.disks, 'sdc1', 'instances', 'new1', 'compose.yaml'))).toBe(true)
    })

    it('send: sudo -n idea-app-data send … <host> …', async () => {
        await rsyncInstanceData({ kind: 'send', srcRoot: 'sdb1', srcId: 'inst-1', host: '10.0.0.4', peerEngineId: 'ENGINE_p4', dstRoot: 'sdc1', dstId: 'new1' })
        expect(await sudoCalls()).toEqual([['-n', '/usr/local/sbin/idea-app-data', 'send', 'sdb1', 'inst-1', '10.0.0.4', 'ENGINE_p4', 'sdc1', 'new1']])
        expect((await sb.calls('rsync'))[0].argv.at(-1)).toBe('pi@10.0.0.4:.')
    })

    it('a helper refusal rejects with the refused: line', async () => {
        await expect(rsyncInstanceData({ kind: 'send', srcRoot: 'sdb1', srcId: 'inst-1', host: '8.8.8.8', peerEngineId: 'ENGINE_p4', dstRoot: 'sdc1', dstId: 'new1' }))
            .rejects.toThrow(/^rsync \(idea-app-data send refused: host '8\.8\.8\.8' resolves to 8\.8\.8\.8, which is not a private LAN/)
    })

    it('cancelOperation SIGTERMs the running helper; the transfer rejects as cancelled', async () => {
        process.env.FAKE_RSYNC_SLEEP = '30'
        const repo = new Repo({ network: [], storage: undefined })
        const handle: DocHandle<Store> = repo.create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} })
        await handle.whenReady()
        handle.change(doc => {
            doc.operationDB['op-1'] = {
                id: 'op-1', kind: 'copyApp', args: {}, cause: 'console-command', subject: null,
                engineId: 'engine-test' as EngineID, status: 'Running', progressPercent: null, currentStep: null,
                totalSteps: null, stepLabel: null, startedAt: Date.now() as Timestamp, completedAt: null, error: null,
            } as any
        })
        const t0 = Date.now()
        const p = rsyncInstanceData({ kind: 'copy', srcRoot: 'sdb1', srcId: 'inst-1', dstRoot: 'sdc1', dstId: 'new1' }, undefined, 'op-1')
        for (let i = 0; i < 50 && (await sb.calls('rsync')).length === 0; i++) await new Promise(r => setTimeout(r, 100))
        expect(cancelOperation(handle, 'op-1')).toBeUndefined()
        await expect(p).rejects.toThrow('rsync cancelled (SIGTERM)')
        expect(Date.now() - t0).toBeLessThan(10_000)
        expect(handle.doc().operationDB['op-1'].status).toBe('Cancelled')
        expect(await sb.journalText()).toMatch(/sub=copy \(cancelled by SIGTERM\)/)
    }, 20_000)
})
