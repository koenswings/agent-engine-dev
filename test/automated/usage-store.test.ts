/**
 * idea#411: settings, day-file writes, no-overwrite, samples cap, presence ring, office merge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readUsageMonitoring, writeUsageMonitoring } from '../../src/usage/settings.js'
import { appendPresence, appendSample, hasGoodDayFile, readDayFile, readSamples, trimPresenceRing, writeDayFile } from '../../src/usage/store.js'
import { reduceOffice, resolveDemo, applyOfficeMerge } from '../../src/usage/merge.js'
import { beginUsageSkip, endUsageSkip, resetUsageSkipCountsForTests } from '../../src/usage/opFlags.js'
import { currentSkipReason } from '../../src/usage/skip.js'
import { addDays, PRESENCE_RING_DAYS } from '../../src/usage/paths.js'
import type { DayFile, PresenceRecord, SampleRecord } from '../../src/usage/types.js'

let tmp: string
let runTmp: string
const prevRoot = process.env.IDEA_USAGE_ROOT
const prevRun = process.env.IDEA_USAGE_RUN_DIR

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-usage-'))
    runTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-usage-run-'))
    process.env.IDEA_USAGE_ROOT = tmp
    process.env.IDEA_USAGE_RUN_DIR = runTmp
    resetUsageSkipCountsForTests()
})
afterEach(() => {
    resetUsageSkipCountsForTests()
    if (prevRoot === undefined) delete process.env.IDEA_USAGE_ROOT
    else process.env.IDEA_USAGE_ROOT = prevRoot
    if (prevRun === undefined) delete process.env.IDEA_USAGE_RUN_DIR
    else process.env.IDEA_USAGE_RUN_DIR = prevRun
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(runTmp, { recursive: true, force: true })
})

const dayFile = (over: Partial<DayFile> = {}): DayFile => ({
    schema: 'idea-usage-day/1',
    engine: 'happy-zebra',
    day: '2026-11-12',
    app: 'kolibri',
    instance: 'kolibri-1',
    name: 'Kolibri',
    demo: false,
    listed: true,
    clock: { synced: true, correctedBoots: 0 },
    collectedAt: '2026-11-13T02:12:04+01:00',
    hookStatus: 'ok',
    ...over,
})

describe('settings', () => {
    it('missing file is off', () => {
        expect(readUsageMonitoring(tmp)).toBe('off')
    })
    it('reads on and off', () => {
        writeUsageMonitoring('on', tmp)
        expect(readUsageMonitoring(tmp)).toBe('on')
        writeUsageMonitoring('off', tmp)
        expect(readUsageMonitoring(tmp)).toBe('off')
    })
    it('a malformed file is off', () => {
        fs.mkdirSync(tmp, { recursive: true })
        fs.writeFileSync(path.join(tmp, 'settings.json'), '{nope')
        expect(readUsageMonitoring(tmp)).toBe('off')
    })
})

describe('day files', () => {
    it('writes a good file and reports it', () => {
        expect(writeDayFile(dayFile(), tmp).written).toBe(true)
        expect(hasGoodDayFile('2026-11-12', 'kolibri-1', tmp)).toBe(true)
        expect(readDayFile('2026-11-12', 'kolibri-1', tmp)?.hookStatus).toBe('ok')
    })
    it('does not overwrite a good file with failed/invalid/skipped/unlisted-no-hook', () => {
        writeDayFile(dayFile(), tmp)
        for (const hookStatus of ['failed', 'invalid', 'skipped', 'unlisted-no-hook', 'no-hook'] as const) {
            const r = writeDayFile(dayFile({ hookStatus }), tmp)
            expect(r).toEqual({ written: false, reason: 'keep-good' })
        }
        expect(readDayFile('2026-11-12', 'kolibri-1', tmp)?.hookStatus).toBe('ok')
    })
    it('allows a stub to overwrite a previous stub', () => {
        writeDayFile(dayFile({ hookStatus: 'unlisted-no-hook' }), tmp)
        expect(writeDayFile(dayFile({ hookStatus: 'no-hook', name: 'later' }), tmp).written).toBe(true)
        expect(readDayFile('2026-11-12', 'kolibri-1', tmp)?.hookStatus).toBe('no-hook')
    })
    it('refuses an oversized day file', () => {
        const huge = dayFile({ notes: 'x'.repeat(300_000) })
        expect(writeDayFile(huge, tmp)).toEqual({ written: false, reason: 'oversize' })
        expect(hasGoodDayFile('2026-11-12', 'kolibri-1', tmp)).toBe(false)
    })
})

describe('samples and presence', () => {
    it('appends samples and drops oldest lines when over 1 MiB', () => {
        const big = { schema: 'idea-usage-sample/1' as const, app: 'nextcloud', office: { tokens: 1, pad: 'y'.repeat(80_000) } }
        for (let i = 0; i < 20; i++) appendSample('2026-11-12', 'nc-1', { ...big, sampledAt: String(i) } as SampleRecord, tmp)
        const samples = readSamples('2026-11-12', 'nc-1', tmp)
        expect(samples.length).toBeGreaterThan(0)
        expect(samples.length).toBeLessThan(20)
        const file = path.join(tmp, '2026-11-12', 'nc-1.samples.ndjson')
        expect(fs.statSync(file).size).toBeLessThanOrEqual(1024 * 1024)
    })
    it('deletes presence files older than 90 days and keeps day files', () => {
        const today = '2026-11-12'
        const old = addDays(today, -(PRESENCE_RING_DAYS + 1))
        const recent = addDays(today, -3)
        writeDayFile(dayFile({ day: old, instance: 'k' }), tmp)
        const presence = (day: string): PresenceRecord => ({
            schema: 'idea-usage-presence/1', engine: 'e', ts: `${day}T00:00:00+01:00`,
            bootId: 'b', uptimeS: 1, ntpSynced: true, engineUp: true, instancesUp: [], tempC: 40, throttled: '0x0',
        })
        appendPresence(presence(old), old, tmp)
        appendPresence(presence(recent), recent, tmp)
        trimPresenceRing(today, tmp)
        expect(fs.existsSync(path.join(tmp, old, 'presence.ndjson'))).toBe(false)
        expect(fs.existsSync(path.join(tmp, old, 'k.json'))).toBe(true)
        expect(fs.existsSync(path.join(tmp, recent, 'presence.ndjson'))).toBe(true)
    })
})

describe('demo and office merge', () => {
    it('ORs the hook demo flag with the display-name heuristic', () => {
        expect(resolveDemo(false, 'Kolibri')).toBe(false)
        expect(resolveDemo(true, 'Kolibri')).toBe(true)
        expect(resolveDemo(false, 'Kolibri Demo Class')).toBe(true)
        expect(resolveDemo(false, 'Wikipedia (Demo)')).toBe(true)
    })
    it('reduces office samples using max snapshot counts and 15-minute consecutive tokens', () => {
        const samples: SampleRecord[] = [
            { schema: 'idea-usage-sample/1', app: 'nextcloud', office: { tokens: 2, distinctDocuments: 1, read: 2, edit: 1, byGroup: { teachers: 2 }, mime: { text: 2 } } },
            { schema: 'idea-usage-sample/1', app: 'nextcloud', office: { tokens: 3, distinctDocuments: 2, read: 1, edit: 2, byGroup: { teachers: 1, learners: 2 }, mime: { text: 1, sheet: 1 } } },
            { schema: 'idea-usage-sample/1', app: 'nextcloud', office: { tokens: 0, distinctDocuments: 0, read: 0, edit: 0 } },
        ]
        const office = reduceOffice(samples) as Record<string, any>
        expect(office.tokens).toBe(3)
        expect(office.distinctDocuments).toBe(2)
        expect(office.read).toBe(2)
        expect(office.edit).toBe(2)
        expect(office.byGroup).toEqual({ teachers: 2, learners: 2 })
        expect(office.mime).toEqual({ text: 2, sheet: 1 })
        expect(office.estimatedMinutes).toBe(15)
        expect(office.opens).toBe(2)
    })
    it('prefers the sample reduction on a stored Nextcloud day file', () => {
        appendSample('2026-11-12', 'nc-1', { schema: 'idea-usage-sample/1', app: 'nextcloud', office: { tokens: 4, distinctDocuments: 1, read: 1, edit: 0 } }, tmp)
        const rec = applyOfficeMerge(dayFile({ app: 'nextcloud', instance: 'nc-1', office: { tokens: 1 } }), tmp)
        expect((rec.office as any).tokens).toBe(4)
    })
})

describe('skip flags', () => {
    it('beginUsageSkip writes a live-pid flag that skip.ts honours', () => {
        expect(currentSkipReason({ runDir: runTmp, readTempC: () => 40 })).toBeNull()
        beginUsageSkip('backup')
        expect(currentSkipReason({ runDir: runTmp, readTempC: () => 40 })).toBe('backup')
        endUsageSkip('backup')
        expect(currentSkipReason({ runDir: runTmp, readTempC: () => 40 })).toBeNull()
    })
    it('ignores a stale flag whose pid is not running', () => {
        fs.writeFileSync(path.join(runTmp, 'update-running'), '9999999\n')
        expect(currentSkipReason({ runDir: runTmp, readTempC: () => 40 })).toBeNull()
    })
    it('skips when temperature is above 75 C', () => {
        expect(currentSkipReason({ runDir: runTmp, readTempC: () => 75.1 })).toBe('temperature')
        expect(currentSkipReason({ runDir: runTmp, readTempC: () => 75 })).toBeNull()
    })
    it('refcounts overlapping begin/end pairs', () => {
        beginUsageSkip('move')
        beginUsageSkip('move')
        endUsageSkip('move')
        expect(currentSkipReason({ runDir: runTmp, readTempC: () => 40 })).toBe('move')
        endUsageSkip('move')
        expect(currentSkipReason({ runDir: runTmp, readTempC: () => 40 })).toBeNull()
    })
})

