/**
 * r75 FAIL@91 (cover-all-stage2-f77c483d-r75): install_app@88 soft-returned; the Engine wrote
 * kolibri-6rgar30p38g7k3felj5 on duration-empty-001 14 s later (09:15:55Z), AFTER the pre-make_files
 * purge (deleted 0) and the stage2-dock reset (09:16:13Z) reformatted the partition under it →
 * stale Pauzed record (currentStep 5) + orphan Created container → make_files_disk preflight instances=1.
 * Fix 1: settleDiskOpsBeforeReset; fix 2: one stored-on predicate; fix 3: disk-state timeline.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { settleDiskOpsBeforeReset } from '../duration/actions.js'
import { diskEmptiness, diskResetVerdict, instanceStoredOn, rowInFlight } from '../duration/fixtureDisks.js'
import { STAGE2_ROLE_MAP, stage2DiskStateConflicts, stage2RoleTimeline } from '../duration/stage2.js'
import type { DiskInstanceRow, SemanticStoreView } from '../duration/types.js'

const E1 = 'duration-empty-001'
const E2 = 'duration-empty-002'
const E3 = 'duration-empty-003'
const COVER_ALL = (parseYaml(fs.readFileSync('test/duration/walks/cover-all.yaml', 'utf8')) as { steps: { action: string }[] }).steps

/** r75 store timeline on idea03 as seen by repeated reads of empty-001 after install_app@88. */
const R75_READS: DiskInstanceRow[][] = [
    [], [], [], // record not written yet (old harness purged + reset here)
    [{ id: 'kolibri-6rgar30p38g7k3felj5', status: 'Pauzed', currentStep: 5 }], // "Starting containers"
    [{ id: 'kolibri-6rgar30p38g7k3felj5', status: 'Starting', currentStep: 6 }],
    [{ id: 'kolibri-6rgar30p38g7k3felj5', status: 'Running', currentStep: null }],
]

const mkCtx = (reads: DiskInstanceRow[][], pending: string | null) => {
    let i = 0
    const ops = { diskInstancesRaw: async () => reads[Math.min(i++, reads.length - 1)]! }
    return { ctx: { opts: { ops }, walker: { pendingInstallDisk: pending } } as never, polls: () => i }
}

describe('r75 replay: reset must wait for the soft-returned install', () => {
    it('old behaviour (no pending-install awareness) would reset on the first, empty read', () => {
        const oldVerdict = (rows: DiskInstanceRow[]) => (rows.some(rowInFlight) ? 'wait' : 'ready')
        expect(oldVerdict(R75_READS[0]!)).toBe('ready') // → purge deleted 0, reset under the install
        expect(diskResetVerdict(R75_READS[0]!, true)).toBe('wait')
    })
    it('waits through not-written → Pauzed@step5 → Starting, resets only once Running/settled', async () => {
        const { ctx, polls } = mkCtx(R75_READS, E1)
        const note = await settleDiskOpsBeforeReset(ctx, 'idea03', E1, 'redockEmpty001BeforeMakeFiles', { budgetMs: 5_000, pollMs: 1 })
        expect(polls()).toBe(R75_READS.length)
        expect(note).toMatch(/settled .*kolibri-6rgar30p38g7k3felj5=Running/)
        expect((ctx as { walker: { pendingInstallDisk: string | null } }).walker.pendingInstallDisk).toBeNull()
    })
    it('an install stuck mid-op fails loud instead of resetting', async () => {
        const { ctx } = mkCtx([[{ id: 'k', status: 'Pauzed', currentStep: 5 }]], E1)
        await expect(settleDiskOpsBeforeReset(ctx, 'idea03', E1, 'L', { budgetMs: 20, pollMs: 1 })).rejects.toThrow(/operation in flight.*refusing to reset/)
    })
    it('a pending install that never lands fails loud', async () => {
        const { ctx } = mkCtx([[]], E1)
        await expect(settleDiskOpsBeforeReset(ctx, 'idea03', E1, 'L', { budgetMs: 20, pollMs: 1 })).rejects.toThrow(/install_app pending/)
    })
    it('no pending install and an empty disk: no wait, empty note', async () => {
        const { ctx, polls } = mkCtx([[]], null)
        expect(await settleDiskOpsBeforeReset(ctx, 'idea03', E1, 'L', { budgetMs: 20, pollMs: 1 })).toBe('')
        expect(polls()).toBe(1)
    })
    it('Fake ops without diskInstancesRaw: no-op, clears pending', async () => {
        const ctx = { opts: { ops: {} }, walker: { pendingInstallDisk: E1 } } as never
        expect(await settleDiskOpsBeforeReset(ctx, 'idea03', E1, 'L')).toBe('')
    })
})

