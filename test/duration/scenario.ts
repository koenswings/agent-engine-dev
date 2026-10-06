/**
 * YAML scenario loader for duration-tests.
 * All layers share { to, weight, action } transition shape.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { FixtureRef, Layer, Scenario, StateDef, StoreMode, Transition, WalkDefinition, WalkShakeOut, WalkStep } from './types.js'

const GOLDEN_DEFAULT = 'idea02'
export const DEFAULT_POOL = ['idea01', 'idea03', 'idea04']
/** Synthetic fixture id — NEVER the idea03 hw-roundtrip stick (USB 26A1EE83197F / vfat 3E50-902A). */
/** Primary infra dock target — Kid Kolibri Grade 5A pack (agent-app-dev#10). */
export const DEFAULT_FIXTURE_DISK = 'duration-kolibri-grade5a-001'
export const DEFAULT_FIXTURE_INSTANCE = 'kolibri-grade5a-001'
export const NEXTCLOUD_FIXTURE_DISK = 'duration-nextcloud-grade5a-001'
export const NEXTCLOUD_FIXTURE_INSTANCE = 'nextcloud-grade5a-001'

const FORBIDDEN_FIXTURE_MARKERS = [
    '26A1EE83197F',
    '3E50-902A',
    '3813430-532011020',
    '378383c9-0612-4c82-9c07-8c34d15253ba',
    'a0bf8374-274e-4bef-b32e-cfbfd09d2884',
]

/** Deprecated CLI/scenario names → canonical unified.yaml (one-graph rule). */
export const SCENARIO_ALIASES: Record<string, string> = {
    minimal: 'unified',
    'minimal-live': 'unified',
    'minimal-dock': 'unified',
    stress: 'unified',
    'school-day': 'unified',
}

/** Markov / random synonyms — all load scenarios/unified.yaml (not a walk). */
export const MARKOV_SCENARIO_NAMES = new Set(['unified', 'random', ''])

/** Deprecated walk CLI names → canonical walks/<name>.yaml basename (brief compat). */
export const WALK_ALIASES: Record<string, string> = {
    'cover-hardpass': 'cover-registered-intents',
}

/** Resolve walk CLI name (alias → canonical basename; paths unchanged). */
export const resolveWalkName = (nameOrPath: string): string => {
    if (!nameOrPath) return nameOrPath
    if (nameOrPath.endsWith('.yaml') || nameOrPath.endsWith('.yml') || nameOrPath.includes('/')) {
        return nameOrPath
    }
    return WALK_ALIASES[nameOrPath] ?? nameOrPath
}

export const scenariosDir = (): string => {
    // Prefer source tree (tsx / repo root); fall back relative to this file.
    const fromCwd = resolve(process.cwd(), 'test/duration/scenarios')
    try {
        readFileSync(join(fromCwd, 'unified.yaml'), 'utf8')
        return fromCwd
    } catch {
        const here = dirname(fileURLToPath(import.meta.url))
        return join(here, 'scenarios')
    }
}

export const walksDir = (): string => {
    const fromCwd = resolve(process.cwd(), 'test/duration/walks')
    try {
        readFileSync(join(fromCwd, 'cover-all.yaml'), 'utf8')
        return fromCwd
    } catch {
        const here = dirname(fileURLToPath(import.meta.url))
        return join(here, 'walks')
    }
}

const asLayer = (v: unknown): Layer | undefined => {
    if (v === 'usage' || v === 'operator' || v === 'infra') return v
    return undefined
}

const asStoreMode = (v: unknown): StoreMode | undefined => {
    if (v === 'unique' || v === 'shared') return v
    return undefined
}

