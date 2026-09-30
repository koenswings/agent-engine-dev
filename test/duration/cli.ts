#!/usr/bin/env npx tsx
/**
 * pnpm test:duration [--scenario minimal] [--iterations 50] [--fast] [--live]
 *
 * Default: FakeFleetOps (no Pis). Pass --live later when fleet + real FleetOps exist.
 */

import { FakeFleetOps } from './actions.js'
import { runWalk } from './runner.js'
import { loadScenario, makeRng } from './scenario.js'

const usage = () => {
    console.log(`Usage: pnpm test:duration [--scenario <name>] [--iterations <n>] [--fast] [--seed <n>]

  --scenario    scenarios/<name>.yaml (default: minimal)
  --iterations  Markov steps (default: 40 for minimal, else 100)
  --fast        pm2 restart instead of reboot; shorter settle
  --seed        RNG seed (overrides YAML seed)
  --help        this message

Phase 1–2 runs against FakeFleetOps (no fleet required). Fleet prerequisites for
a future --live path: see test/duration/README.md.
`)
}

const parseArgs = (argv: string[]) => {
    let scenario = 'minimal'
    let iterations: number | undefined
    let fast = false
    let seed: number | undefined
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!
        if (a === '--') continue // pnpm forwards a bare --
        if (a === '--help' || a === '-h') return { help: true as const }
        if (a === '--scenario') scenario = argv[++i] ?? scenario
        else if (a === '--iterations') iterations = Number(argv[++i])
        else if (a === '--fast') fast = true
        else if (a === '--seed') seed = Number(argv[++i])
        else if (a.startsWith('-')) {
            console.error(`Unknown flag: ${a}`)
            return { help: true as const }
        }
    }
    return { help: false as const, scenario, iterations, fast, seed }
}

const main = async () => {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
        usage()
        process.exit(0)
    }

    const scenario = loadScenario(args.scenario)
    const iterations = args.iterations
        ?? (scenario.name.toLowerCase().includes('minimal') ? 40 : 100)
    const seed = args.seed ?? scenario.seed
    const pool = scenario.pool_engines ?? ['idea01', 'idea03']
    const ops = new FakeFleetOps({
        poolEngines: pool,
        excludeEngines: scenario.exclude_engines,
        storeMode: scenario.store_mode,
        settleDelayMs: 0,
    })

    console.log(JSON.stringify({
        event: 'duration_start',
        scenario: scenario.name,
        iterations,
        fast: args.fast,
        seed: seed ?? null,
        store_mode: scenario.store_mode,
        pool,
        exclude_engines: scenario.exclude_engines,
        fixture_disk: scenario.fixture_disk,
    }))

    const result = await runWalk({
        scenario,
        iterations,
        fast: args.fast,
        ops,
        stubUi: true,
        settleTimeoutMs: args.fast ? 1000 : 3000,
        rng: seed !== undefined ? makeRng(seed) : undefined,
        onLog: (e) => {
            console.log(JSON.stringify({ event: 'duration_step', ...e }))
        },
    })

    console.log(JSON.stringify({
        event: 'duration_done',
        steps: result.steps,
        failures: result.failures,
        finalState: result.finalState,
        aborted: result.aborted,
        abortReason: result.abortReason ?? null,
    }))

    process.exit(result.failures > 0 || result.aborted ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(2)
})
