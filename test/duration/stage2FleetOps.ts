/**
 * Stage 2 live ops: RealFleetOps with fixture dock/undock/move/reboot routed through Atlas's
 * stage2-dock.sh (contract in stage2.ts / STAGE2.md). Everything else (WS store, probes,
 * Console deploy) is inherited unchanged. Selected by DURATION_STAGE=2 in cli.ts.
 *
 * Dock split: per-disk steps use PARTITION verbs (dock/undock/reset/export/import); whole-SSD
 * verbs (dock-ssd/eject-ssd) only after a reboot (planned or 05:00) when the SSD did not come
 * back, and for yank-type steps.
 */
import { RealFleetOps, type RealFleetOptions } from './realFleetOps.js'
import {
    buildEngineConfigProbe, buildStage2DockCmd, parseEngineConfigProbe, parseStage2DockJson, parseStage2Status,
    stage2DockScript, stage2Fixture, stage2FixturesOn, stage2MoveTargetPartition, STAGE2_NEVER_HOSTS,
    type EngineConfigProbe, type Stage2DockVerb, type Stage2Status,
} from './stage2.js'

const DOCK_WAIT_MS = Number(process.env.DURATION_STAGE2_DOCK_WAIT_MS ?? 120_000)

export class Stage2FleetOps extends RealFleetOps {
    readonly stage = 2 as const
    private readonly dockScript: string
    private readonly s2hosts: Record<string, string>
    private readonly sleepMs: (ms: number) => Promise<void>
    /** Partition diskId → diskId of the app network-copied onto it (move target occupancy). */
    readonly moveCopies = new Map<string, string>()
    /** Fixtures the harness deliberately left undocked (a reboot re-adds partitions → undock again). */
    readonly heldUndocked = new Set<string>()
    /** engine → last seen boot_id (05:00 / unplanned reboot detection). */
    readonly bootIds = new Map<string, string>()
    /** Log of redock reconciliations (for evidence / tests). */
    readonly redockLog: string[] = []

    constructor(opts: RealFleetOptions & { dockScript?: string; sleep?: (ms: number) => Promise<void> }) {
        for (const n of STAGE2_NEVER_HOSTS) {
            if (opts.poolEngines.includes(n)) throw new Error(`Stage2FleetOps: refuse ${n} in pool`)
        }
        super(opts)
        this.dockScript = opts.dockScript ?? stage2DockScript()
        this.s2hosts = { ...opts.hosts }
        this.sleepMs = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    }

    private s2host(engineId: string): string {
        if ((STAGE2_NEVER_HOSTS as readonly string[]).includes(engineId)) throw new Error(`Stage2FleetOps: refuse ${engineId}`)
        const h = this.s2hosts[engineId]
        if (!h) throw new Error(`Stage2FleetOps: no host for '${engineId}'`)
        return h
    }

