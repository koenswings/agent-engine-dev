/**
 * idea02 walk host (Koen 10:29 delegation, Steve OK 1-8): walks run FROM idea02 as user walker,
 * and idea02 must NEVER be a walk target. Any of its names refuses: hostname (idea02, idea02.local,
 * any case), its LAN 10.99.0.12, its Tailscale 100.85.108.118, or a store engine id listed in
 * DURATION_IDEA02_ENGINE_IDS (comma-separated).
 */
export const IDEA02_NAMES = ['idea02', '10.99.0.12', '100.85.108.118'] as const

export const isIdea02Target = (name: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean => {
    const n = (name ?? '').trim().toLowerCase().replace(/\.local\.?$/, '').replace(/\.$/, '')
    if (!n) return false
    if ((IDEA02_NAMES as readonly string[]).includes(n)) return true
    const ids = (env.DURATION_IDEA02_ENGINE_IDS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    return ids.includes(n)
}

export const assertNotIdea02Target = (name: string | null | undefined, what: string, env: NodeJS.ProcessEnv = process.env): void => {
    if (isIdea02Target(name, env)) throw new Error(`${what}: refused target '${name}' — idea02 is the walk host, never a walk target`)
}

/** Host map (logical=addr): no entry may name idea02 by either side. */
export const idea02InHostMap = (map: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string[] =>
    Object.entries(map).filter(([k, v]) => isIdea02Target(k, env) || isIdea02Target(v, env)).map(([k, v]) => `${k}=${v}`)

export interface StoreCheckEngine { id?: string; hostname?: string; commands?: unknown[] }
export interface StoreCheckDoc {
    engineDB?: Record<string, StoreCheckEngine>
    instanceDB?: Record<string, { id?: string; name?: string; status?: string; storedOn?: string }>
    diskDB?: Record<string, { dockedTo?: string }>
}
export const STORE_CHECK_EXPECTED = [
    ['kolibri-grade5a-001', 'idea01'],
    ['nextcloud-grade5a-001', 'idea03'],
    ['kiwix-ideaa-001', 'idea03'],
] as const
export const STORE_CHECK_POOL = ['idea01', 'idea03', 'idea04'] as const

/**
 * READY gate (Atlas 11:0x): store=3 instances (the three expected, on their homes), every pool
 * Engine present with an empty command queue, idea02 absent from the engine list. Read-only.
 */
export const storeCheckVerdict = (via: string, d: StoreCheckDoc, env: NodeJS.ProcessEnv = process.env): string[] => {
    const fails: string[] = []
    const engines = Object.entries(d.engineDB ?? {}).map(([id, e]) => ({ ...e, id: e.id ?? id }))
    const insts = Object.values(d.instanceDB ?? {})
    const host = (engId?: string) => engines.find(e => e.id === engId)?.hostname ?? engId ?? '?'
    const rows = insts.map(i => ({ id: String(i.id ?? i.name), on: host(d.diskDB?.[i.storedOn ?? '']?.dockedTo) }))
    if (insts.length !== STORE_CHECK_EXPECTED.length) fails.push(`${via}: instance count ${insts.length} (want ${STORE_CHECK_EXPECTED.length}: ${rows.map(r => `${r.id}@${r.on}`).join(', ')})`)
    for (const [id, on] of STORE_CHECK_EXPECTED) if (!rows.some(r => r.id === id && r.on === on)) fails.push(`${via}: missing ${id}@${on}`)
    for (const p of STORE_CHECK_POOL) {
        const e = engines.find(x => x.hostname === p)
        if (!e) fails.push(`${via}: no engine ${p}`)
        else if ((e.commands ?? []).length) fails.push(`${via}: ${p} queue=${(e.commands ?? []).length}`)
    }
    for (const e of engines) if (isIdea02Target(e.hostname, env) || isIdea02Target(e.id, env)) fails.push(`${via}: idea02 IN engine list (${e.id})`)
    return fails
}
