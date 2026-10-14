import { describe, it, expect } from 'vitest'
import { ADJECTIVES, NOUNS, BLOCKED_PAIRS, allStickerNames, isAllowedPair, isDerivedPair, generateHostName, isStickerName, pickUniqueName, NoFreeNameError } from '../../src/utils/nameGenerator.js'
import { engineHostnames, parseAvahiEngineNames, parseTailscaleStatusNames, resolveStickerName, stickerText, StickerNameDeps } from '../../src/install/stickerName.js'

/** Deterministic PRNG (mulberry32). */
const seeded = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const fakeDeps = (o: Partial<StickerNameDeps> & { persisted?: string | null, store?: string[], storeOk?: boolean, lan?: string[] } = {}) => {
    const saved: string[] = []
    const deps: StickerNameDeps = {
        readPersisted: async () => o.persisted ?? null,
        persist: async (n) => { saved.push(n) },
        storeNames: async () => ({ names: o.store ?? [], checked: o.storeOk ?? true }),
        lanTaken: async (n) => (o.lan ?? []).includes(n),
        rand: o.rand ?? seeded(1),
        log: () => {},
    }
    return { deps, saved }
}

describe('sticker name generator (idea#184)', () => {
    it('word lists are unique, lower-case letters only, short', () => {
        for (const list of [ADJECTIVES, NOUNS]) {
            expect(new Set(list).size).toBe(list.length)
            for (const w of list) { expect(w).toMatch(/^[a-z]{3,8}$/) }
        }
        expect(allStickerNames().length).toBeGreaterThanOrEqual(100_000)
    })
    it('word lists do not overlap and avoid words that read as slurs', () => {
        const nouns = new Set<string>(NOUNS)
        expect(ADJECTIVES.filter((a) => nouns.has(a))).toEqual([])
        const banned = ['ape', 'monkey', 'pig', 'donkey', 'black', 'white', 'dark', 'slave', 'dumb', 'fat', 'ugly', 'lazy', 'jackal', 'angel', 'god']
        for (const w of [...ADJECTIVES, ...NOUNS]) expect(banned).not.toContain(w)
    })
    it('never pairs an adjective with the noun it derives from', () => {
        for (const [a, n] of [['sandy', 'sand'], ['stony', 'stone'], ['starry', 'star'], ['mossy', 'moss'], ['leafy', 'leaf'], ['peachy', 'peach'], ['oaken', 'oak'], ['coastal', 'coast']])
            expect(isDerivedPair(a, n)).toBe(true)
        for (const [a, n] of [['sunset', 'sun'], ['sandy', 'otter'], ['golden', 'gold' + 'fish'], ['brave', 'otter']])
            expect(isDerivedPair(a, n)).toBe(false)
        const all = new Set(allStickerNames())
        for (const n of ['sandy-sand', 'stony-stone', 'starry-star', 'sunny-sun', 'rainy-rain']) expect(all.has(n)).toBe(false)
        const r = seeded(9)
        for (let i = 0; i < 20_000; i++) {
            const [a, n] = generateHostName(r).split('-')
            expect(isDerivedPair(a, n)).toBe(false)
        }
    })
    it('never produces a blocklisted double-meaning pair', () => {
        expect(BLOCKED_PAIRS).toContain('silver-fox')
        const all = new Set(allStickerNames())
        for (const p of BLOCKED_PAIRS) {
            const [a, n] = p.split('-')
            expect(isAllowedPair(a, n)).toBe(false)
            expect(all.has(p)).toBe(false)
        }
        // the walk fallback skips them too: with every other name taken, none is returned
        const others = [...all].filter((n) => n !== 'brave-otter')
        expect(pickUniqueName(others, seeded(5))).toBe('brave-otter')
    })
    it('does not use words the review removed', () => {
        for (const w of ['owl', 'ivory', 'cute', 'first', 'prime', 'springbok', 'ruler', 'whale', 'native'])
            expect([...ADJECTIVES, ...NOUNS] as string[]).not.toContain(w)
    })
    it('generates two words, no digits, valid hostname', () => {
        const r = seeded(42)
        for (let i = 0; i < 500; i++) {
            const n = generateHostName(r)
            expect(isStickerName(n)).toBe(true)
            expect(n).not.toMatch(/\d/)
        }
    })
    it('old idea<N> names are not sticker names', () => {
        expect(isStickerName('idea01')).toBe(false)
        expect(isStickerName('brave-otter')).toBe(true)
    })
    it('pickUniqueName avoids taken names case- and .local-insensitively', () => {
        const first = generateHostName(seeded(7))
        const n = pickUniqueName([first.toUpperCase() + '.local'], seeded(7))
        expect(n).not.toBe(first)
    })
    it('pickUniqueName finds the last free name and fails when none is left', () => {
        const all = allStickerNames()
        const free = all.pop()!
        expect(pickUniqueName(all, seeded(3))).toBe(free)
        expect(() => pickUniqueName([...all, free], seeded(3))).toThrow(NoFreeNameError)
    })
})

