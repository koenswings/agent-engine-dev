/**
 * r59 (r58 FAIL@58): after dock/redock/move/copy/reboot/restore steps the harness waits until every instance
 * on a docked disk has settled (left Undocked/Starting; port when Running) before pinning URLs or using Apps.
 * Bounded, with a field dump; Error fails at once; no user action is retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchAction, resyncFixtureSidecarUrlsFromStore, settleAfterStep } from '../duration/actions.js'
import { SETTLE_AFTER_ACTIONS, evaluateInstances, waitInstancesSettled } from '../duration/instanceSettle.js'

const K = 'duration-kolibri-grade5a-001', NC = 'duration-nextcloud-grade5a-001'
const KI = 'kolibri-grade5a-001', NI = 'nextcloud-grade5a-001', XI = 'kiwix-ideaa-001', COPY = '5z9f9sz0wt25354rwqr'
const HOSTS = { idea01: '10.0.0.1', idea03: '10.0.0.3', idea04: '10.0.0.4' }
type Inst = { diskId: string; port?: number; status: string }

/** r58 replay: the Engine starts copy → kiwix → nextcloud one after another; each read advances the clock. */
const r58Sequence = (): Record<string, Inst>[] => {
    const base = (copy: Inst['status'], kx: Inst['status'], nc: Inst['status']): Record<string, Inst> => ({
        [KI]: { diskId: K, port: 18080, status: 'Running' },
        [COPY]: { diskId: NC, port: 60738, status: copy },
        [XI]: { diskId: NC, port: 18480, status: kx },
        [NI]: { diskId: NC, ...(nc === 'Running' ? { port: 61820 } : {}), status: nc },
    })
    return [
        base('Starting', 'Undocked', 'Undocked'),
        base('Running', 'Starting', 'Undocked'),
        base('Running', 'Running', 'Starting'),
        base('Running', 'Running', 'Running'),
    ]
}

const mkOps = (frames: Record<string, Inst>[], perEngineReadsPerFrame = 3) => {
    let reads = 0
    const ops = {
        stage: 2,
        readStore: async () => {
            const f = frames[Math.min(frames.length - 1, Math.floor(reads++ / perEngineReadsPerFrame))]!
            return {
                instanceDB: Object.fromEntries(Object.entries(f).map(([id, i]) => [id, { id, ...i }])),
                diskDB: { [K]: { id: K, dockedTo: 'idea01' }, [NC]: { id: NC, dockedTo: 'idea03' } },
                engineDB: {},
            }
        },
        findDockedEngine: async (d: string) => (d === K ? 'idea01' : d === NC ? 'idea03' : null),
        verifySidecarOwner: vi.fn(async (_e: string, i: string) => [`${i}-app-1`]),
        getHostMap: () => HOSTS,
        getStoreMode: () => 'unique',
    }
    return ops
}
const ctxFor = (ops: unknown, action: string, driver?: unknown) => ({
    action, from: 'x', to: 'y',
    opts: { ops, uiDriver: driver, fast: true, settleTimeoutMs: 50, rng: () => 0 },
    walker: { dockedEngine: 'idea01', step: 57, layer: 'infra' },
    poolEngines: ['idea01', 'idea03', 'idea04'], excludeEngines: ['idea02'],
    fixtureDisk: K, fixtureInstance: KI,
    fixtureDisks: [K, NC],
    fixtureInstances: { [K]: KI, [NC]: NI },
}) as never

const KEYS = ['DURATION_KOLIBRI_URL', 'DURATION_NEXTCLOUD_URL', 'DURATION_KIWIX_URL', 'DURATION_INSTANCE_SETTLE_MS', 'DURATION_INSTANCE_SETTLE_POLL_MS']
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
    process.env.DURATION_INSTANCE_SETTLE_POLL_MS = '1'
    vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    vi.restoreAllMocks()
})

describe('r59: r58 replay — 3 instances on the NC disk start one after another', () => {
    it('URL resync waits until nextcloud-grade5a-001 has its port (r58: "has no port in the store")', async () => {
        const ops = mkOps(r58Sequence())
        const note = await resyncFixtureSidecarUrlsFromStore(ctxFor(ops, 'infra_dock_fixture'), process.env, { ownerCheck: false })
        expect(note).toMatch(/instances settled after \d+ms/)
        expect(note).toMatch(/DURATION_NEXTCLOUD_URL=http:\/\/idea03:61820/)
    })
})

