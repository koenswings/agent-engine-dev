import { Hostname } from '../data/CommonTypes.js';

/**
 * Sticker names for Engines (idea#184).
 *
 * Every Pi gets a unique, memorable two-word hostname at install, e.g.
 * `brave-otter`. It is printed on a sticker on the case; the operator opens
 * the Console at `http://<name>.local:<port>`. Names never contain digits:
 * Pis are no longer identified by numbers (no `idea<N>`).
 *
 * Words are short, common, friendly and easy to pronounce and spell when read
 * aloud over a phone line. 64 x 64 = 4096 combinations.
 */
export const ADJECTIVES = [
    'amber', 'bold', 'brave', 'bright', 'brisk', 'calm', 'clever', 'cosy',
    'crisp', 'dusty', 'eager', 'early', 'fair', 'fancy', 'fast', 'fond',
    'free', 'fresh', 'gentle', 'glad', 'golden', 'grand', 'green', 'happy',
    'hardy', 'humble', 'jolly', 'keen', 'kind', 'lively', 'lucky', 'mellow',
    'merry', 'mighty', 'misty', 'modest', 'noble', 'proud', 'quick', 'quiet',
    'rapid', 'ready', 'royal', 'rosy', 'shiny', 'silver', 'simple', 'smart',
    'snowy', 'solid', 'steady', 'sunny', 'super', 'swift', 'tall', 'tidy',
    'tiny', 'true', 'trusty', 'velvet', 'warm', 'wild', 'wise', 'witty',
] as const

export const NOUNS = [
    'badger', 'beaver', 'bison', 'camel', 'cedar', 'cobra', 'comet', 'condor',
    'coral', 'crane', 'cricket', 'dingo', 'dolphin', 'eagle', 'falcon', 'ferret',
    'finch', 'gecko', 'gazelle', 'giraffe', 'heron', 'hippo', 'hornet', 'ibis',
    'impala', 'jaguar', 'kestrel', 'koala', 'lemur', 'lion', 'lizard', 'llama',
    'lynx', 'mango', 'marlin', 'meerkat', 'moose', 'otter', 'owl', 'panda',
    'parrot', 'pelican', 'penguin', 'puffin', 'quail', 'rabbit', 'raven', 'robin',
    'salmon', 'seal', 'shark', 'sparrow', 'squid', 'stork', 'swan', 'tapir',
    'tiger', 'toucan', 'turtle', 'walrus', 'weasel', 'whale', 'wombat', 'zebra',
] as const

/** A sticker name: two lower-case words joined by one hyphen, no digits. */
export const STICKER_NAME_RE = /^[a-z]+-[a-z]+$/

export const isStickerName = (name: string): boolean =>
    STICKER_NAME_RE.test(name) && name.length <= 63

/** Lower-case, strip `.local` and a trailing dot, for comparisons. */
export const normaliseName = (name: string): string =>
    name.trim().toLowerCase().replace(/\.$/, '').replace(/\.local$/, '')

export type Rand = () => number

const pick = <T>(a: readonly T[], rand: Rand): T => a[Math.floor(rand() * a.length) % a.length]

/** One random two-word name (not checked for collisions). */
export const generateHostName = (rand: Rand = Math.random): Hostname =>
    `${pick(ADJECTIVES, rand)}-${pick(NOUNS, rand)}` as Hostname

export class NoFreeNameError extends Error {}

/**
 * A random sticker name that is not in `taken` (compared case-insensitively,
 * `.local` ignored). Tries random names first, then walks every combination
 * from a random start so it only fails when all 4096 are taken.
 */
export const pickUniqueName = (taken: Iterable<string>, rand: Rand = Math.random, tries = 50): Hostname => {
    const t = new Set([...taken].map(normaliseName))
    for (let i = 0; i < tries; i++) {
        const n = generateHostName(rand)
        if (!t.has(n)) return n
    }
    const total = ADJECTIVES.length * NOUNS.length
    const start = Math.floor(rand() * total)
    for (let k = 0; k < total; k++) {
        const i = (start + k) % total
        const n = `${ADJECTIVES[Math.floor(i / NOUNS.length)]}-${NOUNS[i % NOUNS.length]}`
        if (!t.has(n)) return n as Hostname
    }
    throw new NoFreeNameError(`all ${total} sticker names are taken`)
}