const parseTransition = (raw: unknown, stateName: string, index: number): Transition => {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`State '${stateName}' transition[${index}]: expected object`)
    }
    const t = raw as Record<string, unknown>
    if (typeof t.to !== 'string' || !t.to) {
        throw new Error(`State '${stateName}' transition[${index}]: missing 'to'`)
    }
    if (typeof t.weight !== 'number' || !(t.weight > 0)) {
        throw new Error(`State '${stateName}' transition[${index}]: weight must be a positive number`)
    }
    if (typeof t.action !== 'string' || !t.action) {
        throw new Error(
            `State '${stateName}' transition[${index}]: missing 'action' Intent name ` +
            `(YAML schema requires to + weight + action for ALL layers)`,
        )
    }
    return { to: t.to, weight: t.weight, action: t.action }
}

const parseState = (name: string, raw: unknown): StateDef => {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`State '${name}': expected object`)
    }
    const s = raw as Record<string, unknown>
    const transitionsRaw = s.transitions
    if (!Array.isArray(transitionsRaw) || transitionsRaw.length === 0) {
        throw new Error(`State '${name}': transitions must be a non-empty array`)
    }
    const transitions = transitionsRaw.map((t, i) => parseTransition(t, name, i))
    let invariants: StateDef['invariants']
    if (Array.isArray(s.invariants)) {
        invariants = (s.invariants as Record<string, unknown>[]).map(inv => {
            if (typeof inv.type !== 'string') {
                throw new Error(`State '${name}': invariant missing type`)
            }
            return { ...inv, type: inv.type as string }
        })
    }
    return {
        description: typeof s.description === 'string' ? s.description : undefined,
        layer: asLayer(s.layer),
        transitions,
        invariants,
    }
}

export const assertSafeFixtureDisk = (fixtureDisk: string): void => {
    const upper = fixtureDisk.toUpperCase()
    for (const marker of FORBIDDEN_FIXTURE_MARKERS) {
        if (upper.includes(marker.toUpperCase()) || fixtureDisk.includes(marker)) {
            throw new Error(
                `Fixture disk '${fixtureDisk}' looks like the idea03 hw-roundtrip stick ` +
                `(forbidden marker ${marker}). Duration tests must use a dedicated fixture.`,
            )
        }
    }
}


const DEFAULT_FIXTURES: FixtureRef[] = [
    {
        name: 'kolibri',
        path: 'tests/duration-tests/fixtures/kolibri',
        diskId: DEFAULT_FIXTURE_DISK,
        instanceId: DEFAULT_FIXTURE_INSTANCE,
        infra_disk: true,
    },
    {
        name: 'nextcloud',
        path: 'tests/duration-tests/fixtures/nextcloud',
        diskId: NEXTCLOUD_FIXTURE_DISK,
        instanceId: NEXTCLOUD_FIXTURE_INSTANCE,
        infra_disk: true,
    },
]

const parseFixtures = (raw: unknown, path: string): FixtureRef[] => {
    if (raw === undefined || raw === null) return DEFAULT_FIXTURES.map(f => ({ ...f }))
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`Scenario ${path}: fixtures must be a map of pack name → { diskId, instanceId, ... }`)
    }
    const out: FixtureRef[] = []
    for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
        if (name === 'kiwix') continue // deferred Phase 3
        if (!val || typeof val !== 'object') {
            throw new Error(`Scenario ${path}: fixtures.${name} must be an object`)
        }
        const v = val as Record<string, unknown>
        const diskId = typeof v.diskId === 'string' ? v.diskId : undefined
        const instanceId = typeof v.instanceId === 'string' ? v.instanceId : undefined
        if (!diskId) {
            throw new Error(`Scenario ${path}: fixtures.${name} requires diskId`)
        }
        assertSafeFixtureDisk(diskId)
        out.push({
            name,
            path: typeof v.path === 'string' ? v.path : undefined,
            diskId,
            ...(instanceId ? { instanceId } : {}),
            infra_disk: v.infra_disk !== false,
        })
    }
    if (out.length === 0) {
        throw new Error(`Scenario ${path}: fixtures map empty after omitting deferred packs`)
    }
    return out
}