describe('r59: bounded, loud, never hides a real start failure', () => {
    const fake = (frames: Record<string, Inst>[]) => {
        let t = 0
        const ops = mkOps(frames, 1)
        return { engines: ['idea01', 'idea03'], readStore: ops.readStore as never, now: () => t, sleep: async (ms: number) => { t += ms }, pollMs: 1_000 }
    }
    it('stuck Starting → fails at the budget with a field dump (status, port, disk per instance)', async () => {
        const stuck = { [KI]: { diskId: K, port: 18080, status: 'Running' }, [NI]: { diskId: NC, status: 'Starting' } }
        await expect(waitInstancesSettled('step 58', fake([stuck]), 10_000)).rejects.toThrow(
            /did not settle within 10000ms .*pending: nextcloud-grade5a-001 status=Starting port=- disk=duration-nextcloud-grade5a-001 on idea03.*All instances: .*kolibri-grade5a-001 status=Running port=18080/,
        )
    })
    it('Error fails at once (no waiting out the budget), with the dump', async () => {
        const f = fake([{ [NI]: { diskId: NC, port: 61820, status: 'Error' } }])
        const t0 = Date.now()
        await expect(waitInstancesSettled('step 100', f, 300_000)).rejects.toThrow(/instance start FAILED \(status Error\) — nextcloud-grade5a-001 status=Error port=61820/)
        expect(Date.now() - t0).toBeLessThan(1_000)
    })
    it('Running without a port is not settled; Stopped / Docked / Missing are; Undocked on an undocked disk is ignored', () => {
        const v = (insts: Record<string, Inst>) => evaluateInstances({
            idea03: {
                engineId: 'idea03',
                instanceDB: Object.fromEntries(Object.entries(insts).map(([id, i]) => [id, { id, ...i }])),
                diskDB: { [NC]: { id: NC, dockedTo: 'idea03' }, gone: { id: 'gone', dockedTo: null } },
                engineDB: {},
            } as never,
        })
        expect(v({ a: { diskId: NC, status: 'Running' } }).kind).toBe('waiting')
        expect(v({ a: { diskId: NC, status: 'Stopped' }, b: { diskId: NC, status: 'Docked' }, c: { diskId: NC, status: 'Missing' } }).kind).toBe('settled')
        expect(v({ a: { diskId: 'gone', status: 'Undocked' } }).kind).toBe('settled')
    })
})

describe('r59: wait after every dock / redock / move / copy / reboot / restore step type', () => {
    it('audit: the step types of cover-all that change instances are all covered', () => {
        for (const a of ['infra_dock_fixture', 'infra_reboot_engine', 'infra_move_disk', 'copy_app', 'move_app', 'restore_from_backup', 'reboot_engine',
            'start_after_install', 'start_instance', 'backup_instance', 'make_backup_disk', 'make_files_disk', 'add_files_role', 'cancel_eject', 'notice_usb_dock', 'confirm_erase']) {
            expect(SETTLE_AFTER_ACTIONS.has(a), a).toBe(true)
        }
        expect(SETTLE_AFTER_ACTIONS.has('open_kolibri_as_teacher')).toBe(false)
    })
    const uiTypes = ['copy_app', 'restore_from_backup', 'reboot_engine', 'start_instance', 'cancel_eject', 'notice_usb_dock']
    for (const action of uiTypes) {
        it(`${action}: after an ok Intent the step waits; an instance stuck Starting fails the step with the dump`, async () => {
            process.env.DURATION_INSTANCE_SETTLE_MS = '1000'
            const driver = { kind: 'stub', runIntent: vi.fn(async () => ({ ok: true, mode: 'stub', message: `ok ${action}` })) }
            const settled = mkOps(r58Sequence(), 1)
            const r1 = await dispatchAction(ctxFor(settled, action, driver))
            if (r1.ok) expect(r1.message).toMatch(/instance settle|instances settled/)
            const stuck = mkOps([{ [NI]: { diskId: NC, status: 'Starting' } }], 1)
            const r2 = await dispatchAction(ctxFor(stuck, action, driver))
            expect(r2.ok).toBe(false)
            expect(r2.message).toMatch(/nextcloud-grade5a-001 status=Starting/)
        })
    }
    // Step types whose own live pre-checks need a fuller fake: the post-step hook itself, per type.
    for (const action of ['infra_dock_fixture', 'infra_reboot_engine', 'infra_move_disk', 'move_app', 'start_after_install', 'backup_instance',
        'make_backup_disk', 'make_files_disk', 'add_files_role', 'confirm_erase']) {
        it(`${action}: settle hook waits through the r58 sequence, and fails a stuck Starting with the dump`, async () => {
            process.env.DURATION_INSTANCE_SETTLE_MS = '1000'
            const ok = { ok: true, message: `ok ${action}` }
            const r1 = await settleAfterStep(ctxFor(mkOps(r58Sequence(), 1), action), ok)
            expect(r1.ok, r1.message).toBe(true)
            expect(r1.message).toMatch(/instances settled after \d+ms \(4: /)
            const r2 = await settleAfterStep(ctxFor(mkOps([{ [NI]: { diskId: NC, status: 'Starting' } }], 1), action), ok)
            expect(r2.ok).toBe(false)
            expect(r2.message).toMatch(/did not settle .*nextcloud-grade5a-001 status=Starting port=- disk=duration-nextcloud-grade5a-001 on idea03/)
        })
    }
    it('a failed step is returned untouched (no extra wait, no retry); non-settle steps skip the wait', async () => {
        const ops = mkOps([{ [NI]: { diskId: NC, status: 'Starting' } }], 1)
        const bad = { ok: false, message: 'Intent failed' }
        expect(await settleAfterStep(ctxFor(ops, 'copy_app'), bad)).toBe(bad)
        const plain = { ok: true, message: 'ok' }
        expect(await settleAfterStep(ctxFor(ops, 'open_kolibri_as_teacher'), plain)).toBe(plain)
    })
})
