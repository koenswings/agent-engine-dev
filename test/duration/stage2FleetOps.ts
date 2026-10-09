/**
 * Stage 2 live ops: RealFleetOps with fixture dock/undock/move/reboot routed through Atlas's
 * stage2-dock.sh (contract in stage2.ts / STAGE2.md). Everything else (WS store, probes,
 * Console deploy) is inherited. Selected by DURATION_STAGE=2 in cli.ts.
 *
 * Dock split: per-disk steps use PARTITION verbs (dock/undock/reset/export/import); whole-SSD
 * verbs (dock-ssd/eject-ssd) only around a reboot (planned or 05:00) and inside one call
 * (ejectSsd/dockSsd), so no walk step ever sees a sibling partition of an ejected SSD.
 *
 * Stage 2 never writes the Stage 1 dock-trigger folder (duration-watch sentinels) and never
 * copies trees into duration-disks: sshDockCopy / sshRemoveSentinel refuse. Disks are addressed
 * by diskId → PARTLABEL only (stage2-dock.sh); paths come from `status` (mounted /disks/<kname>).
 */
import { RealFleetOps, type RealFleetOptions } from './realFleetOps.js'
import {
    buildEngineConfigProbe, buildStage2DockCmd, parseEngineConfigProbe, parseStage2DockJson, parseStage2Status,
    stage2DockScript, stage2Fixture, stage2FixturesOn, stage2MoveTargetPartition, stage2SsdsOn, STAGE2_DISKS_ROOT, STAGE2_NEVER_HOSTS,
    type EngineConfigProbe, type Stage2DockVerb, type Stage2Status,
} from './stage2.js'

const DOCK_WAIT_MS = Number(process.env.DURATION_STAGE2_DOCK_WAIT_MS ?? 120_000)
/**
 * Gap between `undock` and `dock` when re-docking a partition that is present but not mounted
 * (Engine-ejected, or after reset/import). Atlas reset-r53: the script's own partx -d/-a cycle is
 * milliseconds apart, chokidar merges unlink+add of /dev/engine/<kname> into a 'change', and the Engine
 * only acts on add/unlink → the dock silently did nothing. undock → ~5 s → dock worked.
 */
export const STAGE2_REDOCK_GAP_MS_DEFAULT = 5_000
export const stage2RedockGapMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const v = Number(env.DURATION_STAGE2_REDOCK_GAP_MS)
    return Number.isFinite(v) && v >= 0 && env.DURATION_STAGE2_REDOCK_GAP_MS?.trim() ? v : STAGE2_REDOCK_GAP_MS_DEFAULT
}
const RE_INSTANCE = /^[A-Za-z0-9_.-]+$/

export class Stage2FleetOps extends RealFleetOps {
    readonly stage = 2 as const
    private readonly dockScript: string
    private readonly s2hosts: Record<string, string>
    private readonly sleepMs: (ms: number) => Promise<void>
    private readonly dockWaitMs: number
    private readonly redockGapMs: number
    /** Partition diskId → diskId of the app network-copied onto it (move target occupancy). */
    readonly moveCopies = new Map<string, string>()
    /** Fixtures the harness deliberately left undocked (a reboot re-adds partitions → undock again). */
    readonly heldUndocked = new Set<string>()
    /** engine → last seen boot_id (05:00 / unplanned reboot detection). */
    readonly bootIds = new Map<string, string>()
    /** `${engine}#ssd${n}` currently ejected as a whole SSD (both partitions offline). */
    readonly ssdOffline = new Set<string>()
    /** Log of redock reconciliations (for evidence / tests). */
    readonly redockLog: string[] = []
    /** Log of partition docks (undock → gap → dock decisions), for evidence / tests. */
    readonly dockLog: string[] = []

    constructor(opts: RealFleetOptions & { dockScript?: string; sleep?: (ms: number) => Promise<void>; dockWaitMs?: number; redockGapMs?: number }) {
        for (const n of STAGE2_NEVER_HOSTS) {
            if (opts.poolEngines.includes(n)) throw new Error(`Stage2FleetOps: refuse ${n} in pool`)
        }
        super(opts)
        this.dockScript = opts.dockScript ?? stage2DockScript()
        this.s2hosts = { ...opts.hosts }
        this.sleepMs = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
        this.dockWaitMs = opts.dockWaitMs ?? DOCK_WAIT_MS
        this.redockGapMs = opts.redockGapMs ?? stage2RedockGapMs()
    }

