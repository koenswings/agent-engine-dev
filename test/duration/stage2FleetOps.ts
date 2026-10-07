/**
 * Stage 2 live ops: RealFleetOps with fixture dock/undock/move routed through Atlas's
 * stage2-dock.sh (contract in stage2.ts). Everything else (WS store, reboot, probes, Console
 * deploy) is inherited unchanged. Selected by DURATION_STAGE=2 in cli.ts.
 */
import { RealFleetOps, type RealFleetOptions } from './realFleetOps.js'
import {
    buildStage2DockCmd, parseStage2DockJson, parseStage2Status, stage2DockScript, stage2Fixture,
    stage2MoveTargetPartition, STAGE2_NEVER_HOSTS, type Stage2DockVerb, type Stage2Status,
} from './stage2.js'

const DOCK_WAIT_MS = Number(process.env.DURATION_STAGE2_DOCK_WAIT_MS ?? 120_000)

export class Stage2FleetOps extends RealFleetOps {
    readonly stage = 2 as const
    private readonly dockScript: string
    private readonly s2hosts: Record<string, string>
    private readonly sleepMs: (ms: number) => Promise<void>

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

    private async dockCall(engineId: string, verb: Stage2DockVerb, args: { diskId?: string; as?: string } = {}) {
        const out = await this.ssh(this.s2host(engineId), buildStage2DockCmd(verb, args, this.dockScript))
        const r = parseStage2DockJson(out, `${verb}@${engineId}`)
        if (!r.ok) throw new Error(`stage2-dock ${verb} ${args.diskId ?? ''} on ${engineId} returned ok=false: ${JSON.stringify(r).slice(0, 300)}`)
        return r
    }

    async stage2Status(engineId: string): Promise<Stage2Status> {
        return parseStage2Status(await this.ssh(this.s2host(engineId), buildStage2DockCmd('status', {}, this.dockScript)))
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

    /** Stage 2 dock = partition add on the fixture's HOME Pi only; the real Engine mounts it. */
    override async dockFixture(engineId: string, diskId: string): Promise<void> {
        const f = stage2Fixture(diskId)
        const already = await this.findDockedEngine(diskId)
        if (already === engineId) return
        if (engineId !== f.host) {
            if (already && already !== engineId) return this.moveDisk(already, engineId, diskId)
            throw new Error(`Stage 2: ${diskId} lives on ${f.host}'s SSD; cannot dock it on ${engineId} (use infra_move_disk = network copy)`)
        }
        await this.dockCall(engineId, 'dock', { diskId })
        await this.waitDocked(diskId, engineId)
    }

    /** Engine eject (inherited, WS) first, then remove the partition so a later dock is a real add uevent. */
    override async undockFixtures(engineIds: string[], diskId: string): Promise<void> {
        await super.undockFixtures(engineIds, diskId)
        const f = stage2Fixture(diskId)
        if (engineIds.includes(f.host)) await this.dockCall(f.host, 'undock', { diskId })
    }

    /**
     * Stage 2 move_disk = NETWORK COPY (declared gap, STAGE2_GAPS): Engine eject on the source,
     * `export` tar | `import` into the target Pi's Empty partition (walker relay, no Pi→Pi keys),
     * then dock that partition on the target. The source SSD partition stays on its Pi.
     */
    override async moveDisk(fromEngine: string, toEngine: string, diskId: string): Promise<void> {
        if (fromEngine === toEngine) return
        stage2Fixture(diskId)
        const target = stage2MoveTargetPartition(toEngine, diskId)
        console.log(`[duration] stage2 move_disk ${diskId} ${fromEngine}→${toEngine}: NETWORK COPY into ${target.partLabel} (${target.diskId}) — physical move is a declared Stage 2 gap`)
        await super.undockFixtures([fromEngine], diskId)
        await this.relayPipe(
            this.s2host(fromEngine), buildStage2DockCmd('export', { diskId }, this.dockScript),
            this.s2host(toEngine), buildStage2DockCmd('import', { diskId: target.diskId, as: diskId }, this.dockScript),
        ).then(out => {
            const r = parseStage2DockJson(out, `import@${toEngine}`)
            if (!r.ok) throw new Error(`stage2-dock import ${target.diskId} --as ${diskId} on ${toEngine} ok=false`)
        })
        await this.dockCall(toEngine, 'dock', { diskId: target.diskId })
        await this.waitDocked(diskId, toEngine)
    }
}
