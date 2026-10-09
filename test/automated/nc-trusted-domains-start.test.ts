/**
 * nc-trusted-domains-start.test.ts: the host identity an instance gets on every
 * start, and the Nextcloud post-start bridge (agent-engine-dev#163).
 *
 * r54 (Stage 2, idea03): a Nextcloud instance copied from idea01 started on
 * idea03 and answered 400 "Access through untrusted domain". Its .env had no
 * `hostname` / `ip`, and the old post-start occ hack never ran: both are gated on
 * store.appDB[instance.instanceOf].name === 'nextcloud', but instanceOf comes
 * from the instance compose (x-app version '1.0-duration' → 'nextcloud-1.0-duration')
 * while the app record is keyed by its apps/ folder ('nextcloud-1.0'). The lookup
 * missed and every Nextcloud step was skipped.
 *
 * These tests drive the real createInstanceContainers / runInstance with a fake
 * `docker` on PATH and fake network interfaces. They use only exports that exist
 * on main, so the same file runs there and fails.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Fake network interfaces for the host-identity code (Engine source imports 'os').
const fakeIfaces: { current: Record<string, any[]> } = { current: {} }
const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` })
vi.mock('os', async (importOriginal) => {
    const actual: any = await importOriginal()
    const networkInterfaces = () => fakeIfaces.current
    return { ...actual, networkInterfaces, default: { ...(actual.default ?? actual), networkInterfaces } }
})

import os from 'os'
import path from 'path'
import { fs } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { CommandLogStore, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { config, disksRoot } from '../../src/data/Config.js'
import { localEngineId } from '../../src/data/Engine.js'
import { createInstanceContainers, runInstance, Instance } from '../../src/data/Instance.js'
import { Disk, setRootDeviceForTests } from '../../src/data/Disk.js'
import { createTestStore } from '../harness/diskSim.js'

const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-fake-docker-nc-'))
const bin = path.join(fakeDir, 'bin')
const callsLog = path.join(fakeDir, 'calls.log')

/**
 * Fake docker: every call succeeds silently, except `docker exec`:
 *   - `occ-fail` marker present: fails (occ not ready / container gone);
 *   - `config:system:get` exits 1 (key not set, as occ does);
 *   - anything else succeeds.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
D="${fakeDir}"
echo "$*" >> "$D/calls.log"
if [ "$1" = "exec" ]; then
  if [ -e "$D/occ-fail" ]; then echo "Error response from daemon: container not running" >&2; exit 1; fi
  case "$*" in *config:system:get*) exit 1;; esac
fi
exit 0
`

const DEVICE = 'sdz9'
const savedPath = process.env.PATH
const saved = { dockerAvailable: config.settings.dockerAvailable, skipImageLoad: config.settings.skipImageLoad }
let handle: DocHandle<Store>

const NC_COMPOSE = `x-app:
  name: nextcloud
  version: 1.0-duration
services:
  nextcloud-app:
    image: nextcloud:31
  nextcloud-code:
    image: collabora/code
    extra_hosts:
      - \${hostname}.local:\${ip}
`
const OTHER_COMPOSE = `x-app:
  name: kolibri
  version: '1.0'
services:
  kolibri:
    image: kolibri
`

const instDir = (id: string) => `${disksRoot()}/${DEVICE}/instances/${id}`
const envOf = async (id: string) => fs.readFile(`${instDir(id)}/.env`, 'utf8')
const envVar = (env: string, k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]
const disk = { id: 'disk-nc-test', device: DEVICE } as unknown as Disk

/** An instance folder plus its store records; `appKey` is the appDB key (the apps/ folder id). */
const addInstance = async (id: string, compose: string, instanceOf: string, appKey: string, appName: string, env: string) => {
    await fs.mkdirp(instDir(id))
    await fs.writeFile(`${instDir(id)}/compose.yaml`, compose)
    await fs.writeFile(`${instDir(id)}/.env`, env)
    handle.change((doc: any) => {
        doc.diskDB[disk.id] = { id: disk.id, name: 'd', device: DEVICE, dockedTo: localEngineId, diskTypes: ['app'] }
        doc.appDB[appKey] = { id: appKey, name: appName, version: appKey.split('-').pop(), title: appName }
        doc.instanceDB[id] = { id, name: id, instanceOf, storedOn: disk.id, status: 'Starting', statusCondition: null, port: 0 }
    })
    return { id, name: id, instanceOf } as unknown as Instance
}

const onPi = (hostname: string, ifaces: Record<string, any[]>) => {
    handle.change((doc: any) => { doc.engineDB[localEngineId].hostname = hostname })
    fakeIfaces.current = ifaces
}

beforeAll(async () => {
    fs.mkdirpSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 })
    process.env.PATH = `${bin}:${savedPath}`
    config.settings.dockerAvailable = false
    config.settings.skipImageLoad = true
    setRootDeviceForTests('mmcblk-not-a-test-disk')
    const repo = new Repo({ network: [], storage: undefined })
    setCommandLogHandle(repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] }))
    ;({ storeHandle: handle } = await createTestStore())
})

afterAll(async () => {
    process.env.PATH = savedPath
    config.settings.dockerAvailable = saved.dockerAvailable
    config.settings.skipImageLoad = saved.skipImageLoad
    setRootDeviceForTests(null)
    await fs.remove(`${disksRoot()}/${DEVICE}`)
    await fs.remove(fakeDir)
})