    private async rawCall(engineId: string, verb: Stage2DockVerb, args: { diskId?: string; as?: string } = {}) {
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

    /**
     * After any reboot of engineId: real partitions survive and the Engine re-detects them at
     * boot. (1) SSD missing → dock-ssd (whole-SSD). (2) Fixtures the harness held undocked →
     * Engine eject + undock again. (3) Every other home fixture → wait until docked here.
     * A moved copy on the move target comes back too and is left docked (store keeps its diskId).
     */
    async redockAfterBoot(engineId: string, status?: Stage2Status): Promise<void> {
        let st = status ?? await this.stage2Status(engineId)
        const mine = stage2FixturesOn(engineId)
        const missing = mine.filter(f => !st.fixtures.find(x => x.partLabel === f.partLabel)?.present)
        if (missing.length === mine.length && mine.length) {
            this.redockLog.push(`${engineId}: SSD missing after boot → dock-ssd`)
            await this.rawCall(engineId, 'dock-ssd')
            st = await this.stage2Status(engineId)
        }
        if (st.bootId) this.bootIds.set(engineId, st.bootId)
        for (const f of mine) {
            if (this.heldUndocked.has(f.diskId)) {
                this.redockLog.push(`${engineId}: re-undock ${f.diskId}`)
                await super.undockFixtures([engineId], f.diskId)
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
        const deadline = Date.now() + DOCK_WAIT_MS
        let last = 'unread'
        for (;;) {
            try {
                const on = await this.findDockedEngine(diskId)
                last = `dockedTo=${on ?? 'none'}`
                if (on === engineId) return
            } catch (e) { last = e instanceof Error ? e.message : String(e) }
            if (Date.now() >= deadline) throw new Error(`Stage 2: ${diskId} not docked on ${engineId} within ${DOCK_WAIT_MS}ms (${last})`)
            await this.sleepMs(1000)
        }
    }

    /**
     * Stage 2 dock = partition add on the fixture's HOME Pi only. An Empty fixture is always
     * docked FRESH (reset = Stage 1's fresh Empty pack). If the partition holds a moved copy,
     * that copy is ejected first and the app goes back to its home partition (declared gap).
     */
    override async dockFixture(engineId: string, diskId: string): Promise<void> {
        const f = stage2Fixture(diskId)
        const occupant = this.moveCopies.get(diskId)
        const already = occupant ? null : await this.findDockedEngine(diskId)
        if (already === engineId && f.diskTypes?.[0] !== 'empty') return
        if (engineId !== f.host) {
            if (already && already !== engineId) return this.moveDisk(already, engineId, diskId)
            throw new Error(`Stage 2: ${diskId} lives on ${f.host}'s SSD; cannot dock it on ${engineId} (use infra_move_disk = network copy)`)
        }
        this.heldUndocked.delete(diskId)
        if (occupant) {
            console.log(`[duration] stage2: ${diskId} holds moved ${occupant}; ejecting the copy and re-docking ${occupant} at home (Stage 2 gap: post-move state not carried back)`)
            await super.undockFixtures([engineId], occupant)
            await this.dockCall(engineId, 'undock', { diskId })
            this.moveCopies.delete(diskId)
            const home = stage2Fixture(occupant).host
            this.heldUndocked.delete(occupant)
            await this.dockCall(home, 'dock', { diskId: occupant })
            await this.waitDocked(occupant, home)
        } else if (already === engineId) {
            await super.undockFixtures([engineId], diskId)
            await this.dockCall(engineId, 'undock', { diskId })
        }
        if (f.diskTypes?.[0] === 'empty') await this.dockCall(engineId, 'reset', { diskId })
        await this.dockCall(engineId, 'dock', { diskId })
        await this.waitDocked(diskId, engineId)
    }

    /** Engine eject (inherited, WS) first, then remove the partition so a later dock is a real add uevent. */
    override async undockFixtures(engineIds: string[], diskId: string): Promise<void> {
        await super.undockFixtures(engineIds, diskId)
        const f = stage2Fixture(diskId)
        const target = [...this.moveCopies.entries()].find(([, a]) => a === diskId)?.[0]
        if (target) {
            const th = stage2Fixture(target).host
            if (engineIds.includes(th)) { await this.dockCall(th, 'undock', { diskId: target }); this.heldUndocked.add(target) }
            return
        }
        if (engineIds.includes(f.host)) { await this.dockCall(f.host, 'undock', { diskId }); this.heldUndocked.add(diskId) }
    }

    /**
     * Stage 2 move_disk = NETWORK COPY (declared gap, STAGE2_GAPS) into the move target on
     * idea04: Engine eject on the source, `export` | `import` (walker relay, no Pi→Pi keys),
     * dock the target partition. The source partition stays on its Pi, undocked.
     */
    override async moveDisk(fromEngine: string, toEngine: string, diskId: string): Promise<void> {
        if (fromEngine === toEngine) return
        stage2Fixture(diskId)
        const target = stage2MoveTargetPartition(toEngine, diskId)
        if (this.moveCopies.has(target.diskId)) throw new Error(`Stage 2 move_disk: move target ${target.diskId} already holds ${this.moveCopies.get(target.diskId)}`)
        console.log(`[duration] stage2 move_disk ${diskId} ${fromEngine}→${toEngine}: NETWORK COPY into ${target.partLabel} (${target.diskId}) — physical move is a declared Stage 2 gap`)
        await this.checkBoot(fromEngine)
        await this.checkBoot(toEngine)
        await super.undockFixtures([fromEngine], diskId)
        if (await this.findDockedEngine(target.diskId)) {
            await super.undockFixtures([toEngine], target.diskId)
            await this.rawCall(toEngine, 'undock', { diskId: target.diskId })
        }
        await this.rawCall(toEngine, 'reset', { diskId: target.diskId })
        const out = await this.relayPipe(
            this.s2host(fromEngine), buildStage2DockCmd('export', { diskId }, this.dockScript),
            this.s2host(toEngine), buildStage2DockCmd('import', { diskId: target.diskId, as: diskId }, this.dockScript),
        )
        if (!parseStage2DockJson(out, `import@${toEngine}`).ok) throw new Error(`stage2-dock import ${target.diskId} --as ${diskId} on ${toEngine} ok=false`)
        // Source partition leaves the Engine only after the export read it (export mounts it ro itself).
        if (stage2Fixture(diskId).host === fromEngine) { await this.rawCall(fromEngine, 'undock', { diskId }); this.heldUndocked.add(diskId) }
        this.moveCopies.set(target.diskId, diskId)
        this.heldUndocked.delete(target.diskId)
        await this.rawCall(toEngine, 'dock', { diskId: target.diskId })
        await this.waitDocked(diskId, toEngine)
    }
}
