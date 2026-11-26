/**
 * Walker helpers for Engine PR6 peer transfer tickets (engine#595 / PR #599).
 *
 * The capability name is the string literal 'peerTickets1' so this harness
 * change is independent of PR6 landing. An Engine counts as live only when
 * capabilities includes that name AND capabilitiesBootedAt === lastBooted;
 * a missing stamp does not count (unlike MoveAppRemote.engineHasCapability /
 * InFlight.engineCanResume, which treat a missing stamp as live).
 *
 * When at least one pool Engine is live, copy_app pairs are accepted only if
 * BOTH sides are live (v26↔v26). On main, with no Engine advertising the
 * cap, the filter stays inactive. Operator DURATION_COPY_* overrides must
 * still pass the filter; if no legal pair exists the picker fails loud.
 *
 * The mixed-fleet refusal walk (DURATION_MIXED_FLEET_PROOF=1, Atlas only)
 * forces idea01 Kolibri → v26 idea03 and expects the source copyApp to end
 * Failed with a readable 'too old' / 'updated first' error and nothing
 * written on the target disk.
 */
import { STAGE2_MOVE_TARGET_ID, STAGE2_ROLE_MAP } from './stage2.js'
import type { DurationOptions, FleetOps, SemanticEngine, SemanticStoreView, WalkerState } from './types.js'
import { DURATION_UI_FIXTURES } from './ui/fixtures.js'

/** Same order as COPY_MOVE_TARGET_PREFERENCE in actions.ts (avoid a circular import). */
const COPY_MOVE_TARGET_PREFERENCE = [
    DURATION_UI_FIXTURES.nextcloud.diskId,
    DURATION_UI_FIXTURES.kolibri.diskId,
    'duration-empty-001',
] as const

type DurationOperationRow = {
    id: string
    kind: string
    status: string
    startedAt: number | null
    completedAt?: number | null
    error?: string | null
    args?: Record<string, string>
}

/** Capability advertised by a helper-v26 Engine (PR6). Keep as a literal so this PR does not import PR6. */
export const PEER_TICKETS_CAPABILITY = 'peerTickets1'

export const MIXED_FLEET_PROOF_ENV = 'DURATION_MIXED_FLEET_PROOF'
export const MIXED_FLEET_COPY_REFUSAL_WALK = 'mixed-fleet-copy-refusal'

/** Source-side copyApp error from a v26 helper refusing an Engine that cannot mint a ticket. */
export const OLD_TO_NEW_REFUSAL_RE = /too old|updated first/i

export type CopyMovePair = {
    instanceId: string
    sourceDiskId: string
    sourceEngine: string | null
    targetDiskId: string | null
    targetEngine: string | null
    sameEngineOthers: string[]
}

export type PeerTicketsScan = {
    docked: Map<string, string>
    instances: Map<string, { diskId: string | null; status: string }>
    engines: Map<string, SemanticEngine>
}

const isNeverEngine = (id: string): boolean => /idea02/i.test(id)

const isStage2Ops = (ctx: { opts?: { ops?: FleetOps } }): boolean =>
    (ctx.opts?.ops as FleetOps & { stage?: number } | undefined)?.stage === 2

export const mixedFleetProofEnvSet = (env: NodeJS.ProcessEnv = process.env): boolean =>
    env[MIXED_FLEET_PROOF_ENV]?.trim() === '1'

export const isMixedFleetCopyRefusal = (
    ctx: { opts?: { mixedFleetProof?: boolean } },
    env: NodeJS.ProcessEnv = process.env,
): boolean => mixedFleetProofEnvSet(env) && ctx.opts?.mixedFleetProof === true

/**
 * Fail at walk start if someone runs the mixed-fleet refusal walk without the
 * Atlas-only env, so it can never sneak into a normal cover-all / registered run.
 */
export const assertMixedFleetWalkAllowed = (walkName: string, env: NodeJS.ProcessEnv = process.env): void => {
    if (walkName === MIXED_FLEET_COPY_REFUSAL_WALK && !mixedFleetProofEnvSet(env)) {
        throw new Error(
            `Walk ${walkName} is the mixed-fleet old→new copy refusal proof and requires ` +
                `${MIXED_FLEET_PROOF_ENV}=1 (Atlas sets this only for that proof; never for ` +
                `cover-all, cover-registered-intents, or Markov). No soft-pass.`,
        )
    }
}

/**
 * Live peerTickets1: the cap is in the list AND the boot stamp matches lastBooted.
 * A missing capabilitiesBootedAt or lastBooted does NOT count.
 */