/**
 * Resolve CLI --scenario name for Markov graphs.
 * `random` (and empty) → unified. Walk names (e.g. cover-all / cover-registered-intents) are NOT Markov aliases —
 * use isWalkScenario / loadWalk instead.
 */
export const resolveScenarioName = (nameOrPath: string): string => {
    if (!nameOrPath || nameOrPath === 'random') return 'unified'
    if (nameOrPath.endsWith('.yaml') || nameOrPath.endsWith('.yml') || nameOrPath.includes('/')) {
        return nameOrPath
    }
    return SCENARIO_ALIASES[nameOrPath] ?? nameOrPath
}

/** True when --scenario names a deterministic walk (not the Markov graph). */
export const isWalkScenario = (nameOrPath: string): boolean => {
    if (!nameOrPath || nameOrPath === 'random' || nameOrPath === 'unified') return false
    if (SCENARIO_ALIASES[nameOrPath]) return false
    if (nameOrPath.endsWith('.walk.yaml') || nameOrPath.endsWith('.walk.yml')) return true
    const walkName = resolveWalkName(nameOrPath)
    // Bare name: prefer walks/<name>.yaml when present (after walk alias resolve)
    try {
        readFileSync(join(walksDir(), `${walkName}.yaml`), 'utf8')
        return true
    } catch {
        return false
    }
}

export const loadWalk = (nameOrPath: string): WalkDefinition => {
    const resolved = resolveWalkName(nameOrPath)
    const path = resolved.endsWith('.yaml') || resolved.endsWith('.yml') || resolved.includes('/')
        ? resolve(resolved)
        : join(walksDir(), `${resolved}.yaml`)

    const text = readFileSync(path, 'utf8')
    const raw = parseYaml(text) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') {
        throw new Error(`Walk ${path}: empty or invalid YAML`)
    }
    if (raw.kind !== 'walk') {
        throw new Error(`Walk ${path}: kind must be 'walk' (got ${JSON.stringify(raw.kind)})`)
    }
    if (typeof raw.name !== 'string' || !raw.name) {
        throw new Error(`Walk ${path}: missing name`)
    }
    if (typeof raw.graph !== 'string' || !raw.graph) {
        throw new Error(`Walk ${path}: missing graph (e.g. unified)`)
    }
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
        throw new Error(`Walk ${path}: steps must be a non-empty array`)
    }

    const scenario = loadScenario(raw.graph)
    const steps: WalkStep[] = raw.steps.map((step, i) => {
        if (!step || typeof step !== 'object') {
            throw new Error(`Walk ${path}: steps[${i}] expected object`)
        }
        const st = step as Record<string, unknown>
        if (typeof st.to !== 'string' || !st.to) {
            throw new Error(`Walk ${path}: steps[${i}] missing 'to'`)
        }
        if (typeof st.action !== 'string' || !st.action) {
            throw new Error(`Walk ${path}: steps[${i}] missing 'action'`)
        }
        if (!scenario.states[st.to]) {
            throw new Error(`Walk ${path}: steps[${i}] to unknown state '${st.to}'`)
        }
        if (st.from !== undefined) {
            if (typeof st.from !== 'string' || !st.from) {
                throw new Error(`Walk ${path}: steps[${i}] from must be a string`)
            }
            if (!scenario.states[st.from]) {
                throw new Error(`Walk ${path}: steps[${i}] from unknown state '${st.from}'`)
            }
        }
        return {
            from: typeof st.from === 'string' ? st.from : undefined,
            to: st.to,
            action: st.action,
        }
    })

    validateWalkEdges(steps, scenario, path, raw.graph)
    const shakeOut = raw.shake_out === undefined
        ? undefined
        : parseShakeOut(raw.shake_out, steps, path)

    return {
        kind: 'walk',
        name: raw.name,
        graph: raw.graph,
        steps,
        scenario,
        ...(shakeOut ? { shakeOut } : {}),
    }
}

