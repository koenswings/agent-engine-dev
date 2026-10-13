/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * r86g FAIL@102 (cover-all-stage2-28ee0d9-r86g): move_app moved the step-43 copy rpvnt7m965adi3tzpk3
 * (idea03) onto empty-001 (op 2excyrtzvytbzn4tenu Done), but the post-step guard expected
 * kolibri-grade5a-001 (idea04:18080) and judged the leftover Nextcloud tab idea03.local:61820.
 * The post-op settle also sat 878 s in two reconnects (idea03 305 s, idea04 550 s).
 * Fixes: (1) expected instance = the instance the step acts on; (2) leftover-tab rule for every
 * Console-only step; (3) per-Pi timeout in the post-op settle.
 */
import { describe, expect, it } from 'vitest'
import { actedInstanceId, stage2AppUsesForStep } from '../duration/actions.js'
import { CONSOLE_ONLY_APP_ACTIONS, appTabProblems, type AppPin } from '../duration/appUrls.js'
import { settleAfterLongOp, postOpPiTimeoutMs, type PostOpSettleIo } from '../duration/postOpSettle.js'
import type { SemanticStoreView } from '../duration/types.js'

const FIX = 'kolibri-grade5a-001', COPY = 'rpvnt7m965adi3tzpk3'
const ctx = (action: string) => ({
    action, to: 'op_copy_move', fixtureInstance: FIX,
    fixtureInstances: { 'duration-kolibri-grade5a-001': FIX, 'duration-nextcloud-grade5a-001': 'nextcloud-grade5a-001' },
}) as any

describe('r86h (1): the guard expects the instance the step acted on', () => {
    it('move_app / copy_app / open_copied_instance follow DURATION_COPY_INSTANCE_ID (the Stage 2 pin)', () => {
        const env = { DURATION_COPY_INSTANCE_ID: COPY }
        for (const a of ['move_app', 'copy_app', 'open_copied_instance']) expect(actedInstanceId(a, FIX, FIX, env)).toBe(COPY)
        expect(stage2AppUsesForStep(ctx('move_app'), FIX, env)).toEqual([{ app: 'kolibri', instanceId: COPY, diskId: '' }])
    })
    it('without an override the ctx instance stays (Stage 1 / copy@43 unchanged)', () => {
        expect(stage2AppUsesForStep(ctx('copy_app'), FIX, {})).toEqual([{ app: 'kolibri', instanceId: FIX, diskId: 'duration-kolibri-grade5a-001' }])
    })
    it('open_app follows DURATION_START_INSTANCE_ID like the Console', () => {
        expect(actedInstanceId('open_app', FIX, FIX, { DURATION_START_INSTANCE_ID: 'x1' })).toBe('x1')
    })
    it('restore_from_backup: the Console restores the ctx instance; a differing DURATION_BACKUP_SOURCE_INSTANCE is refused', () => {
        expect(actedInstanceId('restore_from_backup', FIX, FIX, {})).toBe(FIX)
        expect(actedInstanceId('restore_from_backup', FIX, FIX, { DURATION_BACKUP_SOURCE_INSTANCE: FIX })).toBe(FIX)
        expect(() => actedInstanceId('restore_from_backup', FIX, FIX, { DURATION_BACKUP_SOURCE_INSTANCE: 'other' })).toThrow(/ignores that env.*Fail loud/)
    })
})

