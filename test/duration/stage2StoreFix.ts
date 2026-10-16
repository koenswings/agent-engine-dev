/**
 * Stage 2 preflight store step (READY 2026-10-09 §4.7): Atlas's box wrapper stage2-store-fix.sh,
 * run with ENGINE_SRC=/workspace/storefix-node (r44 node_modules is gone) and the D10 v2 gate
 * (D10_IDEA02_LAN=10.99.0.12). "Every store write must stay D10-gated" — the wrapper enforces it
 * (and refuses --apply on a gate FAIL); this module never bypasses the gate.
 *
 * OPT-IN: DURATION_STAGE2_STORE_FIX=off (default) | plan | apply. The D10 check reads idea02
 * (read-only); the harness agent's standing rule is never to touch idea02, so it stays off unless
 * the operator (Atlas / Steve) turns it on for a walk. plan: gate must PASS and the plan must be
 * empty (store already in the READY state) else exit 10. apply: wrapper --apply, gate-enforced.
 */
import { spawnSync } from 'node:child_process'

export const STAGE2_STORE_FIX_SCRIPT_DEFAULT = '/workspace/duration-evidence/stage2-plan/scripts/stage2-store-fix.sh'
export const STAGE2_STORE_FIX_ENGINE_SRC = '/workspace/storefix-node'
export const STAGE2_D10_IDEA02_LAN = '10.99.0.12'

export type Stage2StoreFixMode = 'off' | 'plan' | 'apply'

export const resolveStage2StoreFixMode = (env: NodeJS.ProcessEnv = process.env): Stage2StoreFixMode => {
    const raw = env.DURATION_STAGE2_STORE_FIX?.trim().toLowerCase()
    if (!raw || raw === 'off' || raw === '0') return 'off'
    if (raw === 'plan' || raw === 'apply') return raw
    throw new Error(`DURATION_STAGE2_STORE_FIX='${raw}' not supported (off | plan | apply)`)
}

export interface Stage2StoreFixCommand { file: string; args: string[]; env: Record<string, string> }

/** Pure: the exact wrapper invocation (never --plan-readonly-even-if-gate-fails: no gate bypass). */
export const buildStage2StoreFixCommand = (
    mode: Exclude<Stage2StoreFixMode, 'off'>,
    env: NodeJS.ProcessEnv = process.env,
): Stage2StoreFixCommand => ({
    file: env.DURATION_STAGE2_STORE_FIX_SCRIPT?.trim() || STAGE2_STORE_FIX_SCRIPT_DEFAULT,
    args: mode === 'apply' ? ['--apply'] : [],
    env: {
        ENGINE_SRC: env.DURATION_STAGE2_ENGINE_SRC?.trim() || STAGE2_STORE_FIX_ENGINE_SRC,
        D10_IDEA02_LAN: STAGE2_D10_IDEA02_LAN,
    },
})

export interface Stage2StoreFixVerdict { ok: boolean; gate: 'PASS' | 'FAIL' | 'unknown'; mode: string | null; plan: unknown[]; problem?: string }

/** Pure: wrapper stdout ("D10 gate: PASS" + the .mts JSON {mode, plan, warn}) + exit code → verdict. */
export const parseStage2StoreFixOutput = (stdout: string, exitCode: number, mode: Exclude<Stage2StoreFixMode, 'off'>): Stage2StoreFixVerdict => {
    const g = stdout.match(/^D10 gate: (PASS|FAIL)\s*$/m)
    const gate: Stage2StoreFixVerdict['gate'] = (g?.[1] as 'PASS' | 'FAIL' | undefined) ?? 'unknown'
    let parsed: { mode?: string; plan?: unknown[] } | null = null
    const at = stdout.indexOf('{')
    if (at >= 0) { try { parsed = JSON.parse(stdout.slice(at, stdout.lastIndexOf('}') + 1)) } catch { parsed = null } }
    const plan = Array.isArray(parsed?.plan) ? parsed!.plan : []
    const base = { gate, mode: parsed?.mode ?? null, plan }
    if (gate !== 'PASS') return { ok: false, ...base, problem: `D10 gate ${gate} — no store step (every store write stays D10-gated)` }
    if (exitCode !== 0) return { ok: false, ...base, problem: `stage2-store-fix.sh exit ${exitCode}` }
    if (!parsed) return { ok: false, ...base, problem: 'stage2-store-fix.sh printed no plan JSON' }
    if (mode === 'plan' && plan.length) return { ok: false, ...base, problem: `store not in the READY state: ${plan.length} pending write(s) ${JSON.stringify(plan).slice(0, 300)} — run the store fix (DURATION_STAGE2_STORE_FIX=apply) or re-seed` }
    if (mode === 'apply' && parsed.mode !== 'APPLY') return { ok: false, ...base, problem: `expected APPLY, wrapper ran ${parsed.mode}` }
    return { ok: true, ...base }
}

export const runStage2StoreFix = (
    mode: Exclude<Stage2StoreFixMode, 'off'>,
    env: NodeJS.ProcessEnv = process.env,
    run: (c: Stage2StoreFixCommand) => { stdout: string; status: number } = c => {
        const r = spawnSync(c.file, c.args, { env: { ...process.env, ...c.env }, encoding: 'utf8', timeout: 180_000 })
        return { stdout: `${r.stdout ?? ''}`, status: r.status ?? 1 }
    },
): Stage2StoreFixVerdict => {
    const c = buildStage2StoreFixCommand(mode, env)
    const r = run(c)
    return parseStage2StoreFixOutput(r.stdout, r.status, mode)
}
