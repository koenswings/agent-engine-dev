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
    /** Omit for empty-disk packs (no app instance). */
    instanceId?: string
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
    /** Prefer A r20: make_files_disk post-check (files role landed). */
    diskTypes?: string[]
    /** r30: Backup Disk backupConfig.links (instance ids). Not part of convergence equality. */
    backupLinks?: string[]
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
    /**
     * Prefer A r36: delete Automerge instanceDB rows with storedOn=diskId so Console
     * hasInstancesOn / EmptyDiskPanel see Empty after FS wipe + redock. Optionally
     * set disk.diskTypes=['empty']. Duration fixtures only (RealFleetOps).
     */
    purgeInstancesStoredOn(engineId: string, diskId: string): Promise<void>
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
     * When true (default), UI Intents use StubUiDriver / no-op (CI / missing-Intent).
     * When false, require opts.uiDriver (Playwright) — prefer `--live --ui` for real walks.
     */
    stubUi?: boolean
    /** Phase 3: Playwright or Stub driver for usage/operator Intents. */
    uiDriver?: import('./ui/types.js').UiDriver
    /**
     * Opt-in walk recording dir (`--record-walk`). After UI / live-page steps write
     * step-NNNN-<action>.png; at walk end assemble walk.mp4 via ffmpeg.
     */
    recordWalkDir?: string
    /** Phase 4: dwell between transitions (ms). Override; else fast→80 / real→30000. */
    dwellMs?: number
    /** Phase 4: probe interval during dwell (ms). Default 30000 / fast 40. */
    probeIntervalMs?: number
    /** Phase 4: abort after N consecutive probe failures (default 3). */
    probeFailAfter?: number
    /** Post-move/copy docker settle grace; default 90s (1s under --fast). */
    dockerMissingSettleMs?: number
    /** Disable dwell probes entirely. */
    skipStability?: boolean
    /**
     * Path A (`--start-instances`): when true, return_to_start clears layer/UI but
     * keeps fixtures docked so subsequent operator Intents see Kid disks.
     * Default false — Fake Markov hygiene still undocks on return_to_start.
     */
    preserveDockedOnReturn?: boolean
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
    /**
     * idea#168: true after a successful start_after_install put a running app on
     * duration-empty-002 (late install); cleared by every fresh empty-002 re-dock.
     * The next install_app re-docks empty-002 first (redockEmpty002BeforeSecondInstall).
     */
    empty002HoldsApp?: boolean
}

/** One step in a deterministic walk file (kind: walk). */
export interface WalkStep {
    /** Optional; when set, runner validates walker.current matches before dispatch. */
    from?: string
    to: string
    action: string
}

/**
 * Deterministic walk — NOT a Markov graph.
 * Loads states/invariants/fixtures/pool from the referenced graph scenario.
 */
export interface WalkDefinition {
    kind: 'walk'
    name: string
    /** Graph scenario name (always unified today). */
    graph: string
    steps: WalkStep[]
    /** Resolved Markov scenario (states, pool, fixtures, …). */
    scenario: Scenario
    /**
     * idea#168: set when the walk file has a `shake_out:` block — a labelled variant
     * of another walk (e.g. cover-all-skip-copy of cover-all). Runs report
     * shakeOut:true + notCovered; NEVER counts as the parent walk.
     */
    shakeOut?: WalkShakeOut
}

/** Variant step range ↔ parent walk step range (1-based, inclusive, same length). */
export interface WalkStepRange {
    variant: [number, number]
    parent: [number, number]
}

/** idea#168 shake-out labelling, validated step-by-step against the parent walk. */
export interface WalkShakeOut {
    /** Parent walk name (e.g. cover-all). */
    variantOf: string
    reason?: string
    /** Parent walk step count (cover-all: 128). */
    parentSteps: number
    stepMap: WalkStepRange[]
    /** Variant steps that do not exist in the parent (honest substitutes). */
    substitutes: { variant: number; action: string; replacesParent: number[] }[]
    /** Parent steps the variant does NOT execute (parent numbering). */
    notCovered: { step: number; action: string }[]
}
