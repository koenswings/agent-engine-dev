/**
 * Presence / sample / night catch-up scheduling (idea#411 contract §4.4).
 */
import { usageLog } from './log.js'
import {
    CATCH_UP_DAYS,
    PRESENCE_INTERVAL_MS,
    SAMPLE_INTERVAL_MS,
    addDays,
    ensureUsageDirs,
    inNightWindow,
    instanceExistedOnDay,
    kitLocalDay,
    runDir as defaultRunDir,
    usageRoot,
} from './paths.js'
import { readUsageMonitoring } from './settings.js'
import { currentSkipReason } from './skip.js'
import { hasGoodDayFile } from './store.js'
import { samplePresence, type SamplerDeps } from './sampler.js'
import { runDayHook, runSampleHook, type ClockDeps, type ExecHook } from './runner.js'
import { defaultListTargets, targetCreatedAt } from './discover.js'
import type { DayFile, SampleRecord, SkipReason, UsageSwitch, UsageTarget } from './types.js'

export function catchUpDays(today: string, hasGood: (day: string) => boolean): string[] {
    const start = addDays(today, -CATCH_UP_DAYS)
    const end = addDays(today, -1)
    return daysMissing(start, end, hasGood)
}

function daysMissing(from: string, to: string, hasGood: (day: string) => boolean): string[] {
    const out: string[] = []
    let cur = from
    for (let i = 0; i < 40 && cur <= to; i++) {
        if (!hasGood(cur)) out.push(cur)
        cur = addDays(cur, 1)
    }
    return out
}

export interface TickState {
    lastPresenceAt?: number
    lastSampleAt?: number
    lastSwitch?: UsageSwitch
    didStartupCatchUp?: boolean
}

export interface TickDeps {
    now?: () => Date
    root?: string
    runDir?: string
    readTempC?: () => number | null
    hostname?: () => string
    ntpSynced?: () => boolean
    collectPresence?: SamplerDeps
    listTargets?: () => UsageTarget[] | Promise<UsageTarget[]>
    execHook?: ExecHook
}

export interface TickResult {
    idle: boolean
    switch: UsageSwitch
    skipped?: SkipReason | null
    presence: boolean
    samples: number
    days: DayFile[]
    sampleRecords: SampleRecord[]
}

export async function processTick(state: TickState, deps: TickDeps = {}): Promise<TickResult> {
    const root = deps.root ?? usageRoot()
    const nowFn = deps.now ?? (() => new Date())
    const now = nowFn()
    const sw = readUsageMonitoring(root)
    if (state.lastSwitch === 'off' && sw === 'on') state.didStartupCatchUp = false
    state.lastSwitch = sw
    if (sw !== 'on') {
        return { idle: true, switch: sw, presence: false, samples: 0, days: [], sampleRecords: [] }
    }
    ensureUsageDirs(root)

    const clock: ClockDeps = {
        now: nowFn,
        hostname: deps.hostname,
        ntpSynced: deps.ntpSynced,
    }
    const skip = currentSkipReason({ runDir: deps.runDir ?? defaultRunDir(), readTempC: deps.readTempC })
    const result: TickResult = { idle: false, switch: sw, skipped: skip, presence: false, samples: 0, days: [], sampleRecords: [] }

    const duePresence = state.lastPresenceAt === undefined || (now.getTime() - state.lastPresenceAt) >= PRESENCE_INTERVAL_MS
    if (duePresence) {
        try {
            await samplePresence({ ...deps.collectPresence, now: nowFn, hostname: deps.hostname, readNtpSynced: deps.ntpSynced ?? deps.collectPresence?.readNtpSynced }, root)
            state.lastPresenceAt = now.getTime()
            result.presence = true
        } catch (e) {
            usageLog(`presence sample failed: ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    const targets = await (deps.listTargets ?? defaultListTargets)()
    const dueSample = state.lastSampleAt === undefined || (now.getTime() - state.lastSampleAt) >= SAMPLE_INTERVAL_MS
    if (dueSample && !skip) {
        for (const target of targets) {
            const rec = await runSampleHook({ target, root, exec: deps.execHook, clock, skipReason: skip })
            if (rec) {
                result.samples += 1
                result.sampleRecords.push(rec)
            }
        }
        state.lastSampleAt = now.getTime()
    }

    const today = kitLocalDay(now)
    const shouldCatchUp = !state.didStartupCatchUp || inNightWindow(now)
    if (shouldCatchUp) {
        // Per-target missing days, oldest first (a day can be missing for only some instances).
        for (const day of catchUpDays(today, () => false)) {
            for (const target of targets) {
                if (!instanceExistedOnDay(targetCreatedAt(target), day)) continue
                if (hasGoodDayFile(day, target.instanceId, root)) continue
                const rec = await runDayHook({ target, day, root, exec: deps.execHook, clock, skipReason: skip, overwriteOk: false })
                result.days.push(rec)
            }
        }
        state.didStartupCatchUp = true
    }
    return result
}
