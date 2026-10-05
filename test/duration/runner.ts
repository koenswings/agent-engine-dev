/**
 * Markov walker + action dispatcher + invariant checker (Phase 1–4 / idea#168).
 *
 * One YAML schema / one runner for usage + operator + infra.
 * Phase 3: usage/operator Intents via UiDriver (stub or Playwright → Pixel).
 * Phase 4: dwell stability probes between transitions.
 */

import { existsSync } from 'node:fs'
import { dispatchAction, type ActionContext } from './actions.js'
import { DEFAULT_INFRA_INVARIANTS, evaluateInvariants } from './invariants.js'
import {
    assembleWalkVideo,
    finalizeRecordedFrame,
    framePath,
} from './recordWalk.js'
import { makeRng } from './scenario.js'
import {
    DEFAULT_DWELL_MS,
    DEFAULT_FAIL_AFTER,
    DEFAULT_PROBE_INTERVAL_MS,
    CONFIRM_EJECT_MIN_DOCKER_MISSING_SETTLE_MS,
    DEFAULT_DOCKER_MISSING_SETTLE_MS,
    FAST_DWELL_MS,
    FAST_PROBE_INTERVAL_MS,
    FAST_DOCKER_MISSING_SETTLE_MS,
    runStabilityDuringDwell,
} from './stability.js'
import type {
    DurationOptions,
    Layer,
    StructuredLogEntry,
    Transition,
    WalkDefinition,
    WalkerResult,
    WalkerState,
} from './types.js'

const pickTransition = (transitions: Transition[], rng: () => number): Transition => {
    const total = transitions.reduce((s, t) => s + t.weight, 0)
    if (total <= 0) throw new Error('transition weights sum to 0')
    let r = rng() * total
    for (const t of transitions) {
        r -= t.weight
        if (r <= 0) return t
    }
    return transitions[transitions.length - 1]!
}

const nowIso = () => new Date().toISOString()

export const runWalk = async (opts: DurationOptions): Promise<WalkerResult> => {
    return runWalkWithSteps(opts)
}

/**
 * Resolve `--start-from <N|action>` against a walk's steps.
 * N is 1-based (matches duration_step numbering on a full walk).
 * Action name → first matching step. Throws on past-end / unknown action.
 */
export const resolveWalkStartIndex = (
    steps: { action: string }[],
    startFrom: number | string,
): number => {
    const raw = typeof startFrom === 'number' ? startFrom : String(startFrom).trim()
    if (typeof raw === 'number' || /^\d+$/.test(raw)) {
        const n = typeof raw === 'number' ? raw : Number(raw)
        if (!Number.isInteger(n) || n < 1) {
            throw new Error(
                `--start-from: expected 1-based step number >= 1, got ${JSON.stringify(startFrom)}`,
            )
        }
        if (n > steps.length) {
            throw new Error(`--start-from ${n}: past end (walk has ${steps.length} steps)`)
        }
        return n - 1
    }
    const action = String(raw)
    if (!action) {
        throw new Error('--start-from: empty value')
    }
    const idx = steps.findIndex(s => s.action === action)
    if (idx < 0) {
        throw new Error(`--start-from: unknown action '${action}' in walk`)
    }
    return idx
}

/**
 * Deterministic walk runner — executes WalkDefinition.steps in order.
 * Same action dispatch, invariants, dwell/stability as Markov runWalk.
 * `--iterations` defaults to steps.length and is capped at steps.length.
 * `--start-from` (optional): slice from 1-based step N or first matching action,
 * seed walker.current to that step's `from`. When both set, start-from applies
 * first, then iterations truncates the remaining slice.
 */
export const runDeterministicWalk = async (
    walk: WalkDefinition,
    opts: Omit<DurationOptions, 'scenario' | 'iterations'> & {
        iterations?: number
        /** 1-based step number or action name — see resolveWalkStartIndex. */
        startFrom?: number | string
    },
): Promise<WalkerResult> => {
    const startIndex = opts.startFrom !== undefined
        ? resolveWalkStartIndex(walk.steps, opts.startFrom)
        : 0
    const fromStart = walk.steps.slice(startIndex)
    const maxSteps = fromStart.length
    const iterations = Math.min(opts.iterations ?? maxSteps, maxSteps)
    const steps = fromStart.slice(0, iterations)
    const seedCurrent = steps[0]?.from ?? walk.scenario.initial_state
    const seedLayer = walk.scenario.states[seedCurrent]?.layer ?? null
    return runWalkWithSteps({
        ...opts,
        scenario: walk.scenario,
        iterations,
        steps,
        initialCurrent: seedCurrent,
        initialLayer: seedLayer,
        stepNumberBase: startIndex,
    })
}