/**
 * idea#168: a walk may only use EXISTING graph edges. Every step's
 * from --action--> to must be a transition in the graph scenario; steps are
 * continuous (from == previous to). Step 1's from defaults to initial_state
 * (an explicit step-1 from is allowed for smoke walks / --start-from seeds).
 * The runner re-checks at dispatch; this fails the walk at load, before any Pi work.
 */
export const validateWalkEdges = (
    steps: WalkStep[],
    scenario: Scenario,
    path: string,
    graph: string,
): void => {
    let prevTo: string | null = null
    steps.forEach((st, i) => {
        const n = i + 1
        if (prevTo !== null && st.from !== undefined && st.from !== prevTo) {
            throw new Error(
                `Walk ${path}: step ${n} (${st.action}) from '${st.from}' but step ${n - 1} ended at '${prevTo}' (walk must be continuous)`,
            )
        }
        const from = st.from ?? prevTo ?? scenario.initial_state
        const def = scenario.states[from]
        if (!def) {
            throw new Error(`Walk ${path}: step ${n} from unknown state '${from}'`)
        }
        if (!def.transitions.some(t => t.to === st.to && t.action === st.action)) {
            throw new Error(
                `Walk ${path}: step ${n}: no edge ${from} --${st.action}--> ${st.to} in graph '${graph}' ` +
                    `(walks may only use existing graph edges)`,
            )
        }
        prevTo = st.to
    })
}

const intPair = (v: unknown, what: string, path: string): [number, number] => {
    if (!Array.isArray(v) || v.length !== 2 || !v.every(x => Number.isInteger(x) && (x as number) >= 1)) {
        throw new Error(`Walk ${path}: shake_out ${what} must be [first, last] (1-based integers)`)
    }
    const [a, b] = v as [number, number]
    if (b < a) throw new Error(`Walk ${path}: shake_out ${what} [${a}, ${b}] is reversed`)
    return [a, b]
}

/**
 * idea#168 shake-out block: the variant maps onto its parent walk (cover-all) in
 * ranges; every mapped step must be the SAME edge (from/to/action) as the parent
 * step; every variant step is mapped or an explicit substitute; the parent steps
 * left unmapped must be exactly not_covered (parent numbering, actions checked).
 */
