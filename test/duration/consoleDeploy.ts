/**
 * idea#168 r36@98: the Console under test is the one the POOL serves, not the box checkout.
 *
 * r36 pinned Console 2d972c5 by checking the box checkout (/workspace/agent-console-dev),
 * which only supplies the e2e Intents. The browser drove http://idea01:8080, served by the
 * Engine from `settings.consolePath` (/home/pi/idea/agents/agent-console-dev/dist) — a
 * 230b70f build that predates the r30 id contract (c981361) and sent
 * `backupApp kolibri Duration Tests — Empty Disk 002` → Engine "Too many arguments".
 *
 * Pre-walk gate (live + UI): resolve the served Console's commit and require it to equal the
 * pin (DURATION_EXPECTED_CONSOLE_SHA, else the box Intents checkout HEAD); the box Intents
 * checkout must be the same commit. Any mismatch fails loud before step 1.
 *
 * How the served commit is read (the served dist carries no SHA stamp as of 230b70f / 1a46f20:
 * index.html only references hashed assets, package.json "version" is 0.2.85 on every
 * commit, the Engine has no Console-version endpoint):
 *   1. `GET <consoleUrl>/build-info.json` with a `sha` field (the proposed Console build
 *      stamp) — used when present;
 *   2. otherwise a READ-ONLY ssh probe of the Console host: consolePath from the Engine's
 *      config.yaml, `git rev-parse HEAD` of the checkout that holds that dist, tracked
 *      changes, HEAD commit time, dist/index.html mtime and its main asset. Accepted only if
 *      the served index.html main asset equals that dist's (it really is the served dir),
 *      the checkout has no tracked changes and the dist is not older than HEAD's commit.
 */

/** Exit code of a failed Console pin gate (4 = engine unreachable, 2 = crash/stall). */
export const EXIT_CONSOLE_PIN_MISMATCH = 5

export type ConsoleDistProbe = {
    consolePath: string | null
    head: string | null
    dirty: number | null
    headTime: number | null // unix seconds (git %ct)
    distMtime: number | null // unix seconds
    distAsset: string | null
}

export type ConsoleBuildStamp = { sha: string; dirty?: boolean; builtAt?: string }

export type ConsoleDeployInput = {
    consoleUrl: string
    consoleHost: string | null // pool logical id serving the Console, null when not a pool host
    pin: string
    pinSource: string
    boxHead: string | null
    servedAsset: string | null
    stamp: ConsoleBuildStamp | null
    probe: ConsoleDistProbe | null
    probeError?: string | null
    /** r65 split pins: the served PRODUCT pin (absent = Stage 1 single-pin behaviour). */
    product?: ConsoleProductPin | null
    /** md5 of the served main asset bytes (split mode). */
    servedAssetMd5?: string | null
    /** `git diff --name-only <product>..<intents>` in the box Intents checkout (split mode). */
    rangeFiles?: string[] | null
    /** product SHA is an ancestor of the intents SHA (split mode). */
    rangeAncestor?: boolean | null
    rangeError?: string | null
}

/**
 * r65 (r64 exit 5): the Console the pool SERVES (product: built from `sha`, asset name + md5) is pinned
 * apart from the box Intents checkout (DURATION_EXPECTED_CONSOLE_SHA). An intents tip passes only when
 * every commit between the two touches e2e/ or test/ paths alone.
 */
export type ConsoleProductPin = { sha: string; asset: string; md5: string | null }

/** Paths an intents-only tip may change without a dist rebuild. */
export const INTENTS_ONLY_PATH = /^(e2e|test)\//
export const productPathsIn = (files: string[]): string[] => files.filter(f => f.trim() && !INTENTS_ONLY_PATH.test(f.trim()))

/** Product pin from env (DURATION_CONSOLE_PRODUCT_SHA / _ASSET / _ASSET_MD5); null when unset. */
export const consoleProductPinFromEnv = (env: NodeJS.ProcessEnv = process.env): ConsoleProductPin | null => {
    const sha = env.DURATION_CONSOLE_PRODUCT_SHA?.trim()
    if (!sha) return null
    const asset = env.DURATION_CONSOLE_PRODUCT_ASSET?.trim()
    if (!asset) throw new Error('console_deploy_preflight: DURATION_CONSOLE_PRODUCT_SHA set without DURATION_CONSOLE_PRODUCT_ASSET (served asset name, e.g. index-<hash>.js)')
    return { sha, asset: asset.replace(/^\/?(assets\/)?/, 'assets/'), md5: env.DURATION_CONSOLE_PRODUCT_ASSET_MD5?.trim().toLowerCase() || null }
}

