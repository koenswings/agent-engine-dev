/**
 * r84c FAIL@93 (cover-all-stage2-52e2a30-r84c): add_files_role had no DURATION_ADD_FILES_DISK_ID, so it
 * fell back to fixtureDisk = duration-kolibri-grade5a-001. infra_move_disk@62 had network-copied that
 * disk to idea04 (empty-003); restoring it to its idea01 home called moveDisk(idea04→idea01) and the
 * Stage 2 guard refused it: "never move onto idea01 (READY §4.4)". Stage 2 must target its dedicated
 * app-only fixture duration-add-files-001 (idea01 p2), which never leaves idea01. Guard unchanged.
 */
import { describe, expect, it } from 'vitest'
import { addFilesAppDiskId, ensureAppOnlyDiskOnConsoleEngine } from '../duration/actions.js'
import { STAGE2_ADD_FILES_DISK_ID, STAGE2_FIXTURES, STAGE2_NEVER_MOVE_TO, stage2HomeOf } from '../duration/stage2.js'

const ctx = { fixtureDisk: 'duration-kolibri-grade5a-001' }

describe('r84c: Stage 2 add_files_role targets duration-add-files-001, never the moved Kolibri', () => {
    it('Stage 2 default is the dedicated app-only fixture on idea01', () => {
        expect(addFilesAppDiskId(ctx, { DURATION_STAGE: '2' })).toBe('duration-add-files-001')
        expect(STAGE2_ADD_FILES_DISK_ID).toBe('duration-add-files-001')
        const f = STAGE2_FIXTURES.find(x => x.diskId === STAGE2_ADD_FILES_DISK_ID)!
        expect(f.host).toBe('idea01')
        expect(f.diskTypes).toEqual(['app'])
        expect(stage2HomeOf(STAGE2_ADD_FILES_DISK_ID)).toBe('idea01')
    })
    it('explicit DURATION_ADD_FILES_DISK_ID still wins; Stage 1 keeps fixtureDisk', () => {
        expect(addFilesAppDiskId(ctx, { DURATION_STAGE: '2', DURATION_ADD_FILES_DISK_ID: 'duration-other-app' })).toBe('duration-other-app')
        expect(addFilesAppDiskId(ctx, {})).toBe('duration-kolibri-grade5a-001')
    })
    it('guard kept: idea01 is still never a move target', () => {
        expect(STAGE2_NEVER_MOVE_TO).toContain('idea01')
    })
    it('r84c replay: add-files-001 already on idea01 → no moveDisk at all (Kolibri on idea04 untouched)', async () => {
        const moves: string[] = []
        const docked: Record<string, string> = { 'duration-add-files-001': 'idea01', 'duration-kolibri-grade5a-001': 'idea04' }
        const ops = {
            stage: 2,
            findDockedEngine: async (id: string) => docked[id] ?? null,
            moveDisk: async (a: string, b: string, d: string) => { moves.push(`${d} ${a}→${b}`) },
            readStore: async () => ({ diskDB: { 'duration-add-files-001': { dockedTo: 'idea01', diskTypes: ['app'] } }, instanceDB: {} }),
        }
        const c = { opts: { ops, fast: true }, poolEngines: ['idea01', 'idea03', 'idea04'], excludeEngines: ['idea02'], fixtureDisk: 'duration-kolibri-grade5a-001', walker: {} }
        const prev = { ...process.env }
        process.env.DURATION_STAGE = '2'; delete process.env.DURATION_ADD_FILES_DISK_ID
        process.env.DURATION_FILES_DISK_SKIP_EXT4_PREFLIGHT = '1'
        try {
            const r = await ensureAppOnlyDiskOnConsoleEngine(c as never)
            expect(r.diskId).toBe('duration-add-files-001')
            expect(r.engine).toBe('idea01')
            expect(r.movedFixture).toBe(false)
            expect(moves).toEqual([])
        } finally {
            for (const k of ['DURATION_STAGE', 'DURATION_ADD_FILES_DISK_ID', 'DURATION_FILES_DISK_SKIP_EXT4_PREFLIGHT']) {
                if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]
            }
        }
    })
})