    private s2host(engineId: string): string {
        if ((STAGE2_NEVER_HOSTS as readonly string[]).includes(engineId)) throw new Error(`Stage2FleetOps: refuse ${engineId}`)
        const h = this.s2hosts[engineId]
        if (!h) throw new Error(`Stage2FleetOps: no host for '${engineId}'`)
        return h
    }

    // ── Stage 1 dock-trigger folder: never in Stage 2 ──────────────────────
    protected override async sshDockCopy(engineId: string, diskId: string): Promise<void> {
        throw new Error(`Stage2FleetOps: refuse Stage 1 tree copy + duration-watch sentinel for ${diskId} on ${engineId} (real partitions only)`)
    }
    protected override async sshRemoveSentinel(engineId: string, device: string): Promise<void> {
        throw new Error(`Stage2FleetOps: refuse duration-watch sentinel removal (${device} on ${engineId}); Stage 2 never writes the dock-trigger folder`)
    }

    private assertSsdOnline(engineId: string, diskId: string): void {
        const f = stage2Fixture(diskId)
        if (f.host === engineId && this.ssdOffline.has(`${engineId}#ssd${f.ssd}`)) {
            throw new Error(`Stage 2: ${diskId} sits on ${engineId} SSD${f.ssd}, which is ejected as a whole SSD — no partition step on a sibling of an ejected SSD`)
        }
    }

    private async rawCall(engineId: string, verb: Stage2DockVerb, args: { diskId?: string; as?: string } = {}) {
        if (args.diskId && verb !== 'dock-ssd' && verb !== 'eject-ssd' && verb !== 'status') this.assertSsdOnline(engineId, args.diskId)
        const out = await this.ssh(this.s2host(engineId), buildStage2DockCmd(verb, args, this.dockScript))
        const r = parseStage2DockJson(out, `${verb}@${engineId}`)
        if (!r.ok) throw new Error(`stage2-dock ${verb} ${args.diskId ?? ''} on ${engineId} returned ok=false: ${JSON.stringify(r).slice(0, 300)}`)
        return r
    }

    /** Every fixture op first checks boot_id: a changed id (05:00 reboot) triggers redock reconciliation. */
    private async dockCall(engineId: string, verb: Stage2DockVerb, args: { diskId?: string; as?: string } = {}) {
        await this.checkBoot(engineId)
        return this.rawCall(engineId, verb, args)
    }

    async stage2Status(engineId: string): Promise<Stage2Status> {
        return parseStage2Status(await this.ssh(this.s2host(engineId), buildStage2DockCmd('status', {}, this.dockScript)))
    }

    /** Read-only: config.yaml + running Engine IDEA_* env (production's own sources). */
    async probeEngineConfig(engineId: string): Promise<EngineConfigProbe> {
        return parseEngineConfigProbe(await this.ssh(this.s2host(engineId), buildEngineConfigProbe()))
    }

    private async checkBoot(engineId: string): Promise<void> {
        const st = await this.stage2Status(engineId)
        const prev = this.bootIds.get(engineId)
        if (st.bootId) this.bootIds.set(engineId, st.bootId)
        if (prev && st.bootId && prev !== st.bootId) {
            console.log(`[duration] stage2: ${engineId} rebooted outside the walk (boot_id ${prev.slice(0, 8)}→${st.bootId.slice(0, 8)}; 05:00?) — redock`)
            await this.redockAfterBoot(engineId, st)
        }
    }

    /** Record the current boot_id of every pool Pi (walk start), so a later change is seen as a reboot. */
    async recordBootIds(engineIds: readonly string[]): Promise<Record<string, string | null>> {
        const out: Record<string, string | null> = {}
        for (const e of engineIds) {
            const st = await this.stage2Status(e)
            out[e] = st.bootId
            if (st.bootId) this.bootIds.set(e, st.bootId)
        }
        return out
    }

