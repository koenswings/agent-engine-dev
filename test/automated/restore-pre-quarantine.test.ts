/**
 * restore-pre-quarantine.test.ts (#190): restore onto another disk quarantines the
 * old disk's pre-restore folder with the helper v4 quarantine op (never deletes it),
 * refuses HELPER_OUTDATED below v4, and leaves everything alone in the other cases.
 */
import { describe, it, expect, vi } from 'vitest'
import { assertPreQuarantineHelper, quarantinePreRestore, PreQuarantineDeps } from '../../src/data/RestorePreQuarantine.js'

const E = 'ENGINE_local'
const OLD = { id: 'DISK_old', name: 'old', device: 'sdb1', dockedTo: E } as any
const NEW = { id: 'DISK_new', name: 'new', device: 'sdc1', dockedTo: E } as any
const store = (storedOn: string, status = 'Stopped', oldDocked = true) => ({
    instanceDB: { I1: { id: 'I1', storedOn, status } },
    diskDB: { DISK_old: oldDocked ? OLD : { ...OLD, device: null }, DISK_new: NEW },
}) as any
const deps = (o: Partial<PreQuarantineDeps> = {}): PreQuarantineDeps => ({
    helperProblem: vi.fn(async () => null),
    folderExists: vi.fn(async () => true),
    quarantine: vi.fn(async () => '/disks/sdb1/.idea-quarantine/I1-20261029T090000Z'),
    ...o,
})

describe('restore to another disk: pre-restore quarantine (#190)', () => {
    it('quarantines the old folder after the instance is registered on the target', async () => {
        const d = deps()
        const prev = await assertPreQuarantineHelper(store('DISK_old'), 'I1' as any, NEW, E, d)
        expect(prev?.id).toBe('DISK_old')
        const q = await quarantinePreRestore(store('DISK_new'), 'I1' as any, NEW, prev, d)
        expect(q).toContain('.idea-quarantine/I1-')
        expect(d.quarantine).toHaveBeenCalledWith(OLD, 'I1')
    })
    it('refuses HELPER_OUTDATED up front when the helper is below v4', async () => {
        const d = deps({ helperProblem: async () => 'needs v4' })
        await expect(assertPreQuarantineHelper(store('DISK_old'), 'I1' as any, NEW, E, d)).rejects.toThrow(/^HELPER_OUTDATED: needs v4/)
    })
    it('same-disk restore, no old folder, or old disk on another Engine: nothing to do, no helper needed', async () => {
        const d = deps({ helperProblem: async () => 'needs v4' })
        expect(await assertPreQuarantineHelper(store('DISK_new'), 'I1' as any, NEW, E, d)).toBeNull()
        expect(await assertPreQuarantineHelper(store('DISK_old'), 'I1' as any, NEW, E, deps({ folderExists: async () => false, helperProblem: async () => 'x' }))).toBeNull()
        expect(await assertPreQuarantineHelper(store('DISK_old'), 'I1' as any, NEW, 'ENGINE_other', d)).toBeNull()
    })
    it('skips when the store does not say the instance now lives on the target, or the old disk left', async () => {
        const d = deps()
        expect(await quarantinePreRestore(store('DISK_old'), 'I1' as any, NEW, OLD, d)).toBeNull()
        expect(await quarantinePreRestore(store('DISK_new', 'Stopped', false), 'I1' as any, NEW, OLD, d)).toBeNull()
        expect(d.quarantine).not.toHaveBeenCalled()
    })
    it('a failing quarantine is logged, not thrown (the restore is already done)', async () => {
        const d = deps({ quarantine: async () => { throw new Error('ID_BUSY') } })
        expect(await quarantinePreRestore(store('DISK_new'), 'I1' as any, NEW, OLD, d)).toBeNull()
    })
})