describe('r86h (2): leftover-tab rule on every Console-only step', () => {
    it('covers move/copy/backup/restore/eject/erase/start/stop/install/files steps, never open_app or App-opening steps', () => {
        for (const a of ['copy_app', 'move_app', 'restore_from_backup', 'backup_instance', 'eject_disk', 'confirm_eject', 'cancel_eject',
            'erase_disk', 'confirm_erase', 'cancel_erase', 'start_instance', 'stop_instance', 'open_instance_controls', 'open_copied_instance',
            'install_app', 'start_after_install', 'make_files_disk', 'add_files_role', 'make_backup_disk']) expect(CONSOLE_ONLY_APP_ACTIONS.has(a)).toBe(true)
        for (const a of ['open_app', 'open_kolibri_as_teacher', 'open_nextcloud_as_learner', 'keep_editing', 'open_wikipedia_as_teacher']) expect(CONSOLE_ONLY_APP_ACTIONS.has(a)).toBe(false)
    })
    const pin: AppPin = { app: 'kolibri', instanceId: COPY, engine: 'idea03', port: 52677, url: 'http://idea03:52677', hosts: ['idea03', 'idea03.local', '10.99.0.13'] }
    const leftover = { url: 'http://idea03.local:61820/apps/text', active: true, fresh: false, seq: 7 }
    it('the r86g case: untouched Nextcloud leftover tab is not move_app\'s App use', () => {
        expect(appTabProblems([leftover], [pin], ['idea01'], undefined, [leftover])).toEqual([])
    })
    it('a tab that navigated during the step is still judged (no blanket exemption)', () => {
        const moved = { ...leftover, url: 'http://idea04:18080/' }
        expect(appTabProblems([moved], [pin], ['idea01'], undefined, [leftover])).toHaveLength(1)
    })
})

describe('r86h (3): post-op settle per-Pi timeout', () => {
    const view = (e: string): SemanticStoreView => ({
        engineId: e, engineDB: {},
        instanceDB: { [COPY]: { id: COPY, status: 'Running', diskId: 'duration-empty-001' } } as any,
        diskDB: { 'duration-empty-001': { id: 'duration-empty-001', dockedTo: 'idea03' } } as any,
    })
    const never = () => new Promise<never>(() => {})
    const mk = (over: Partial<PostOpSettleIo>) => {
        const logs: string[] = []
        let t = 0
        const io: PostOpSettleIo = { engines: ['idea01', 'idea03', 'idea04'], readStore: async e => view(e), refresh: async () => true,
            sleep: async ms => { t += ms }, now: () => t, log: l => logs.push(l), ...over }
        return { io, logs }
    }
    it('default 150 s, env override', () => {
        expect(postOpPiTimeoutMs({})).toBe(150_000)
        expect(postOpPiTimeoutMs({ DURATION_POST_OP_PI_TIMEOUT_MS: '5000' })).toBe(5000)
    })
    it('a refresh that never answers (r86g idea04 550 s) → retried once, then fail loud naming the Pi', async () => {
        const calls: string[] = []
        const { io, logs } = mk({ refresh: async e => { calls.push(e); return e === 'idea04' ? never() : true } })
        const r = await settleAfterLongOp('move_app', [COPY], null, io, 60_000, 1, 60_000, 20)
        expect(r.ok).toBe(false)
        expect(r.note).toMatch(/idea04 store refresh did not answer within 20ms \(twice\).*fail loud/)
        expect(calls.filter(c => c === 'idea04')).toHaveLength(2)
        expect(logs.filter(l => l.includes('post_op_pi_timeout'))).toHaveLength(2)
    })
    it('a read that hangs once → reconnect that Pi → second read answers → settle ok', async () => {
        let hung = false
        const refreshed: string[] = []
        const { io } = mk({
            readStore: async e => { if (e === 'idea03' && !hung) { hung = true; return never() } return view(e) },
            refresh: async e => { refreshed.push(e); return true },
        })
        const r = await settleAfterLongOp('move_app', [COPY], null, io, 60_000, 1, 60_000, 20)
        expect(r.ok).toBe(true)
        expect(refreshed.filter(e => e === 'idea03').length).toBeGreaterThanOrEqual(2) // initial + reconnect
    })
    it('a read that keeps hanging after the reconnect → fail loud', async () => {
        const { io } = mk({ readStore: async e => (e === 'idea03' ? never() : view(e)) })
        const r = await settleAfterLongOp('move_app', [COPY], null, io, 60_000, 1, 60_000, 20)
        expect(r.ok).toBe(false)
        expect(r.note).toMatch(/idea03 store read timed out twice/)
    })
})