export const engineHasLivePeerTickets = (eng: SemanticEngine | null | undefined): boolean => {
    if (!eng) return false
    const caps = eng.capabilities
    if (!Array.isArray(caps) || !caps.includes(PEER_TICKETS_CAPABILITY)) return false
    if (eng.capabilitiesBootedAt == null || eng.lastBooted == null) return false
    return eng.capabilitiesBootedAt === eng.lastBooted
}

export const poolHasLivePeerTickets = (engines: Iterable<SemanticEngine | null | undefined>): boolean => {
    for (const e of engines) if (engineHasLivePeerTickets(e)) return true
    return false
}

export const mergePeerTicketsScan = (scan: PeerTicketsScan, view: SemanticStoreView): void => {
    for (const d of Object.values(view.diskDB ?? {})) {
        if (d.dockedTo && !scan.docked.has(d.id)) scan.docked.set(d.id, d.dockedTo)
    }
    for (const [id, inst] of Object.entries(view.instanceDB ?? {})) {
        const prev = scan.instances.get(id)
        if (!prev || (prev.status === 'Undocked' && inst.status !== 'Undocked')) {
            scan.instances.set(id, { diskId: inst.diskId, status: inst.status })
        }
    }
    for (const [id, eng] of Object.entries(view.engineDB ?? {})) {
        if (!scan.engines.has(id)) scan.engines.set(id, eng)
        else {
            const cur = scan.engines.get(id)!
            // Prefer a record that carries capability fields when views disagree.
            if ((cur.capabilities == null || cur.lastBooted == null) && (eng.capabilities != null || eng.lastBooted != null)) {
                scan.engines.set(id, eng)
            }
        }
    }
}

export const emptyPeerTicketsScan = (): PeerTicketsScan => ({
    docked: new Map(),
    instances: new Map(),
    engines: new Map(),
})

const pairDesc = (p: CopyMovePair): string =>
    `${p.instanceId} on ${p.sourceEngine ?? 'undocked'} (disk ${p.sourceDiskId}) -> ${p.targetDiskId ?? 'none'} on ${p.targetEngine ?? 'undocked'}`

const liveSet = (engines: Map<string, SemanticEngine>, ids: Iterable<string>): string[] => {
    const out: string[] = []
    for (const id of ids) if (engineHasLivePeerTickets(engines.get(id))) out.push(id)
    return out
}

const unique = (ids: Array<string | null | undefined>): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const id of ids) {
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push(id)
    }
    return out
}

const stage2ProtectedTargets = (): Set<string> =>
    new Set<string>([...Object.values(STAGE2_ROLE_MAP), STAGE2_MOVE_TARGET_ID])

const allowedCopyTarget = (
    diskId: string,
    sourceDiskId: string,
    scan: PeerTicketsScan,
    exclude: string[],
): boolean => {
    if (diskId === sourceDiskId || /system/i.test(diskId)) return false
    const eng = scan.docked.get(diskId)
    if (!eng || exclude.includes(eng) || isNeverEngine(eng)) return false
    return engineHasLivePeerTickets(scan.engines.get(eng))
}

/**
 * Apply the v26↔v26 copy filter to a predicted pair.
 *
 * Inactive when no pool Engine has live peerTickets1, when the mixed-fleet
 * refusal walk is forcing the old→new pair, or when the action is move_app
 * (same-Pi move does not use transfer tickets).
 *
 * Throws if an operator override is illegal, if Stage 2 remapping would land
 * on a role / move-only disk, or if no legal pair exists.
 */
