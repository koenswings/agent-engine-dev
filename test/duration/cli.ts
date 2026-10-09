#!/usr/bin/env npx tsx
/**
 * pnpm test:duration [--scenario random|unified|cover-all|cover-registered-intents|kolibri-*-smoke|…] [--iterations N] [--start-from N|action] [--fast] [--live] [--ui]
 *
 * Preferred verification (once Pixel+Atlas ready): `--live --ui` for real Console walks.
 * Default Fake: FakeFleetOps + StubUiDriver (CI / missing-Intent only) + Markov on unified.yaml.
 * --scenario random|unified|default → Markov simulation on scenarios/unified.yaml
 * --scenario cover-all → deterministic full-graph walk (walks/cover-all.yaml)
 * --scenario cover-registered-intents → Pixel-registered + infra walk (walks/cover-registered-intents.yaml); live --ui demo
 * --scenario cover-all-skip-copy → SHAKE-OUT variant of cover-all (no copy_app / open_copied_instance);
 *   reported shakeOut:true + notCovered (cover-all numbering). NOT a cover-all attempt.
 * Deprecated aliases (minimal, stress, school-day, …) resolve to unified — not separate graphs.
 * --live: RealFleetOps over Tailscale/SSH (requires --hosts or DURATION_FLEET_HOSTS).
 * --ui: PlaywrightUiDriver → Pixel e2e/intents (DURATION_CONSOLE_URL / idea01 :8080).
 * --record-walk <dir>: screenshots after UI/live-page steps + ffmpeg walk.mp4 (best with --ui).
 */

import { FakeFleetOps } from './actions.js'
import { RealFleetOps, parseHostsFlag } from './realFleetOps.js'
import { ensureRecordWalkDir } from './recordWalk.js'
import { resolveWalkStartIndex, runDeterministicWalk, runWalk } from './runner.js'
import {
    DEFAULT_POOL,
    isWalkScenario,
    loadScenario,
    loadWalk,
    makeRng,
    resolveScenarioName,
    SCENARIO_ALIASES,
} from './scenario.js'
import { createUiDriver, resolveConsoleIntentsDir } from './ui/index.js'
import { EXIT_CONSOLE_PIN_MISMATCH, runConsoleDeployPreflight } from './consoleDeploy.js'
import { $ } from 'zx'
import type { StructuredLogEntry } from './types.js'
import { EXIT_ENGINE_UNREACHABLE, installProcessGuards, timeoutSummary, walkExitCode } from './automergeTimeoutGuard.js'
import { DEFAULT_PREFLIGHT_TIMEOUT_MS } from './realFleetOps.js'
import { EXIT_STORE_PREFLIGHT, formatStoreMismatch, runStorePreflight } from './storePreflight.js'
import { EXIT_SLOT_PREFLIGHT } from './slotLayout.js'
import { describeStage2Windows, EXIT_STAGE2_PREFLIGHT, resolveDurationStage, stage2Preflight, stage2HomeOf, stage2SummaryFields, STAGE2_FIXTURES } from './stage2.js'
import { resolveStage2StoreFixMode, runStage2StoreFix } from './stage2StoreFix.js'
import { Stage2FleetOps } from './stage2FleetOps.js'
import { EXIT_FIXTURE_PREFLIGHT, fixtureDiskPreflight } from './fixtureDisks.js'
import {
    EXIT_PEER_PREFLIGHT,
    deriveCopyPairs,
    peerPreflightVerdict,
    requiredHelperVersion,
    type PeerHostProbe,
    type PeerPreflightResult,
} from './peerPreflight.js'
import { resolveConsoleEngineHost } from './actions.js'
import {
    buildRunSummary,
    formatRunSummaryLine,
    KeepEditingRecoveryCounter,
    shakeOutSummary,
    stepNumbers,
    tapStdoutLines,
} from './runSummary.js'

