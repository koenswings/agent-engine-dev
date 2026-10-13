/**
 * r65 (r64 exit 5 before step 1): the box Intents checkout moved to 4fb5299 (e2e/intents + test only) while
 * the pool kept serving the cda87d2 product dist (index-CyVOVvJQ.js, md5 d65c2daa…). The gate compared
 * dist mtime to the checkout HEAD and demanded a rebuild. Split pins: served PRODUCT pin (asset + md5 +
 * product SHA) vs intents SHA; pass iff the served asset = product pin and product..intents touches only
 * e2e/ + test/.
 */
import { describe, expect, it } from 'vitest'
import { consoleDeployVerdict, consoleProductPinFromEnv, productPathsIn, runConsoleDeployPreflight, type ConsoleDistProbe } from '../duration/consoleDeploy.js'

const PROD = 'cda87d20606a270eab896a4f9b0350ecebcbfb5b'
const INT = '4fb5299f55bcf0b376c1e8ca12841f72caa8390a'
const ASSET = 'assets/index-CyVOVvJQ.js'
const MD5 = 'd65c2daa0123456789abcdef01234567'
const R64_FILES = [
    'e2e/intents/copyMoveApp.ts', 'e2e/intents/durationBridge.ts', 'e2e/intents/kolibriCoaching.ts', 'e2e/intents/openApp.ts',
    'e2e/intents/openKolibriContent.ts', 'e2e/intents/operationWait.ts', 'e2e/intents/operatorDeepActions.ts',
    'e2e/intents/sidecarUrls.ts', 'e2e/intents/types.ts', 'e2e/intents/wikipedia.ts', 'test/operationWait.test.ts', 'test/tabHostForms.test.ts',
]
const ENV = { DURATION_EXPECTED_CONSOLE_SHA: INT, DURATION_CONSOLE_PRODUCT_SHA: PROD, DURATION_CONSOLE_PRODUCT_ASSET: 'index-CyVOVvJQ.js', DURATION_CONSOLE_PRODUCT_ASSET_MD5: MD5 }
// r64: pool checkout moved to 4fb5299 without a rebuild → dist older than HEAD's commit.
const R64_PROBE: ConsoleDistProbe = { consolePath: '/home/pi/idea/agents/agent-console-dev/dist', head: INT, dirty: 0, headTime: 1_791_700_000, distMtime: 1_791_000_000, distAsset: ASSET }

const run = (o: { env?: Record<string, string>; served?: string; md5?: string; files?: string[]; ancestor?: boolean; probe?: ConsoleDistProbe; box?: string } = {}) =>
    runConsoleDeployPreflight('http://idea01:8080', { idea01: '100.99.231.94' }, {
        fetchText: async url => url.endsWith('build-info.json')
            ? { status: 404, contentType: 'text/html', body: '' }
            : { status: 200, contentType: 'text/html', body: `<script type="module" src="/${o.served ?? ASSET}"></script>` },
        probeDist: async () => o.probe ?? R64_PROBE,
        boxHead: async () => o.box ?? INT,
        fetchMd5: async () => o.md5 ?? MD5,
        rangeFiles: async () => ({ files: o.files ?? R64_FILES, ancestor: o.ancestor ?? true }),
    }, o.env ?? ENV)

