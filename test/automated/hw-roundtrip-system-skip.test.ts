/**
 * hw-roundtrip-system-skip.test.ts (engine#288)
 *
 * script/hw-roundtrip.ts must not FAIL the system-record checks when the Engine runs with
 * systemDiskSkip:true or the store has no 'system' record. Modelled on idea04 at #278/#279:
 * root on sda2, a stale App record duration-kolibri-grade5a-001 docked on sda2 (diskTypes ["app"]).
 */
import { describe, it, expect } from 'vitest'
import { planSystemRecordChecks, systemDiskSkipFromConfig } from '../../script/hw-roundtrip-guard.js'

const ENGINE = 'engine-idea04'
const sysDevs = new Set(['sda1', 'sda2'])
const stale = { id: 'duration-kolibri-grade5a-001', name: 'grade5a', device: 'sda2', dockedTo: ENGINE, diskTypes: ['app'] }
const sysRec = { id: 'sys-1', name: 'system', device: 'sda2', dockedTo: ENGINE, diskTypes: ['system'] }
const stick = { id: 'stick-1', name: 'stick', device: 'sdb1', dockedTo: ENGINE, diskTypes: ['app'] }

describe('planSystemRecordChecks (engine#288)', () => {
    it('systemDiskSkip:true skips the record checks but keeps the records for the eject-refusal checks', () => {
        const p = planSystemRecordChecks({ systemDiskSkip: true, allDisks: [stale, stick], engineId: ENGINE, systemDevs: sysDevs })
        expect(p.checkRecords).toBe(false)
        expect(p.reason).toMatch(/systemDiskSkip:true/)
        expect(p.records.map(d => d.id)).toEqual(['duration-kolibri-grade5a-001'])
    })
    it('no system record in the store (idea04 #278 case) skips instead of matching the stale record by device', () => {
        const p = planSystemRecordChecks({ systemDiskSkip: false, allDisks: [stale, stick], engineId: ENGINE, systemDevs: sysDevs })
        expect(p.checkRecords).toBe(false)
        expect(p.reason).toMatch(/no record with diskTypes 'system'/)
    })
    it("a 'system' record docked to another Engine does not count", () => {
        const p = planSystemRecordChecks({ systemDiskSkip: false, allDisks: [stale, { ...sysRec, dockedTo: 'other' }], engineId: ENGINE, systemDevs: sysDevs })
        expect(p.checkRecords).toBe(false)
    })
    it('a real system record keeps the checks on', () => {
        const p = planSystemRecordChecks({ systemDiskSkip: false, allDisks: [sysRec, stick], engineId: ENGINE, systemDevs: sysDevs })
        expect(p.checkRecords).toBe(true)
        expect(p.records.map(d => d.id)).toEqual(['sys-1'])
    })
})

describe('systemDiskSkipFromConfig (engine#288)', () => {
    it('reads settings.systemDiskSkip', () => {
        expect(systemDiskSkipFromConfig('settings:\n  systemDiskSkip: true\n')).toBe(true)
        expect(systemDiskSkipFromConfig('settings:\n  systemDiskSkip: false\n')).toBe(false)
        expect(systemDiskSkipFromConfig('settings:\n  mdns: true\n')).toBe(false)
    })
    it('IDEA_SYSTEM_DISK_SKIP=true overrides, missing or bad config is false', () => {
        expect(systemDiskSkipFromConfig(null, { IDEA_SYSTEM_DISK_SKIP: 'true' })).toBe(true)
        expect(systemDiskSkipFromConfig(null)).toBe(false)
        expect(systemDiskSkipFromConfig(': : [bad')).toBe(false)
    })
})