export const applyPeerTicketsCopyFilter = (
    args: {
        action?: string
        pair: CopyMovePair
        scan: PeerTicketsScan
        excludeEngines: string[]
        env?: NodeJS.ProcessEnv
        mixedFleetProof?: boolean
        stage2?: boolean
    },
): CopyMovePair => {
    const env = args.env ?? process.env
    if (args.action === 'move_app') return args.pair
    if (args.mixedFleetProof && mixedFleetProofEnvSet(env)) return args.pair
    if (!poolHasLivePeerTickets(args.scan.engines.values())) return args.pair

    const exclude = args.excludeEngines
    const bothLive = (p: CopyMovePair): boolean =>
        !!p.sourceEngine &&
        !!p.targetEngine &&
        !!p.targetDiskId &&
        !exclude.includes(p.sourceEngine) &&
        !exclude.includes(p.targetEngine) &&
        !isNeverEngine(p.sourceEngine) &&
        !isNeverEngine(p.targetEngine) &&
        engineHasLivePeerTickets(args.scan.engines.get(p.sourceEngine)) &&
        engineHasLivePeerTickets(args.scan.engines.get(p.targetEngine))

    const overridden = !!(
        env.DURATION_COPY_INSTANCE_ID?.trim() ||
        env.DURATION_COPY_SOURCE_DISK?.trim() ||
        env.DURATION_COPY_TARGET_DISK?.trim()
    )

    if (bothLive(args.pair)) return args.pair

    const live = liveSet(args.scan.engines, [
        ...args.scan.engines.keys(),
        ...args.scan.docked.values(),
    ])
    const stale = [...new Set([...args.scan.engines.keys(), ...args.scan.docked.values()])]
        .filter(id => !exclude.includes(id) && !isNeverEngine(id) && !live.includes(id))

    if (overridden) {
        throw new Error(
            `copy_app: operator DURATION_COPY_* override pair ${pairDesc(args.pair)} is not v26↔v26 ` +
                `(live peerTickets1: ${live.join(', ') || 'none'}; not live: ${stale.join(', ') || 'none'}). ` +
                `The override must still pass the filter. No soft-pass, no fallback.`,
        )
    }

    const picked = pickLegalCopyPair(args.pair, args.scan, exclude, args.stage2 === true)
    if (picked) return picked

    if (args.stage2) {
        throw new Error(
            `copy_app: no legal v26↔v26 pair that preserves Stage 2 role disks ` +
                `(files/backup/erase/moveApp and empty-003). Default pair ${pairDesc(args.pair)} is mixed ` +
                `(live peerTickets1: ${live.join(', ') || 'none'}; not live: ${stale.join(', ') || 'none'}). ` +
                `Run the ${MIXED_FLEET_COPY_REFUSAL_WALK} walk with ${MIXED_FLEET_PROOF_ENV}=1, not cover-all, ` +
                `on a mixed pool. No soft-pass.`,
        )
    }
    throw new Error(
        `copy_app: no legal v26↔v26 pair (both engines must advertise live ${PEER_TICKETS_CAPABILITY}). ` +
            `Default pair ${pairDesc(args.pair)} is mixed (live: ${live.join(', ') || 'none'}; not live: ${stale.join(', ') || 'none'}). ` +
            `No soft-pass, no fallback.`,
    )
}

const pickLegalCopyPair = (
    fallback: CopyMovePair,
    scan: PeerTicketsScan,
    exclude: string[],
    stage2: boolean,
): CopyMovePair | null => {
    const protectedTargets = stage2 ? stage2ProtectedTargets() : new Set<string>()
    const liveInstances = (): string[] => {
        const ids: string[] = []
        for (const [id, inst] of scan.instances) {
            if (inst.status === 'Undocked' || !inst.diskId) continue
            const eng = scan.docked.get(inst.diskId)
            if (!eng || exclude.includes(eng) || isNeverEngine(eng)) continue
            if (!engineHasLivePeerTickets(scan.engines.get(eng))) continue
            ids.push(id)
        }
        return ids
    }
    const instOrder = unique([
        fallback.instanceId,
        DURATION_UI_FIXTURES.kolibri.instanceId,
        DURATION_UI_FIXTURES.nextcloud.instanceId,
        ...liveInstances().sort(),
    ])
    const targetOrder = (sourceDisk: string): string[] =>
        unique([
            fallback.targetDiskId,
            ...COPY_MOVE_TARGET_PREFERENCE,
            ...[...scan.docked.keys()].sort(),
        ]).filter(id => allowedCopyTarget(id, sourceDisk, scan, exclude))
            .filter(id => !protectedTargets.has(id))

    for (const instanceId of instOrder) {
        const inst = scan.instances.get(instanceId)
        const sourceDiskId = (inst?.status !== 'Undocked' && inst?.diskId) || (
            instanceId === fallback.instanceId ? fallback.sourceDiskId : undefined
        )
        if (!sourceDiskId) continue
        // Stage 2 remapping must not start from a role / move-only disk either
        // (those partitions have no app instance at walk start; Fake docks may invent one).
        if (protectedTargets.has(sourceDiskId)) continue
        const sourceEngine = scan.docked.get(sourceDiskId)
        if (!sourceEngine || exclude.includes(sourceEngine) || isNeverEngine(sourceEngine)) continue
        if (!engineHasLivePeerTickets(scan.engines.get(sourceEngine))) continue
        for (const targetDiskId of targetOrder(sourceDiskId)) {
            const targetEngine = scan.docked.get(targetDiskId) ?? null
            if (!targetEngine) continue
            const others = [...scan.docked.keys()].filter(
                id => id !== sourceDiskId && !/system/i.test(id) && scan.docked.get(id) === sourceEngine,
            )
            return {
                instanceId,
                sourceDiskId,
                sourceEngine,
                targetDiskId,
                targetEngine,
                sameEngineOthers: others,
            }
        }
    }
    return null
}

