/**
 * r60 FAIL@59 (infra_reboot_engine, --fast pm2 restart of idea03): the harness removed the Nextcloud
 * containers, then read the store's PRE-restart "Running" and probed 1.5 s before the Engine re-processed
 * the disk. r61: no container removal on a Stage 2 --fast restart; for the restarted Pi wait until every
 * docked disk has lastDocked > restart time and every Running instance has all its containers Up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    DEFAULT_RESTART_RECONCILE_MS, evaluateRestartReconcile, parseDockerPs, restartReconcileBudgetMs, waitRestartReconciled,
} from '../duration/restartReconcile.js'
import { RealFleetOps } from '../duration/realFleetOps.js'
import { Stage2FleetOps } from '../duration/stage2FleetOps.js'
import type { SemanticStoreView } from '../duration/types.js'

const NC = 'duration-nextcloud-grade5a-001', E1 = 'duration-empty-001', K = 'duration-kolibri-grade5a-001'
const NI = 'nextcloud-grade5a-001', XI = 'kiwix-ideaa-001', COPY = 'd0goqyhhsasxl8y9exo', KI = 'kolibri-grade5a-001'
const T0 = 1791625224627 // r60: pm2 restart of idea03 (11:40:24 UTC+2)

const view = (o: { ncLast: number; e1Last?: number; nc: string; kx?: string; copy?: string }): SemanticStoreView => ({
    instanceDB: {
        [NI]: { id: NI, status: o.nc, diskId: NC, port: 61820 },
        [XI]: { id: XI, status: o.kx ?? 'Running', diskId: NC, port: 18480 },
        [COPY]: { id: COPY, status: o.copy ?? 'Running', diskId: NC, port: 62092 },
        [KI]: { id: KI, status: 'Running', diskId: K, port: 18080 }, // on idea01: not this Pi's business
    },
    diskDB: {
        [NC]: { id: NC, dockedTo: 'idea03', lastDocked: o.ncLast },
        [E1]: { id: E1, dockedTo: 'idea03', lastDocked: o.e1Last ?? o.ncLast },
        [K]: { id: K, dockedTo: 'idea01', lastDocked: 1 },
    },
    engineDB: {},
} as unknown as SemanticStoreView)
const ps = (nc: 'none' | 'created' | 'running') => [
    `${COPY}\t${COPY}-kolibri-1\trunning`,
    `${XI}\t${XI}-kiwix-1\trunning`,
    ...(nc === 'none' ? [] : [`${NI}\t${NI}-nextcloud-app-1\t${nc}`, `${NI}\t${NI}-nextcloud-db-1\trunning`]),
    `5l5zsyndcpsy18z0v9n\t5l5zsyndcpsy18z0v9n-kolibri-1\texited`,
].join('\n')

/** The r60 timeline on idea03, one store/docker read per 2 s poll from t0+12 s (WS back). */
const r60Io = () => {
    let t = T0 + 12_000
    const sleeps: number[] = []
    return {
        sleeps,
        io: {
            now: () => t,
            sleep: async (ms: number) => { sleeps.push(ms); t += ms },
            readStore: async () => t < T0 + 26_000 ? view({ ncLast: T0 - 60_000, nc: 'Running' }) // stale pre-restart Running
                : t < T0 + 33_000 ? view({ ncLast: T0 + 26_000, nc: 'Starting' })
                : t < T0 + 43_000 ? view({ ncLast: T0 + 26_000, nc: 'Starting' })
                : view({ ncLast: T0 + 26_000, nc: 'Running' }),
            dockerPs: async () => ps(t < T0 + 33_000 ? 'none' : 'running'),
        },
    }
}

afterEach(() => vi.restoreAllMocks())

describe('evaluateRestartReconcile', () => {
    it('stale pre-restart Running (lastDocked ≤ restart, no containers) is pending, not settled', () => {
        const ev = evaluateRestartReconcile(view({ ncLast: T0 - 1, nc: 'Running' }), 'idea03', T0, parseDockerPs(ps('none')))
        expect(ev.done).toBe(false)
        expect(ev.pending).toEqual(expect.arrayContaining([`disk ${NC} not re-processed since restart`, `${NI} Running but no containers`]))
    })
    it('reconciled disk but containers not all Up stays pending; all Up is done; other Pis are ignored', () => {
        expect(evaluateRestartReconcile(view({ ncLast: T0 + 1, nc: 'Running' }), 'idea03', T0, parseDockerPs(ps('created'))).pending)
            .toEqual([`${NI} Running but containers not all Up (${NI}-nextcloud-app-1:created)`])
        const ok = evaluateRestartReconcile(view({ ncLast: T0 + 1, nc: 'Running' }), 'idea03', T0, parseDockerPs(ps('running')))
        expect(ok.done).toBe(true)
        expect(ok.fields.join(' ')).not.toContain(KI)
    })
    it('Stopped/Paused-free Docked instances need no containers; Error is fatal', () => {
        expect(evaluateRestartReconcile(view({ ncLast: T0 + 1, nc: 'Stopped' }), 'idea03', T0, parseDockerPs(ps('none'))).done).toBe(true)
        expect(evaluateRestartReconcile(view({ ncLast: T0 + 1, nc: 'Error' }), 'idea03', T0, []).error).toBe(`${NI} is Error on idea03`)
    })
    it('budget: default 180 s, env override', () => {
        expect(restartReconcileBudgetMs({})).toBe(DEFAULT_RESTART_RECONCILE_MS)
        expect(restartReconcileBudgetMs({ DURATION_RESTART_RECONCILE_MS: '5000' })).toBe(5000)
    })
})

