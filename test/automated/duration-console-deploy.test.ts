/**
 * duration-console-deploy.test.ts — idea#168 r36@98: the Console pin must point at the
 * Console the POOL serves (--console-url), not the box Intents checkout.
 *
 * r36 pinned 2d972c5 by checking /workspace/agent-console-dev, while idea01:8080 served a
 * 230b70f dist (pre-c981361) that sent `backupApp kolibri Duration Tests — Empty Disk 002`.
 */

import { describe, it, expect } from 'vitest'
import {
    EXIT_CONSOLE_PIN_MISMATCH,
    consoleDeployVerdict,
    consoleDistProbeScript,
    consoleHostFor,
    mainAssetFromIndexHtml,
    parseBuildStamp,
    parseConsoleDistProbe,
    runConsoleDeployPreflight,
    shaMatches,
    type ConsoleDeployInput,
    type ConsoleDistProbe,
} from '../duration/consoleDeploy.js'

const C230 = '230b70f0000000000000000000000000000000aa'
const C1A4 = '1a46f20000000000000000000000000000000000bb'.slice(0, 40)
const C2D9 = '2d972c5122de15a4839979b3b6e21b03e08f636c'
const HOSTS = { idea01: '100.99.231.94', idea03: '100.126.117.80', idea04: '100.108.39.45' }
const INDEX = (asset: string) =>
    `<!DOCTYPE html><html><head><script type="module" crossorigin src="/${asset}"></script>` +
    `<link rel="stylesheet" crossorigin href="/assets/index-Bpkm8dCF.css"></head><body></body></html>`
const R36_ASSET = 'assets/index-DtPYwV_T.js'
const probe = (o: Partial<ConsoleDistProbe> = {}): ConsoleDistProbe => ({
    consolePath: '/home/pi/idea/agents/agent-console-dev/dist',
    head: C1A4,
    dirty: 0,
    headTime: 1_791_200_000,
    distMtime: 1_791_200_600,
    distAsset: R36_ASSET,
    ...o,
})
const input = (o: Partial<ConsoleDeployInput> = {}): ConsoleDeployInput => ({
    consoleUrl: 'http://idea01:8080',
    consoleHost: 'idea01',
    pin: C1A4.slice(0, 7),
    pinSource: 'DURATION_EXPECTED_CONSOLE_SHA',
    boxHead: C1A4,
    servedAsset: R36_ASSET,
    stamp: null,
    probe: probe(),
    ...o,
})