export const mixedFleetRefusalPins = (
    env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
    const kolibri = DURATION_UI_FIXTURES.kolibri
    const nc = DURATION_UI_FIXTURES.nextcloud
    const set: Record<string, string> = {}
    if (!env.DURATION_COPY_INSTANCE_ID?.trim()) set.DURATION_COPY_INSTANCE_ID = kolibri.instanceId
    if (!env.DURATION_COPY_SOURCE_DISK?.trim()) set.DURATION_COPY_SOURCE_DISK = kolibri.diskId
    if (!env.DURATION_COPY_TARGET_DISK?.trim()) set.DURATION_COPY_TARGET_DISK = nc.diskId
    return set
}

/**
 * Env pins so the Console Intent follows the (possibly remapped) pair.
 * Returns null when the filter is inactive and this is not the mixed-fleet walk
 * (leave current un-pinned behaviour).
 */
export const copyAppPairPins = (
    args: {
        action: string
        pair: CopyMovePair
        mixedFleetProof?: boolean
        filterActive: boolean
    },
    env: NodeJS.ProcessEnv = process.env,
): { set: Record<string, string>; note: string } | null => {
    if (args.action !== 'copy_app') return null
    if (args.mixedFleetProof && mixedFleetProofEnvSet(env)) {
        const set = mixedFleetRefusalPins(env)
        const inst = env.DURATION_COPY_INSTANCE_ID?.trim() || set.DURATION_COPY_INSTANCE_ID || DURATION_UI_FIXTURES.kolibri.instanceId
        const src = env.DURATION_COPY_SOURCE_DISK?.trim() || set.DURATION_COPY_SOURCE_DISK || DURATION_UI_FIXTURES.kolibri.diskId
        const tgt = env.DURATION_COPY_TARGET_DISK?.trim() || set.DURATION_COPY_TARGET_DISK || DURATION_UI_FIXTURES.nextcloud.diskId
        return {
            set,
            note: `mixed-fleet refusal: pin ${inst} on ${src} -> ${tgt} (expect Failed; ${MIXED_FLEET_PROOF_ENV}=1)`,
        }
    }
    if (!args.filterActive) return null
    const set: Record<string, string> = {}
    if (!env.DURATION_COPY_INSTANCE_ID?.trim()) set.DURATION_COPY_INSTANCE_ID = args.pair.instanceId
    if (!env.DURATION_COPY_SOURCE_DISK?.trim()) set.DURATION_COPY_SOURCE_DISK = args.pair.sourceDiskId
    if (!env.DURATION_COPY_TARGET_DISK?.trim() && args.pair.targetDiskId) set.DURATION_COPY_TARGET_DISK = args.pair.targetDiskId
    if (!Object.keys(set).length) return { set, note: `v26↔v26 copy pair ${pairDesc(args.pair)} (already pinned)` }
    return { set, note: `v26↔v26 copy pair ${pairDesc(args.pair)}` }
}

export type RefusalCheckReason =
    | 'ok'
    | 'never_started'
    | 'not_failed'
    | 'wrong_error'
    | 'target_op'
    | 'target_instance'
    | 'target_folder'
    | 'target_marker'

export type RefusalBaseline = {
    instanceIds: ReadonlySet<string>
    diskEntries: readonly string[]
}

export const isInFlightMarker = (name: string): boolean => name.endsWith('.idea-op-in-flight')

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Post-check for the mixed-fleet old→new copy: the source copyApp must end Failed
 * with a readable 'too old' / 'updated first' error, and the target must be
 * untouched (no target-side op, no new instanceDB row, no instances/<id> folder,
 * no *.idea-op-in-flight marker). No command-log assert (idea01 may have none).
 * Returns null without a listOperations reader (Fake ops).
 */
type RefusalOps = {
    readStore: FleetOps['readStore']
    listOperations?: (engineId: string) => Promise<DurationOperationRow[]>
    listDiskInstanceEntries?: (engineId: string, diskId: string) => Promise<string[]>
}