    /**
     * After any reboot of engineId: real partitions survive and the Engine re-detects them at
     * boot. (1) SSD missing → dock-ssd (whole-SSD). (2) Fixtures the harness held undocked →
     * Engine eject + undock again. (3) Every other home fixture → wait until docked here.
     * A moved copy on the move target comes back too and is left docked (store keeps its diskId).
     */
    async redockAfterBoot(engineId: string, status?: Stage2Status): Promise<void> {
        let st = status ?? await this.stage2Status(engineId)
        for (const n of stage2SsdsOn(engineId)) {
            const onSsd = stage2FixturesOn(engineId).filter(f => f.ssd === n)
            if (onSsd.every(f => !st.fixtures.find(x => x.partLabel === f.partLabel)?.present)) {
                this.redockLog.push(`${engineId}: SSD${n} missing after boot → dock-ssd --ssd ${onSsd[0]!.diskId}`)
                await this.rawCall(engineId, 'dock-ssd', { diskId: onSsd[0]!.diskId })
                this.ssdOffline.delete(`${engineId}#ssd${n}`)
                st = await this.stage2Status(engineId)
            } else {
                this.ssdOffline.delete(`${engineId}#ssd${n}`)
            }
        }
        if (st.bootId) this.bootIds.set(engineId, st.bootId)
        for (const f of stage2FixturesOn(engineId)) {
            if (this.heldUndocked.has(f.diskId)) {
                if (!st.fixtures.find(x => x.partLabel === f.partLabel)?.present) continue
                this.redockLog.push(`${engineId}: re-undock ${f.diskId}`)
                await this.engineEject(engineId, f.diskId)
                await this.rawCall(engineId, 'undock', { diskId: f.diskId })
            } else {
                const as = this.moveCopies.get(f.diskId) ?? f.diskId
                this.redockLog.push(`${engineId}: wait docked ${as}`)
                await this.waitDocked(as, engineId)
            }
        }
    }

    override async rebootEngine(engineId: string, fast: boolean): Promise<void> {
        await super.rebootEngine(engineId, fast)
        await this.redockAfterBoot(engineId)
    }

    private async waitDocked(diskId: string, engineId: string): Promise<void> {
        const deadline = Date.now() + this.dockWaitMs
        let last = 'unread'
        for (;;) {
            try {
                const on = await this.findDockedEngine(diskId)
                last = `dockedTo=${on ?? 'none'}`
                if (on === engineId) return
            } catch (e) { last = e instanceof Error ? e.message : String(e) }
            if (Date.now() >= deadline) throw new Error(`Stage 2: ${diskId} not docked on ${engineId} within ${this.dockWaitMs}ms (${last})`)
            await this.sleepMs(1000)
        }
    }

    /** Partition (by PARTLABEL) that currently carries diskId on engineId (META diskId; a moved copy carries the source id). */
    private partitionWith(st: Stage2Status, diskId: string) {
        return st.fixtures.find(x => x.present && x.diskId === diskId)
            ?? st.fixtures.find(x => x.partLabel === stage2Fixture(diskId).partLabel && !this.moveCopies.has(diskId))
    }

    /**
     * Engine eject (WS `ejectDisk`, inherited) and wait until the store shows it undocked AND the
     * partition is no longer mounted — only then may a partition verb (undock/reset/export) run.
     * Partition = the one carrying diskId's META (a moved copy lives on the move target).
     */
    async engineEject(engineId: string, diskId: string): Promise<void> {
        await super.undockFixtures([engineId], diskId)
        const deadline = Date.now() + this.dockWaitMs
        let last = 'unread'
        for (;;) {
            try {
                const on = await this.findDockedEngine(diskId)
                const st = await this.stage2Status(engineId)
                const p = this.partitionWith(st, diskId)
                last = `dockedTo=${on ?? 'none'} ${p?.partLabel ?? '?'} mounted=${p?.mounted ?? 'no'}`
                if (on !== engineId && !p?.mounted) return
            } catch (e) { last = e instanceof Error ? e.message : String(e) }
            if (Date.now() >= deadline) throw new Error(`Stage 2: Engine eject of ${diskId} on ${engineId} not done within ${this.dockWaitMs}ms (${last})`)
            await this.sleepMs(1000)
        }
    }