const parseShakeOut = (rawSo: unknown, steps: WalkStep[], path: string): WalkShakeOut => {
    if (!rawSo || typeof rawSo !== 'object' || Array.isArray(rawSo)) {
        throw new Error(`Walk ${path}: shake_out must be an object`)
    }
    const so = rawSo as Record<string, unknown>
    if (typeof so.variant_of !== 'string' || !so.variant_of) {
        throw new Error(`Walk ${path}: shake_out.variant_of missing (e.g. cover-all)`)
    }
    const parent = loadWalk(so.variant_of)
    if (parent.shakeOut) {
        throw new Error(`Walk ${path}: shake_out.variant_of '${so.variant_of}' is itself a shake-out variant`)
    }
    const ps = parent.steps
    const vMapped = new Map<number, number>()
    const pMapped = new Set<number>()
    if (!Array.isArray(so.step_map) || so.step_map.length === 0) {
        throw new Error(`Walk ${path}: shake_out.step_map must be a non-empty array`)
    }
    const stepMap = so.step_map.map((m, k) => {
        const mm = (m ?? {}) as Record<string, unknown>
        const variant = intPair(mm.variant, `step_map[${k}].variant`, path)
        const par = intPair(mm.parent, `step_map[${k}].parent`, path)
        if (variant[1] - variant[0] !== par[1] - par[0]) {
            throw new Error(`Walk ${path}: shake_out step_map[${k}] ranges differ in length`)
        }
        for (let d = 0; d <= variant[1] - variant[0]; d++) {
            const v = variant[0] + d
            const p = par[0] + d
            const vs = steps[v - 1]
            const pst = ps[p - 1]
            if (!vs) throw new Error(`Walk ${path}: shake_out step_map variant @${v} past end (${steps.length} steps)`)
            if (!pst) throw new Error(`Walk ${path}: shake_out step_map ${so.variant_of} @${p} past end (${ps.length} steps)`)
            if (vMapped.has(v) || pMapped.has(p)) {
                throw new Error(`Walk ${path}: shake_out step_map overlaps at variant @${v} / ${so.variant_of} @${p}`)
            }
            const vFrom = vs.from ?? (v === 1 ? undefined : steps[v - 2]!.to)
            const pFrom = pst.from ?? (p === 1 ? undefined : ps[p - 2]!.to)
            if (vs.action !== pst.action || vs.to !== pst.to || vFrom !== pFrom) {
                throw new Error(
                    `Walk ${path}: shake_out variant @${v} (${vFrom} --${vs.action}--> ${vs.to}) ` +
                        `is not ${so.variant_of} @${p} (${pFrom} --${pst.action}--> ${pst.to})`,
                )
            }
            vMapped.set(v, p)
            pMapped.add(p)
        }
        return { variant, parent: par }
    })
    const substitutes = (Array.isArray(so.substitutes) ? so.substitutes : []).map((s, k) => {
        const ss = (s ?? {}) as Record<string, unknown>
        const v = ss.variant
        if (!Number.isInteger(v) || !steps[(v as number) - 1]) {
            throw new Error(`Walk ${path}: shake_out.substitutes[${k}].variant must be a variant step number`)
        }
        if (vMapped.has(v as number)) {
            throw new Error(`Walk ${path}: shake_out substitute @${v} is also in step_map`)
        }
        if (ss.action !== steps[(v as number) - 1]!.action) {
            throw new Error(
                `Walk ${path}: shake_out substitute @${v} action '${String(ss.action)}' ≠ step action '${steps[(v as number) - 1]!.action}'`,
            )
        }
        const rep = Array.isArray(ss.replaces_parent) ? ss.replaces_parent : []
        for (const p of rep) {
            if (!Number.isInteger(p) || pMapped.has(p as number) || !ps[(p as number) - 1]) {
                throw new Error(`Walk ${path}: shake_out substitute @${v} replaces_parent ${String(p)} must be an unmapped ${so.variant_of} step`)
            }
        }
        vMapped.set(v as number, 0)
        return { variant: v as number, action: ss.action as string, replacesParent: rep as number[] }
    })
    for (let v = 1; v <= steps.length; v++) {
        if (!vMapped.has(v)) {
            throw new Error(`Walk ${path}: shake_out: variant @${v} (${steps[v - 1]!.action}) neither mapped nor a substitute`)
        }
    }
    if (!Array.isArray(so.not_covered) || so.not_covered.length === 0) {
        throw new Error(`Walk ${path}: shake_out.not_covered must list the ${so.variant_of} steps the variant skips`)
    }
    const notCovered = so.not_covered.map((n, k) => {
        const nn = (n ?? {}) as Record<string, unknown>
        const step = nn.step
        if (!Number.isInteger(step) || !ps[(step as number) - 1]) {
            throw new Error(`Walk ${path}: shake_out.not_covered[${k}].step must be a ${so.variant_of} step number`)
        }
        if (nn.action !== ps[(step as number) - 1]!.action) {
            throw new Error(
                `Walk ${path}: shake_out.not_covered ${so.variant_of} @${step} is '${ps[(step as number) - 1]!.action}', not '${String(nn.action)}'`,
            )
        }
        return { step: step as number, action: nn.action as string }
    })
    const unmapped = ps.map((_, i) => i + 1).filter(p => !pMapped.has(p))
    const listed = notCovered.map(n => n.step).sort((a, b) => a - b)
    if (unmapped.join(',') !== listed.join(',')) {
        throw new Error(
            `Walk ${path}: shake_out.not_covered [${listed.join(',')}] must equal the ${so.variant_of} steps ` +
                `the variant skips [${unmapped.join(',')}] (no silent gaps)`,
        )
    }
    return {
        variantOf: so.variant_of,
        ...(typeof so.reason === 'string' ? { reason: so.reason } : {}),
        parentSteps: ps.length,
        stepMap,
        substitutes,
        notCovered,
    }
}