const usage = () => {
    console.log(`Usage: pnpm test:duration [options]

  --scenario <name>     Markov: random|unified (default) → scenarios/unified.yaml
                        Walk:   cover-all → walks/cover-all.yaml (strict full graph)
                        Walk:   cover-registered-intents → walks/cover-registered-intents.yaml (registered-intents walk; alias cover-hardpass)
                        Walk:   cover-all-skip-copy → SHAKE-OUT variant of cover-all (skips copy_app @43/@116,
                                open_copied_instance @117); duration_done says shakeOut:true + notCovered
                        Walk:   kolibri-*-smoke / nextcloud-*-smoke / wikipedia-smoke → short Prefer A smokes
                        Deprecated aliases → unified: ${Object.keys(SCENARIO_ALIASES).join(', ')}
  --iterations <n>      Markov steps (default: 40). Walks default to steps.length.
  --start-from <N|action>  Walks only: start at 1-based step N (duration_step numbering)
                        or first step whose action matches. Seeds walker.current to
                        that step's 'from'. With --iterations, start-from applies first
                        then remaining steps are truncated to N.
  --fast                pm2 restart instead of reboot; shorter settle / dwell
  --seed <n>            RNG seed (Markov only; overrides YAML seed)
  --live                Use RealFleetOps against fleet Pis (default: FakeFleetOps)
  --hosts <map>         Required with --live unless DURATION_FLEET_HOSTS is set.
                        Format: idea01=IP,idea03=IP,idea04=IP
  --health-wrap-before <cmd>   Shell before reboot; {pis} → pool host IPs
  --health-wrap-after <cmd>    Shell after waitReady post-reboot; {pis} ok
  --ui                  Playwright UI Intents via Pixel e2e/intents (prefer with --live)
  --console-url <url>   Console origin for --ui (default DURATION_CONSOLE_URL or http://idea01:8080)
  --record-walk <dir>   Save step-NNNN-<action>.png after UI/live-page steps; assemble walk.mp4
                        (real PNGs need Playwright page — use with --ui; Fake stub logs record_walk_skip)
  --start-instances     Path A: RealFleetOps startInstances:true (keep instances/ on dock) +
                        preserveDockedOnReturn so cover-registered-intents dock-before-inventory stays visible
  --no-stability        Skip Phase 4 dwell probes
  --no-preflight        --live: skip the pre-walk check that every pool Engine serves the
                        store over WS (default on; budget DURATION_PREFLIGHT_MS, 60000).
                        A failed preflight exits 4 ("engine <id> unreachable for Ns …").
                        With --ui it also gates the Console: the build the pool serves at
                        --console-url must be DURATION_EXPECTED_CONSOLE_SHA (default: the
                        box Intents checkout HEAD) and the Intents checkout that same commit;
                        a mismatch exits 5 (console_deploy_preflight).
                        Store preflight (EVERY --live run; NOT skipped by --no-preflight):
                        each pool Pi must use the one shared store DURATION_EXPECTED_STORE_ID
                        (default 3zoqd: store-url.txt, the running Engine's /api/store-url,
                        the harness WS doc) with mDNS ON (settings.mdns, IDEA_MDNS_DISABLE) and
                        no static peers (IDEA_STATIC_PEERS ?? settings.staticPeers); a mismatch
                        exits 6 (store_preflight, names Pi / field / expected vs actual).
                        Live store_mode must be shared (unique is refused; Fake keeps both).
                        Slot-layout preflight (EVERY --live run; NOT skipped by --no-preflight):
                        read-only, per pool Pi. No /usr/local/sbin/idea-app-data → mode=legacy
                        (pre-helper slot handling, unchanged). Helper present → mode=helper,
                        enforced: \`sudo -n idea-app-data version\` answers, the disks root is
                        root-owned and not group/other-writable, idea-test-1..6 exist, are real
                        dirs (no symlink) and pi-writable, and /etc/idea/app-data-roots (root:root
                        0644) lists each; the harness then never creates or removes a slot dir
                        (it empties slots; instances/<id> via sudo -n idea-app-data delete).
                        A failure exits 7 (slot_layout_preflight).
                        Fixture-disk preflight (EVERY --live walk; NOT skipped by --no-preflight):
                        each Empty-disk role the executed steps consume needs its own disk —
                        Files (install_app / make_files_disk: DURATION_EMPTY_DISK_ID, default
                        duration-empty-001), Backup (make_backup_disk: DURATION_BACKUP_DISK_ID,
                        default duration-empty-003), Erase (erase_disk: duration-empty-002).
                        From step 1 each must be docked on the Console engine and Empty
                        (diskTypes=[empty], no instances); with --start-from only docked +
                        distinct. A failure exits 8 (fixture_disk_preflight).
                        Peer-key preflight (EVERY --live walk; NOT skipped by --no-preflight):
                        the walk's cross-Engine copy steps (copy_app, at/after --start-from)
                        need every pool pair (never idea02) to have exchanged per-Pi Engine
                        keys: both entries publish peerAccess, each lists the other in
                        peerAccess.authorized with the other's CURRENT key + host key
                        fingerprints, no pool Engine authorizes idea02 or a non-pool Engine;
                        read-only ssh per Pi: idea-app-data version >= 2 and (if readable)
                        /etc/ssh/idea_authorized_keys/pi + /etc/idea/peer_known_hosts hold
                        the peer's published keys. The slot-layout check then also needs
                        helper >= 2 on helper Pis. No copy step → skipped (logged). A failure
                        exits 9 (peer_preflight, names the pair and the reason).
  Exit codes: 0 ok · 1 walk failures · 2 fatal/refused · 4 engine unreachable ·
              5 Console pin mismatch · 6 store preflight mismatch · 7 slot-layout preflight ·
              8 fixture-disk preflight · 9 peer-key preflight
  --dwell-ms <n>        Dwell between transitions (default: 30000 / --fast 80)
  --help                this message

Prefer real UI (Pixel Intents hardening; Fake Stub only for CI / missing Intents):
  pnpm test:duration -- --live --ui --scenario cover-registered-intents --fast \\
    --hosts idea01=…,idea03=…,idea04=… --console-url http://idea01:8080
  pnpm test:duration -- --live --ui --scenario cover-all --fast \\
    --hosts idea01=…,idea03=…,idea04=… --console-url http://idea01:8080   # strict; failLoud on Pixel-missing
  pnpm test:duration -- --live --ui --scenario random --iterations 40 --seed 42 --fast \\
    --hosts idea01=…,idea03=…,idea04=… --record-walk /tmp/dur-walk

Fake Markov (CI / box, no fleet) — ONE canonical graph:
  pnpm test:duration
  pnpm test:duration -- --scenario random --iterations 2000 --seed 42 --fast
  pnpm test:duration -- --scenario unified --iterations 2000 --seed 42 --fast

Fake deterministic walks (regression before long random soak):
  pnpm test:duration -- --scenario cover-all --fast          # strict full graph (90 actions)
  pnpm test:duration -- --scenario cover-registered-intents --fast     # registered-intents walk (alias cover-hardpass)
  pnpm test:duration -- --scenario cover-registered-intents --fast --record-walk /tmp/dur-rec   # dry-run flag (0 frames)
  pnpm test:duration -- --scenario kolibri-learn-smoke --fast
  pnpm test:duration -- --scenario kolibri-teacher-preview-smoke --fast
  pnpm test:duration -- --scenario cover-all --start-from 12 --fast          # finish_exercise onward
  pnpm test:duration -- --scenario cover-all --start-from finish_exercise --iterations 1 --fast

Live (same unified graph; hosts/store are CLI knobs — not alternate YAMLs):
  pnpm test:duration -- --live --scenario unified --fast --iterations 30 \\
    --hosts idea01=100.99.231.94,idea03=100.126.117.80,idea04=<ip>

Env: DURATION_FLEET_HOSTS=idea01=…,idea03=…,idea04=…  (same format as --hosts)

Never put idea02 in the pool. Live App-open later uses Kid sidecar
post-dock-restore-running.sh → idea166-kolibri-live :18080 (see ACTIONS.md).
Recording + cover-registered-intents (alias cover-hardpass; or cover-all) / random with --ui --live is the intended verification path
once Pixel+Atlas are ready. See test/duration/README.md.
`)
}