    /**
     * Every partition dock goes through here (dockFixture, move_disk source/target). Engine-visible dock
     * of partition `part` (META diskId `as`, ≠ part for a network-copied fixture) on engineId:
     *   - mounted already → nothing to add (still verified below);
     *   - present but NOT mounted (Engine-ejected, or fresh from reset/import) → `undock`, wait
     *     redockGapMs (DURATION_STAGE2_REDOCK_GAP_MS, default 5 s), then `dock` — never the script's
     *     millisecond re-add cycle, which chokidar sees as a 'change' the Engine ignores (reset-r53);
     *   - absent → `dock` (a real add).
     * Then verify (bounded by dockWaitMs): the store has `as` docked on engineId AND the partition is
     * mounted there. A dock with no effect fails loud — never a silent no-op.
     */
    private async dockPartition(engineId: string, part: string, as = part): Promise<void> {
        const label = stage2Fixture(part).partLabel
        await this.checkBoot(engineId) // a 05:00 reboot is reconciled before any partition verb
        const st = await this.stage2Status(engineId)
        const p = st.fixtures.find(x => x.partLabel === label)
        if (p?.present && p.mounted) {
            console.log(`[duration] stage2: dock ${part} on ${engineId}: ${label} already mounted at ${p.mounted}`)
        } else {
            if (p?.present) {
                this.dockLog.push(`${engineId}: ${label} present, not mounted → undock, wait ${this.redockGapMs}ms, dock`)
                await this.rawCall(engineId, 'undock', { diskId: part })
                await this.sleepMs(this.redockGapMs)
            }
            const r = await this.rawCall(engineId, 'dock', { diskId: part })
            if (r.cycled === true) {
                // The script re-added a partition it found present (fast cycle) — exactly the case the Engine may miss.
                console.log(`[duration] stage2: dock ${part} on ${engineId} used the fast re-add cycle (cycled:true) — verifying the Engine took it`)
            }
            this.dockLog.push(`${engineId}: dock ${part}${as !== part ? ` (as ${as})` : ''}`)
        }
        await this.verifyEngineDocked(engineId, part, as)
    }

    /** Store shows `as` docked on engineId AND `part`'s partition is mounted there, within dockWaitMs; else throw. */
    private async verifyEngineDocked(engineId: string, part: string, as = part): Promise<void> {
        const label = stage2Fixture(part).partLabel
        const deadline = Date.now() + this.dockWaitMs
        let last = 'unread'
        for (;;) {
            try {
                const on = await this.findDockedEngine(as)
                const p = (await this.stage2Status(engineId)).fixtures.find(x => x.partLabel === label)
                last = `store dockedTo=${on ?? 'none'}, ${label} ${p?.present ? `present, mounted=${p.mounted ?? 'no'}` : 'absent'}`
                if (on === engineId && p?.present && p.mounted) return
            } catch (e) { last = e instanceof Error ? e.message : String(e) }
            if (Date.now() >= deadline) {
                throw new Error(
                    `Stage 2: dock of ${part}${as !== part ? ` (as ${as})` : ''} on ${engineId} had no effect within ${this.dockWaitMs}ms ` +
                        `(${last}) — the Engine did not take the partition. No soft-pass.`,
                )
            }
            await this.sleepMs(1000)
        }
    }

    /**
     * Stage 2 dock = partition add on the fixture's HOME Pi only. An Empty fixture is always
     * docked FRESH (Engine eject → reset → dock re-add cycle = Stage 1's fresh Empty pack).
     * reset needs the partition PRESENT and unmounted, so it is never partx-removed first.
     */
    override async dockFixture(engineId: string, diskId: string): Promise<void> {
        const f = stage2Fixture(diskId)
        if (f.expectDocked === false) throw new Error(`Stage 2: ${diskId} is kept out of the Engine — never docked by the walk`)
        if (this.moveCopies.has(diskId)) throw new Error(`Stage 2: ${diskId} holds the moved ${this.moveCopies.get(diskId)} — the move target is never re-docked as itself mid-run`)
        const copyOn = [...this.moveCopies.entries()].find(([, a]) => a === diskId)?.[0]
        if (copyOn && engineId === f.host) {
            throw new Error(`Stage 2: ${diskId} was network-copied to ${copyOn} (${stage2Fixture(copyOn).host}); docking the home partition too would give two partitions one diskId — refused`)
        }
        const already = await this.findDockedEngine(diskId)
        if (already === engineId && f.diskTypes?.[0] !== 'empty') {
            // "Already docked" only when the Pi agrees: the store row AND the partition mounted there.
            // A stale store row (or a Console eject the store has not caught up with) gets a real dock.
            const p = this.partitionWith(await this.stage2Status(engineId), diskId)
            if (p?.mounted) return
            console.log(`[duration] stage2: store has ${diskId} docked on ${engineId} but ${p?.partLabel ?? 'its partition'} is not mounted → dock`)
        }
        if (engineId !== f.host) {
            if (already && already !== engineId) return this.moveDisk(already, engineId, diskId)
            throw new Error(`Stage 2: ${diskId} lives on ${f.host}'s SSD; cannot dock it on ${engineId} (use infra_move_disk = network copy)`)
        }
        if (f.diskTypes?.[0] === 'empty') {
            if (this.heldUndocked.has(diskId)) await this.dockPartition(engineId, diskId) // reset needs it present
            if (await this.findDockedEngine(diskId)) await this.engineEject(engineId, diskId)
            await this.dockCall(engineId, 'reset', { diskId })
        }
        this.heldUndocked.delete(diskId)
        await this.dockPartition(engineId, diskId)
    }