describe('waitRestartReconciled', () => {
    it('r60 replay: never accepts the stale Running; passes only once the disk is re-processed and NC containers are Up', async () => {
        const { io } = r60Io()
        const reads: number[] = []
        const note = await waitRestartReconciled('idea03', T0, { ...io, readStore: async () => { reads.push(io.now() - T0); return io.readStore() } })
        expect(note).toMatch(/restart reconciled on idea03/)
        expect(io.now()).toBeGreaterThanOrEqual(T0 + 43_000)
        expect(reads[0]).toBe(12_000)
    })
    it('never comes back: store Running, no containers → fails at the budget with a dump naming the instance', async () => {
        let t = T0
        await expect(waitRestartReconciled('idea03', T0, {
            now: () => t, sleep: async ms => { t += ms },
            readStore: async () => view({ ncLast: T0 + 26_000, nc: 'Running' }), dockerPs: async () => ps('none'),
        }, 10_000)).rejects.toThrow(new RegExp(`not done within 10000ms.*${NI} Running but no containers.*instance ${NI} status=Running disk=${NC} port=61820 containers=\\[none\\]`))
    })
    it('Error during start fails at once (no wait)', async () => {
        let t = T0, polls = 0
        await expect(waitRestartReconciled('idea03', T0, {
            now: () => t, sleep: async ms => { polls++; t += ms },
            readStore: async () => view({ ncLast: T0 + 1, nc: 'Error' }), dockerPs: async () => '',
        }, 60_000)).rejects.toThrow(/nextcloud-grade5a-001 is Error on idea03/)
        expect(polls).toBe(0)
    })
    it('read errors are retried until the budget, then reported', async () => {
        let t = T0
        await expect(waitRestartReconciled('idea03', T0, {
            now: () => t, sleep: async ms => { t += ms },
            readStore: async () => { throw new Error('ws down') }, dockerPs: async () => '',
        }, 4_000)).rejects.toThrow(/last error: ws down/)
    })
})

describe('--fast restart: no container removal in Stage 2; Stage 1 unchanged', () => {
    const HOSTS = { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' }
    const fakeRestart = (o: RealFleetOps, cmds: string[]) => {
        const anyO = o as unknown as Record<string, unknown>
        anyO.ssh = async (_h: string, c: string) => { cmds.push(c); return c.startsWith('docker ps -a --format "{{.Names}}"') ? `${NI}-nextcloud-app-1\n${KI}-kolibri-1` : '' }
        anyO.waitReady = async () => ({ wsUp: true })
        anyO.disconnect = async () => {}
        anyO.reconcileDurationZombies = async () => {}
        vi.spyOn(console, 'log').mockImplementation(() => {})
    }
    it('Stage 2 --fast: pm2 restart only — no docker stop/rm', async () => {
        const o = new Stage2FleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
        const cmds: string[] = []
        fakeRestart(o, cmds)
        await (RealFleetOps.prototype.rebootEngine).call(o, 'idea03', true)
        expect(cmds).toContain('pm2 restart engine')
        expect(cmds.some(c => /docker (stop|rm)|xargs -r docker/.test(c))).toBe(false)
    })
    it('Stage 1 --fast keeps its orphan hygiene (stop+rm duration fixtures)', async () => {
        const o = new RealFleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared' })
        const cmds: string[] = []
        fakeRestart(o, cmds)
        await o.rebootEngine('idea03', true)
        expect(cmds.some(c => /xargs -r docker rm/.test(c))).toBe(true)
        expect(cmds.indexOf('pm2 restart engine')).toBeGreaterThan(cmds.findIndex(c => /docker rm/.test(c)))
    })
    it('Stage2FleetOps.rebootEngine: reads the Pi clock first, then waits for reconcile after redock', async () => {
        const o = new Stage2FleetOps({ poolEngines: ['idea01', 'idea03', 'idea04'], hosts: HOSTS, storeMode: 'shared', sleep: async () => {} })
        const order: string[] = []
        vi.spyOn(o, 'piNowMs').mockImplementation(async () => { order.push('clock'); return T0 })
        vi.spyOn(RealFleetOps.prototype, 'rebootEngine').mockImplementation(async () => { order.push('restart') })
        vi.spyOn(o, 'redockAfterBoot').mockImplementation(async () => { order.push('redock') })
        vi.spyOn(o, 'readStore').mockImplementation(async () => { order.push('read'); return view({ ncLast: T0 + 26_000, nc: 'Running' }) })
        ;(o as unknown as { ssh: (h: string, c: string) => Promise<string> }).ssh = async () => ps('running')
        vi.spyOn(console, 'log').mockImplementation(() => {})
        await o.rebootEngine('idea03', true)
        expect(order).toEqual(['clock', 'restart', 'redock', 'read'])
        expect(o.redockLog.at(-1)).toMatch(/idea03: restart reconciled on idea03/)
    })
})
