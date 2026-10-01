/**
 * Duration-tests types (idea#166 / proposals/duration-tests.md Phase 1–2).
 *
 * YAML transition shape is shared across usage / operator / infra:
 *   { to, weight, action }  — action = Intent name (snake_case, see ACTIONS.md).
 */

export type Layer = 'usage' | 'operator' | 'infra'

/** unique+mDNS-off (single-Pi) vs shared+mDNS-on (multi-Engine). */
export type StoreMode = 'unique' | 'shared'

export interface Transition {
    to: string
    weight: number
    action: string
}

export interface InvariantSpec {
    type: string
    [key: string]: unknown
}

export interface StateDef {
    description?: string
    layer?: Layer
    transitions: Transition[]
    invariants?: InvariantSpec[]
}

export interface FixtureRef {
    /** Logical pack name (kolibri / nextcloud). */
    name: string
    /** Path in agent-app-dev (documentation / future pack load). */
    path?: string
    diskId: string
    instanceId: string
    /** When true, eligible for infra_dock_fixture / move / undock. */
    infra_disk?: boolean
}

export interface Scenario {
    name: string
    duration_minutes?: number
    seed?: number
    /** Engines never targeted by destructive infra (golden idea02). */
    exclude_engines: string[]
    /** Pool engines eligible for infra dock/reboot. */
    pool_engines?: string[]
    /** Store / discovery mode for this scenario. */
    store_mode?: StoreMode
    /** @deprecated prefer fixtures[]; kept as primary infra dock target. */
    fixture_disk?: string
    /** Kid pack refs (agent-app-dev idea#166). */
    fixtures?: FixtureRef[]
    states: Record<string, StateDef>
    initial_state: string
}

/** Semantic store view — compare fields, never raw Automerge blobs. */
export interface SemanticStoreView {
    engineId: string
    instanceDB: Record<string, SemanticInstance>
    diskDB: Record<string, SemanticDisk>
    engineDB: Record<string, SemanticEngine>
}

export interface SemanticInstance {
    id: string
    status: string
    diskId: string | null
    name?: string
}

export interface SemanticDisk {
    id: string
    name?: string
    dockedTo: string | null
    device?: string | null
}

export interface SemanticEngine {
    id: string
    hostname?: string
}

export interface SettleReady {
    wsUp: boolean
    storeSynced: boolean
}

/** Phase 4 dwell probe sample (FleetOps.probeStability). */
export interface FleetStabilityProbe {
    ok: boolean
    detail?: string
    engines: { id: string; wsUp: boolean; dockerOk?: boolean; statusAnomaly?: string }[]
}

export interface StructuredLogEntry {
    ts: string
    step: number
    from: string
    to: string
    action: string
    layer: Layer | null
    ok: boolean
    durationMs: number
    message?: string
    invariants?: { type: string; ok: boolean; detail?: string }[]
    /** Phase 4: stability samples taken during post-action dwell. */
    probes?: { ok: boolean; detail?: string }[]
}

export interface WalkerResult {
    steps: number
    failures: number
    finalState: string
    logs: StructuredLogEntry[]
    aborted: boolean
    abortReason?: string
}

/**
 * Fleet / MountOps adapter. Real fleet impl can SSH + eject/dock commands;
 * Phase 1–2 ships a FakeFleetOps so tests pass without Pis.
 */
export interface FleetOps {
    /** Prefer Engine eject/dock commands over physical USB. */
    dockFixture(engineId: string, diskId: string): Promise<void>
    undockFixtures(engineIds: string[], diskId: string): Promise<void>
    /** Move: undock then dock on another pool engine. */
    moveDisk(fromEngine: string, toEngine: string, diskId: string): Promise<void>
    /** Reboot pool engine; fast=true → pm2 restart instead of sudo reboot. */
    rebootEngine(engineId: string, fast: boolean): Promise<void>
    /** Engine-owned settle: WS up + store sync ready. */
    waitReady(engineId: string, timeoutMs: number): Promise<SettleReady>
    readStore(engineId: string): Promise<SemanticStoreView>
    listPoolEngines(): string[]
    /** Apply shared-store / unique-doc + mDNS policy. */
    applyStoreMode(mode: StoreMode): Promise<void>
    getStoreMode(): StoreMode
    /**
     * Phase 4: one stability sample (WS ping + optional docker ps / status).
     * Optional — Fake + Real implement; runners fall back to waitReady.
     */
    probeStability?(engineIds: string[]): Promise<FleetStabilityProbe>
}

export interface DurationOptions {
    scenario: Scenario
    iterations: number
    fast: boolean
    ops: FleetOps
    /**
     * When true (default), UI Intents use StubUiDriver / no-op.
     * When false, require opts.uiDriver (Playwright) — Phase 3.
     */
    stubUi?: boolean
    /** Phase 3: Playwright or Stub driver for usage/operator Intents. */
    uiDriver?: import('./ui/types.js').UiDriver
    /** Phase 4: dwell between transitions (ms). Override; else fast→80 / real→30000. */
    dwellMs?: number
    /** Phase 4: probe interval during dwell (ms). Default 30000 / fast 40. */
    probeIntervalMs?: number
    /** Phase 4: abort after N consecutive probe failures (default 3). */
    probeFailAfter?: number
    /** Disable dwell probes entirely. */
    skipStability?: boolean
    settleTimeoutMs?: number
    rng?: () => number
    onLog?: (entry: StructuredLogEntry) => void
}

export interface WalkerState {
    current: string
    layer: Layer | null
    /** Engine currently holding the fixture disk, if any. */
    dockedEngine: string | null
    step: number
}
