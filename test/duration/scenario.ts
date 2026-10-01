/**
 * YAML scenario loader for duration-tests.
 * All layers share { to, weight, action } transition shape.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { FixtureRef, Layer, Scenario, StateDef, StoreMode, Transition } from './types.js'

const GOLDEN_DEFAULT = 'idea02'
const DEFAULT_POOL = ['idea01', 'idea03', 'idea04']
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
    'school-day-2engine': 'unified',
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
        if (!diskId || !instanceId) {
            throw new Error(`Scenario ${path}: fixtures.${name} requires diskId + instanceId`)
        }
        assertSafeFixtureDisk(diskId)
        out.push({
            name,
            path: typeof v.path === 'string' ? v.path : undefined,
            diskId,
            instanceId,
            infra_disk: v.infra_disk !== false,
        })
    }
    if (out.length === 0) {
        throw new Error(`Scenario ${path}: fixtures map empty after omitting deferred packs`)
    }
    return out
}

export const resolveScenarioName = (nameOrPath: string): string => {
    if (nameOrPath.endsWith('.yaml') || nameOrPath.endsWith('.yml') || nameOrPath.includes('/')) {
        return nameOrPath
    }
    return SCENARIO_ALIASES[nameOrPath] ?? nameOrPath
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
