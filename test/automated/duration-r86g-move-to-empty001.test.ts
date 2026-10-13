/**
 * r86f FAIL@102 → Steve option (A). After @62 the Kolibri fixture sits on idea04 next to only the Backup
 * Disk, so no same-Pi move target exists. Stage 2 move_app now moves the step-43 copy (Nextcloud disk,
 * idea03) onto duration-empty-001 (idea03) between Files (@88–@92) and Erase (@104–@122).
 * On-Pi check 2026-10-12: Engine f194fb5 accepted `moveApp 8dy1euovy7hlkn5uq9y duration-nextcloud-grade5a-001
 * duration-empty-001` (op moul3p35tlq5rdfwtk2 Done, FILES.yaml intact, diskTypes [files]).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newCopyInstanceId, pinEnv, stage2MoveAppPins, stage2RedockSharedEraseDisk } from '../duration/actions.js'
import { STAGE2_ROLE_MAP, STAGE2_SEQUENTIAL_SHARES, describeStage2Windows, stage2RoleTimeline, stage2RoleWindows } from '../duration/stage2.js'
import { loadWalk } from '../duration/scenario.js'
const steps = (n: string) => loadWalk(n).steps as { action: string }[]

const E1 = 'duration-empty-001'
const COVER_ALL = steps('cover-all')
const ctx = (action: string, copy?: string | null, stage = 2) =>
    ({ action, walker: { step: 102, stage2CopyInstanceId: copy ?? null }, opts: { ops: { stage } } }) as never

describe('r86g (A): Stage 2 role map — empty-001 Files → move target → Erase', () => {
    it('moveApp role is empty-001, its window is move_app only, and the cover-all timeline fits', () => {
        expect(STAGE2_ROLE_MAP.moveApp).toBe(E1)
        expect(STAGE2_SEQUENTIAL_SHARES).toEqual(expect.arrayContaining([['files', 'moveApp'], ['moveApp', 'erase']]))
        const w = stage2RoleWindows(COVER_ALL)
        const files = w.find(x => x.role === 'files')!, mv = w.find(x => x.role === 'moveApp')!, er = w.find(x => x.role === 'erase')!
        expect(files.to).toBeLessThan(mv.from)
        expect(mv.to).toBeLessThan(er.from)
        expect(stage2RoleTimeline(COVER_ALL)).toEqual([])
        expect(describeStage2Windows(COVER_ALL)).toMatch(new RegExp(`moveApp=${E1}@`))
    })
    it('move_app inside the Files window is an overlap; Erase before move is not an allowed share', () => {
        expect(stage2RoleTimeline([{ action: 'install_app' }, { action: 'make_files_disk' }, { action: 'move_app' }, { action: 'install_app' }, { action: 'make_files_disk' }]).map(c => c.kind)).toContain('overlap')
        expect(stage2RoleTimeline([{ action: 'erase_disk' }, { action: 'confirm_erase' }, { action: 'move_app' }]).map(c => c.kind)).toContain('share')
    })
})

describe('r86g (A): move_app pins the step-43 copy onto empty-001 (Stage 2 only; env wins)', () => {
    it('Stage 2: recorded copy + empty-001', () => {
        expect(stage2MoveAppPins(ctx('move_app', '8dy1euovy7hlkn5uq9y'), {})).toEqual({
            instanceId: '8dy1euovy7hlkn5uq9y', targetDiskId: E1,
            set: { DURATION_COPY_INSTANCE_ID: '8dy1euovy7hlkn5uq9y', DURATION_COPY_TARGET_DISK: E1 },
        })
    })
    it('env overrides win and are not overwritten', () => {
        expect(stage2MoveAppPins(ctx('move_app', 'rec'), { DURATION_COPY_INSTANCE_ID: 'mine', DURATION_COPY_TARGET_DISK: 'disk-x' }))
            .toEqual({ instanceId: 'mine', targetDiskId: 'disk-x', set: {} })
        expect(stage2MoveAppPins(ctx('move_app', 'rec'), { DURATION_COPY_TARGET_DISK: 'disk-x' })!.set).toEqual({ DURATION_COPY_INSTANCE_ID: 'rec' })
    })
    it('Stage 1 and other actions: unchanged (null)', () => {
        expect(stage2MoveAppPins(ctx('move_app', 'rec', 1), {})).toBeNull()
        expect(stage2MoveAppPins(ctx('copy_app', 'rec'), {})).toBeNull()
    })
    it('no recorded copy and no override: fail loud, never the cross-Pi Kolibri fixture', () => {
        expect(() => stage2MoveAppPins(ctx('move_app', null), {})).toThrow(/no step-43 copy recorded.*Fail loud/)
    })
    it('the copy id is resolved dynamically: exactly one new pool id, else null', () => {
        expect(newCopyInstanceId(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe('c')
        expect(newCopyInstanceId(new Set(['a']), new Set(['a']))).toBeNull()
        expect(newCopyInstanceId(new Set(['a']), new Set(['a', 'c', 'd']))).toBeNull()
    })
    it('pinEnv restores prior values (set and unset)', () => {
        const env: NodeJS.ProcessEnv = { DURATION_COPY_TARGET_DISK: 'old' }
        const restore = pinEnv({ DURATION_COPY_TARGET_DISK: E1, DURATION_COPY_INSTANCE_ID: 'x' }, env)
        expect(env).toMatchObject({ DURATION_COPY_TARGET_DISK: E1, DURATION_COPY_INSTANCE_ID: 'x' })
        restore()
        expect(env).toEqual({ DURATION_COPY_TARGET_DISK: 'old' })
    })
})

describe('r86g (A): erase_disk@104 fresh re-dock clears the moved instance (eject first, fail loud)', () => {
    const mkOps = (afterEject: { id: string; status: string; currentStep: null }[]) => {
        const order: string[] = []
        let undocked = false, purged = false
        const view = () => ({
            diskDB: { [E1]: { id: E1, dockedTo: undocked && !purged ? null : 'idea03', diskTypes: purged ? ['empty'] : ['files'] } },
            instanceDB: purged ? {} : { '8dy1euovy7hlkn5uq9y': { id: '8dy1euovy7hlkn5uq9y', diskId: E1, status: undocked ? 'Undocked' : 'Running' } },
            engineDB: {}, appDB: {},
        })
        const ops = {
            stage: 2,
            getStoreMode: () => 'shared',
            waitReady: async () => {},
            readStore: async () => view(),
            findDockedEngine: async () => (undocked && !purged ? null : 'idea03'),
            waitDiskUndocked: async () => {},
            diskInstancesRaw: async () => {
                if (purged) return []
                if (!undocked) { order.push('read:docked'); return [{ id: '8dy1euovy7hlkn5uq9y', status: 'Running', currentStep: null }] }
                order.push('read:undocked'); return afterEject
            },
            undockFixtures: async () => { order.push('undock'); undocked = true },
            purgeInstancesStoredOn: async () => { order.push(undocked ? 'purge:undocked' : 'purge:DOCKED'); purged = true },
            // Stop right after the re-dock: the participant settle that follows is covered elsewhere (r82b).
            dockFixture: async () => { order.push('dock'); throw new Error('STOP-after-dock') },
        }
        return { ops, order }
    }
    let prevStage: string | undefined, prevErase: string | undefined
    beforeEach(() => { prevStage = process.env.DURATION_STAGE; prevErase = process.env.DURATION_ERASE_DISK_ID; process.env.DURATION_STAGE = '2'; delete process.env.DURATION_ERASE_DISK_ID })
    afterEach(() => {
        if (prevStage === undefined) delete process.env.DURATION_STAGE; else process.env.DURATION_STAGE = prevStage
        if (prevErase !== undefined) process.env.DURATION_ERASE_DISK_ID = prevErase
    })
    const ctxFor = (ops: unknown) => ({
        opts: { ops, rng: () => 0, settleTimeoutMs: 50, fast: true },
        walker: { current: 'op_disk', layer: 'operator' as const, dockedEngine: 'idea03', step: 104, pendingInstallDisk: null },
        from: 'op_disk', to: 'op_disk', action: 'erase_disk',
        excludeEngines: ['idea02'], poolEngines: ['idea01', 'idea03', 'idea04'],
        fixtureDisk: E1, fixtureInstance: '', fixtureDisks: [E1],
    })
    it('Running moved copy: eject (stops it) → rows settle → purge → dock; never purged while docked', async () => {
        const { ops, order } = mkOps([{ id: '8dy1euovy7hlkn5uq9y', status: 'Undocked', currentStep: null }])
        await expect(stage2RedockSharedEraseDisk(ctxFor(ops) as never)).rejects.toThrow('STOP-after-dock')
        expect(order).not.toContain('purge:DOCKED')
        const u = order.indexOf('undock'), p = order.indexOf('purge:undocked'), d = order.lastIndexOf('dock')
        expect(u).toBeGreaterThan(-1); expect(p).toBeGreaterThan(u); expect(d).toBeGreaterThan(p)
    })
    it('moved copy left in Error after the eject: fail loud, not purged', async () => {
        const { ops, order } = mkOps([{ id: '8dy1euovy7hlkn5uq9y', status: 'Error', currentStep: null }])
        await expect(stage2RedockSharedEraseDisk(ctxFor(ops) as never)).rejects.toThrow(/Engine left 8dy1euovy7hlkn5uq9y in Error on duration-empty-001/)
        expect(order).not.toContain('purge:undocked')
    })
})