describe('split Console pins (r65)', () => {
    it('r64 replay: Stage 1 single-pin gate fails (stale dist); split pins pass and record both pins', async () => {
        const single = await run({ env: { DURATION_EXPECTED_CONSOLE_SHA: INT } })
        expect(single.ok).toBe(false)
        expect(single.note).toMatch(/stale dist, rebuild/)
        const r = await run()
        expect(r.ok).toBe(true)
        expect(r.note).toMatch(/split pins product cda87d2 \(assets\/index-CyVOVvJQ\.js md5 d65c2daa\) \/ intents 4fb5299/)
        expect(r.note).toMatch(/touches only e2e\/ \+ test\/ \(12 files\)/)
        expect(r.product).toEqual({ sha: PROD, asset: ASSET, md5: MD5 })
        expect(r.pin).toBe(INT)
        expect(r.servedAssetMd5).toBe(MD5)
    })
    it('a product-file change in the range fails (rebuild required)', async () => {
        const r = await run({ files: [...R64_FILES, 'src/components/CopyMoveModal.tsx', 'package.json'] })
        expect(r.ok).toBe(false)
        expect(r.note).toMatch(/changes product path\(s\) \[src\/components\/CopyMoveModal\.tsx, package\.json\].*rebuild/)
    })
    it('served asset name mismatch fails', async () => {
        const r = await run({ served: 'assets/index-NEWHASH.js', probe: { ...R64_PROBE, distAsset: 'assets/index-NEWHASH.js' } })
        expect(r.ok).toBe(false)
        expect(r.note).toMatch(/serves assets\/index-NEWHASH\.js, not the product pin assets\/index-CyVOVvJQ\.js/)
    })
    it('served asset md5 mismatch fails', async () => {
        const r = await run({ md5: 'ffffffffffffffffffffffffffffffff' })
        expect(r.ok).toBe(false)
        expect(r.note).toMatch(/md5 ffffffff.*not the product pin md5 d65c2daa/)
    })
    it('box checkout not at the intents pin, product not an ancestor, unreadable range, foreign pool checkout all fail', async () => {
        expect((await run({ box: PROD })).note).toMatch(/box Intents checkout is cda87d2/)
        expect((await run({ ancestor: false })).note).toMatch(/not an ancestor/)
        const noRange = await runConsoleDeployPreflight('http://idea01:8080', { idea01: 'x' }, {
            fetchText: async () => ({ status: 200, contentType: 'text/html', body: `<script src="/${ASSET}"></script>` }),
            probeDist: async () => R64_PROBE, boxHead: async () => INT, fetchMd5: async () => MD5,
        }, ENV)
        expect(noRange.ok).toBe(false)
        expect((await run({ probe: { ...R64_PROBE, head: '1111111111111111111111111111111111111111' } })).note).toMatch(/neither the product nor the intents pin/)
        expect((await run({ probe: { ...R64_PROBE, dirty: 2 } })).ok).toBe(false)
    })
    it('pool checkout still at the product SHA also passes', async () => {
        expect((await run({ probe: { ...R64_PROBE, head: PROD, headTime: 1_790_000_000 } })).ok).toBe(true)
    })
    it('env parsing: unset → Stage 1; asset required; asset normalised to assets/', () => {
        expect(consoleProductPinFromEnv({})).toBeNull()
        expect(() => consoleProductPinFromEnv({ DURATION_CONSOLE_PRODUCT_SHA: PROD })).toThrow(/DURATION_CONSOLE_PRODUCT_ASSET/)
        expect(consoleProductPinFromEnv({ DURATION_CONSOLE_PRODUCT_SHA: PROD, DURATION_CONSOLE_PRODUCT_ASSET: '/assets/index-X.js' })).toEqual({ sha: PROD, asset: 'assets/index-X.js', md5: null })
        expect(productPathsIn(['e2e/a.ts', 'test/b.ts', 'src/c.ts', 'e2e2/x', 'vite.config.ts'])).toEqual(['src/c.ts', 'e2e2/x', 'vite.config.ts'])
    })
    it('Stage 1 behaviour unchanged without a product pin (verdict input without product)', () => {
        const v = consoleDeployVerdict({ consoleUrl: 'http://idea01:8080', consoleHost: 'idea01', pin: INT, pinSource: 'env', boxHead: INT, servedAsset: ASSET, stamp: null, probe: { ...R64_PROBE, distMtime: 1_791_800_000 } })
        expect(v.ok).toBe(true)
        expect(v.note).not.toMatch(/split pins/)
    })
})