    /**
     * r55 (r54 step 58): true when the store has diskId Docked on engineId AND its partition is mounted
     * there — such a disk needs no dock (an Empty would otherwise be ejected + reset + re-docked fresh).
     * A moved copy is looked up by its META diskId on the move target.
     */
    async stage2DockedAndMounted(engineId: string, diskId: string): Promise<boolean> {
        if ((await this.findDockedEngine(diskId)) !== engineId) return false
        const p = this.partitionWith(await this.stage2Status(engineId), diskId)
        return !!(p?.present && p.mounted)
    }

    /** Engine eject (inherited, WS) first, then remove the partition so a later dock is a real add uevent. */
    override async undockFixtures(engineIds: string[], diskId: string): Promise<void> {
        const f = stage2Fixture(diskId)
        const target = [...this.moveCopies.entries()].find(([, a]) => a === diskId)?.[0]
        const holder = target ? stage2Fixture(target).host : f.host
        for (const e of engineIds) {
            if (e === holder) continue
            await super.undockFixtures([e], diskId) // not on its partition's Pi: store eject only (no device here)
        }
        if (!engineIds.includes(holder)) return
        await this.engineEject(holder, diskId)
        const part = target ?? diskId
        await this.dockCall(holder, 'undock', { diskId: part })
        this.heldUndocked.add(part)
    }

    /**
     * Whole-SSD eject of the SSD carrying diskId (both partitions leave): Engine-eject every docked
     * fixture on it, `eject-ssd`, mark it offline. Partition verbs on its fixtures are refused until dockSsd.
     */
    async ejectSsd(engineId: string, diskId: string): Promise<Record<string, unknown>> {
        const f = stage2Fixture(diskId)
        if (f.host !== engineId) throw new Error(`Stage 2: ${diskId} is not on ${engineId}`)
        for (const g of stage2FixturesOn(engineId).filter(x => x.ssd === f.ssd)) {
            const as = this.moveCopies.get(g.diskId) ?? g.diskId
            if (await this.findDockedEngine(as) === engineId) await this.engineEject(engineId, as)
        }
        const r = await this.rawCall(engineId, 'eject-ssd', { diskId })
        this.ssdOffline.add(`${engineId}#ssd${f.ssd}`)
        return r
    }

    /** `dock-ssd` and wait until every fixture of that SSD (not held undocked) is docked again. */
    async dockSsd(engineId: string, diskId: string): Promise<Record<string, unknown>> {
        const f = stage2Fixture(diskId)
        const r = await this.rawCall(engineId, 'dock-ssd', { diskId })
        this.ssdOffline.delete(`${engineId}#ssd${f.ssd}`)
        for (const g of stage2FixturesOn(engineId).filter(x => x.ssd === f.ssd)) {
            if (this.heldUndocked.has(g.diskId)) {
                await this.engineEject(engineId, g.diskId)
                await this.rawCall(engineId, 'undock', { diskId: g.diskId })
                continue
            }
            await this.waitDocked(this.moveCopies.get(g.diskId) ?? g.diskId, engineId)
        }
        return r
    }

