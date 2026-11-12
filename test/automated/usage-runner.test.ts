/**
 * idea#411: hook argv shape, listed/unlisted invocation, fail-open, caps, stubs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clampTimeoutS, listedArgv, parseHookDecl, parseHookStdout, runArgv, runDayHook, runSampleHook, unlistedArgv } from '../../src/usage/runner.js'
import { hasGoodDayFile, readDayFile, writeDayFile } from '../../src/usage/store.js'
import type { DayFile, ExecResult, ListedTarget, UnlistedTarget } from '../../src/usage/types.js'

const listed = (over: Partial<ListedTarget> = {}): ListedTarget => ({
    kind: 'listed',
    instanceId: 'kolibri-1',
    name: 'Kolibri',
    app: 'kolibri',
    listed: true,
    cwd: '/instances/kolibri-1',
    hook: { service: 'kolibri', command: ['/hooks/usage.sh'], timeoutS: 30 },
    ...over,
})

const unlisted = (over: Partial<UnlistedTarget> = {}): UnlistedTarget => ({
    kind: 'unlisted',
    instanceId: 'unlisted-old-kolibri',
    name: 'old-kolibri',
    app: 'kolibri',
    listed: false,
    containerId: 'abc123',
    hook: { service: 'kolibri', command: ['/hooks/usage.sh'], timeoutS: 30 },
    hookScript: '#!/bin/sh\necho hi\n',
    ...over,
})

const okKolibri = (day = '2026-11-12') => JSON.stringify({
    schema: 'idea-usage-day/1',
    day,
    app: 'kolibri',
    setup: {
        classes: 0, classesDelta: 0,
        learner: { total: 0, beyondSeed: 0 }, learnerDelta: 0, learnerEnrolled: 0,
        teacher: { total: 0, beyondSeed: 0 }, teachersDelta: 0,
        admin: { total: 0, beyondSeed: 0 },
    },
    signins: {
        learner: { total: 0, beyondSeed: 0, sessions: 0, minutes: 0 },
        coach: { total: 0, beyondSeed: 0, sessions: 0, minutes: 0 },
        admin: { total: 0, beyondSeed: 0, sessions: 0, minutes: 0 },
    },
    content: [],
    teaching: { lessonsCreated: 0, lessonsVisible: 0, quizzesCreated: 0, quizzesStarted: 0, quizzesEnded: 0 },
    guest: { visits: 0, seconds: 0 },
})

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-usage-run-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('argv builders', () => {
    it('clamps timeoutS to 120', () => {
        expect(clampTimeoutS(500)).toBe(120)
        expect(clampTimeoutS(0)).toBe(1)
        expect(clampTimeoutS(30)).toBe(30)
    })
    it('builds listed argv with no shell, nice, ionice, env and mode args', () => {
        const argv = listedArgv({ timeoutS: 30, service: 'kolibri', command: ['/hooks/usage.sh'], mode: 'day', day: '2026-11-12' })
        expect(argv.slice(0, 8)).toEqual(['timeout', '--signal=TERM', '--kill-after=10s', '30', 'nice', '-n', '15', 'ionice'])
        expect(argv).toContain('-c3')
        expect(argv).toEqual(expect.arrayContaining(['docker', 'compose', 'exec', '-T', '-e', 'IDEA_USAGE_MODE=day', '-e', 'IDEA_USAGE_DAY=2026-11-12', 'kolibri', '/hooks/usage.sh', 'day', '2026-11-12']))
        expect(argv.join(' ')).not.toMatch(/(bash|sh) -c/)
    })
    it('omits IDEA_USAGE_DAY in sample mode', () => {
        const argv = listedArgv({ timeoutS: 30, service: 'nextcloud', command: ['/hooks/usage.sh'], mode: 'sample' })
        expect(argv).toContain('IDEA_USAGE_MODE=sample')
        expect(argv.join(' ')).not.toContain('IDEA_USAGE_DAY=')
        expect(argv.slice(-1)).toEqual(['sample'])
    })
    it('builds unlisted argv as docker exec -i … sh -s', () => {
        const argv = unlistedArgv({ timeoutS: 30, container: 'abc123', mode: 'day', day: '2026-11-12' })
        expect(argv).toEqual(expect.arrayContaining(['docker', 'exec', '-i', 'abc123', 'sh', '-s', '--', 'day', '2026-11-12']))
    })
    it('treats a command string as one token and a list as an argv prefix', () => {
        expect(parseHookDecl({ service: 'k', command: '/hooks/usage.sh', timeoutS: 10 })?.command).toEqual(['/hooks/usage.sh'])
        expect(parseHookDecl({ service: 'k', command: ['python', '/hooks/usage.py'], timeoutS: 10 })?.command).toEqual(['python', '/hooks/usage.py'])
        expect(parseHookDecl({ service: 'k', command: '/hooks/usage.sh' })).toBeNull()
        expect(parseHookDecl({ service: 'k', command: '/hooks/usage.sh', timeoutS: 0 })).toBeNull()
    })
})

describe('stdout parsing', () => {
    it('accepts one JSON object with surrounding whitespace', () => {
        const r = parseHookStdout('  {"schema":"idea-usage-day/1"} \n', 1024)
        expect(r.ok).toBe(true)
    })
    it('rejects a BOM, non-JSON, two values, or oversize', () => {
        expect(parseHookStdout('\uFEFF{"a":1}', 1024).ok).toBe(false)
        expect(parseHookStdout('not-json', 1024).ok).toBe(false)
        expect(parseHookStdout('{"a":1}{"b":2}', 1024).ok).toBe(false)
        expect(parseHookStdout('{"a":1}', 3).ok).toBe(false)
    })
})

describe('runDayHook', () => {
    const clock = { now: () => new Date('2026-11-13T02:10:00+01:00'), hostname: () => 'happy-zebra', ntpSynced: () => true }

    it('stores an ok listed result and overwrites identity fields the hook printed', async () => {
        const hookBody = JSON.parse(okKolibri())
        hookBody.engine = 'forged'
        hookBody.instance = 'forged'
        hookBody.listed = false
        hookBody.hookStatus = 'failed'
        const rec = await runDayHook({
            target: listed(),
            day: '2026-11-12',
            root: tmp,
            clock,
            exec: async () => ({ stdout: JSON.stringify(hookBody), stderr: 'dbg', exitCode: 0, timedOut: false }),
        })
        expect(rec.hookStatus).toBe('ok')
        expect(rec.engine).toBe('happy-zebra')
        expect(rec.instance).toBe('kolibri-1')
        expect(rec.listed).toBe(true)
        expect(rec.name).toBe('Kolibri')
        expect(hasGoodDayFile('2026-11-12', 'kolibri-1', tmp)).toBe(true)
    })
    it('fail-open: invalid/failed/timeout do not overwrite a good file', async () => {
        writeDayFile({
            schema: 'idea-usage-day/1', engine: 'happy-zebra', day: '2026-11-12', app: 'kolibri',
            instance: 'kolibri-1', name: 'Kolibri', demo: false, listed: true,
            clock: { synced: true, correctedBoots: 0 }, collectedAt: 'x', hookStatus: 'ok',
        } as DayFile, tmp)
        for (const result of [
            { stdout: 'nope', stderr: '', exitCode: 0, timedOut: false },
            { stdout: '', stderr: 'boom', exitCode: 1, timedOut: false },
            { stdout: '', stderr: '', exitCode: 1, timedOut: true },
        ] as ExecResult[]) {
            const rec = await runDayHook({ target: listed(), day: '2026-11-12', root: tmp, clock, exec: async () => result })
            expect(rec.hookStatus).not.toBe('ok')
            expect(readDayFile('2026-11-12', 'kolibri-1', tmp)?.hookStatus).toBe('ok')
        }
    })
    it('writes unlisted-no-hook / no-hook stubs when there is no hook', async () => {
        const u = await runDayHook({ target: unlisted({ hook: null, hookScript: undefined }), day: '2026-11-12', root: tmp, clock })
        expect(u.hookStatus).toBe('unlisted-no-hook')
        expect(u.listed).toBe(false)
        const n = await runDayHook({ target: listed({ hook: null, instanceId: 'plain-1' }), day: '2026-11-12', root: tmp, clock })
        expect(n.hookStatus).toBe('no-hook')
    })
    it('writes a no-payload stub that a later ok result replaces', async () => {
        const failed = await runDayHook({
            target: listed(),
            day: '2026-11-12',
            root: tmp,
            clock,
            exec: async () => ({ stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }),
        })
        expect(failed.hookStatus).toBe('failed')
        expect(failed.setup).toBeUndefined()
        expect(failed.signins).toBeUndefined()
        expect(readDayFile('2026-11-12', 'kolibri-1', tmp)?.hookStatus).toBe('failed')
        const ok = await runDayHook({
            target: listed(),
            day: '2026-11-12',
            root: tmp,
            clock,
            exec: async () => ({ stdout: okKolibri(), stderr: '', exitCode: 0, timedOut: false }),
        })
        expect(ok.hookStatus).toBe('ok')
        expect(ok.setup).toBeTruthy()
        expect(readDayFile('2026-11-12', 'kolibri-1', tmp)?.hookStatus).toBe('ok')
    })
    it('writes skipped with skipReason and does not call exec', async () => {
        let called = 0
        const rec = await runDayHook({
            target: listed(),
            day: '2026-11-12',
            root: tmp,
            clock,
            skipReason: 'backup',
            exec: async () => { called += 1; throw new Error('should not run') },
        })
        expect(called).toBe(0)
        expect(rec.hookStatus).toBe('skipped')
        expect(rec.skipReason).toBe('backup')
    })
    it('does not store a supported:false sample', async () => {
        const rec = await runSampleHook({
            target: listed({ app: 'kolibri' }),
            root: tmp,
            clock,
            exec: async () => ({ stdout: JSON.stringify({ schema: 'idea-usage-sample/1', app: 'kolibri', supported: false }), stderr: '', exitCode: 0, timedOut: false }),
        })
        expect(rec).toBeNull()
        expect(fs.existsSync(path.join(tmp, '2026-11-13', 'kolibri-1.samples.ndjson'))).toBe(false)
    })
    it('stores a supported Nextcloud sample', async () => {
        const rec = await runSampleHook({
            target: listed({ instanceId: 'nc-1', app: 'nextcloud', name: 'Nextcloud', hook: { service: 'app', command: ['/hooks/usage.sh'], timeoutS: 20 } }),
            root: tmp,
            clock,
            exec: async () => ({ stdout: JSON.stringify({ schema: 'idea-usage-sample/1', app: 'nextcloud', office: { tokens: 2, documentIds: ['1111111111111111'], read: 1, edit: 1 } }), stderr: '', exitCode: 0, timedOut: false }),
        })
        expect(rec?.office).toMatchObject({ tokens: 2 })
        expect(fs.existsSync(path.join(tmp, '2026-11-13', 'nc-1.samples.ndjson'))).toBe(true)
    })
})

describe('runArgv (local, no docker)', () => {
    it('captures stdout and caps stderr', async () => {
        const r = await runArgv({
            argv: [process.execPath, '-e', 'process.stdout.write("hi"); process.stderr.write("e".repeat(100)); process.exit(0)'],
            stdoutCap: 1024,
            stderrCap: 16,
            timeoutMs: 5000,
        })
        expect(r.stdout).toBe('hi')
        expect(r.stderr.length).toBe(16)
        expect(r.exitCode).toBe(0)
    })
})
