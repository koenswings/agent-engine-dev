/**
 * idea#411: export since / archive-and-clear / disabled / invalid arguments.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXIT_DISABLED, EXIT_INVALID, EXIT_OK, parseExportArgs, runExport } from '../../src/usage/exportCmd.js'
import { writeUsageMonitoring } from '../../src/usage/settings.js'
import { appendPresence, appendSample, writeDayFile } from '../../src/usage/store.js'
import type { DayFile, PresenceRecord, SampleRecord } from '../../src/usage/types.js'

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-usage-ex-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

async function exportText(argv: string[], ssh?: string) {
    let stdout = ''
    let stderr = ''
    const code = await runExport({
        argv,
        sshOriginal: ssh,
        root: tmp,
        hostname: 'happy-zebra',
        stdout: { write: (s: string) => { stdout += s } },
        stderr: { write: (s: string) => { stderr += s } },
        now: () => new Date('2026-11-10T20:30:45Z'),
    })
    return { code, stdout, stderr }
}

const dayRec = (day: string, instance: string): DayFile => ({
    schema: 'idea-usage-day/1', engine: 'happy-zebra', day, app: 'kolibri', instance,
    name: instance, demo: false, listed: true, clock: { synced: true, correctedBoots: 0 },
    collectedAt: `${day}T02:00:00+01:00`, hookStatus: 'ok',
})

describe('parseExportArgs', () => {
    it('accepts since and archive-and-clear, with or without the binary name', () => {
        expect(parseExportArgs(['since', '2026-11-01'])).toEqual({ ok: true, verb: 'since', date: '2026-11-01' })
        expect(parseExportArgs(['/usr/local/sbin/idea-usage-export', 'since', '2026-11-01'])).toEqual({ ok: true, verb: 'since', date: '2026-11-01' })
        expect(parseExportArgs(['archive-and-clear', '--before', '2026-11-01'])).toEqual({ ok: true, verb: 'archive', before: '2026-11-01' })
        expect(parseExportArgs(['archive-and-clear', '--before=2026-11-01'])).toEqual({ ok: true, verb: 'archive', before: '2026-11-01' })
    })
    it('prefers SSH_ORIGINAL_COMMAND over argv', () => {
        expect(parseExportArgs(['since', '2026-01-01'], 'since 2026-11-02')).toEqual({ ok: true, verb: 'since', date: '2026-11-02' })
    })
    it('rejects shell metacharacters, extra args, and impossible dates', () => {
        expect(parseExportArgs(['since', '2026-11-01;id']).ok).toBe(false)
        expect(parseExportArgs(['since', '2026-11-01', 'extra']).ok).toBe(false)
        expect(parseExportArgs(['since', '2026-02-30']).ok).toBe(false)
        expect(parseExportArgs(['rm', '-rf', '/']).ok).toBe(false)
    })
})

describe('runExport', () => {
    it('returns exit 10, empty stdout and stderr disabled when the switch is off or missing', async () => {
        const missing = await exportText(['since', '2026-11-01'])
        expect(missing).toEqual({ code: EXIT_DISABLED, stdout: '', stderr: 'disabled\n' })
        writeUsageMonitoring('off', tmp)
        fs.mkdirSync(path.join(tmp, '2026-11-12'), { recursive: true })
        writeDayFile(dayRec('2026-11-12', 'k1'), tmp)
        const off = await exportText(['since', '2026-11-01'])
        expect(off).toEqual({ code: EXIT_DISABLED, stdout: '', stderr: 'disabled\n' })
        expect(fs.existsSync(path.join(tmp, '2026-11-12', 'k1.json'))).toBe(true)
    })
    it('rejects invalid arguments with exit 2 and empty stdout', async () => {
        writeUsageMonitoring('on', tmp)
        const r = await exportText(['since'])
        expect(r.code).toBe(EXIT_INVALID)
        expect(r.stdout).toBe('')
        expect(r.stderr).toBe('invalid arguments\n')
    })
    it('streams presence, day, sample then end, ordered by day and instance', async () => {
        writeUsageMonitoring('on', tmp)
        writeDayFile(dayRec('2026-11-12', 'b-inst'), tmp)
        writeDayFile(dayRec('2026-11-12', 'a-inst'), tmp)
        writeDayFile(dayRec('2026-11-10', 'old'), tmp)
        appendPresence({
            schema: 'idea-usage-presence/1', engine: 'happy-zebra', ts: '2026-11-12T10:00:00+01:00',
            bootId: 'boot', uptimeS: 1, ntpSynced: true, engineUp: true, instancesUp: ['a-inst'], tempC: 40, throttled: '0x0',
        } as PresenceRecord, '2026-11-12', tmp)
        appendSample('2026-11-12', 'a-inst', { schema: 'idea-usage-sample/1', app: 'nextcloud', office: { tokens: 1 } } as SampleRecord, tmp)
        const r = await exportText(['since', '2026-11-12'])
        expect(r.code).toBe(EXIT_OK)
        const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l))
        expect(lines.map(l => l.type)).toEqual(['presence', 'day', 'day', 'sample', 'end'])
        expect(lines[0].day).toBe('2026-11-12')
        expect(lines[1].instance).toBe('a-inst')
        expect(lines[2].instance).toBe('b-inst')
        expect(lines[3].instance).toBe('a-inst')
        expect(lines[4]).toMatchObject({
            type: 'end', schema: 'idea-usage-export/1', since: '2026-11-12', engine: 'happy-zebra',
            usageMonitoring: 'on', counts: { day: 2, sample: 1, presence: 1 }, errors: 0,
        })
        expect(r.stdout).not.toContain('2026-11-10')
    })
    it('emits only the end marker when the range is empty', async () => {
        writeUsageMonitoring('on', tmp)
        const r = await exportText(['since', '2026-11-01'])
        const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ type: 'end', counts: { day: 0, sample: 0, presence: 0 }, errors: 0 })
    })
    it('archive-and-clear moves days strictly before the cut and leaves later days + settings', async () => {
        writeUsageMonitoring('on', tmp)
        writeDayFile(dayRec('2026-10-31', 'old'), tmp)
        writeDayFile(dayRec('2026-11-01', 'keep'), tmp)
        const r = await exportText(['archive-and-clear', '--before', '2026-11-01'])
        expect(r.code).toBe(EXIT_OK)
        const rec = JSON.parse(r.stdout.trim())
        expect(rec).toMatchObject({ type: 'archived', schema: 'idea-usage-export/1', before: '2026-11-01', days: 1 })
        expect(rec.files).toBeGreaterThanOrEqual(1)
        expect(fs.existsSync(path.join(tmp, '2026-10-31'))).toBe(false)
        expect(fs.existsSync(path.join(tmp, '2026-11-01', 'keep.json'))).toBe(true)
        expect(fs.existsSync(path.join(tmp, 'settings.json'))).toBe(true)
        const archived = fs.readdirSync(path.join(tmp, '.archive'))
        expect(archived[0]).toMatch(/^2026-11-01-20261110T203045Z$/)
        expect(fs.existsSync(path.join(tmp, '.archive', archived[0], '2026-10-31', 'old.json'))).toBe(true)
    })
    it('does not move files when archive is asked while disabled', async () => {
        writeUsageMonitoring('off', tmp)
        writeDayFile(dayRec('2026-10-31', 'old'), tmp)
        const r = await exportText(['archive-and-clear', '--before', '2026-11-01'])
        expect(r.code).toBe(EXIT_DISABLED)
        expect(r.stdout).toBe('')
        expect(fs.existsSync(path.join(tmp, '2026-10-31', 'old.json'))).toBe(true)
        expect(fs.existsSync(path.join(tmp, '.archive'))).toBe(false)
    })
    it('counts an unreadable day file as an error and still writes end', async () => {
        writeUsageMonitoring('on', tmp)
        fs.mkdirSync(path.join(tmp, '2026-11-12'), { recursive: true })
        fs.writeFileSync(path.join(tmp, '2026-11-12', 'broken.json'), '{nope')
        const r = await exportText(['since', '2026-11-01'])
        expect(r.code).toBe(EXIT_OK)
        const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l))
        expect(lines.at(-1).errors).toBe(1)
        expect(lines.at(-1).type).toBe('end')
    })
})