    /**
     * Stage 2 move_disk = NETWORK COPY (declared gap, STAGE2_GAPS) into the move-only target
     * duration-empty-003 (idea04 p2): Engine eject source + target, reset target, `export` | `import`
     * (walker relay, no Pi→Pi keys), undock the source partition (held), dock the target. Partition
     * verbs only: the target's sibling (empty-002, Backup) stays mounted throughout.
     */
    override async moveDisk(fromEngine: string, toEngine: string, diskId: string): Promise<void> {
        // A same-Pi "move" is not a network copy — refuse instead of a silent no-op.
        if (fromEngine === toEngine) throw new Error(`Stage 2 move_disk: ${diskId} ${fromEngine}→${toEngine} is not a move (same Pi) — refused`)
        stage2Fixture(diskId)
        const target = stage2MoveTargetPartition(toEngine, diskId)
        if (this.moveCopies.has(target.diskId)) throw new Error(`Stage 2 move_disk: move target ${target.diskId} already holds ${this.moveCopies.get(target.diskId)}`)
        console.log(`[duration] stage2 move_disk ${diskId} ${fromEngine}→${toEngine}: NETWORK COPY into ${target.partLabel} (${target.diskId}) — physical move is a declared Stage 2 gap`)
        await this.checkBoot(fromEngine)
        await this.checkBoot(toEngine)
        await this.engineEject(fromEngine, diskId)
        if (this.heldUndocked.has(target.diskId)) await this.dockPartition(toEngine, target.diskId)
        if (await this.findDockedEngine(target.diskId)) await this.engineEject(toEngine, target.diskId)
        await this.rawCall(toEngine, 'reset', { diskId: target.diskId })
        this.assertSsdOnline(fromEngine, diskId)
        const out = await this.relayPipe(
            this.s2host(fromEngine), buildStage2DockCmd('export', { diskId }, this.dockScript),
            this.s2host(toEngine), buildStage2DockCmd('import', { diskId: target.diskId, as: diskId }, this.dockScript),
        )
        if (!parseStage2DockJson(out, `import@${toEngine}`).ok) throw new Error(`stage2-dock import ${target.diskId} --as ${diskId} on ${toEngine} ok=false`)
        // Source partition leaves the Engine only after the export read it (export mounts it ro itself).
        if (stage2Fixture(diskId).host === fromEngine) { await this.rawCall(fromEngine, 'undock', { diskId }); this.heldUndocked.add(diskId) }
        this.moveCopies.set(target.diskId, diskId)
        this.heldUndocked.delete(target.diskId)
        // Fresh from reset + import the target is present but unmounted → undock, gap, dock (reset-r53), verified.
        await this.dockPartition(toEngine, target.diskId, diskId)
    }

    // ── Read-only probes on the real partition (Stage 1 used idea-test-N slots) ──

    /** Mount point of the partition carrying diskId on engineId, from `status` (never a guessed sdX). */
    async stage2MountOf(engineId: string, diskId: string): Promise<{ dest: string; kname: string; partLabel: string } | null> {
        const st = await this.stage2Status(engineId)
        const p = st.fixtures.find(x => x.present && x.diskId === diskId && x.mounted)
        if (!p || !p.kname || !p.mounted) return null
        if (p.mounted !== `${STAGE2_DISKS_ROOT}/${p.kname}`) throw new Error(`Stage 2: ${diskId} on ${engineId} mounted at ${p.mounted}, expected ${STAGE2_DISKS_ROOT}/${p.kname}`)
        if (st.rootDisk && p.parent === st.rootDisk) throw new Error(`Stage 2: ${diskId} resolves to the ROOT disk ${st.rootDisk} on ${engineId} — refusing`)
        return { dest: p.mounted, kname: p.kname, partLabel: p.partLabel }
    }

    override async probeBackupDisk(engineId: string, diskId: string, instanceId: string) {
        if (!RE_INSTANCE.test(instanceId)) throw new Error(`Stage2FleetOps: refuse backup probe for odd instance id '${instanceId}'`)
        const m = await this.stage2MountOf(engineId, diskId)
        if (!m) return null
        const repo = `${m.dest}/backups/${instanceId}`
        const out = await this.ssh(this.s2host(engineId),
            `if [ -f '${m.dest}/BACKUP.yaml' ]; then cat '${m.dest}/BACKUP.yaml'; else echo '@@NO_BACKUP_YAML@@'; fi; ` +
            `echo '@@REPO@@'; if [ -d '${repo}' ]; then ls -1A '${repo}'; else echo '@@NO_REPO@@'; fi`)
        const [yamlPart, repoPart = ''] = String(out ?? '').split('@@REPO@@')
        return {
            dest: m.dest,
            backupYaml: /@@NO_BACKUP_YAML@@/.test(yamlPart ?? '') ? null : (yamlPart ?? '').trim(),
            repoEntries: /@@NO_REPO@@/.test(repoPart) ? null : repoPart.split('\n').map(l => l.trim()).filter(Boolean),
        }
    }