interface ParsedArgs {
    help: boolean
    scenario: string
    iterations?: number
    /** Walks only: 1-based step number or action name (raw CLI string). */
    startFrom?: string
    fast: boolean
    seed?: number
    live: boolean
    hostsRaw?: string
    healthWrapBefore?: string
    healthWrapAfter?: string
    ui: boolean
    consoleUrl?: string
    noStability: boolean
    dwellMs?: number
    recordWalkDir?: string
    startInstances: boolean
    noPreflight?: boolean
}

const parseArgs = (argv: string[]): ParsedArgs => {
    let scenario = 'random'
    let iterations: number | undefined
    let startFrom: string | undefined
    let fast = false
    let seed: number | undefined
    let live = false
    let hostsRaw: string | undefined
    let healthWrapBefore: string | undefined
    let healthWrapAfter: string | undefined
    let ui = false
    let consoleUrl: string | undefined
    let noStability = false
    let dwellMs: number | undefined
    let recordWalkDir: string | undefined
    let startInstances = false
    let noPreflight = false
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!
        if (a === '--') continue
        if (a === '--help' || a === '-h') return {
            help: true, scenario, fast, live, ui: false, noStability: false, startInstances: false,
        }
        if (a === '--scenario') scenario = argv[++i] ?? scenario
        else if (a === '--iterations') iterations = Number(argv[++i])
        else if (a === '--start-from') {
            startFrom = argv[++i]
            if (!startFrom) {
                console.error('--start-from requires <N|action>')
                return { help: true, scenario, fast, live, ui: false, noStability: false, startInstances: false }
            }
        }
        else if (a === '--fast') fast = true
        else if (a === '--seed') seed = Number(argv[++i])
        else if (a === '--live') live = true
        else if (a === '--hosts') hostsRaw = argv[++i]
        else if (a === '--health-wrap-before') healthWrapBefore = argv[++i]
        else if (a === '--health-wrap-after') healthWrapAfter = argv[++i]
        else if (a === '--ui') ui = true
        else if (a === '--console-url') consoleUrl = argv[++i]
        else if (a === '--record-walk') recordWalkDir = argv[++i]
        else if (a === '--start-instances') startInstances = true
        else if (a === '--no-stability') noStability = true
        else if (a === '--no-preflight') noPreflight = true
        else if (a === '--dwell-ms') dwellMs = Number(argv[++i])
        else if (a === '--engine-urls') {
            console.error('Unknown flag: --engine-urls (use --hosts name=ip,…)')
            return { help: true, scenario, fast, live, ui: false, noStability: false, startInstances: false }
        }
        else if (a.startsWith('-')) {
            console.error(`Unknown flag: ${a}`)
            return { help: true, scenario, fast, live, ui: false, noStability: false, startInstances: false }
        }
    }
    return {
        help: false, scenario, iterations, startFrom, fast, seed, live,
        hostsRaw, healthWrapBefore, healthWrapAfter,
        ui, consoleUrl, noStability, dwellMs, recordWalkDir, startInstances, noPreflight,
    }
}

