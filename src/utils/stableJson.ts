/**
 * JSON.stringify with object keys sorted, for change detection that compares a
 * value read from the Automerge store with a freshly built plain object.
 * Automerge >= 3.3 returns map keys in sorted order instead of insertion order,
 * so a plain JSON.stringify comparison reports a change on every call.
 */
export const stableStringify = (value: unknown): string =>
    JSON.stringify(value, (_key, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
            : v)