describe('r36@98: console_deploy_preflight — the served Console must be the pinned Console', () => {
    it('r36 exactly: pool serves the 230b70f dist, pin 2d972c5 on the box → refused before step 1, naming both', () => {
        const v = consoleDeployVerdict(input({ pin: '2d972c5', boxHead: C2D9, probe: probe({ head: C230, headTime: 1_791_100_000 }) }))
        expect(v.ok).toBe(false)
        expect(v.method).toBe('ssh-checkout')
        expect(v.servedSha).toBe(C230)
        expect(v.note).toMatch(/^console_deploy_preflight: http:\/\/idea01:8080 \(idea01\) serves the dist of Console 230b70f \(idea01:\/home\/pi\/idea\/agents\/agent-console-dev\/dist\), not the pin\. Pin 2d972c5/)
        expect(v.note).toMatch(/not the box checkout — deploy the pinned Console to the pool/)
        expect(v.note).toMatch(/No soft-pass\.$/)
    })

    it('r37: pool serves 1a46f20 (clean, dist newer than the commit, served asset = that dist), box Intents at 1a46f20 → ok', () => {
        const v = consoleDeployVerdict(input())
        expect(v.ok, v.note).toBe(true)
        expect(v.servedSha).toBe(C1A4)
        expect(v.note).toMatch(/serves assets\/index-DtPYwV_T\.js = idea01:\/home\/pi\/idea\/agents\/agent-console-dev\/dist built from Console 1a46f20 \(clean; dist newer than commit\) = pin 1a46f20/)
    })

    it('box Intents checkout on another commit than the pin → refused (even when the pool is right)', () => {
        const v = consoleDeployVerdict(input({ boxHead: C2D9 }))
        expect(v.ok).toBe(false)
        expect(v.note).toMatch(/box Intents checkout is 2d972c5, not the pinned Console\. Pin 1a46f20/)
    })

    it('served index.html asset differs from the probed dist (not the served dir) → refused', () => {
        const v = consoleDeployVerdict(input({ servedAsset: 'assets/index-OTHER123.js' }))
        expect(v.ok).toBe(false)
        expect(v.note).toMatch(/serves assets\/index-OTHER123\.js but idea01:.*references assets\/index-DtPYwV_T\.js — not the served dist/)
    })

    it('pinned commit but tracked changes, or a dist older than the commit (stale build) → refused', () => {
        const dirty = consoleDeployVerdict(input({ probe: probe({ dirty: 3 }) }))
        expect(dirty.ok).toBe(false)
        expect(dirty.note).toMatch(/has 3 tracked change\(s\)/)
        const stale = consoleDeployVerdict(input({ probe: probe({ distMtime: 1_791_100_000 }) }))
        expect(stale.ok).toBe(false)
        expect(stale.note).toMatch(/stale dist, rebuild/)
        const unknown = consoleDeployVerdict(input({ probe: probe({ distMtime: null }) }))
        expect(unknown.ok).toBe(false)
    })

    it('probe failures: ssh error, no consolePath, not a git checkout, unreadable index.html → refused', () => {
        expect(consoleDeployVerdict(input({ probe: null, probeError: 'ssh: timeout' })).note).toMatch(/read-only probe of idea01 failed: ssh: timeout/)
        expect(consoleDeployVerdict(input({ probe: probe({ consolePath: null }) })).note).toMatch(/has no consolePath/)
        expect(consoleDeployVerdict(input({ probe: probe({ head: null }) })).note).toMatch(/not inside a git checkout/)
        expect(consoleDeployVerdict(input({ servedAsset: null })).note).toMatch(/could not read the main asset/)
    })

    it('build-info.json stamp (proposed Console change) wins over ssh: match ok, mismatch / dirty refused', () => {
        const ok = consoleDeployVerdict(input({ stamp: { sha: C1A4 }, probe: null }))
        expect(ok.ok, ok.note).toBe(true)
        expect(ok.method).toBe('build-info')
        const bad = consoleDeployVerdict(input({ stamp: { sha: C230 }, probe: null }))
        expect(bad.ok).toBe(false)
        expect(bad.note).toMatch(/serves Console 230b70f \(build-info\.json\), not the pin/)
        expect(consoleDeployVerdict(input({ stamp: { sha: C1A4, dirty: true }, probe: null })).ok).toBe(false)
    })

    it('Console URL not on a pool host and no stamp → refused (cannot tell what it serves)', () => {
        const v = consoleDeployVerdict(input({ consoleUrl: 'http://localhost:5173', consoleHost: null, probe: null }))
        expect(v.ok).toBe(false)
        expect(v.note).toMatch(/not a pool engine host and serves no build-info\.json/)
    })

    it('helpers: shaMatches, mainAssetFromIndexHtml, parseBuildStamp, consoleHostFor', () => {
        expect(shaMatches(C1A4, '1a46f20')).toBe(true)
        expect(shaMatches('1a46f20', C1A4)).toBe(true)
        expect(shaMatches(C230, '1a46f20')).toBe(false)
        expect(shaMatches('1a4', C1A4)).toBe(false) // too short to pin
        expect(shaMatches(null, C1A4)).toBe(false)
        expect(mainAssetFromIndexHtml(INDEX(R36_ASSET))).toBe(R36_ASSET)
        expect(mainAssetFromIndexHtml('<html></html>')).toBeNull()
        expect(parseBuildStamp(`{"sha":"${C1A4}","dirty":false,"builtAt":"2026-10-06T08:00:00Z"}`)).toEqual({ sha: C1A4, dirty: false, builtAt: '2026-10-06T08:00:00Z' })
        expect(parseBuildStamp(INDEX(R36_ASSET))).toBeNull() // SPA fallback for a missing file
        expect(consoleHostFor('http://idea01:8080', HOSTS)).toBe('idea01')
        expect(consoleHostFor('http://100.126.117.80:8080/', HOSTS)).toBe('idea03')
        expect(consoleHostFor('http://localhost:5173', HOSTS)).toBeNull()
        expect(EXIT_CONSOLE_PIN_MISMATCH).toBe(5)
    })

    it('parseConsoleDistProbe reads the probe output; the probe script is read-only', () => {
        const out = [
            'consolePath=/home/pi/idea/agents/agent-console-dev/dist',
            `head=${C230}`,
            'dirty=0',
            'headTime=1791158417',
            'distMtime=1791160816',
            `distAsset=${R36_ASSET}`,
        ].join('\n')
        expect(parseConsoleDistProbe(out)).toEqual({
            consolePath: '/home/pi/idea/agents/agent-console-dev/dist',
            head: C230,
            dirty: 0,
            headTime: 1791158417,
            distMtime: 1791160816,
            distAsset: R36_ASSET,
        })
        expect(parseConsoleDistProbe('consolePath=\nhead=\n').head).toBeNull()
        const script = consoleDistProbeScript()
        expect(script).toMatch(/\/home\/pi\/idea\/agents\/agent-engine-dev\/config\.yaml/)
        // only reads: no writes, moves, deletes, builds, checkouts, service changes
        expect(script).not.toMatch(/\b(rm|mv|cp|tee|touch|mkdir|chmod|chown|sudo|pm2|docker|systemctl|npm|pnpm|checkout|reset|pull|fetch|clean)\b/)
        expect(script).not.toMatch(/(^|[^2&])>(?!&)/) // no redirect into a file (2>/dev/null only)
        expect(script.match(/>/g)?.length).toBe((script.match(/2>\/dev\/null/g) ?? []).length)
    })

    it('runConsoleDeployPreflight: env pin vs served 230b70f → refused; pin defaults to the box Intents HEAD; no pin → refused', async () => {
        const deps = (served: string, box: string | null, stampBody?: string) => {
            const seen: string[] = []
            return {
                seen,
                deps: {
                    fetchText: async (url: string) => {
                        seen.push(url)
                        if (url.endsWith('/build-info.json')) {
                            return stampBody
                                ? { status: 200, contentType: 'application/json', body: stampBody }
                                : { status: 200, contentType: 'text/html; charset=utf-8', body: INDEX(R36_ASSET) }
                        }
                        return { status: 200, contentType: 'text/html', body: INDEX(R36_ASSET) }
                    },
                    probeDist: async (host: string) => {
                        seen.push(`probe:${host}`)
                        return probe({ head: served })
                    },
                    boxHead: async () => box,
                },
            }
        }
        const r36 = deps(C230, C1A4)
        const bad = await runConsoleDeployPreflight('http://idea01:8080', HOSTS, r36.deps, { DURATION_EXPECTED_CONSOLE_SHA: '1a46f20' })
        expect(bad.ok).toBe(false)
        expect(bad.pin).toBe('1a46f20')
        expect(bad.note).toMatch(/serves the dist of Console 230b70f .* not the pin\. Pin 1a46f20 \(DURATION_EXPECTED_CONSOLE_SHA\)/)
        expect(r36.seen).toEqual(['http://idea01:8080/build-info.json', 'http://idea01:8080/', 'probe:idea01'])

        const good = await runConsoleDeployPreflight('http://idea01:8080/', HOSTS, deps(C1A4, C1A4).deps, {})
        expect(good.ok, good.note).toBe(true)
        expect(good.note).toMatch(/pin 1a46f20 \(box Intents checkout HEAD \(DURATION_EXPECTED_CONSOLE_SHA unset\)\)/)

        const boxOff = await runConsoleDeployPreflight('http://idea01:8080', HOSTS, deps(C1A4, C2D9).deps, { DURATION_EXPECTED_CONSOLE_SHA: C1A4 })
        expect(boxOff.ok).toBe(false)
        expect(boxOff.note).toMatch(/box Intents checkout is 2d972c5/)

        const none = await runConsoleDeployPreflight('http://idea01:8080', HOSTS, deps(C1A4, null).deps, {})
        expect(none.ok).toBe(false)
        expect(none.note).toMatch(/no Console pin — set DURATION_EXPECTED_CONSOLE_SHA/)

        const stamped = deps(C230, C1A4, `{"sha":"${C1A4}"}`)
        const st = await runConsoleDeployPreflight('http://idea01:8080', HOSTS, stamped.deps, { DURATION_EXPECTED_CONSOLE_SHA: '1a46f20' })
        expect(st.ok, st.note).toBe(true)
        expect(st.method).toBe('build-info')
        expect(stamped.seen).not.toContain('probe:idea01') // stamp present → no ssh
    })
})
