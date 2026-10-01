#!/usr/bin/env npx tsx
/**
 * pnpm test:duration [--scenario unified] [--iterations 50] [--fast] [--live] [--ui]
 *
 * Default: FakeFleetOps (no Pis) + StubUiDriver + canonical unified.yaml.
 * Deprecated aliases (minimal, stress, school-day, …) resolve to unified — not separate graphs.
 * --live: RealFleetOps over Tailscale/SSH (requires --hosts or DURATION_FLEET_HOSTS).
 * --ui: PlaywrightUiDriver → Pixel e2e/intents (DURATION_CONSOLE_URL / idea01 :8080).
 */

import { FakeFleetOps } from './actions.js'
import { RealFleetOps, parseHostsFlag } from './realFleetOps.js'
import { runWalk } from './runner.js'
import { loadScenario, makeRng, resolveScenarioName, SCENARIO_ALIASES } from './scenario.js'
import { createUiDriver } from './ui/index.js'

const usage = () => {
    console.log(`Usage: pnpm test:duration [options]

  --scenario <name>     scenarios/<name>.yaml (default: unified)
                        Deprecated aliases → unified: ${Object.keys(SCENARIO_ALIASES).join(', ')}
  --iterations <n>      Markov steps (default: 40)
  --fast                pm2 restart instead of reboot; shorter settle / dwell
  --seed <n>            RNG seed (overrides YAML seed)
  --live                Use RealFleetOps against fleet Pis (default: FakeFleetOps)
  --hosts <map>         Required with --live unless DURATION_FLEET_HOSTS is set.
                        Format: idea01=100.99.231.94,idea03=100.126.117.80
  --health-wrap-before <cmd>   Shell before reboot; {pis} → pool host IPs
  --health-wrap-after <cmd>    Shell after waitReady post-reboot; {pis} ok
  --ui                  Playwright UI Intents via Pixel e2e/intents (Phase 3)
  --console-url <url>   Console origin for --ui (default DURATION_CONSOLE_URL or http://idea01:8080)
  --no-stability        Skip Phase 4 dwell probes
  --dwell-ms <n>        Dwell between transitions (default: 30000 / --fast 80)
  --help                this message

Fake (CI / box, no fleet) — ONE canonical graph:
  pnpm test:duration
  pnpm test:duration -- --scenario unified --iterations 2000 --seed 42 --fast

Live (same unified graph; hosts/store are CLI knobs — not alternate YAMLs):
  pnpm test:duration -- --live --scenario unified --fast --iterations 30 \\
    --hosts idea01=100.99.231.94,idea03=100.126.117.80

Env: DURATION_FLEET_HOSTS=idea01=…,idea03=…  (same format as --hosts)

Never put idea02 in the pool. Live App-open later uses Kid sidecar
post-dock-restore-running.sh → idea166-kolibri-live :18080 (see ACTIONS.md).
See test/duration/README.md.
`)
}

interface ParsedArgs {
    help: boolean
    scenario: string
    iterations?: number
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
}

const parseArgs = (argv: string[]): ParsedArgs => {
    let scenario = 'unified'
    let iterations: number | undefined
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
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!
        if (a === '--') continue
        if (a === '--help' || a === '-h') return {
            help: true, scenario, fast, live, ui: false, noStability: false,
        }
        if (a === '--scenario') scenario = argv[++i] ?? scenario
        else if (a === '--iterations') iterations = Number(argv[++i])
        else if (a === '--fast') fast = true
        else if (a === '--seed') seed = Number(argv[++i])
        else if (a === '--live') live = true
        else if (a === '--hosts') hostsRaw = argv[++i]
        else if (a === '--health-wrap-before') healthWrapBefore = argv[++i]
        else if (a === '--health-wrap-after') healthWrapAfter = argv[++i]
        else if (a === '--ui') ui = true
        else if (a === '--console-url') consoleUrl = argv[++i]
        else if (a === '--no-stability') noStability = true
        else if (a === '--dwell-ms') dwellMs = Number(argv[++i])
        else if (a === '--engine-urls') {
            console.error('Unknown flag: --engine-urls (use --hosts name=ip,…)')
            return { help: true, scenario, fast, live, ui: false, noStability: false }
        }
        else if (a.startsWith('-')) {
            console.error(`Unknown flag: ${a}`)
            return { help: true, scenario, fast, live, ui: false, noStability: false }
        }
    }
    return {
        help: false, scenario, iterations, fast, seed, live,
        hostsRaw, healthWrapBefore, healthWrapAfter,
        ui, consoleUrl, noStability, dwellMs,
    }
}

const main = async () => {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
        usage()
        process.exit(0)
    }

    const resolvedName = resolveScenarioName(args.scenario)
    if (resolvedName !== args.scenario && SCENARIO_ALIASES[args.scenario]) {
        console.error(JSON.stringify({
            event: 'duration_scenario_alias',
            requested: args.scenario,
            resolved: resolvedName,
            note: 'Deprecated preset name — loads unified.yaml (one-graph rule)',
        }))
    }
    const scenario = loadScenario(args.scenario)
    const iterations = args.iterations ?? 40
    const seed = args.seed ?? scenario.seed
    const pool = scenario.pool_engines ?? ['idea01', 'idea03']
    const fixtureInstances: Record<string, string> = {}
    for (const f of scenario.fixtures ?? []) fixtureInstances[f.diskId] = f.instanceId

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
                '--live requires --hosts idea01=IP,idea03=IP (or DURATION_FLEET_HOSTS env)',
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

    const uiDriver = createUiDriver({
        stub: !args.ui,
        baseUrl: args.consoleUrl,
        headless: true,
        failLoud: true,
    })

    console.log(JSON.stringify({
        event: 'duration_start',
        scenario: scenario.name,
        scenario_file: resolvedName,
        iterations,
        fast: args.fast,
        seed: seed ?? null,
        store_mode: scenario.store_mode,
        pool,
        exclude_engines: scenario.exclude_engines,
        fixture_disk: scenario.fixture_disk,
        live: args.live,
        ui: args.ui,
        uiDriver: uiDriver.kind,
        hosts: hosts ?? null,
        stability: !args.noStability,
    }))

    const result = await runWalk({
        scenario,
        iterations,
        fast: args.fast,
        ops,
        stubUi: !args.ui,
        uiDriver,
        skipStability: args.noStability,
        dwellMs: args.dwellMs,
        // Live --fast: align settle with RealFleetOps PM2_RECONNECT_TIMEOUT_MS (150s).
        // Overnight smoke: 60s was insufficient after rapid pm2 on idea03.
        settleTimeoutMs: args.live
            ? (args.fast ? 150_000 : 180_000)
            : (args.fast ? 1000 : 3000),
        rng: seed !== undefined ? makeRng(seed) : undefined,
        onLog: (e) => {
            console.log(JSON.stringify({ event: 'duration_step', ...e }))
        },
    })

    await uiDriver.close?.().catch(() => {})
    if (ops instanceof RealFleetOps) {
        await ops.close().catch(() => {})
    }

    console.log(JSON.stringify({
        event: 'duration_done',
        steps: result.steps,
        failures: result.failures,
        finalState: result.finalState,
        aborted: result.aborted,
        abortReason: result.abortReason ?? null,
        live: args.live,
        scenario_file: resolvedName,
    }))

    process.exit(result.failures > 0 || result.aborted ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(2)
})