const main = async () => {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
        usage()
        process.exit(0)
    }

    if (args.recordWalkDir) {
        ensureRecordWalkDir(args.recordWalkDir)
        if (!args.ui) {
            console.error(JSON.stringify({
                event: 'record_walk_warn',
                message:
                    '--record-walk without --ui: Fake Stub has no Playwright page; ' +
                    'UI steps log record_walk_skip (dry-run of flag wiring). ' +
                    'Prefer --record-walk with --ui (and --live) for real PNGs + walk.mp4.',
                dir: args.recordWalkDir,
            }))
        }
    }

    const walkMode = isWalkScenario(args.scenario)
    const walk = walkMode ? loadWalk(args.scenario) : null
    // idea#168: shake-out variants (walk file has shake_out:) are labelled everywhere.
    const shakeOut = shakeOutSummary(walk)
    const scenario = walk ? walk.scenario : loadScenario(args.scenario)
    const resolvedName = walk
        ? args.scenario
        : resolveScenarioName(args.scenario)

    if (!walk && resolvedName !== args.scenario && SCENARIO_ALIASES[args.scenario]) {
        console.error(JSON.stringify({
            event: 'duration_scenario_alias',
            requested: args.scenario,
            resolved: resolvedName,
            note: 'Deprecated preset name — loads unified.yaml (one-graph rule)',
        }))
    }

    if (args.startFrom !== undefined && !walk) {
        console.error('--start-from applies to deterministic walks only (e.g. --scenario cover-all)')
        process.exit(2)
    }
    let startFromResolved: string | number | undefined
    if (walk && args.startFrom !== undefined) {
        try {
            // Prefer numeric when the CLI token is all digits; else action name.
            startFromResolved = /^\d+$/.test(args.startFrom)
                ? Number(args.startFrom)
                : args.startFrom
            // Validate early for clear CLI errors (runner also validates).
            resolveWalkStartIndex(walk.steps, startFromResolved)
        } catch (err) {
            console.error(err instanceof Error ? err.message : String(err))
            process.exit(2)
        }
    }
    const startIndex = walk && startFromResolved !== undefined
        ? resolveWalkStartIndex(walk.steps, startFromResolved)
        : 0
    const walkRemaining = walk ? walk.steps.length - startIndex : 0
    const iterations = walk
        ? Math.min(args.iterations ?? walkRemaining, walkRemaining)
        : (args.iterations ?? 40)
    const seed = args.seed ?? scenario.seed
    const pool = scenario.pool_engines ?? [...DEFAULT_POOL]
    // idea#168: the cross-Engine copy steps this run executes (--start-from / --iterations
    // applied) and the pool pairs whose per-Pi keys they need (peer preflight, exit 9).
    const peerPlan = walk
        ? deriveCopyPairs({
            steps: walk.steps,
            startIndex,
            endIndex: startIndex + iterations,
            poolEngines: pool,
            excludeEngines: scenario.exclude_engines,
        })
        : null
    const fixtureInstances: Record<string, string> = {}
    for (const f of scenario.fixtures ?? []) {
        if (f.instanceId) fixtureInstances[f.diskId] = f.instanceId
    }

    if (args.live && pool.includes('idea02')) {
        console.error('Refusing --live with idea02 in pool_engines (golden)')
        process.exit(2)
    }

    let ops: FakeFleetOps | RealFleetOps
    const durationStage = resolveDurationStage()
    const stage2Fields = durationStage === 2 ? stage2SummaryFields(walk?.steps ?? null) : null
    let hosts: Record<string, string> | undefined

    if (args.live) {
        const hostsSource = args.hostsRaw ?? process.env.DURATION_FLEET_HOSTS
        if (!hostsSource) {
            console.error(
                '--live requires --hosts idea01=IP,idea03=IP,idea04=IP (or DURATION_FLEET_HOSTS env)',
            )
            process.exit(2)
        }
        hosts = parseHostsFlag(hostsSource)
        for (const id of pool) {
            if (!hosts[id]) {
                console.error(`--live: missing host for pool engine '${id}' in --hosts`)
                process.exit(2)
            }
        }
        if (hosts['idea02'] && pool.includes('idea02')) {
            console.error('Refusing --live with idea02 in pool')
            process.exit(2)
        }
        const opsOpts = {
            poolEngines: pool,
            excludeEngines: scenario.exclude_engines,
            hosts,
            // idea#168 r38: live pool = one shared store (unique refused by RealFleetOps).
            storeMode: scenario.store_mode ?? 'shared',
            fixtureInstances,
            healthWrapBefore: args.healthWrapBefore,
            healthWrapAfter: args.healthWrapAfter,
            startInstances: args.startInstances,
        }
        // Stage 2 (DURATION_STAGE=2): real SSD partitions via stage2-dock.sh; Stage 1 unchanged otherwise.
        ops = durationStage === 2 ? new Stage2FleetOps(opsOpts) : new RealFleetOps(opsOpts)
    } else {
        ops = new FakeFleetOps({
            poolEngines: pool,
            excludeEngines: scenario.exclude_engines,
            storeMode: scenario.store_mode,
            settleDelayMs: 0,
            fixtureInstances,
        })
    }

    // --ui → Playwright always (never silently force Stub for registered Intents).
    // Deferred / unregistered soft-skip or clear-fail via failLoud.
    const uiDriver = createUiDriver({
        stub: !args.ui,
        baseUrl: args.consoleUrl,
        headless: true,
        failLoud: true,
    })

    const commonStart = {
        event: 'duration_start',
        scenario: walk ? walk.name : scenario.name,
        scenario_file: resolvedName,
        mode: walk ? 'walk' as const : 'markov' as const,
        walk_file: walk ? args.scenario : null,
        shakeOut: !!shakeOut,
        ...(shakeOut
            ? { variantOf: shakeOut.variantOf, notCovered: shakeOut.notCovered, stepNumbering: shakeOut.stepNumbering }
            : {}),
        iterations,
        start_from: args.startFrom ?? null,
        fast: args.fast,
        seed: seed ?? null,
        store_mode: scenario.store_mode,
        pool,
        exclude_engines: scenario.exclude_engines,
        fixture_disk: scenario.fixture_disk,
        live: args.live,
        ui: args.ui,
        uiDriver: uiDriver.kind,
        record_walk: args.recordWalkDir ?? null,
        start_instances: args.startInstances,
        hosts: hosts ?? null,
        stability: !args.noStability,
        stage: durationStage,
        ...(stage2Fields ?? {}),
    }
    console.log(JSON.stringify(commonStart))

    // r32: fail fast before step 1 when a pool Engine does not serve the store over WS,
    // instead of discovering it as an "own store" withTimeout 60 s into the walk.
    if (ops instanceof RealFleetOps && !args.noPreflight) {
        const budget = Number(process.env.DURATION_PREFLIGHT_MS ?? DEFAULT_PREFLIGHT_TIMEOUT_MS)
        const pf = await ops.preflightEngines(budget)
        console.log(JSON.stringify({ event: 'engine_preflight', ok: pf.ok, budgetMs: budget, engines: pf.engines }))
        if (!pf.ok) {
            for (const e of pf.engines.filter(x => !x.ok)) {
                console.error(`[duration] FATAL (preflight): ${e.message ?? `engine ${e.id} not ready`}`)
            }
            console.log(JSON.stringify(timeoutSummary()))
            await uiDriver.close?.().catch(() => {})
            await ops.close().catch(() => {})
            process.exit(EXIT_ENGINE_UNREACHABLE)
        }
    }

    // idea#168 r38: EVERY live run (any scenario / walk, not skippable by --no-preflight):
    // each pool Pi must be on the one shared dev store (DURATION_EXPECTED_STORE_ID, default
    // 3zoqd) with mDNS ON and no static peers — the production replica. Read-only ssh + the
    // Engine's own /api/store-url + the harness WS doc. Mismatch → exit 6 before step 1.
    if (ops instanceof RealFleetOps) {
        const sp = await runStorePreflight(pool, ops.getHostMap(), {
            probe: id => ops.probeStoreConfig(id),
            fetchStoreUrl: async (host, port) => {
                const res = await fetch(`http://${host}:${port}/api/store-url`, { signal: AbortSignal.timeout(10_000) })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                return res.text()
            },
            ws: id => ops.wsStoreInfo(id),
        })
        console.log(JSON.stringify({ event: 'store_preflight', ok: sp.ok, expected_store_id: sp.expected, pis: sp.pis, mismatches: sp.mismatches }))
        if (!sp.ok) {
            for (const m of sp.mismatches) console.error(`[duration] FATAL (${formatStoreMismatch(m)})`)
            console.log(JSON.stringify(timeoutSummary()))
            await uiDriver.close?.().catch(() => {})
            await ops.close().catch(() => {})
            process.exit(EXIT_STORE_PREFLIGHT)
        }

        // idea#168 (Steve GO, option a): EVERY live run — which slot layout is in force on each
        // pool Pi (helper vs legacy), and a helper Pi's layout must be what the helper needs.
        // Read-only ssh. Legacy Pis (no helper: the current f65183a pool) pass unchanged.
        // Helper floor: v1 in general, v2 when the walk copies across Pis (peer keys = v2 sync-peers).
        const helperMin = peerPlan ? requiredHelperVersion(peerPlan) : 1
        if (ops instanceof Stage2FleetOps) {
            // Stage 2: no idea-test-N slots; partitions by PARTLABEL, Engine settings pinned, store home state.
            const s2ops = ops
            // READY §4.7: store step = stage2-store-fix.sh behind the D10 v2 gate (opt-in; default off).
            const storeFixMode = resolveStage2StoreFixMode()
            if (storeFixMode !== 'off') {
                const sf = runStage2StoreFix(storeFixMode)
                console.log(JSON.stringify({ event: 'stage2_store_fix', mode: storeFixMode, ok: sf.ok, gate: sf.gate, plan: sf.plan, problem: sf.problem ?? null }))
                if (!sf.ok) {
                    console.error(`[duration] FATAL (stage2 store step): ${sf.problem}`)
                    console.log(JSON.stringify(timeoutSummary()))
                    await uiDriver.close?.().catch(() => {})
                    await ops.close().catch(() => {})
                    process.exit(EXIT_STAGE2_PREFLIGHT)
                }
            } else {
                console.log('[duration] stage2 store step: off (DURATION_STAGE2_STORE_FIX=plan|apply runs stage2-store-fix.sh behind D10 v2)')
            }
            const status: Parameters<typeof stage2Preflight>[0]['status'] = {}
            const configYaml: Parameters<typeof stage2Preflight>[0]['configYaml'] = {}
            for (const e of pool) {
                try { status[e] = await s2ops.stage2Status(e) } catch (err) { status[e] = err instanceof Error ? err : new Error(String(err)) }
                try { configYaml[e] = await s2ops.probeEngineConfig(e) } catch (err) { configYaml[e] = err instanceof Error ? err : new Error(String(err)) }
            }
            const store: Parameters<typeof stage2Preflight>[0]['store'] = {}
            try {
                const view = await s2ops.readStore(pool[0]!)
                for (const f of STAGE2_FIXTURES) {
                    const d = view.diskDB[f.diskId]
                    if (!d) continue
                    store[f.diskId] = {
                        dockedTo: await s2ops.findDockedEngine(f.diskId),
                        diskTypes: [...(d.diskTypes ?? [])],
                        instances: Object.values(view.instanceDB).filter(x => x.diskId === f.diskId).map(x => x.id),
                    }
                }
            } catch (err) { console.error(`[duration] stage2 preflight: store read failed: ${err instanceof Error ? err.message : String(err)}`) }
            const s2 = stage2Preflight({ pool, hosts: ops.getHostMap(), status, configYaml, store, ...(walk ? { steps: walk.steps.slice(0, startIndex + iterations) } : {}) })
            console.log(`[duration] ${s2.message}`)
            console.log(JSON.stringify({ event: 'stage2_preflight', ok: s2.ok, table: s2.table, problems: s2.problems }))
            if (!s2.ok) {
                for (const p of s2.problems) console.error(`[duration] FATAL (stage2 preflight): ${p}`)
                console.log(JSON.stringify(timeoutSummary()))
                await uiDriver.close?.().catch(() => {})
                await ops.close().catch(() => {})
                process.exit(EXIT_STAGE2_PREFLIGHT)
            }
            // D5 safety net: remember every pool Pi's boot_id so a 05:00 / unplanned reboot is seen
            // at the next fixture op and reconciled (dock-ssd → re-undock held → wait docked).
            const bootIds = await s2ops.recordBootIds(pool)
            const roleWindows = walk ? describeStage2Windows(walk.steps.slice(0, startIndex + iterations)) : ''
            console.log(JSON.stringify({ event: 'stage2_walk_start', bootIds, roleWindows }))
        }
        const sl = ops instanceof Stage2FleetOps ? [] : await ops.preflightSlotLayout(pool, helperMin)
        for (const v of sl) console.log(`[duration] ${v.message}`)
        console.log(JSON.stringify({
            event: 'slot_layout_preflight',
            ok: sl.every(v => v.ok),
            helper_min_version: helperMin,
            pis: sl.map(v => ({ engine: v.engine, host: v.host, mode: v.ok || v.mode === 'helper' ? v.mode : 'unknown', helper_version: v.helperVersion, ok: v.ok, problems: v.problems })),
        }))
        if (!sl.every(v => v.ok)) {
            for (const v of sl.filter(x => !x.ok)) console.error(`[duration] FATAL (${v.message})`)
            console.log(JSON.stringify(timeoutSummary()))
            await uiDriver.close?.().catch(() => {})
            await ops.close().catch(() => {})
            process.exit(EXIT_SLOT_PREFLIGHT)
        }

        // idea#168 r38@103: EVERY live walk — the Files, Backup and Erase Empty disks the walk
        // consumes must be distinct, docked and (from step 1) Empty on the Console engine, else
        // exit 8 before step 1 instead of failing at erase_disk 100 steps in. Read-only.
        if (walk) {
            const consoleEngine = resolveConsoleEngineHost(
                { poolEngines: pool, excludeEngines: scenario.exclude_engines, opts: { ops } },
                { ...process.env, ...(args.consoleUrl ? { DURATION_CONSOLE_URL: args.consoleUrl } : {}) },
            )
            let fp: ReturnType<typeof fixtureDiskPreflight> | null = null
            let readErr: string | null = null
            try {
                fp = fixtureDiskPreflight({
                    steps: walk.steps.slice(0, startIndex + iterations),
                    startIndex,
                    consoleEngine,
                    poolEngines: pool.filter(e => !scenario.exclude_engines.includes(e)),
                    view: await ops.readStore(consoleEngine),
                    ...(ops instanceof Stage2FleetOps ? { expectedHostOf: stage2HomeOf } : {}),
                })
            } catch (e) {
                readErr = `fixture disk preflight: store read on ${consoleEngine} failed: ${e instanceof Error ? e.message : String(e)}`
            }
            console.log(`[duration] ${fp?.message ?? readErr}`)
            console.log(JSON.stringify({
                event: 'fixture_disk_preflight',
                ok: !!fp?.ok,
                from_start: fp?.fromStart ?? startIndex <= 0,
                console_engine: consoleEngine,
                roles: (fp?.roles ?? []).map(r => ({
                    role: r.role, disk_id: r.diskId, steps: r.steps, docked_to: r.state.dockedTo,
                    disk_types: r.state.diskTypes, instances: r.state.instances, empty: r.state.empty, ok: r.ok,
                })),
                problems: fp?.problems ?? [readErr],
            }))
            if (!fp?.ok) {
                for (const p of fp?.problems ?? [readErr]) console.error(`[duration] FATAL (fixture disk preflight): ${p}`)
                console.log(JSON.stringify(timeoutSummary()))
                await uiDriver.close?.().catch(() => {})
                await ops.close().catch(() => {})
                process.exit(EXIT_FIXTURE_PREFLIGHT)
            }

            // idea#168 per-Pi Engine keys: every cross-Engine copy step the run executes needs its
            // pool pairs' keys published and mutually accepted (the Engine's copy validate()
            // refuses otherwise) — exit 9 before step 1, not at copy_app 40/116 steps in. Read-only.
            const plan = peerPlan!
            let pv: PeerPreflightResult
            if (!plan.pairs.length) {
                pv = peerPreflightVerdict({ plan, store: { via: consoleEngine, engines: {}, liveIdOf: {} } })
            } else {
                const engines = [...new Set(plan.pairs.flatMap(p => [p.a, p.b]))]
                const probes: Record<string, PeerHostProbe | Error> = {}
                for (const e of engines) {
                    try {
                        probes[e] = await ops.probePeerHost(e)
                    } catch (err) {
                        probes[e] = err instanceof Error ? err : new Error(String(err))
                    }
                }
                try {
                    pv = peerPreflightVerdict({ plan, store: await ops.readPeerStore(consoleEngine), hosts: ops.getHostMap(), probes })
                } catch (err) {
                    const why = `peer preflight: store read on ${consoleEngine} failed: ${err instanceof Error ? err.message : String(err)}`
                    pv = { ok: false, skipped: false, pairs: [], problems: [{ kind: 'probe-failed', subject: consoleEngine, message: why }], notes: [], message: why }
                }
            }
            console.log(`[duration] ${pv.message}`)
            for (const n of pv.notes) console.log(`[duration] peer preflight note: ${n}`)
            console.log(JSON.stringify({
                event: 'peer_preflight',
                ok: pv.ok,
                skipped: pv.skipped,
                copy_steps: plan.copySteps,
                from_step: plan.fromStep,
                helper_min_version: helperMin,
                pairs: pv.pairs.length
                    ? pv.pairs.map(r => ({ a: r.a, b: r.b, host_a: r.hostA, host_b: r.hostB, steps: r.steps, a_accepts_b: r.aAcceptsB, b_accepts_a: r.bAcceptsA, ok: r.ok }))
                    : plan.pairs.map(p => ({ a: p.a, b: p.b, steps: p.steps })),
                problems: pv.problems,
                notes: pv.notes,
            }))
            if (!pv.ok) {
                for (const p of pv.problems) console.error(`[duration] FATAL (peer preflight, ${p.kind}): ${p.message}`)
                console.log(JSON.stringify(timeoutSummary()))
                await uiDriver.close?.().catch(() => {})
                await ops.close().catch(() => {})
                process.exit(EXIT_PEER_PREFLIGHT)
            }
        }
    }

    // r36@98: the browser drives the Console the POOL serves (--console-url), not the box
    // checkout that supplies the Intents. Its commit must equal the pin
    // (DURATION_EXPECTED_CONSOLE_SHA, else the box Intents checkout HEAD) and the box Intents
    // checkout must be that same commit — else fail loud before step 1. Read-only.
    if (ops instanceof RealFleetOps && args.ui && !args.noPreflight) {
        const consoleUrl = args.consoleUrl ?? process.env.DURATION_CONSOLE_URL ?? 'http://idea01:8080'
        const fleet = ops
        const intentsDir = resolveConsoleIntentsDir()
        const cd = await runConsoleDeployPreflight(consoleUrl, fleet.getHostMap(), {
            fetchText: async url => {
                const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
                return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() }
            },
            probeDist: host => fleet.probeConsoleDist(host),
            boxHead: async () => {
                if (!intentsDir) return null
                const r = await $`git -C ${intentsDir} rev-parse HEAD`.quiet()
                return r.stdout.trim() || null
            },
        })
        console.log(JSON.stringify({
            event: 'console_deploy_preflight',
            ok: cd.ok,
            method: cd.method,
            console_url: consoleUrl,
            served_sha: cd.servedSha,
            pin: cd.pin,
            box_intents_head: cd.boxHead,
            intents_dir: intentsDir,
            note: cd.note,
        }))
        if (!cd.ok) {
            console.error(`[duration] FATAL (console preflight): ${cd.note}`)
            console.log(JSON.stringify(timeoutSummary()))
            await uiDriver.close?.().catch(() => {})
            await ops.close().catch(() => {})
            process.exit(EXIT_CONSOLE_PIN_MISMATCH)
        }
    }

    const onLog = (e: StructuredLogEntry) => {
        // Shake-out: every step line also carries its parent (cover-all) step number.
        console.log(JSON.stringify({ event: 'duration_step', ...e, ...stepNumbers(walk, e.step) }))
    }
    const settleTimeoutMs = args.live
        ? (args.fast ? 150_000 : 180_000)
        : (args.fast ? 1000 : 3000)

    const sharedOpts = {
        fast: args.fast,
        ops,
        stubUi: !args.ui,
        uiDriver,
        skipStability: args.noStability,
        dwellMs: args.dwellMs,
        settleTimeoutMs,
        recordWalkDir: args.recordWalkDir,
        preserveDockedOnReturn: args.startInstances,
        onLog,
    }

    // idea#168: count the Console keep_editing Intent's {"event":"keep_editing_recovery"}
    // lines as they go to stdout (= run.log); reported in duration_summary / duration_done.
    const recoveryCounter = new KeepEditingRecoveryCounter()
    const untapStdout = tapStdoutLines(line => recoveryCounter.addLines(line))
    const result = walk
        ? await runDeterministicWalk(walk, {
            ...sharedOpts,
            iterations,
            startFrom: startFromResolved,
        })
        : await runWalk({
            scenario,
            iterations,
            ...sharedOpts,
            rng: seed !== undefined ? makeRng(seed) : undefined,
        })

    untapStdout()
    await uiDriver.close?.().catch(() => {})
    if (ops instanceof RealFleetOps) {
        await ops.close().catch(() => {})
    }

    console.log(JSON.stringify(timeoutSummary()))
    const summary = { ...buildRunSummary({ walk, result, recoveries: recoveryCounter.snapshot() }), ...(stage2Fields ?? {}) }
    console.log(JSON.stringify(summary))
    console.log(formatRunSummaryLine(summary) + (stage2Fields
        ? ` | STAGE 2: ${stage2Fields.stage2NotCovered.map(n => `@${n.step} ${n.action} = network copy`).join(', ') || 'no gap steps'} (physical move not covered)`
        : ''))
    console.log(JSON.stringify({
        event: 'duration_done',
        mode: walk ? 'walk' : 'markov',
        walk: walk?.name ?? null,
        shakeOut: summary.shakeOut,
        ...(stage2Fields ?? {}),
        ...(shakeOut
            ? { variantOf: shakeOut.variantOf, notCovered: shakeOut.notCovered, stepNumbering: shakeOut.stepNumbering }
            : {}),
        lastStep: summary.lastStep,
        keepEditingRecoveries: summary.keepEditingRecoveries,
        steps: result.steps,
        failures: result.failures,
        finalState: result.finalState,
        aborted: result.aborted,
        abortReason: result.abortReason ?? null,
        live: args.live,
        scenario_file: resolvedName,
        record_walk: args.recordWalkDir ?? null,
    }))

    process.exit(walkExitCode(result))
}

/**
 * r30 (2026-10-06): with mDNS ON the harness's automerge-repo clients receive docs
 * relayed by the pool Engines (incl. production idea02's foreign docs) and can hit
 * an internal `withTimeout: timed out after 60000ms` rejection that nobody awaits.
 * Node then killed the walker mid-step (cover-all r30 died at step 9 open_video,
 * not an Intent failure). See automergeTimeoutGuard.ts for the policy:
 *   - only automerge-repo's withTimeout TimeoutError is considered for tolerance;
 *   - on the walker's OWN store doc it is FATAL (exit 2): a real sync bug;
 *   - foreign / own CommandLog / undeterminable doc → tolerated, logged as
 *     `automerge_find_timeout_tolerated` with docId, peerId, class;
 *   - any other unhandledRejection or uncaughtException → exit 2.
 */
installProcessGuards()

main().catch(err => {
    console.error(err)
    console.log(JSON.stringify(timeoutSummary()))
    process.exit(2)
})