export type ConsoleDeployVerdict = { ok: boolean; servedSha: string | null; method: 'build-info' | 'ssh-checkout' | 'none'; note: string }

const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : 'unknown')

/** Same commit: equal, or one is a ≥7-char prefix of the other. */
export const shaMatches = (a: string | null | undefined, b: string | null | undefined): boolean => {
    if (!a || !b) return false
    const x = a.trim().toLowerCase()
    const y = b.trim().toLowerCase()
    if (x.length < 7 || y.length < 7) return false
    return x.startsWith(y) || y.startsWith(x)
}

/** Main entry asset (`assets/index-<hash>.js`) referenced by a Console index.html. */
export const mainAssetFromIndexHtml = (html: string | null | undefined): string | null => {
    if (!html) return null
    const m = html.match(/<script[^>]*\bsrc="\/?(assets\/index-[A-Za-z0-9_-]+\.js)"/)
    return m ? m[1]! : null
}

/** Parse the `key=value` lines of the read-only probe script. */
export const parseConsoleDistProbe = (out: string): ConsoleDistProbe => {
    const kv: Record<string, string> = {}
    for (const line of out.split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    const num = (k: string) => (kv[k] && /^\d+$/.test(kv[k]!) ? Number(kv[k]) : null)
    const str = (k: string) => (kv[k] ? kv[k]! : null)
    return {
        consolePath: str('consolePath'),
        head: str('head') && /^[0-9a-f]{40}$/i.test(kv.head!) ? kv.head! : null,
        dirty: num('dirty'),
        headTime: num('headTime'),
        distMtime: num('distMtime'),
        distAsset: str('distAsset'),
    }
}

/** Parse a served build-info.json (proposed Console stamp); null unless it carries a sha. */
export const parseBuildStamp = (body: string | null | undefined): ConsoleBuildStamp | null => {
    if (!body) return null
    try {
        const v = JSON.parse(body) as Record<string, unknown>
        if (v && typeof v.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(v.sha)) {
            return { sha: v.sha, dirty: v.dirty === true, builtAt: typeof v.builtAt === 'string' ? v.builtAt : undefined }
        }
    } catch {
        // SPA fallback (index.html) or no stamp
    }
    return null
}

/**
 * READ-ONLY probe of the Console host (cat/grep/stat/git rev-parse/log/status only).
 * `engineDir` is the Engine checkout whose config.yaml names consolePath.
 */
export const consoleDistProbeScript = (engineDir = '/home/pi/idea/agents/agent-engine-dev'): string =>
    [
        `cfg='${engineDir}/config.yaml'`,
        `cpath=$(sed -n 's/^[[:space:]]*consolePath:[[:space:]]*\\([^[:space:]#]*\\).*/\\1/p' "$cfg" 2>/dev/null | head -1)`,
        'echo "consolePath=$cpath"',
        '[ -n "$cpath" ] || exit 0',
        'repo=$(git -C "$cpath" rev-parse --show-toplevel 2>/dev/null || dirname "$cpath")',
        'echo "head=$(git -C "$repo" rev-parse HEAD 2>/dev/null)"',
        'echo "dirty=$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null | wc -l)"',
        'echo "headTime=$(git -C "$repo" log -1 --format=%ct 2>/dev/null)"',
        'echo "distMtime=$(stat -c %Y "$cpath/index.html" 2>/dev/null)"',
        `echo "distAsset=$(grep -o 'assets/index-[A-Za-z0-9_-]*\\.js' "$cpath/index.html" 2>/dev/null | head -1)"`,
    ].join('; ')

/** Pure verdict for the pre-walk Console pin gate. */
export const consoleDeployVerdict = (i: ConsoleDeployInput): ConsoleDeployVerdict => {
    const where = `${i.consoleUrl}${i.consoleHost ? ` (${i.consoleHost})` : ''}`
    const fail = (servedSha: string | null, method: ConsoleDeployVerdict['method'], why: string): ConsoleDeployVerdict => ({
        ok: false,
        servedSha,
        method,
        note:
            `console_deploy_preflight: ${why} Pin ${short(i.pin)} (${i.pinSource}). The browser drives the ` +
            `Console the pool serves, not the box checkout — deploy the pinned Console to the pool ` +
            `(checkout + build its dist) before the walk. No soft-pass.`,
    })
    if (!i.boxHead || !shaMatches(i.boxHead, i.pin)) {
        return fail(null, 'none', `box Intents checkout is ${short(i.boxHead)}, not the pinned Console.`)
    }
    if (i.product) return splitVerdict(i, i.product, where, fail)
    if (i.stamp) {
        if (i.stamp.dirty) return fail(i.stamp.sha, 'build-info', `${where} serves a dirty build of ${short(i.stamp.sha)} (build-info.json).`)
        if (!shaMatches(i.stamp.sha, i.pin)) {
            return fail(i.stamp.sha, 'build-info', `${where} serves Console ${short(i.stamp.sha)} (build-info.json), not the pin.`)
        }
        return {
            ok: true,
            servedSha: i.stamp.sha,
            method: 'build-info',
            note: `console_deploy_preflight: ${where} serves Console ${short(i.stamp.sha)} (build-info.json) = pin ${short(i.pin)} (${i.pinSource}) = box Intents checkout`,
        }
    }
    if (!i.consoleHost) {
        return fail(null, 'none', `${where} is not a pool engine host and serves no build-info.json — cannot tell which Console it serves.`)
    }
    const p = i.probe
    if (!p) return fail(null, 'ssh-checkout', `read-only probe of ${i.consoleHost} failed${i.probeError ? `: ${i.probeError}` : ''}.`)
    if (!p.consolePath) return fail(null, 'ssh-checkout', `${i.consoleHost} Engine config.yaml has no consolePath (Console not served by the Engine?).`)
    if (!p.head) return fail(null, 'ssh-checkout', `${i.consoleHost}:${p.consolePath} is not inside a git checkout — cannot tell its commit.`)
    if (!i.servedAsset) return fail(p.head, 'ssh-checkout', `could not read the main asset from ${i.consoleUrl}/ index.html.`)
    if (p.distAsset !== i.servedAsset) {
        return fail(p.head, 'ssh-checkout', `${where} serves ${i.servedAsset} but ${i.consoleHost}:${p.consolePath}/index.html references ${p.distAsset ?? 'nothing'} — not the served dist.`)
    }
    if (!shaMatches(p.head, i.pin)) {
        return fail(p.head, 'ssh-checkout', `${where} serves the dist of Console ${short(p.head)} (${i.consoleHost}:${p.consolePath}), not the pin.`)
    }
    if ((p.dirty ?? 0) > 0) {
        return fail(p.head, 'ssh-checkout', `${i.consoleHost} Console checkout ${short(p.head)} has ${p.dirty} tracked change(s) — the dist may not be ${short(p.head)}.`)
    }
    if (p.headTime == null || p.distMtime == null || p.distMtime < p.headTime) {
        return fail(p.head, 'ssh-checkout', `${i.consoleHost}:${p.consolePath} was built ${p.distMtime ?? '?'} before HEAD ${short(p.head)} was committed (${p.headTime ?? '?'}) — stale dist, rebuild.`)
    }
    return {
        ok: true,
        servedSha: p.head,
        method: 'ssh-checkout',
        note:
            `console_deploy_preflight: ${where} serves ${i.servedAsset} = ${i.consoleHost}:${p.consolePath} ` +
            `built from Console ${short(p.head)} (clean; dist newer than commit) = pin ${short(i.pin)} (${i.pinSource}) = box Intents checkout`,
    }
}

/** r65 split-pin verdict: served asset = product pin, product..intents touches only e2e/ + test/. */
const splitVerdict = (
    i: ConsoleDeployInput,
    prod: ConsoleProductPin,
    where: string,
    fail: (servedSha: string | null, method: ConsoleDeployVerdict['method'], why: string) => ConsoleDeployVerdict,
): ConsoleDeployVerdict => {
    const pins = `product ${short(prod.sha)} (${prod.asset}${prod.md5 ? ` md5 ${prod.md5.slice(0, 8)}` : ''}) / intents ${short(i.pin)}`
    // Range: intents = product + e2e/test-only commits.
    if (i.rangeError || i.rangeFiles == null) return fail(null, 'none', `cannot list ${short(prod.sha)}..${short(i.pin)} in the box Intents checkout${i.rangeError ? `: ${i.rangeError}` : ''}.`)
    if (!shaMatches(prod.sha, i.pin) && i.rangeAncestor === false) {
        return fail(null, 'none', `product ${short(prod.sha)} is not an ancestor of intents ${short(i.pin)} — the intents tip is not built on the served product.`)
    }
    const prodFiles = productPathsIn(i.rangeFiles)
    if (prodFiles.length) {
        return fail(null, 'none', `${short(prod.sha)}..${short(i.pin)} changes product path(s) [${prodFiles.slice(0, 10).join(', ')}${prodFiles.length > 10 ? `, +${prodFiles.length - 10}` : ''}] — the served dist is stale, rebuild.`)
    }
    // Served = product pin.
    if (!i.servedAsset) return fail(null, 'none', `could not read the main asset from ${i.consoleUrl}/ index.html.`)
    if (i.servedAsset !== prod.asset) return fail(null, 'none', `${where} serves ${i.servedAsset}, not the product pin ${prod.asset}.`)
    if (prod.md5) {
        if (!i.servedAssetMd5) return fail(null, 'none', `could not hash the served ${i.servedAsset}.`)
        if (i.servedAssetMd5.toLowerCase() !== prod.md5) return fail(null, 'none', `${where} serves ${i.servedAsset} with md5 ${i.servedAssetMd5}, not the product pin md5 ${prod.md5}.`)
    }
    if (i.stamp) {
        if (i.stamp.dirty || !shaMatches(i.stamp.sha, prod.sha)) return fail(i.stamp.sha, 'build-info', `${where} build-info.json says ${short(i.stamp.sha)}${i.stamp.dirty ? ' (dirty)' : ''}, not the product pin.`)
        return { ok: true, servedSha: i.stamp.sha, method: 'build-info', note: `console_deploy_preflight: split pins ${pins}: ${where} serves ${i.servedAsset} (build-info ${short(i.stamp.sha)}); range e2e/test-only (${i.rangeFiles.length} files)` }
    }
    if (i.consoleHost) {
        const p = i.probe
        if (!p) return fail(null, 'ssh-checkout', `read-only probe of ${i.consoleHost} failed${i.probeError ? `: ${i.probeError}` : ''}.`)
        if (p.distAsset !== i.servedAsset) return fail(p.head, 'ssh-checkout', `${where} serves ${i.servedAsset} but ${i.consoleHost}:${p.consolePath ?? '?'}/index.html references ${p.distAsset ?? 'nothing'} — not the served dist.`)
        if ((p.dirty ?? 0) > 0) return fail(p.head, 'ssh-checkout', `${i.consoleHost} Console checkout ${short(p.head)} has ${p.dirty} tracked change(s).`)
        if (p.head && !shaMatches(p.head, prod.sha) && !shaMatches(p.head, i.pin)) {
            return fail(p.head, 'ssh-checkout', `${i.consoleHost} Console checkout is ${short(p.head)}, neither the product nor the intents pin.`)
        }
    }
    return {
        ok: true,
        servedSha: prod.sha,
        method: i.consoleHost ? 'ssh-checkout' : 'none',
        note:
            `console_deploy_preflight: split pins ${pins}: ${where} serves ${i.servedAsset}` +
            `${i.servedAssetMd5 ? ` md5 ${i.servedAssetMd5.slice(0, 8)}` : ''} = product pin; ` +
            `${short(prod.sha)}..${short(i.pin)} touches only e2e/ + test/ (${i.rangeFiles.length} files); box Intents checkout = ${short(i.pin)}`,
    }
}

/** Pool logical id behind the Console URL host (id itself, or its --hosts address), else null. */
export const consoleHostFor = (consoleUrl: string, hosts: Record<string, string>): string | null => {
    let h: string
    try {
        h = new URL(consoleUrl).hostname
    } catch {
        return null
    }
    if (hosts[h]) return h
    const hit = Object.entries(hosts).find(([, addr]) => addr === h)
    return hit ? hit[0] : null
}

export type ConsoleDeployDeps = {
    /** GET a URL, return its body (and content-type), or throw. */
    fetchText: (url: string) => Promise<{ status: number; contentType: string; body: string }>
    /** Read-only ssh probe of the pool host serving the Console. */
    probeDist: (consoleHost: string) => Promise<ConsoleDistProbe>
    /** `git rev-parse HEAD` of the box Intents checkout. */
    boxHead: () => Promise<string | null>
    /** Split mode: md5 hex of a served URL's bytes. */
    fetchMd5?: (url: string) => Promise<string>
    /** Split mode: changed files and ancestry of product..intents in the box Intents checkout. */
    rangeFiles?: (from: string, to: string) => Promise<{ files: string[]; ancestor: boolean }>
}

/**
 * Pre-walk Console pin gate (live + UI). Pin = DURATION_EXPECTED_CONSOLE_SHA, else the box
 * Intents checkout HEAD (then the gate still proves the pool serves what the Intents were
 * written for). Never writes anything anywhere.
 */
export const runConsoleDeployPreflight = async (
    consoleUrl: string,
    hosts: Record<string, string>,
    deps: ConsoleDeployDeps,
    env: NodeJS.ProcessEnv = process.env,
): Promise<ConsoleDeployVerdict & { pin: string | null; boxHead: string | null; product: ConsoleProductPin | null; servedAsset?: string | null; servedAssetMd5?: string | null }> => {
    const base = consoleUrl.replace(/\/+$/, '')
    const boxHead = await deps.boxHead().catch(() => null)
    const envPin = env.DURATION_EXPECTED_CONSOLE_SHA?.trim()
    const pin = envPin || boxHead
    const pinSource = envPin ? 'DURATION_EXPECTED_CONSOLE_SHA' : 'box Intents checkout HEAD (DURATION_EXPECTED_CONSOLE_SHA unset)'
    if (!pin) {
        return {
            ok: false,
            servedSha: null,
            method: 'none',
            pin: null,
            boxHead,
            product: null,
            note:
                'console_deploy_preflight: no Console pin — set DURATION_EXPECTED_CONSOLE_SHA (and point ' +
                'DURATION_CONSOLE_INTENTS at a git checkout of that commit). No soft-pass.',
        }
    }
    let stamp: ConsoleBuildStamp | null = null
    try {
        const r = await deps.fetchText(`${base}/build-info.json`)
        if (r.status === 200 && /json/i.test(r.contentType)) stamp = parseBuildStamp(r.body)
    } catch {
        // no stamp
    }
    let servedAsset: string | null = null
    try {
        const r = await deps.fetchText(`${base}/`)
        if (r.status === 200) servedAsset = mainAssetFromIndexHtml(r.body)
    } catch {
        servedAsset = null
    }
    const consoleHost = consoleHostFor(consoleUrl, hosts)
    let probe: ConsoleDistProbe | null = null
    let probeError: string | null = null
    if (!stamp && consoleHost) {
        try {
            probe = await deps.probeDist(consoleHost)
        } catch (e) {
            probeError = e instanceof Error ? e.message : String(e)
        }
    }
    let product: ConsoleProductPin | null = null
    try {
        product = consoleProductPinFromEnv(env)
    } catch (e) {
        return { ok: false, servedSha: null, method: 'none', pin, boxHead, product: null, note: `${e instanceof Error ? e.message : String(e)}. No soft-pass.` }
    }
    let servedAssetMd5: string | null = null
    let rangeFiles: string[] | null = null
    let rangeAncestor: boolean | null = null
    let rangeError: string | null = null
    if (product) {
        if (servedAsset && deps.fetchMd5) servedAssetMd5 = await deps.fetchMd5(`${base}/${servedAsset}`).catch(() => null)
        if (!deps.rangeFiles) rangeError = 'no git range reader'
        else {
            try {
                const r = await deps.rangeFiles(product.sha, pin)
                rangeFiles = r.files
                rangeAncestor = r.ancestor
            } catch (e) {
                rangeError = e instanceof Error ? e.message : String(e)
            }
        }
    }
    const v = consoleDeployVerdict({ consoleUrl: base, consoleHost, pin, pinSource, boxHead, servedAsset, stamp, probe, probeError, product, servedAssetMd5, rangeFiles, rangeAncestor, rangeError })
    return { ...v, pin, boxHead, product, servedAsset, servedAssetMd5 }
}
