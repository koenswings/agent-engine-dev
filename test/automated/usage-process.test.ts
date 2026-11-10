/**
 * idea#411: process tick — off writes nothing; on samples presence and runs hooks;
 * toggling the switch never restarts the Engine or Apps; catch-up covers 14 days.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeUsageMonitoring } from '../../src/usage/settings.js'
import { processTick, catchUpDays, type TickState } from '../../src/usage/scheduler.js'
import { inNightWindow, kitLocalDay, addDays } from '../../src/usage/paths.js'
import { hasGoodDayFile, writeDayFile } from '../../src/usage/store.js'
import { collectPresence } from '../../src/usage/sampler.js'
import type { DayFile, ListedTarget } from '../../src/usage/types.js'

let tmp: string
let runTmp: string
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-usage-proc-'))
    runTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-usage-prun-'))
})
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(runTmp, { recursive: true, force: true })
})

const target: ListedTarget = {
    kind: 'listed',
    instanceId: 'kolibri-1',
    name: 'Kolibri',
    app: 'kolibri',
    listed: true,
    cwd: '/instances/kolibri-1',
    hook: { service: 'kolibri', command: ['/hooks/usage.sh'], timeoutS: 30 },
}

const okBody = (day: string) => JSON.stringify({
    schema: 'idea-usage-day/1', day, app: 'kolibri',
    setup: { classes: 0, classesDelta: 0, learnersRegistered: 0, learnersRegisteredDelta: 0, learnersEnrolled: 0, teachers: 0, teachersDelta: 0, admins: 0 },
    signins: {
        learner: { users: 0, sessions: 0, minutes: 0 },
        coach: { users: 0, sessions: 0, minutes: 0 },
        admin: { users: 0, sessions: 0, minutes: 0 },
    },
    content: [],
    teaching: { lessonsCreated: 0, lessonsVisible: 0, quizzesCreated: 0, quizzesStarted: 0, quizzesEnded: 0 },
    guest: { visits: 0, seconds: 0 },
})

function listWritten(root: string): string[] {
    const out: string[] = []
    const walk = (d: string) => {
        if (!fs.existsSync(d)) return
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, ent.name)
            if (ent.isDirectory()) walk(p)
            else out.push(path.relative(root, p))
        }
    }
    walk(root)
    return out.sort()
}

describe('scheduler helpers', () => {
    it('night window is 02:00 inclusive to 03:30 exclusive', () => {
        expect(inNightWindow(new Date(2026, 10, 13, 1, 59))).toBe(false)
        expect(inNightWindow(new Date(2026, 10, 13, 2, 0))).toBe(true)
        expect(inNightWindow(new Date(2026, 10, 13, 3, 29))).toBe(true)
        expect(inNightWindow(new Date(2026, 10, 13, 3, 30))).toBe(false)
    })
    it('catch-up lists missing days in the last 14, oldest first, excluding today', () => {
        const today = '2026-11-13'
        const have = new Set(['2026-11-12', '2026-11-05'])
        const missing = catchUpDays(today, d => have.has(d))
        expect(missing[0]).toBe(addDays(today, -14))
        expect(missing).not.toContain(today)
        expect(missing).not.toContain('2026-11-12')
        expect(missing).not.toContain('2026-11-05')
        expect(missing).toHaveLength(12)
    })
})

describe('processTick', () => {
    it('writes nothing when the switch is off or missing — not even settings.json', async () => {
        const state: TickState = {}
        const r = await processTick(state, {
            root: tmp, runDir: runTmp, now: () => new Date(2026, 10, 13, 2, 10),
            listTargets: () => [target],
            execHook: async () => { throw new Error('should not run') },
            collectPresence: { engineUp: () => false, listInstancesUp: () => [], readTempC: () => 40, readThrottled: () => '0x0', readBootId: () => 'b', readUptimeS: () => 1, readNtpSynced: () => true },
        })
        expect(r.idle).toBe(true)
        expect(listWritten(tmp)).toEqual([])
    })
    it('when on, writes a presence sample and catch-up day files without calling docker', async () => {
        writeUsageMonitoring('on', tmp)
        const state: TickState = {}
        const daysRequested: string[] = []
        const r = await processTick(state, {
            root: tmp, runDir: runTmp,
            now: () => new Date(2026, 10, 13, 2, 10),
            hostname: () => 'happy-zebra',
            ntpSynced: () => true,
            listTargets: () => [target],
            readTempC: () => 40,
            collectPresence: { engineUp: () => true, listInstancesUp: () => ['kolibri-1'], readTempC: () => 42, readThrottled: () => '0x0', readBootId: () => 'boot-1', readUptimeS: () => 99, readNtpSynced: () => true },
            execHook: async spec => {
                if (spec.mode === 'sample') {
                    return { stdout: JSON.stringify({ schema: 'idea-usage-sample/1', app: 'kolibri', supported: false }), stderr: '', exitCode: 0, timedOut: false }
                }
                daysRequested.push(spec.day ?? '')
                return { stdout: okBody(spec.day ?? ''), stderr: '', exitCode: 0, timedOut: false }
            },
        })
        expect(r.idle).toBe(false)
        expect(r.presence).toBe(true)
        const today = kitLocalDay(new Date(2026, 10, 13, 2, 10))
        expect(fs.existsSync(path.join(tmp, today, 'presence.ndjson'))).toBe(true)
        expect(daysRequested).toEqual(catchUpDays(today, () => false))
        expect(hasGoodDayFile(daysRequested[0], 'kolibri-1', tmp)).toBe(true)
        expect(hasGoodDayFile(addDays(today, -1), 'kolibri-1', tmp)).toBe(true)
    })
    it('does not invoke hooks for a day that already has a good file', async () => {
        writeUsageMonitoring('on', tmp)
        const today = kitLocalDay(new Date(2026, 10, 13, 2, 10))
        const yesterday = addDays(today, -1)
        writeDayFile({
            schema: 'idea-usage-day/1', engine: 'happy-zebra', day: yesterday, app: 'kolibri',
            instance: 'kolibri-1', name: 'Kolibri', demo: false, listed: true,
            clock: { synced: true, correctedBoots: 0 }, collectedAt: 'x', hookStatus: 'ok',
        } as DayFile, tmp)
        const asked: string[] = []
        await processTick({}, {
            root: tmp, runDir: runTmp,
            now: () => new Date(2026, 10, 13, 2, 10),
            hostname: () => 'happy-zebra',
            listTargets: () => [target],
            readTempC: () => 40,
            collectPresence: { engineUp: () => false, listInstancesUp: () => [], readTempC: () => 40, readThrottled: () => '0x0', readBootId: () => 'b', readUptimeS: () => 1, readNtpSynced: () => true },
            execHook: async spec => {
                if (spec.mode === 'sample') {
                    return { stdout: JSON.stringify({ schema: 'idea-usage-sample/1', app: 'kolibri', supported: false }), stderr: '', exitCode: 0, timedOut: false }
                }
                asked.push(spec.day ?? '')
                return { stdout: okBody(spec.day ?? ''), stderr: '', exitCode: 0, timedOut: false }
            },
        })
        expect(asked).not.toContain(yesterday)
    })
    it('writeUsageMonitoring only touches settings.json — no pm2 or compose restart path', () => {
        writeUsageMonitoring('off', tmp)
        writeUsageMonitoring('on', tmp)
        expect(listWritten(tmp)).toEqual(['settings.json'])
        const settingsSrc = fs.readFileSync(path.join(process.cwd(), 'src/usage/settings.ts'), 'utf8')
        expect(settingsSrc).not.toMatch(/pm2 (restart|stop|delete)|stopInstance|startInstance|compose (restart|down)|docker compose (restart|down)/)
        const schedulerSrc = fs.readFileSync(path.join(process.cwd(), 'src/usage/scheduler.ts'), 'utf8')
        expect(schedulerSrc).not.toMatch(/pm2 (restart|stop|delete)|stopInstance|startInstance/)
    })
})

describe('presence sampler', () => {
    it('builds a presence record from injectable probes', async () => {
        const rec = await collectPresence({
            hostname: () => 'happy-zebra',
            now: () => new Date('2026-11-12T10:05:00+01:00'),
            readBootId: () => 'boot-xyz',
            readUptimeS: () => 12345,
            readNtpSynced: () => true,
            engineUp: () => true,
            listInstancesUp: () => ['kolibri-1', 'nextcloud-1'],
            readTempC: () => 52.1,
            readThrottled: () => '0x0',
        })
        expect(rec).toMatchObject({
            schema: 'idea-usage-presence/1',
            engine: 'happy-zebra',
            bootId: 'boot-xyz',
            uptimeS: 12345,
            ntpSynced: true,
            engineUp: true,
            instancesUp: ['kolibri-1', 'nextcloud-1'],
            tempC: 52.1,
            throttled: '0x0',
        })
        expect(rec.ts).toMatch(/2026-11-12T10:05:00/)
    })
})
