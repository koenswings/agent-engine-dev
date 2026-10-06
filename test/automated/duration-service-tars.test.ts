/**
 * duration-service-tars.test.ts (idea#168 Stage 1)
 *
 * Fixture packs carry their services/*.tar (staged once per Pi by Atlas under
 * DURATION_SERVICE_TARS_ROOT; the harness only hard-links them into the slot), and the
 * start/readiness budgets allow for skipImageLoad: false (env-configurable, measured
 * durations logged). The remote scripts are run here with local bash in temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { $, fs } from 'zx'
import { serviceImageTarPath } from '../../src/data/Instance.js'
import {
    APP_PACK_SERVICE_TARS,
    DEFAULT_DURATION_SERVICE_TARS_ROOT,
    RealFleetOps,
    appPackServiceTars,
    buildEnsureServiceTarsRemote,
    buildSshDockCopyRemote,
    buildTreeDigestRemote,
    buildTreeSendRemote,
    parseEnsureServiceTars,
    serviceImageTarName,
    serviceTarsMode,
    serviceTarsRoot,
} from '../../test/duration/realFleetOps.js'
import {
    DEFAULT_COPY_DONE_MS,
    DEFAULT_DOCK_WAIT_MS,
    DEFAULT_INSTANCE_START_MS,
    copyDoneBudgetMs,
    dockWaitMs,
    envMs,
    instanceStartBudgetMs,
    logStartMeasured,
} from '../../test/duration/startBudgets.js'
import { nextcloudReadyTimeoutMs, waitNextcloudSidecarReadyForEngine } from '../../test/duration/actions.js'

$.verbose = false
const KOLIBRI = 'duration-kolibri-grade5a-001'
const NC = 'duration-nextcloud-grade5a-001'
const bash = (script: string) => $`bash -c ${script}`.nothrow()

let tmp: string
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dur-tars-')) })
afterEach(async () => { vi.restoreAllMocks(); await fs.remove(tmp) })

describe('pack service tars (definitions)', () => {
    it('tar names are the Engine serviceImageTarPath names; Kolibri 1 tar, Nextcloud 2; empty packs none', () => {
        for (const specs of Object.values(APP_PACK_SERVICE_TARS)) {
            for (const t of specs) {
                expect(`/d/services/${t.tar}`).toBe(serviceImageTarPath('/d', t.image))
                expect(serviceImageTarName(t.image)).toBe(t.tar)
            }
        }
        expect(appPackServiceTars(KOLIBRI).map(t => t.tar)).toEqual(['koenswings_kolibri:1.0-0.15.5-dev.tar'])
        expect(appPackServiceTars(NC).map(t => t.tar)).toEqual([
            'koenswings_nextcloud:1.0-31.0.1.tar',
            'koenswings_nextcloud-mariadb:1.0-11.7.2-MariaDB-ubu2404.tar',
        ])
        expect(appPackServiceTars('duration-empty-002')).toEqual([])
        const gb = (id: string) => appPackServiceTars(id).reduce((n, t) => n + t.approxBytes, 0) / 1e9
        expect(gb(KOLIBRI)).toBeCloseTo(1.62, 2)
        expect(gb(NC)).toBeCloseTo(2.51, 2)
    })

    it('DURATION_SERVICE_TARS (require default | off) and DURATION_SERVICE_TARS_ROOT (never /disks)', () => {
        expect(serviceTarsMode({})).toBe('require')
        expect(serviceTarsMode({ DURATION_SERVICE_TARS: 'off' })).toBe('off')
        expect(serviceTarsMode({ DURATION_SERVICE_TARS: 'require' })).toBe('require')
        expect(serviceTarsRoot({})).toBe(DEFAULT_DURATION_SERVICE_TARS_ROOT)
        expect(serviceTarsRoot({ DURATION_SERVICE_TARS_ROOT: '/home/pi/tars' })).toBe('/home/pi/tars')
        expect(() => serviceTarsRoot({ DURATION_SERVICE_TARS_ROOT: '/disks/sda1' })).toThrow(/outside \/disks/)
        expect(() => serviceTarsRoot({ DURATION_SERVICE_TARS_ROOT: 'rel/tars' })).toThrow()
    })

    it('RealFleetOps.serviceTarsFor: app packs with --start-instances only; off / empty / dock-only → null', () => {
        const prev = process.env.DURATION_SERVICE_TARS
        try {
            delete process.env.DURATION_SERVICE_TARS
            const start = new RealFleetOps({ poolEngines: ['idea01'], hosts: { idea01: 'a' }, startInstances: true })
            const dockOnly = new RealFleetOps({ poolEngines: ['idea01'], hosts: { idea01: 'a' } })
            expect(start.serviceTarsFor(NC)?.tars.length).toBe(2)
            expect(start.serviceTarsFor(NC)?.root).toBe(DEFAULT_DURATION_SERVICE_TARS_ROOT)
            expect(start.serviceTarsFor('duration-empty-001')).toBeNull()
            expect(dockOnly.serviceTarsFor(KOLIBRI)).toBeNull()
            process.env.DURATION_SERVICE_TARS = 'off'
            expect(start.serviceTarsFor(KOLIBRI)).toBeNull()
        } finally {
            if (prev === undefined) delete process.env.DURATION_SERVICE_TARS
            else process.env.DURATION_SERVICE_TARS = prev
        }
    })
})

describe('buildEnsureServiceTarsRemote (run with local bash)', () => {
    const tars = APP_PACK_SERVICE_TARS[NC]!
    const stage = async () => {
        const root = `${tmp}/staged`
        await fs.ensureDir(root)
        for (const t of tars) await fs.writeFile(`${root}/${t.tar}`, `tar of ${t.image}`)
        const slot = `${tmp}/idea-test-2`
        await fs.ensureDir(slot)
        return { root, slot }
    }

    it('hard-links each staged tar into slot/services (same inode); a second run keeps them; a stale file is replaced', async () => {
        const { root, slot } = await stage()
        const r1 = await bash(buildEnsureServiceTarsRemote(slot, root, tars))
        expect(r1.exitCode, r1.stderr).toBe(0)
        expect(parseEnsureServiceTars(r1.stdout).map(t => t.state)).toEqual(['linked', 'linked'])
        for (const t of tars) {
            expect((await fs.stat(`${slot}/services/${t.tar}`)).ino).toBe((await fs.stat(`${root}/${t.tar}`)).ino)
        }
        const r2 = await bash(buildEnsureServiceTarsRemote(slot, root, tars))
        expect(parseEnsureServiceTars(r2.stdout).map(t => t.state)).toEqual(['present', 'present'])
        await fs.remove(`${slot}/services/${tars[1]!.tar}`)
        await fs.writeFile(`${slot}/services/${tars[1]!.tar}`, 'partial')          // stale, other size
        const r3 = await bash(buildEnsureServiceTarsRemote(slot, root, tars))
        expect(parseEnsureServiceTars(r3.stdout).map(t => t.state)).toEqual(['present', 'linked'])
        expect(await fs.readFile(`${slot}/services/${tars[1]!.tar}`, 'utf8')).toBe(`tar of ${tars[1]!.image}`)
    })

    it('a missing staged tar → exit 5 naming it and its size; nothing outside the slot is written', async () => {
        const { root, slot } = await stage()
        await fs.remove(`${root}/${tars[0]!.tar}`)
        const before = await fs.readdir(root)
        const r = await bash(buildEnsureServiceTarsRemote(slot, root, tars))
        expect(r.exitCode).toBe(5)
        expect(r.stderr).toContain(`SERVICE_TAR_MISSING ${root}/koenswings_nextcloud:1.0-31.0.1.tar (koenswings/nextcloud:1.0-31.0.1, ~2.02 GB) — Atlas must stage it on this Pi`)
        expect(await fs.readdir(root)).toEqual(before)
    })
})

describe('dock copy script carries services/*.tar', () => {
    const args = (over: Record<string, unknown> = {}) => ({
        diskId: KOLIBRI, pack: 'kolibri', src: `${tmp}/pack`, dest: `${tmp}/disks/idea-test-1`,
        sentinel: `${tmp}/watch/idea-test-1`, disksRoot: `${tmp}/disks`, watchDir: `${tmp}/watch`,
        startInstances: true, serviceTars: { root: `${tmp}/staged`, tars: APP_PACK_SERVICE_TARS[KOLIBRI]! }, ...over,
    })

    it('app pack: tars linked before the sentinel fires, in the fresh-copy and the reuse path; empty packs and serviceTars=null: none', () => {
        const s = buildSshDockCopyRemote(args())
        const reuse = s.slice(s.indexOf('reuse existing Path A tree'), s.indexOf('exit 0; fi'))
        expect(reuse.indexOf('services/koenswings_kolibri:1.0-0.15.5-dev.tar')).toBeGreaterThan(0)
        expect(reuse.indexOf('services/koenswings_kolibri')).toBeLessThan(reuse.indexOf("touch '"))
        const fresh = s.slice(s.indexOf('META.yaml missing after copy'))
        expect(fresh.indexOf('ln -f')).toBeGreaterThan(0)
        expect(fresh.indexOf('ln -f')).toBeLessThan(fresh.indexOf("touch '"))
        expect(buildSshDockCopyRemote(args({ serviceTars: null }))).not.toContain('services/')
        expect(buildSshDockCopyRemote(args({ diskId: 'duration-empty-002', pack: 'empty-002' }))).not.toContain('SERVICE_TAR')
    })

    it('fresh copy of the Kolibri pack (local bash): slot gets META + instances + services/<tar> hard-linked, then the sentinel', async () => {
        await fs.ensureDir(`${tmp}/pack/instances/kolibri-grade5a-001`)
        await fs.writeFile(`${tmp}/pack/META.yaml`, `diskId: ${KOLIBRI}\n`)
        await fs.ensureDir(`${tmp}/staged`)
        await fs.writeFile(`${tmp}/staged/koenswings_kolibri:1.0-0.15.5-dev.tar`, 'kolibri image')
        const r = await bash(buildSshDockCopyRemote(args()))
        expect(r.exitCode, r.stderr).toBe(0)
        const dest = `${tmp}/disks/idea-test-1`
        expect(await fs.pathExists(`${dest}/instances/kolibri-grade5a-001`)).toBe(true)
        expect((await fs.stat(`${dest}/services/koenswings_kolibri:1.0-0.15.5-dev.tar`)).ino)
            .toBe((await fs.stat(`${tmp}/staged/koenswings_kolibri:1.0-0.15.5-dev.tar`)).ino)
        expect(await fs.pathExists(`${tmp}/watch/idea-test-1`)).toBe(true)
        expect(parseEnsureServiceTars(r.stdout)).toEqual([{ state: 'linked', tar: 'koenswings_kolibri:1.0-0.15.5-dev.tar', bytes: 13 }])
    }, 20_000)
})

describe('moveDisk does not stream services/ (tars re-linked on the target)', () => {
    it("send excludes ./services; the digest prunes ./services on both sides, so trees with and without tars match", async () => {
        expect(buildTreeSendRemote('/s', ['services'], 'never')).toContain("--exclude='./services'")
        const a = `${tmp}/a`, b = `${tmp}/b`
        for (const d of [a, b]) {
            await fs.ensureDir(`${d}/instances/x/data`)
            await fs.writeFile(`${d}/instances/x/data/db.sqlite3`, 'db')
            await fs.ensureDir(`${d}/apps/services`)                                   // a nested 'services' dir is still hashed
            await fs.writeFile(`${d}/apps/services/keep.txt`, 'k')
        }
        await fs.ensureDir(`${a}/services`)
        await fs.writeFile(`${a}/services/big.tar`, 'GBs')
        const digest = async (root: string, ex: string[]) =>
            (await bash(buildTreeDigestRemote(root, 'instances/x/data/db.sqlite3', 'never', [], ex))).stdout.trim()
        expect(await digest(a, ['services'])).toBe(await digest(b, ['services']))
        expect(await digest(a, [])).not.toBe(await digest(b, []))
        expect(await digest(a, ['services'])).toMatch(/^DIGEST files=2 /)
    })
})

describe('start / readiness budgets (skipImageLoad: false)', () => {
    it('defaults raised and env-configurable; Fake keeps short budgets', () => {
        expect(instanceStartBudgetMs({ fast: true, live: true }, {})).toBe(DEFAULT_INSTANCE_START_MS.fast)
        expect(instanceStartBudgetMs({ fast: false, live: true }, {})).toBe(600_000)
        expect(instanceStartBudgetMs({ fast: true, live: true }, { DURATION_INSTANCE_START_MS: '900000' })).toBe(900_000)
        expect(instanceStartBudgetMs({ fast: true, live: false }, { DURATION_INSTANCE_START_MS: '900000' })).toBe(800)
        expect(nextcloudReadyTimeoutMs({})).toBe(420_000)
        expect(copyDoneBudgetMs(true, {})).toBe(DEFAULT_COPY_DONE_MS.fast)
        expect(copyDoneBudgetMs(false, { DURATION_COPY_DONE_MS: '1200000' })).toBe(1_200_000)
        expect(dockWaitMs({})).toBe(DEFAULT_DOCK_WAIT_MS)
        expect(dockWaitMs({ DURATION_DOCK_WAIT_MS: '5' })).toBe(10_000)               // floor
        expect(envMs({ X: 'abc' }, 'X', 7)).toBe(7)
    })

    it('logStartMeasured writes one instance_start_measured JSON line; the Nextcloud wait logs its measured ready time', async () => {
        const lines: string[] = []
        logStartMeasured({ what: 'copy_op', engine: 'idea01', instanceId: 'k', ms: 1234, budgetMs: 300_000, opMs: 1100 }, l => lines.push(l))
        expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'instance_start_measured', what: 'copy_op', engine: 'idea01', ms: 1234, budgetMs: 300_000, opMs: 1100 })

        const logs: string[] = []
        vi.spyOn(console, 'log').mockImplementation((l: unknown) => { logs.push(String(l)) })
        let calls = 0
        const html = '<form><input name="user"><input name="password" type="password"><input type="submit" id="submit-form"></form>'
        const msg = await waitNextcloudSidecarReadyForEngine('idea01', {
            env: { DURATION_NEXTCLOUD_URL: 'http://idea01:18280' },
            hosts: { idea01: 'idea01' },
            fetchImpl: (async () => (++calls < 2 ? new Response('booting', { status: 503 }) : new Response(html, { status: 200 }))) as any,
            sleepImpl: async () => {},
        })
        expect(msg).toMatch(/login form ready after \d+ms, budget 420000ms/)
        const ev = logs.map(l => { try { return JSON.parse(l) } catch { return null } }).find(e => e?.event === 'instance_start_measured')
        expect(ev).toMatchObject({ what: 'nextcloud_ready', engine: 'idea01', budgetMs: 420_000 })
    })
})