type StepSpec = { from?: string; to: string; action: string }

/** Shared executor: Markov-picked transitions OR explicit walk steps. */
const runWalkWithSteps = async (
    opts: DurationOptions & {
        steps?: StepSpec[]
        /** Prefer A --start-from: seed walker.current before first step. */
        initialCurrent?: string
        initialLayer?: Layer | null
        /** Prefer A --start-from: duration_step numbers stay aligned with original walk. */
        stepNumberBase?: number
    },
): Promise<WalkerResult> => {
    const scenario = opts.scenario
    const rng = opts.rng ?? (scenario.seed !== undefined ? makeRng(scenario.seed) : Math.random)
    const fullOpts: DurationOptions = { ...opts, rng, stubUi: opts.stubUi !== false }

    const exclude = scenario.exclude_engines
    const pool = (scenario.pool_engines ?? fullOpts.ops.listPoolEngines())
        .filter(e => !exclude.includes(e))
    const fixtures = scenario.fixtures ?? []
    const fixtureDisk = scenario.fixture_disk
        ?? fixtures.find(f => f.name === 'kolibri')?.diskId
        ?? 'duration-kolibri-grade5a-001'
    const fixtureInstance = fixtures.find(f => f.diskId === fixtureDisk)?.instanceId
        ?? 'kolibri-grade5a-001'
    const fixtureDisks = fixtures.filter(f => f.infra_disk !== false).map(f => f.diskId)
    const primaryIsInfra = fixtures.some(f => f.diskId === fixtureDisk && f.infra_disk !== false)
        || fixtures.length === 0
    if (primaryIsInfra && !fixtureDisks.includes(fixtureDisk)) fixtureDisks.unshift(fixtureDisk)
    const fixtureInstances: Record<string, string> = {}
    for (const f of fixtures) {
        if (f.instanceId) fixtureInstances[f.diskId] = f.instanceId
    }
    if (fixtureInstance && !fixtureInstances[fixtureDisk]) fixtureInstances[fixtureDisk] = fixtureInstance

    await fullOpts.ops.applyStoreMode(scenario.store_mode ?? fullOpts.ops.getStoreMode())

    const stepNumberBase = opts.stepNumberBase ?? 0
    const walker: WalkerState = {
        current: opts.initialCurrent ?? scenario.initial_state,
        layer: opts.initialLayer ?? null,
        dockedEngine: null,
        step: stepNumberBase,
    }

    const logs: StructuredLogEntry[] = []
    let failures = 0
    let aborted = false
    let abortReason: string | undefined

    const useExplicit = Array.isArray(opts.steps) && opts.steps.length > 0
    const limit = useExplicit ? opts.steps!.length : fullOpts.iterations

    for (let i = 0; i < limit; i++) {
        const stateDef = scenario.states[walker.current]
        if (!stateDef) {
            aborted = true
            abortReason = `unknown state '${walker.current}'`
            break
        }

        let to: string
        let action: string
        if (useExplicit) {
            const step = opts.steps![i]!
            const walkStepNo = stepNumberBase + i + 1
            if (step.from !== undefined && step.from !== walker.current) {
                aborted = true
                abortReason =
                    `walk step ${walkStepNo}: expected from '${step.from}' but current is '${walker.current}'`
                break
            }
            const edgeOk = stateDef.transitions.some(t => t.to === step.to && t.action === step.action)
            if (!edgeOk) {
                aborted = true
                abortReason =
                    `walk step ${walkStepNo}: no edge ${walker.current} --${step.action}--> ${step.to}`
                break
            }
            to = step.to
            action = step.action
        } else {
            const transition = pickTransition(stateDef.transitions, rng)
            to = transition.to
            action = transition.action
        }

        const from = walker.current
        const started = Date.now()

        const ctx: ActionContext = {
            opts: fullOpts,
            walker,
            from,
            to,
            action,
            excludeEngines: exclude,
            poolEngines: pool,
            fixtureDisk,
            fixtureInstance,
            fixtureDisks,
            fixtureInstances,
        }

        let ok = true
        let message: string | undefined
        let invResults: StructuredLogEntry['invariants'] = []

        try {
            const result = await dispatchAction(ctx)
            ok = result.ok
            message = result.message
            if (result.dockedEngine !== undefined) walker.dockedEngine = result.dockedEngine
            if (result.layer !== undefined) walker.layer = result.layer
            walker.current = result.forceState ?? to
            if (result.forceState === 'start') walker.layer = null

            const dest = scenario.states[walker.current]
            if (dest?.layer) walker.layer = dest.layer

            const layer: Layer | null = walker.layer
            const specs = [
                ...(layer === 'infra' ? DEFAULT_INFRA_INVARIANTS : []),
                ...(dest?.invariants ?? []),
            ]
            const seen = new Set<string>()
            const deduped = specs.filter(s => {
                if (seen.has(s.type)) return false
                seen.add(s.type)
                return true
            })

            if (deduped.length > 0) {
                const evaluated = await evaluateInvariants(deduped, {
                    ops: fullOpts.ops,
                    walker,
                    excludeEngines: exclude,
                    poolEngines: pool,
                    fixtureDisk,
                    engines: pool,
                })
                invResults = evaluated
                for (const inv of evaluated) {
                    if (!inv.ok) {
                        ok = false
                        message = `${message ?? 'ok'}; invariant ${inv.type} failed: ${inv.detail ?? ''}`
                    }
                }
            }
        } catch (err) {
            ok = false
            message = err instanceof Error ? err.message : String(err)
        }

        let probeResults: StructuredLogEntry['probes'] = []
        if (ok && !fullOpts.skipStability && i < limit - 1) {
            const dwellMs = fullOpts.dwellMs
                ?? (fullOpts.fast ? FAST_DWELL_MS : DEFAULT_DWELL_MS)
            const intervalMs = fullOpts.probeIntervalMs
                ?? (fullOpts.fast ? FAST_PROBE_INTERVAL_MS : DEFAULT_PROBE_INTERVAL_MS)
            const failAfter = fullOpts.probeFailAfter ?? DEFAULT_FAIL_AFTER
            // Caller-supplied dockerMissingSettleMs always wins (unit tests pass 20ms).
            // confirm_eject needs at least 15s even under --fast (1s is too short);
            // the non-fast 90s default already covers it.
            const defaultSettleMs = fullOpts.fast
                ? FAST_DOCKER_MISSING_SETTLE_MS
                : DEFAULT_DOCKER_MISSING_SETTLE_MS
            const settleMs = action === 'confirm_eject'
                ? Math.max(defaultSettleMs, CONFIRM_EJECT_MIN_DOCKER_MISSING_SETTLE_MS)
                : defaultSettleMs
            const stab = await runStabilityDuringDwell({
                ops: fullOpts.ops,
                engines: pool,
                intervalMs,
                failAfter,
                dwellMs,
                justCompletedAction: action,
                dockerMissingSettleMs: fullOpts.dockerMissingSettleMs ?? settleMs,
            })
            probeResults = stab.samples.map(s => ({ ok: s.ok, detail: s.detail }))
            if (!stab.ok) {
                ok = false
                message = stab.abortReason ?? 'stability probe threshold exceeded'
            }
        }

        walker.step = stepNumberBase + i + 1
        const entry: StructuredLogEntry = {
            ts: nowIso(),
            step: walker.step,
            from,
            to: walker.current,
            action,
            layer: walker.layer,
            ok,
            durationMs: Date.now() - started,
            message,
            invariants: invResults,
            probes: probeResults,
        }
        logs.push(entry)
        fullOpts.onLog?.(entry)

        // --record-walk: if Playwright page is live and this step has no PNG yet
        // (infra / non-UI), capture a frame. UI Intents already recorded in actions.
        const recDir = fullOpts.recordWalkDir
        if (recDir && fullOpts.uiDriver?.kind === 'playwright') {
            const shot = framePath(recDir, walker.step, action)
            if (!existsSync(shot) && typeof fullOpts.uiDriver.screenshot === 'function') {
                try {
                    await fullOpts.uiDriver.screenshot(shot)
                } catch {
                    /* finalize below */
                }
                finalizeRecordedFrame({
                    dir: recDir,
                    step: walker.step,
                    action,
                    path: shot,
                    skipped: !existsSync(shot),
                    skipReason: existsSync(shot) ? undefined : 'live_page_unavailable',
                })
            }
        }

        if (!ok) {
            failures++
            aborted = true
            abortReason = message ?? `step ${walker.step} failed`
            break
        }
    }

    // Assemble walk.mp4 on success or abort when --record-walk was set.
    if (fullOpts.recordWalkDir) {
        assembleWalkVideo(fullOpts.recordWalkDir)
    }

    return {
        // Executed step count (duration_step log entries keep original walk numbering via stepNumberBase).
        steps: logs.length,
        failures,
        finalState: walker.current,
        logs,
        aborted,
        abortReason,
    }
}
