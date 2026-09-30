/**
 * Markov walker + action dispatcher + invariant checker (Phase 1–2).
 *
 * One YAML schema / one runner for usage + operator + infra.
 * Phase 1–2: infra actions live; usage/operator Intents stubbed.
 */

import { dispatchAction, type ActionContext } from './actions.js'
import { DEFAULT_INFRA_INVARIANTS, evaluateInvariants } from './invariants.js'
import { makeRng } from './scenario.js'
import type {
    DurationOptions,
    Layer,
    StructuredLogEntry,
    Transition,
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
    const scenario = opts.scenario
    const rng = opts.rng ?? (scenario.seed !== undefined ? makeRng(scenario.seed) : Math.random)
    // Ensure opts.rng is set for action helpers that pick engines.
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
    const fixtureDisks = (fixtures.filter(f => f.infra_disk !== false).map(f => f.diskId))
    if (!fixtureDisks.includes(fixtureDisk)) fixtureDisks.unshift(fixtureDisk)
    const fixtureInstances: Record<string, string> = {}
    for (const f of fixtures) fixtureInstances[f.diskId] = f.instanceId
    if (!fixtureInstances[fixtureDisk]) fixtureInstances[fixtureDisk] = fixtureInstance

    await fullOpts.ops.applyStoreMode(scenario.store_mode ?? fullOpts.ops.getStoreMode())

    const walker: WalkerState = {
        current: scenario.initial_state,
        layer: null,
        dockedEngine: null,
        step: 0,
    }

    const logs: StructuredLogEntry[] = []
    let failures = 0
    let aborted = false
    let abortReason: string | undefined

    for (let i = 0; i < fullOpts.iterations; i++) {
        const stateDef = scenario.states[walker.current]
        if (!stateDef) {
            aborted = true
            abortReason = `unknown state '${walker.current}'`
            break
        }

        const transition = pickTransition(stateDef.transitions, rng)
        const from = walker.current
        const to = transition.to
        const action = transition.action
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
            // Advance state (return_to_start forces start).
            walker.current = result.forceState ?? to
            if (result.forceState === 'start') walker.layer = null

            // Layer tag from destination state when present.
            const dest = scenario.states[walker.current]
            if (dest?.layer) walker.layer = dest.layer

            // Invariants after settle (infra primary; optional per-state specs).
            const layer: Layer | null = walker.layer
            const specs = [
                ...(layer === 'infra' ? DEFAULT_INFRA_INVARIANTS : []),
                ...(dest?.invariants ?? []),
            ]
            // Dedupe by type (state-specific overrides first occurrence).
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

        walker.step = i + 1
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
        }
        logs.push(entry)
        fullOpts.onLog?.(entry)

        if (!ok) {
            failures++
            aborted = true
            abortReason = message ?? `step ${walker.step} failed`
            break
        }
    }

    return {
        steps: walker.step,
        failures,
        finalState: walker.current,
        logs,
        aborted,
        abortReason,
    }
}
