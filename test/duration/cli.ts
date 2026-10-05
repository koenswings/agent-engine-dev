#!/usr/bin/env npx tsx
/**
 * pnpm test:duration [--scenario random|unified|cover-all|cover-registered-intents|kolibri-*-smoke|…] [--iterations N] [--start-from N|action] [--fast] [--live] [--ui]
 *
 * Preferred verification (once Pixel+Atlas ready): `--live --ui` for real Console walks.
 * Default Fake: FakeFleetOps + StubUiDriver (CI / missing-Intent only) + Markov on unified.yaml.
 * --scenario random|unified|default → Markov simulation on scenarios/unified.yaml
 * --scenario cover-all → deterministic full-graph walk (walks/cover-all.yaml)
 * --scenario cover-registered-intents → Pixel-registered + infra walk (walks/cover-registered-intents.yaml); live --ui demo
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
import { createUiDriver } from './ui/index.js'
import type { StructuredLogEntry } from './types.js'

const usage = () => {
    console.log(`Usage: pnpm test:duration [options]

  --scenario <name>     Markov: random|unified (default) → scenarios/unified.yaml
                        Walk:   cover-all → walks/cover-all.yaml (strict full graph)
                        Walk:   cover-registered-intents → walks/cover-registered-intents.yaml (registered-intents walk; alias cover-hardpass)
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
        ui, consoleUrl, noStability, dwellMs, recordWalkDir, startInstances,
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
    const fixtureInstances: Record<string, string> = {}
    for (const f of scenario.fixtures ?? []) {
        if (f.instanceId) fixtureInstances[f.diskId] = f.instanceId
    }

    if (args.live && pool.includes('idea02')) {
        console.error('Refusing --live with idea02 in pool_engines (golden)')
        process.exit(2)
    }

    let ops: FakeFleetOps | RealFleetOps
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
        ops = new RealFleetOps({
            poolEngines: pool,
            excludeEngines: scenario.exclude_engines,
            hosts,
            storeMode: scenario.store_mode ?? 'unique',
            fixtureInstances,
            healthWrapBefore: args.healthWrapBefore,
            healthWrapAfter: args.healthWrapAfter,
            startInstances: args.startInstances,
        })
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
    }
    console.log(JSON.stringify(commonStart))

    const onLog = (e: StructuredLogEntry) => {
        console.log(JSON.stringify({ event: 'duration_step', ...e }))
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

    await uiDriver.close?.().catch(() => {})
    if (ops instanceof RealFleetOps) {
        await ops.close().catch(() => {})
    }

    console.log(JSON.stringify({
        event: 'duration_done',
        mode: walk ? 'walk' : 'markov',
        steps: result.steps,
        failures: result.failures,
        finalState: result.finalState,
        aborted: result.aborted,
        abortReason: result.abortReason ?? null,
        live: args.live,
        scenario_file: resolvedName,
        record_walk: args.recordWalkDir ?? null,
    }))

    process.exit(result.failures > 0 || result.aborted ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(2)
})