describe('resolveStickerName', () => {
    it('keeps an explicit --hostname (existing idea01-04) and persists it', async () => {
        const { deps, saved } = fakeDeps()
        const r = await resolveStickerName('idea03', deps)
        expect(r).toMatchObject({ name: 'idea03', source: 'explicit' })
        expect(saved).toEqual(['idea03'])
    })
    it('rejects an invalid explicit hostname', async () => {
        await expect(resolveStickerName('bad_name!', fakeDeps().deps)).rejects.toThrow(/bad hostname/)
    })
    it('re-runs keep the persisted name (never renames a stickered Pi)', async () => {
        const { deps, saved } = fakeDeps({ persisted: 'calm-heron\n' })
        const r = await resolveStickerName(undefined, deps)
        expect(r).toMatchObject({ name: 'calm-heron', source: 'persisted' })
        expect(saved).toEqual([])
    })
    it('generates a name not in the store and not on the LAN, and persists it', async () => {
        const probe = seeded(9)
        const a = generateHostName(probe), b = generateHostName(probe)
        const { deps, saved } = fakeDeps({ rand: seeded(9), store: [a], lan: [b] })
        const r = await resolveStickerName(undefined, deps)
        expect(r.source).toBe('generated')
        expect(r.storeChecked).toBe(true)
        expect([a, b]).not.toContain(r.name)
        expect(isStickerName(r.name)).toBe(true)
        expect(saved).toEqual([r.name])
    })
    it('avoids names taken on the tailnet when tailscale is online', async () => {
        const probe = seeded(11)
        const a = generateHostName(probe)
        const { deps } = fakeDeps({ rand: seeded(11) })
        deps.tailnetNames = async () => ({ names: [a.toUpperCase()], checked: true })
        const r = await resolveStickerName(undefined, deps)
        expect(r.tailnetChecked).toBe(true)
        expect(r.name).not.toBe(a)
    })
    it('without tailscale the tailnet is reported unchecked', async () => {
        const r = await resolveStickerName(undefined, fakeDeps().deps)
        expect(r.tailnetChecked).toBe(false)
    })
    it('reports when the network database could not be checked', async () => {
        const r = await resolveStickerName(undefined, fakeDeps({ storeOk: false }).deps)
        expect(r.storeChecked).toBe(false)
    })
})

describe('install helpers', () => {
    it('engineHostnames lists unique engineDB hostnames', () => {
        expect(engineHostnames({ engineDB: { a: { hostname: 'idea01' }, b: { hostname: 'brave-otter' }, c: { hostname: 'idea01' }, d: {} } }))
            .toEqual(['idea01', 'brave-otter'])
        expect(engineHostnames(undefined)).toEqual([])
    })
    it('parses Engine names from avahi-browse -atrp', () => {
        const out = [
            '+;eth0;IPv4;brave-otter;_engine._tcp;local',
            '=;eth0;IPv4;brave-otter;_engine._tcp;local;brave-otter.local;10.0.0.5;80;"store=s1" "version=1" "id=e1" "name=brave-otter"',
            '=;eth0;IPv4;printer;_ipp._tcp;local;printer.local;10.0.0.9;631;"name=printer"',
            '=;eth0;IPv4;idea01;_engine._tcp;local;idea01.local;10.0.0.6;80;"id=e2" "name=IDEA01"',
        ].join('\n')
        expect(parseAvahiEngineNames(out)).toEqual(['brave-otter', 'idea01'])
    })
    it('sticker text names the Console URL', () => {
        expect(stickerText('brave-otter', 8080)).toContain('http://brave-otter.local:8080')
        expect(stickerText('brave-otter', 80)).toContain('http://brave-otter.local\n')
    })
})

describe('tailscale status --json parsing (idea#184)', () => {
    it('collects self and peer HostName and MagicDNS labels when Running', () => {
        const out = JSON.stringify({
            BackendState: 'Running',
            Self: { HostName: 'idea02', DNSName: 'idea02.tail1234.ts.net.' },
            Peer: { k1: { HostName: 'Brave-Otter', DNSName: 'brave-otter-1.tail1234.ts.net.' }, k2: { HostName: 'laptop' } },
        })
        const r = parseTailscaleStatusNames(out)
        expect(r.checked).toBe(true)
        expect(r.names.sort()).toEqual(['brave-otter', 'brave-otter-1', 'idea02', 'laptop'])
    })
    it('is unchecked when not online, empty or not JSON', () => {
        expect(parseTailscaleStatusNames(JSON.stringify({ BackendState: 'NeedsLogin', Peer: {} })).checked).toBe(false)
        expect(parseTailscaleStatusNames('').checked).toBe(false)
        expect(parseTailscaleStatusNames('tailscale: not found').checked).toBe(false)
    })
})