export const verifyOldToNewCopyRefusal = async (
    ctx: {
        opts: { ops: RefusalOps; fast?: boolean }
        poolEngines: string[]
        excludeEngines: string[]
        action?: string
        walker?: WalkerState
    },
    sinceMs: number,
    expect: {
        sourceEngine: string
        targetEngine: string
        instanceId?: string
        targetDiskId: string
        baseline: RefusalBaseline
        diskEntriesAfter?: readonly string[]
        startBudgetMs?: number
        pollMs?: number
        slackMs?: number
        startClockMs?: number
    },
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; reason: RefusalCheckReason; note: string } | null> => {
    const ops = ctx.opts.ops as FleetOps & {
        listOperations?: (engineId: string) => Promise<DurationOperationRow[]>
        listDiskInstanceEntries?: (engineId: string, diskId: string) => Promise<string[]>
    }
    if (typeof ops.listOperations !== 'function') return null
    const startBudget = expect.startBudgetMs ?? (ctx.opts.fast ? 60 : 30_000)
    const pollMs = expect.pollMs ?? (ctx.opts.fast ? 5 : 1_000)
    const slackMs = expect.slackMs ?? 5_000
    const t0 = expect.startClockMs ?? Date.now()
    const terminal = (st: string) => st === 'Done' || st === 'Failed' || st === 'Cancelled'

    let sourceRows: DurationOperationRow[] = []
    let targetRows: DurationOperationRow[] = []
    let readErrors: string[] = []
    const scan = async () => {
        sourceRows = []
        targetRows = []
        readErrors = []
        for (const [eng, bucket] of [
            [expect.sourceEngine, 'source'] as const,
            [expect.targetEngine, 'target'] as const,
        ]) {
            try {
                for (const r of await ops.listOperations!(eng)) {
                    if (r.kind !== 'copyApp') continue
                    if (typeof r.startedAt !== 'number' || r.startedAt < sinceMs - slackMs) continue
                    if (bucket === 'source') {
                        if (expect.instanceId && r.args?.instanceId && r.args.instanceId !== expect.instanceId) continue
                        sourceRows.push(r)
                    } else {
                        targetRows.push(r)
                    }
                }
            } catch (e) {
                readErrors.push(`${eng}: ${e instanceof Error ? e.message : String(e)}`)
            }
        }
    }
    for (;;) {
        await scan()
        const elapsed = Date.now() - t0
        if (sourceRows.some(r => terminal(r.status)) || elapsed >= startBudget) break
        await sleep(pollMs)
    }
    const errNote = readErrors.length ? ` (store read errors: ${readErrors.join('; ')})` : ''
    const srcDesc = sourceRows
        .map(r => `${r.id}=${r.status}${r.error ? ` (error: ${r.error})` : ''}`)
        .join(', ') || 'none'

    if (!sourceRows.length) {
        return {
            ok: false,
            reason: 'never_started',
            note:
                `mixed-fleet copy refusal: no copyApp Operation on source ${expect.sourceEngine} ` +
                `within ${Date.now() - t0}ms (budget ${startBudget}ms)${errNote}. No soft-pass.`,
        }
    }
    const failed = sourceRows.filter(r => r.status === 'Failed')
    if (!failed.length) {
        const done = sourceRows.some(r => r.status === 'Done')
        return {
            ok: false,
            reason: 'not_failed',
            note:
                `mixed-fleet copy refusal: source copyApp did not end Failed (${srcDesc}` +
                `${done ? '; ended Done' : ''})${errNote}. No soft-pass.`,
        }
    }
    const matched = failed.filter(r => OLD_TO_NEW_REFUSAL_RE.test(r.error ?? ''))
    if (!matched.length) {
        return {
            ok: false,
            reason: 'wrong_error',
            note:
                `mixed-fleet copy refusal: source copyApp Failed but the error is missing 'too old' or ` +
                `'updated first' (${srcDesc})${errNote}. No soft-pass.`,
        }
    }
    if (targetRows.length) {
        return {
            ok: false,
            reason: 'target_op',
            note:
                `mixed-fleet copy refusal: target ${expect.targetEngine} grew a copyApp Operation ` +
                `(${targetRows.map(r => `${r.id}=${r.status}`).join(', ')}) — nothing should be written. No soft-pass.`,
        }
    }

    let afterIds: Set<string>
    try {
        afterIds = new Set(Object.keys((await ctx.opts.ops.readStore(expect.targetEngine)).instanceDB ?? {}))
        // Also merge other pool views so a unique-store row is not missed.
        for (const eng of ctx.poolEngines.filter(e => !ctx.excludeEngines.includes(e) && e !== expect.targetEngine)) {
            try {
                for (const id of Object.keys((await ctx.opts.ops.readStore(eng)).instanceDB ?? {})) afterIds.add(id)
            } catch { /* view unread */ }
        }
    } catch (e) {
        return {
            ok: false,
            reason: 'target_instance',
            note: `mixed-fleet copy refusal: could not re-read instanceDB: ${e instanceof Error ? e.message : String(e)}. No soft-pass.`,
        }
    }
    const newIds = [...afterIds].filter(id => !expect.baseline.instanceIds.has(id))
    if (newIds.length) {
        return {
            ok: false,
            reason: 'target_instance',
            note:
                `mixed-fleet copy refusal: new instanceDB row(s) ${newIds.join(', ')} after the refused copy. No soft-pass.`,
        }
    }

    let afterEntries: readonly string[] | undefined = expect.diskEntriesAfter
    if (!afterEntries) {
        if (typeof ops.listDiskInstanceEntries !== 'function') {
            return {
                ok: false,
                reason: 'target_folder',
                note:
                    `mixed-fleet copy refusal: ops.listDiskInstanceEntries is missing; cannot prove ` +
                    `${expect.targetDiskId} on ${expect.targetEngine} was untouched. No soft-pass.`,
            }
        }
        try {
            afterEntries = await ops.listDiskInstanceEntries(expect.targetEngine, expect.targetDiskId)
        } catch (e) {
            return {
                ok: false,
                reason: 'target_folder',
                note:
                    `mixed-fleet copy refusal: could not list instances/ on ${expect.targetDiskId}@${expect.targetEngine}: ` +
                    `${e instanceof Error ? e.message : String(e)}. No soft-pass.`,
            }
        }
    }
    const before = new Set(expect.baseline.diskEntries)
    const added = afterEntries.filter(n => !before.has(n))
    const newFolders = added.filter(n => !isInFlightMarker(n) && !n.startsWith('.'))
    const newMarkers = added.filter(isInFlightMarker)
    if (newFolders.length) {
        return {
            ok: false,
            reason: 'target_folder',
            note:
                `mixed-fleet copy refusal: new instances/ folder(s) on ${expect.targetDiskId}: ${newFolders.join(', ')}. No soft-pass.`,
        }
    }
    if (newMarkers.length) {
        return {
            ok: false,
            reason: 'target_marker',
            note:
                `mixed-fleet copy refusal: new idea-op-in-flight marker(s) on ${expect.targetDiskId}: ${newMarkers.join(', ')}. No soft-pass.`,
        }
    }
    const op = matched[0]!
    return {
        ok: true,
        reason: 'ok',
        note:
            `mixed-fleet copy refusal: source ${expect.sourceEngine} copyApp ${op.id} Failed ` +
            `(${op.error}); target ${expect.targetEngine} disk ${expect.targetDiskId} unchanged`,
    }
}