/** idea#168: parent (cover-all) step number for a variant step, or null for a substitute / non-variant walk. */
export const parentStepFor = (walk: WalkDefinition, variantStep: number): number | null => {
    const so = walk.shakeOut
    if (!so) return null
    for (const m of so.stepMap) {
        if (variantStep >= m.variant[0] && variantStep <= m.variant[1]) {
            return m.parent[0] + (variantStep - m.variant[0])
        }
    }
    return null
}

export const loadScenario = (nameOrPath: string): Scenario => {
    const resolved = resolveScenarioName(nameOrPath)
    const path = resolved.endsWith('.yaml') || resolved.endsWith('.yml') || resolved.includes('/')
        ? resolve(resolved)
        : join(scenariosDir(), `${resolved}.yaml`)

    const text = readFileSync(path, 'utf8')
    const raw = parseYaml(text) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') {
        throw new Error(`Scenario ${path}: empty or invalid YAML`)
    }
    if (typeof raw.name !== 'string') throw new Error(`Scenario ${path}: missing name`)
    if (!raw.states || typeof raw.states !== 'object') throw new Error(`Scenario ${path}: missing states`)
    if (typeof raw.initial_state !== 'string') throw new Error(`Scenario ${path}: missing initial_state`)

    const states: Record<string, StateDef> = {}
    for (const [key, val] of Object.entries(raw.states as Record<string, unknown>)) {
        states[key] = parseState(key, val)
    }
    if (!states[raw.initial_state]) {
        throw new Error(`Scenario ${path}: initial_state '${raw.initial_state}' not in states`)
    }

    // Validate transition targets exist
    for (const [from, def] of Object.entries(states)) {
        for (const t of def.transitions) {
            if (!states[t.to]) {
                throw new Error(`Scenario ${path}: state '${from}' transitions to unknown '${t.to}'`)
            }
        }
    }

    const exclude = Array.isArray(raw.exclude_engines)
        ? (raw.exclude_engines as unknown[]).map(String)
        : [GOLDEN_DEFAULT]
    if (!exclude.includes(GOLDEN_DEFAULT)) {
        exclude.push(GOLDEN_DEFAULT)
    }

    const fixtures = parseFixtures(raw.fixtures, path)
    const fixtureDisk = typeof raw.fixture_disk === 'string'
        ? raw.fixture_disk
        : (fixtures.find(f => f.name === 'kolibri')?.diskId ?? fixtures[0]!.diskId)
    assertSafeFixtureDisk(fixtureDisk)
    for (const f of fixtures) assertSafeFixtureDisk(f.diskId)

    const pool = Array.isArray(raw.pool_engines)
        ? (raw.pool_engines as unknown[]).map(String).filter(e => !exclude.includes(e))
        : DEFAULT_POOL.filter(e => !exclude.includes(e))

    if (pool.length === 0) {
        throw new Error(`Scenario ${path}: no pool engines left after exclude_engines`)
    }

    return {
        name: raw.name,
        duration_minutes: typeof raw.duration_minutes === 'number' ? raw.duration_minutes : undefined,
        seed: typeof raw.seed === 'number' ? raw.seed : undefined,
        exclude_engines: exclude,
        pool_engines: pool,
        store_mode: asStoreMode(raw.store_mode) ?? (pool.length >= 2 ? 'shared' : 'unique'),
        fixture_disk: fixtureDisk,
        fixtures,
        states,
        initial_state: raw.initial_state,
    }
}

/** Mulberry32 seeded RNG for reproducible walks. */
export const makeRng = (seed: number): (() => number) => {
    let t = seed >>> 0
    return () => {
        t += 0x6d2b79f5
        let r = Math.imul(t ^ (t >>> 15), 1 | t)
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296
    }
}