    override async probeFixtureFsType(engineId: string, diskId: string) {
        const m = await this.stage2MountOf(engineId, diskId)
        if (!m) return null
        const out = await this.ssh(this.s2host(engineId), `findmnt -no FSTYPE '${m.dest}' || true`)
        return { device: m.kname, dest: m.dest, fsType: String(out ?? '').trim() }
    }

    override async probeFixtureRootEntries(engineId: string, diskId: string) {
        const m = await this.stage2MountOf(engineId, diskId)
        if (!m) return null
        const out = await this.ssh(this.s2host(engineId), `ls -1A '${m.dest}' 2>/dev/null || true`)
        return { dest: m.dest, entries: String(out ?? '').split('\n').map(l => l.trim()).filter(Boolean) }
    }

    /**
     * Per-Pi HTTP identity (READY §4.2): the port a sidecar check uses must belong to THIS
     * instance's container on THIS Pi. idea04 also answers :18080 (native kolibri-0.15.5), so a bare
     * "200 on :18080" proves nothing. Bridge containers (Nextcloud) must publish `:port`; host-network
     * containers (Kolibri) must own the process listening on :port (ss pid ∈ docker top pids).
     * Returns the owning container names; throws on a mismatch.
     */
    async verifySidecarOwner(engineId: string, instanceId: string, port: number): Promise<string[]> {
        if (!RE_INSTANCE.test(instanceId)) throw new Error(`Stage2FleetOps: odd instance id '${instanceId}'`)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Stage2FleetOps: bad port ${port}`)
        const out = await this.ssh(this.s2host(engineId), buildSidecarOwnerProbe(instanceId, port))
        const v = parseSidecarOwnerProbe(String(out ?? ''), port)
        if (!v.owners.length) {
            throw new Error(
                `Stage 2: :${port} on ${engineId} is not served by ${instanceId} (containers: ${v.containers.join(' | ') || 'none'}; ` +
                    `listeners: ${v.listenerPids.join(',') || 'none'}) — another service answers there; no "any Pi" / bare-port check`,
            )
        }
        return v.owners
    }
}

/** One read-only ssh: the instance's containers, their published ports + pids, and who listens on :port. */
export const buildSidecarOwnerProbe = (instanceId: string, port: number): string => {
    if (!RE_INSTANCE.test(instanceId)) throw new Error(`odd instance id '${instanceId}'`)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad port ${port}`)
    return (
        `for c in $(docker ps --filter name='^${instanceId}-' --format '{{.Names}}' 2>/dev/null); do ` +
        `echo "@@C $c $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$c" 2>/dev/null)"; ` +
        `docker port "$c" 2>/dev/null | sed "s|^|@@P $c |"; ` +
        `docker top "$c" -eo pid 2>/dev/null | tail -n +2 | sed "s|^ *|@@T $c |"; done; ` +
        `sudo -n ss -ltnpH 'sport = :${port}' 2>/dev/null | sed 's|^|@@L |'; true`
    )
}

export interface SidecarOwnerVerdict { owners: string[]; containers: string[]; listenerPids: number[] }

export const parseSidecarOwnerProbe = (out: string, port: number): SidecarOwnerVerdict => {
    const containers: string[] = []
    const published = new Set<string>()
    const pids = new Map<string, Set<number>>()
    const listenerPids: number[] = []
    for (const raw of out.split('\n')) {
        const l = raw.trim()
        let m: RegExpMatchArray | null
        if ((m = l.match(/^@@C (\S+)\s*(\S*)/))) containers.push(`${m[1]}(${m[2] || '?'})`)
        else if ((m = l.match(/^@@P (\S+) .*:(\d+)$/))) { if (Number(m[2]) === port) published.add(m[1]!) }
        else if ((m = l.match(/^@@T (\S+) (\d+)$/))) { const s = pids.get(m[1]!) ?? new Set<number>(); s.add(Number(m[2])); pids.set(m[1]!, s) }
        else if (l.startsWith('@@L ')) for (const p of l.matchAll(/pid=(\d+)/g)) listenerPids.push(Number(p[1]))
    }
    const owners = new Set(published)
    for (const [c, set] of pids) if (listenerPids.some(p => set.has(p))) owners.add(c)
    return { owners: [...owners].sort(), containers, listenerPids }
}
