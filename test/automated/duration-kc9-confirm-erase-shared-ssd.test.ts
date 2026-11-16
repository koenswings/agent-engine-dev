/**
 * kc9 FAIL@105 (Engine 9040e73, 2026-11-16 19:00:51 CET): confirm_erase of duration-empty-001 (idea03 p2)
 * was refused by the Engine shared-disk guard (#188, 323accd 2026-10-16): "… shares its physical disk
 * (/dev/sdb) with sdb1 mounted at /disks/sdb1. Erasing wipes the whole disk, so nothing was erased."
 * Every Stage 2 fixture is a partition on a two-partition SSD, so the walker now expects that refusal,
 * proves nothing changed, closes the dialog, and declares "real whole-disk erase" a Stage 2 gap.
 * r86t (Engine f194fb5, before #188) "passed" only because the Intent counted a closed dialog as success.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stage2ConfirmEraseAfter, stage2ConfirmErasePrecheck } from '../duration/actions.js'
import {
    ERASE_SHARED_DISK_REFUSAL, STAGE2_GAPS, STAGE2_GAP_SHORT, stage2ConfirmEraseVerdict, stage2MountedSiblings, stage2NotCovered,
    type Stage2Status, type Stage2StatusFixture,
} from '../duration/stage2.js'
import { loadWalk } from '../duration/scenario.js'

const E1 = 'duration-empty-001'
const KC9 = 'idea#168 confirm_erase: erase failed — "Duration Tests — Empty Disk 001 shares its physical disk (/dev/sdb) with sdb1 mounted at /disks/sdb1. Erasing wipes the whole disk, so nothing was erased.". No soft-pass.'
const KC9_RESULT = { ok: false, message: `runDurationIntent('confirm_erase'): ${KC9}` }

const fx = (partLabel: string, kname: string | null, parent: string | null, mounted: string | null, diskId: string | null): Stage2StatusFixture =>
    ({ partLabel, diskId, kname, parent, fsType: 'ext4', fsLabel: null, mounted, present: !!kname })
const status = (fixtures: Stage2StatusFixture[]): Stage2Status =>
    ({ ok: true, host: 'idea03', bootId: 'b', rootDisk: 'sda', ssds: [], fixtures, ugreenDetached: true, extraSdDisks: [] })
const NC = fx('IDEA-NEXTCLOUD', 'sdb1', 'sdb', '/disks/sdb1', 'duration-nextcloud-grade5a-001')
const EMPTY = fx('IDEA-EMPTY001', 'sdb2', 'sdb', '/disks/sdb2', E1)
const SHARED = status([NC, EMPTY])

describe('kc9: shared-SSD detection from stage2-dock status', () => {
    it('idea03 layout: empty-001 shares sdb with the mounted Nextcloud partition', () => {
        const r = stage2MountedSiblings(SHARED, E1)
        expect(r.parent).toBe('sdb')
        expect(r.target.kname).toBe('sdb2')
        expect(r.siblings.map(s => s.kname)).toEqual(['sdb1'])
    })
    it('an unmounted sibling, or one on another disk, does not count', () => {
        expect(stage2MountedSiblings(status([{ ...NC, mounted: null }, EMPTY]), E1).siblings).toEqual([])
        expect(stage2MountedSiblings(status([{ ...NC, parent: 'sdc', kname: 'sdc1' }, EMPTY]), E1).siblings).toEqual([])
    })
    it('target missing from status: fail loud', () => {
        expect(() => stage2MountedSiblings(status([NC]), E1)).toThrow(/is not present on idea03/)
    })
})

describe('kc9: confirm_erase verdict on a shared SSD', () => {
    const sib = [NC]
    it('the exact kc9 refusal is the expected result', () => {
        expect(ERASE_SHARED_DISK_REFUSAL.test(KC9)).toBe(true)
        const v = stage2ConfirmEraseVerdict(KC9_RESULT, E1, 'sdb', sib)
        expect(v.kind).toBe('expected_refusal')
        expect(v.note).toMatch(/refused as expected \(shared SSD \/dev\/sdb with mounted sdb1 \(IDEA-NEXTCLOUD\)/)
    })
    it('an ok Intent is a failure (guard did not fire, or a closed dialog counted as success like r86t)', () => {
        const v = stage2ConfirmEraseVerdict({ ok: true, message: 'runDurationIntent ok: confirm_erase' }, E1, 'sdb', sib)
        expect(v.kind).toBe('fail')
        expect(v.note).toMatch(/Intent reported ok.*closed dialog/)
    })
    it('any other error, another disk, or a missing sibling name is a failure', () => {
        expect(stage2ConfirmEraseVerdict({ ok: false, message: 'erase did not complete within 180s' }, E1, 'sdb', sib).kind).toBe('fail')
        expect(stage2ConfirmEraseVerdict(KC9_RESULT, E1, 'sdc', sib).note).toMatch(/names \/dev\/sdb, but/)
        const two = [NC, fx('IDEA-X', 'sdb3', 'sdb', '/disks/sdb3', 'x')]
        expect(stage2ConfirmEraseVerdict(KC9_RESULT, E1, 'sdb', two).note).toMatch(/does not name mounted sibling\(s\) sdb3/)
    })
})

describe('kc9: confirm_erase is a declared Stage 2 gap on cover-all', () => {
    it('reported in stage2NotCovered at the cover-all confirm_erase step, with a short summary label', () => {
        const steps = loadWalk('cover-all').steps as { action: string }[]
        const at = steps.findIndex(s => s.action === 'confirm_erase') + 1
        const gap = STAGE2_GAPS.find(g => g.action === 'confirm_erase')!
        expect(gap.semantics).toMatch(/expected refusal.*shares its SSD.*no real whole-disk erase/)
        expect(stage2NotCovered(steps)).toContainEqual({ step: at, action: 'confirm_erase', semantics: gap.semantics })
        expect(STAGE2_GAP_SHORT.confirm_erase).toBe('expected shared-SSD refusal')
    })
})

describe('kc9: pre-check and after-check wiring (Stage 2 live ops)', () => {
    let prevStage: string | undefined, prevErase: string | undefined
    beforeEach(() => { prevStage = process.env.DURATION_STAGE; prevErase = process.env.DURATION_ERASE_DISK_ID; process.env.DURATION_STAGE = '2'; delete process.env.DURATION_ERASE_DISK_ID })
    afterEach(() => {
        if (prevStage === undefined) delete process.env.DURATION_STAGE; else process.env.DURATION_STAGE = prevStage
        if (prevErase !== undefined) process.env.DURATION_ERASE_DISK_ID = prevErase
    })
    const mk = (o: { statuses: Stage2Status[]; dockedTo?: string | null; diskTypes?: string[] }) => {
        let n = 0
        const calls: string[] = []
        const ops = {
            stage: 2,
            stage2Status: async (e: string) => { calls.push(`status:${e}`); return o.statuses[Math.min(n++, o.statuses.length - 1)]! },
            readStore: async () => ({
                diskDB: { [E1]: { id: E1, dockedTo: o.dockedTo === undefined ? 'idea03' : o.dockedTo, diskTypes: o.diskTypes ?? ['empty'] } },
                instanceDB: {}, engineDB: {}, appDB: {},
            }),
        }
        const ctx = { action: 'confirm_erase', opts: { ops }, walker: { step: 105 } } as never
        return { ctx, calls }
    }
    const driver = () => {
        const d = { closed: 0, dismissEraseError: async () => { d.closed++; return 'closed the erase error dialog' } }
        return d
    }

    it('not Stage 2, or ops without stage2Status: null (unchanged Stage 1 / fake runs)', async () => {
        process.env.DURATION_STAGE = '1'
        expect(await stage2ConfirmErasePrecheck({ action: 'confirm_erase', opts: { ops: { stage: 1 } } } as never)).toBeNull()
        process.env.DURATION_STAGE = '2'
        expect(await stage2ConfirmErasePrecheck({ action: 'confirm_erase', opts: { ops: { stage: 2 } } } as never)).toBeNull()
    })
    it('shared SSD: pre-check reads idea03 and records sdb + sibling sdb1', async () => {
        const { ctx, calls } = mk({ statuses: [SHARED] })
        const pre = await stage2ConfirmErasePrecheck(ctx)
        expect(pre).toMatchObject({ diskId: E1, home: 'idea03', parent: 'sdb' })
        expect(pre!.siblings.map(s => s.kname)).toEqual(['sdb1'])
        expect(calls).toEqual(['status:idea03'])
    })
    it('target alone on its disk: fail loud before clicking (PARTLABEL would be lost)', async () => {
        const { ctx } = mk({ statuses: [status([{ ...NC, parent: 'sdc', kname: 'sdc1', mounted: '/disks/sdc1' }, EMPTY])] })
        await expect(stage2ConfirmErasePrecheck(ctx)).rejects.toThrow(/alone on \/dev\/sdb.*PARTLABEL IDEA-EMPTY001.*Nothing was clicked/)
    })
    it('kc9 refusal + nothing changed: ok, dialog closed, gap declared', async () => {
        const { ctx } = mk({ statuses: [SHARED, SHARED] })
        const pre = (await stage2ConfirmErasePrecheck(ctx))!
        const d = driver()
        const r = await stage2ConfirmEraseAfter(ctx, pre, KC9_RESULT, d)
        expect(r.ok).toBe(true)
        expect(d.closed).toBe(1)
        expect(r.message).toMatch(/refused as expected.*nothing changed.*sdb2 still mounted at \/disks\/sdb2.*sdb1 at \/disks\/sdb1 still mounted.*closed the erase error dialog.*real whole-disk erase not covered/)
    })
    it('refusal but the target was undocked or is no longer Empty: fail', async () => {
        const a = mk({ statuses: [SHARED, SHARED], dockedTo: null })
        expect((await stage2ConfirmEraseAfter(a.ctx, (await stage2ConfirmErasePrecheck(a.ctx))!, KC9_RESULT, driver())).message).toMatch(/expected docked on idea03 and Empty/)
        const b = mk({ statuses: [SHARED, SHARED], diskTypes: ['files'] })
        expect((await stage2ConfirmEraseAfter(b.ctx, (await stage2ConfirmErasePrecheck(b.ctx))!, KC9_RESULT, driver())).ok).toBe(false)
    })
    it('refusal but the target or the sibling got unmounted: fail', async () => {
        const a = mk({ statuses: [SHARED, status([NC, { ...EMPTY, mounted: null }])] })
        expect((await stage2ConfirmEraseAfter(a.ctx, (await stage2ConfirmErasePrecheck(a.ctx))!, KC9_RESULT, driver())).message).toMatch(/sdb2\) is no longer mounted/)
        const b = mk({ statuses: [SHARED, status([{ ...NC, mounted: null }, EMPTY])] })
        expect((await stage2ConfirmEraseAfter(b.ctx, (await stage2ConfirmErasePrecheck(b.ctx))!, KC9_RESULT, driver())).message).toMatch(/IDEA-NEXTCLOUD are no longer mounted/)
    })
    it('Intent ok on a shared SSD: fail loud, dialog left alone', async () => {
        const { ctx } = mk({ statuses: [SHARED, SHARED] })
        const pre = (await stage2ConfirmErasePrecheck(ctx))!
        const d = driver()
        const r = await stage2ConfirmEraseAfter(ctx, pre, { ok: true, message: 'runDurationIntent ok: confirm_erase' }, d)
        expect(r.ok).toBe(false)
        expect(d.closed).toBe(0)
    })
})