describe('IDEA_HOSTNAME / IDEA_HOST_IPS on every start (#163 B-env)', () => {
    it('every app gets them, and they follow the instance to another Pi', async () => {
        // .env without a trailing newline: the new variables must not be glued onto pass=
        const inst = await addInstance('kolibri-env-1', OTHER_COMPOSE, 'kolibri-1.0', 'kolibri-1.0', 'kolibri', 'port=8080\npass=s3cret')
        onPi('idea01', {
            lo: [v4('127.0.0.1', true)],
            eth0: [v4('192.168.0.11')],
            docker0: [v4('172.17.0.1')],
            'br-1a2b': [v4('172.18.0.1')],
            tailscale0: [v4('100.64.0.11')],
            wlan0: [v4('10.0.0.11')],
        })
        await createInstanceContainers(handle, inst, disk)
        let env = await envOf(inst.id)
        expect(envVar(env, 'IDEA_HOSTNAME')).toBe('idea01')
        expect(envVar(env, 'IDEA_HOST_IPS')).toBe('192.168.0.11,10.0.0.11,100.64.0.11')
        expect(envVar(env, 'pass')).toBe('s3cret')
        expect(envVar(env, 'port')).toBe('8080')

        // The disk moves to idea03 (other LAN address, no Wi-Fi): next start rewrites both
        onPi('idea03.local', { lo: [v4('127.0.0.1', true)], eth0: [v4('192.168.0.13')], tailscale0: [v4('100.64.0.13')] })
        await createInstanceContainers(handle, inst, disk)
        env = await envOf(inst.id)
        expect(envVar(env, 'IDEA_HOSTNAME')).toBe('idea03')
        expect(envVar(env, 'IDEA_HOST_IPS')).toBe('192.168.0.13,100.64.0.13')
        expect(env.match(/^IDEA_HOSTNAME=/gm)?.length).toBe(1)
        expect(env.match(/^IDEA_HOST_IPS=/gm)?.length).toBe(1)
        expect(envVar(env, 'pass')).toBe('s3cret')
    })
})

describe('idea03 r54 regression: Nextcloud detected from the instance compose (#163)', () => {
    it('instance version 1.0-duration in apps/nextcloud-1.0 still gets hostname / ip / IDEA_*', async () => {
        // appDB only knows 'nextcloud-1.0'; instanceOf is 'nextcloud-1.0-duration' (as on idea03)
        const inst = await addInstance('nextcloud-dur-1', NC_COMPOSE, 'nextcloud-1.0-duration', 'nextcloud-1.0', 'nextcloud', 'port=18280\npass=x\n')
        expect(handle.doc()!.appDB[inst.instanceOf as any]).toBeUndefined()
        onPi('idea03', { eth0: [v4('192.168.0.13')], tailscale0: [v4('100.64.0.13')] })
        await createInstanceContainers(handle, inst, disk)
        const env = await envOf(inst.id)
        expect(envVar(env, 'hostname'), 'Collabora extra_hosts ${hostname}').toBe('idea03')
        expect(envVar(env, 'ip'), 'Collabora extra_hosts ${ip}').toBe('192.168.0.13')
        expect(envVar(env, 'IDEA_HOSTNAME')).toBe('idea03')
        expect(envVar(env, 'IDEA_HOST_IPS')).toBe('192.168.0.13,100.64.0.13')
    })
})

describe('Nextcloud post-start bridge (#163, TODO-remove)', () => {
    it('a failing occ never marks the instance Error, and there is no 20 s wait', async () => {
        // appDB key == instanceOf here, so main's old hack runs too (and marks Error after 20 s)
        const inst = await addInstance('nextcloud-br-1', NC_COMPOSE, 'nextcloud-1.0', 'nextcloud-1.0', 'nextcloud', 'pass=x\nip=192.168.0.13\nhostname=idea03\n')
        onPi('idea03', { eth0: [v4('192.168.0.13')] })
        fs.writeFileSync(path.join(fakeDir, 'occ-fail'), '')
        try {
            const t0 = Date.now()
            await runInstance(handle, inst, disk)
            const ms = Date.now() - t0
            const st = (handle.doc()!.instanceDB as any)[inst.id]
            expect(st.status, `status ${st.status} (${JSON.stringify(st.statusCondition)})`).toBe('Running')
            expect(st.statusCondition).toBeNull()
            expect(ms, 'no fixed 20 s sleep before occ').toBeLessThan(15_000)
        } finally {
            await fs.remove(path.join(fakeDir, 'occ-fail'))
        }
    }, 60_000)

    it('sets the full list for this Pi (no *.local:* / 192.168.0.*:* wildcards)', async () => {
        await fs.writeFile(callsLog, '')
        const inst = await addInstance('nextcloud-br-2', NC_COMPOSE, 'nextcloud-1.0', 'nextcloud-1.0', 'nextcloud', 'pass=x\nip=192.168.0.13\nhostname=idea03\n')
        onPi('idea03', { eth0: [v4('192.168.0.13')], tailscale0: [v4('100.64.0.13')] })
        await runInstance(handle, inst, disk)
        const calls = await fs.readFile(callsLog, 'utf8')
        const sets = calls.split('\n').filter(l => /config:system:set trusted_domains/.test(l)).map(l => l.replace(/^.*trusted_domains /, ''))
        expect(sets).toEqual([
            '0 --value=localhost', '1 --value=idea03', '2 --value=idea03.local',
            '3 --value=192.168.0.13', '4 --value=100.64.0.13',
        ])
        expect(calls).not.toMatch(/\*\.local:\*|192\.168\.0\.\*/)
        expect(calls).toMatch(/config:app:set --value=http:\/\/192\.168\.0\.13:9980 richdocuments wopi_url/)
        expect((handle.doc()!.instanceDB as any)[inst.id].status).toBe('Running')
    }, 60_000)
})