describe('fix 2: one stored-on predicate for purge and emptiness', () => {
    it('raw storedOn and semantic diskId agree', () => {
        expect(instanceStoredOn({ storedOn: E1 }, E1)).toBe(true)
        expect(instanceStoredOn({ diskId: E1 }, E1)).toBe(true)
        expect(instanceStoredOn({ storedOn: E2 }, E1)).toBe(false)
        expect(instanceStoredOn(null, E1)).toBe(false)
        const view = { diskDB: { [E1]: { id: E1, dockedTo: 'idea03', diskTypes: ['empty'] } }, instanceDB: { k: { id: 'k', status: 'Pauzed', diskId: E1 } } } as unknown as SemanticStoreView
        expect(diskEmptiness(view, E1)).toMatchObject({ empty: false, instances: ['k'] })
    })
})

describe('fix 3: all-pairs role windows + dirtied-then-needs-Empty', () => {
    it('cover-all fits (install@88 → settled reset before make_files_disk@91)', () => {
        expect(stage2DiskStateConflicts(COVER_ALL)).toEqual([])
        expect(stage2RoleTimeline(COVER_ALL)).toEqual([])
    })
    it('install then a needs-Empty step without a settled reset is a pre-walk conflict', () => {
        const steps = [{ action: 'install_app' }, { action: 'back_to_overview' }, { action: 'make_backup_disk' }]
        expect(stage2DiskStateConflicts(steps, E3, { files: E1, backup: E1, erase: E2, moveApp: 'x-move-unused' }).map(c => c.kind)).toEqual(['dirty-needs-empty'])
        expect(stage2DiskStateConflicts([{ action: 'install_app' }, { action: 'install_app' }]).map(c => c.kind)).toEqual(['dirty-needs-empty'])
        expect(stage2DiskStateConflicts([{ action: 'install_app' }, { action: 'make_files_disk' }])).toEqual([])
    })
    it('late installs: second install after start_after_install is re-docked; erase resets', () => {
        const late = ['erase_disk', 'confirm_erase', 'install_app', 'start_after_install', 'install_app', 'stay_on_disk', 'erase_disk'].map(action => ({ action }))
        expect(stage2DiskStateConflicts(late)).toEqual([])
        const noStart = ['erase_disk', 'confirm_erase', 'install_app', 'install_app'].map(action => ({ action }))
        expect(stage2DiskStateConflicts(noStart).map(c => c.kind)).toEqual(['dirty-needs-empty'])
    })
    it('every role pair and every consumer is checked against the move target', () => {
        for (const role of ['files', 'backup', 'erase'] as const) {
            const kinds = stage2RoleTimeline(COVER_ALL, E3, { ...STAGE2_ROLE_MAP, [role]: E3 }).map(c => c.kind)
            expect(kinds).toContain('move-target')
            expect(kinds).toContain('consumer-on-move-target')
        }
        for (const [a, b] of [['files', 'backup'], ['backup', 'erase']] as const) {
            const map = { ...STAGE2_ROLE_MAP, [a]: E2, [b]: E2, ...(a === 'files' ? { erase: E1 } : { files: E1 }) }
            expect(stage2RoleTimeline(COVER_ALL, E3, map).length).toBeGreaterThan(0)
        }
    })
})