export const captureRefusalBaseline = async (
    ops: FleetOps & { listDiskInstanceEntries?: (engineId: string, diskId: string) => Promise<string[]> },
    opts: { poolEngines: string[]; excludeEngines: string[]; targetEngine: string; targetDiskId: string },
): Promise<RefusalBaseline> => {
    const instanceIds = new Set<string>()
    for (const eng of opts.poolEngines.filter(e => !opts.excludeEngines.includes(e))) {
        try {
            for (const id of Object.keys((await ops.readStore(eng)).instanceDB ?? {})) instanceIds.add(id)
        } catch { /* view unread */ }
    }
    let diskEntries: string[] = []
    if (typeof ops.listDiskInstanceEntries === 'function') {
        diskEntries = await ops.listDiskInstanceEntries(opts.targetEngine, opts.targetDiskId)
    }
    return { instanceIds, diskEntries }
}

/** Re-export for callers that only want the predicate without constructing a scan. */
export const filterActiveFor = (scan: PeerTicketsScan, action?: string, mixedFleetProof?: boolean, env: NodeJS.ProcessEnv = process.env): boolean => {
    if (action === 'move_app') return false
    if (mixedFleetProof && mixedFleetProofEnvSet(env)) return false
    return poolHasLivePeerTickets(scan.engines.values())
}

export const isStage2Context = isStage2Ops

// Silence unused DurationOptions import if tsc noUnusedLocals — we type mixedFleetProof via a structural type above.
export type MixedFleetDurationOptions = DurationOptions & { mixedFleetProof?: boolean }
