/**
 * Stage 2 duration harness (real SSD per test Pi) — Atlas plan
 * /workspace/duration-evidence/stage2-plan/PLAN.md (2026-10-07, Steve/Koen decided).
 *
 * Switch: DURATION_STAGE=2 (default 1). Stage 1 (loop fixture trees under
 * /home/pi/idea/duration-disks + testMode sentinels) is untouched when the switch is unset.
 *
 * Stage 2 facts this module encodes:
 *  - The Engine only sees partitions 1-2 of an sd disk (udev `sd?|sd?1|sd?2`, validDevice,
 *    sudoers) and mounts ext4 only, under /disks/sd[a-z][12]. So the six Stage 1 fixtures
 *    are rehomed TWO per Pi (STAGE2_FIXTURES), identified by GPT PARTLABEL, never by kname.
 *  - Dock/undock is Atlas's `stage2-dock.sh` on the Pi (contract: STAGE2_DOCK_CONTRACT).
 *    The harness never runs mkfs / unbind / partx itself.
 *  - move_disk stays a NETWORK COPY between Pis; a physical move of the same SSD is a
 *    declared Stage 2 gap (STAGE2_GAPS), reported in duration_start / duration_summary.
 *  - Engine settings pinned explicitly (testMode off ⇒ every skip* set, no defaults).
 *  - idea02 is never a host, never probed.
 */
import { parse as parseYaml } from 'yaml'

export type DurationStage = 1 | 2

/** Exit code: Stage 2 fixture/engine-settings preflight failed (before step 1). */
export const EXIT_STAGE2_PREFLIGHT = 10

export const resolveDurationStage = (env: NodeJS.ProcessEnv = process.env): DurationStage => {
    const raw = env.DURATION_STAGE?.trim()
    if (!raw || raw === '1') return 1
    if (raw === '2') return 2
    throw new Error(`DURATION_STAGE='${raw}' not supported (1 = loop fixtures, 2 = real SSD partitions)`)
}

export const STAGE2_POOL = ['idea01', 'idea03', 'idea04'] as const
export const STAGE2_NEVER_HOSTS = ['idea02'] as const
export const STAGE2_DISKS_ROOT = '/disks'
export const STAGE2_DOCK_SCRIPT_DEFAULT = '/usr/local/sbin/stage2-dock.sh'

export interface Stage2Fixture {
    diskId: string
    /** Home Pi (the only Pi whose SSD carries this partition). */
    host: (typeof STAGE2_POOL)[number]
    partNumber: 1 | 2
    partLabel: string
    fsLabel: string
    /** Exact diskTypes the reset fixture must carry; null = per Stage 1 META, not pinned yet (PLAN §1 [unverified]). */
    diskTypes: string[] | null
    /** Stage 1 slot it replaces (for the evidence table only). */
    stage1Slot: string
}

/** PLAN §1 partition layout — 2 fixtures per Pi, one Prefer A app per Pi. */
export const STAGE2_FIXTURES: readonly Stage2Fixture[] = [
    { diskId: 'duration-kolibri-grade5a-001', host: 'idea01', partNumber: 1, partLabel: 'IDEA-KOLIBRI', fsLabel: 'DUR-KOLIBRI', diskTypes: ['app'], stage1Slot: 'idea-test-1' },
    { diskId: 'duration-add-files-001', host: 'idea01', partNumber: 2, partLabel: 'IDEA-ADDFILES', fsLabel: 'ADDFILES01', diskTypes: ['app'], stage1Slot: 'idea-test-5' },
    { diskId: 'duration-nextcloud-grade5a-001', host: 'idea03', partNumber: 1, partLabel: 'IDEA-NEXTCLOUD', fsLabel: 'DUR-NEXTCLOUD', diskTypes: ['app'], stage1Slot: 'idea-test-2' },
    { diskId: 'duration-empty-001', host: 'idea03', partNumber: 2, partLabel: 'IDEA-EMPTY001', fsLabel: 'DUR-EMPTY001', diskTypes: ['empty'], stage1Slot: 'idea-test-3' },
    { diskId: 'duration-empty-002', host: 'idea04', partNumber: 1, partLabel: 'IDEA-EMPTY002', fsLabel: 'DUR-EMPTY002', diskTypes: ['empty'], stage1Slot: 'idea-test-4' },
    { diskId: 'duration-empty-003', host: 'idea04', partNumber: 2, partLabel: 'IDEA-EMPTY003', fsLabel: 'DUR-EMPTY003', diskTypes: ['empty'], stage1Slot: 'idea-test-6' },
]

export const stage2Fixture = (diskId: string): Stage2Fixture => {
    const f = STAGE2_FIXTURES.find(x => x.diskId === diskId)
    if (!f) throw new Error(`Stage 2: '${diskId}' is not a Stage 2 fixture (${STAGE2_FIXTURES.map(x => x.diskId).join(', ')})`)
    return f
}
export const stage2HomeOf = (diskId: string): string => stage2Fixture(diskId).host
export const stage2FixturesOn = (host: string): Stage2Fixture[] => STAGE2_FIXTURES.filter(f => f.host === host)

/** Static layout sanity (also a unit test): ≤2 partitions per Pi, numbers 1/2 only, unique labels, never idea02. */
export const validateStage2Layout = (fixtures: readonly Stage2Fixture[] = STAGE2_FIXTURES): string[] => {
    const problems: string[] = []
    const seen = new Set<string>()
    for (const f of fixtures) {
        if ((STAGE2_NEVER_HOSTS as readonly string[]).includes(f.host)) problems.push(`${f.diskId} homed on ${f.host} (never)`)
        if (f.partNumber !== 1 && f.partNumber !== 2) problems.push(`${f.diskId} on partition ${f.partNumber} (Engine sees only 1-2)`)
        for (const k of [f.diskId, f.partLabel, f.fsLabel, `${f.host}#${f.partNumber}`]) {
            if (seen.has(k)) problems.push(`duplicate ${k}`)
            seen.add(k)
        }
    }
    for (const h of new Set(fixtures.map(f => f.host))) {
        const n = fixtures.filter(f => f.host === h).length
        if (n > 2) problems.push(`${h} carries ${n} fixtures (max 2 partitions visible to the Engine)`)
    }
    return problems
}

// ── stage2-dock.sh contract ─────────────────────────────────────────────────

/**
 * The CLI the harness ASSUMES Atlas's stage2-dock.sh implements (script not shipped yet).
 * Every call: `sudo -n <script> <verb> [args] --json`, one JSON object on stdout's last line,
 * exit 0 = done, 2 = usage, 3 = refused (safety), 4 = device/timeout, 5 = state mismatch.
 */
export const STAGE2_DOCK_CONTRACT = {
    script: 'path from DURATION_STAGE2_DOCK (default /usr/local/sbin/stage2-dock.sh), run as `sudo -n`',
    verbs: {
        status: '`status --json` → {ok,host,rootDisk,fixtures:[{partLabel,diskId|null,kname|null,parent|null,fsType,fsLabel,mounted:"/disks/sdXN"|null,present}],ugreenDetached:bool,extraSdDisks:[kname]}. Read-only.',
        dock: '`dock <diskId> --json` (partition-level: `partx -a --nr N` of the PARTLABEL\'s partition) → {ok,diskId,kname}. Idempotent when present.',
        undock: '`undock <diskId> --json` (partition-level: refuses while mounted — Engine eject first; `partx -d --nr N`) → {ok,diskId}.',
        'eject-ssd': '`eject-ssd --json` USB unbind of THIS Pi\'s fixture SSD by serial (refuses root disk) → {ok,serial,fixtures:[diskId]}. Both partitions leave.',
        'dock-ssd': '`dock-ssd --json` USB bind by serial → {ok,serial,fixtures:[{diskId,kname}]}.',
        yank: '`yank <diskId> --json` removal WITHOUT umount (dirty-unplug path, idea#126) — only when a walk step asks for it.',
        export: '`export <diskId>` → tar stream (numeric-owner, xattrs) of the mounted partition on stdout. Read-only.',
        import: '`import <targetDiskId> --as <diskId> --json` ← tar on stdin into the (empty) target partition; keeps target fs, writes the source META. Refuses non-empty target.',
    },
    exitCodes: { 0: 'ok', 2: 'usage', 3: 'refused (safety: root disk / idea02 / unknown label)', 4: 'device not found / timeout', 5: 'state mismatch' },
    safety: 'resolve diskId → PARTLABEL → /dev/disk/by-partlabel → kname; refuse parent == PKNAME of findmnt /; hostname/machine-id deny idea02',
} as const

export type Stage2DockVerb = 'status' | 'dock' | 'undock' | 'eject-ssd' | 'dock-ssd' | 'yank' | 'export' | 'import'

const RE_DISK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const RE_SCRIPT = /^\/[A-Za-z0-9._/-]+$/

export const stage2DockScript = (env: NodeJS.ProcessEnv = process.env): string => {
    const s = env.DURATION_STAGE2_DOCK?.trim() || STAGE2_DOCK_SCRIPT_DEFAULT
    if (!RE_SCRIPT.test(s) || s.includes('..')) throw new Error(`Stage 2: refuse dock script path '${s}'`)
    return s
}

/** Remote command line for one contract verb. diskIds must be Stage 2 fixtures. */
export const buildStage2DockCmd = (
    verb: Stage2DockVerb,
    args: { diskId?: string; as?: string } = {},
    script = STAGE2_DOCK_SCRIPT_DEFAULT,
): string => {
    if (!RE_SCRIPT.test(script)) throw new Error(`Stage 2: refuse dock script path '${script}'`)
    const id = (x: string | undefined, what: string): string => {
        if (!x || !RE_DISK_ID.test(x)) throw new Error(`Stage 2: ${verb} needs a valid ${what} (got '${x ?? ''}')`)
        stage2Fixture(x)
        return x
    }
    const base = `sudo -n ${script}`
    switch (verb) {
        case 'status': case 'eject-ssd': case 'dock-ssd': return `${base} ${verb} --json`
        case 'dock': case 'undock': case 'yank': return `${base} ${verb} ${id(args.diskId, 'diskId')} --json`
        case 'export': return `${base} export ${id(args.diskId, 'diskId')}`
        case 'import': return `${base} import ${id(args.diskId, 'target diskId')} --as ${id(args.as, 'source diskId')} --json`
    }
}

export interface Stage2DockResult { ok: boolean; [k: string]: unknown }

/** Last non-empty stdout line must be a JSON object with boolean `ok`. */
export const parseStage2DockJson = (out: string, verb: string): Stage2DockResult => {
    const line = String(out ?? '').split('\n').map(l => l.trim()).filter(Boolean).at(-1)
    if (!line) throw new Error(`stage2-dock ${verb}: no output`)
    let j: unknown
    try { j = JSON.parse(line) } catch { throw new Error(`stage2-dock ${verb}: last line is not JSON: ${line.slice(0, 200)}`) }
    if (!j || typeof j !== 'object' || typeof (j as { ok?: unknown }).ok !== 'boolean') {
        throw new Error(`stage2-dock ${verb}: JSON without boolean ok: ${line.slice(0, 200)}`)
    }
    return j as Stage2DockResult
}

export interface Stage2StatusFixture {
    partLabel: string
    diskId: string | null
    kname: string | null
    parent: string | null
    fsType: string | null
    fsLabel: string | null
    mounted: string | null
    present: boolean
}
export interface Stage2Status {
    ok: boolean
    host: string
    rootDisk: string | null
    fixtures: Stage2StatusFixture[]
    ugreenDetached: boolean
    extraSdDisks: string[]
}

export const parseStage2Status = (out: string): Stage2Status => {
    const j = parseStage2DockJson(out, 'status') as Partial<Stage2Status> & { ok: boolean }
    if (typeof j.host !== 'string' || !Array.isArray(j.fixtures)) throw new Error('stage2-dock status: missing host/fixtures')
    return {
        ok: j.ok, host: j.host, rootDisk: j.rootDisk ?? null,
        fixtures: j.fixtures.map(f => ({
            partLabel: String(f.partLabel), diskId: f.diskId ?? null, kname: f.kname ?? null, parent: f.parent ?? null,
            fsType: f.fsType ?? null, fsLabel: f.fsLabel ?? null, mounted: f.mounted ?? null, present: !!f.present,
        })),
        ugreenDetached: j.ugreenDetached === true,
        extraSdDisks: Array.isArray(j.extraSdDisks) ? j.extraSdDisks.map(String) : [],
    }
}

// ── Engine settings (testMode off, every skip* pinned) ──────────────────────

/** PLAN §5 Stage 2 column. null = must be explicitly set but either value accepted (decision pending). */
export const STAGE2_ENGINE_SETTINGS: Record<string, boolean | string | null> = {
    testMode: false,
    disksRoot: STAGE2_DISKS_ROOT,
    skipImageLoad: false,
    skipMetaWrite: true,
    skipMetaUpdate: true,
    skipHardwareId: true,
    skipBorg: false,
    peerAccess: true,
    mdns: true,
}

/** Check a Pi's config.yaml text (settings:) against the Stage 2 pins; also no static peers. */
export const stage2EngineSettingsProblems = (configYaml: string | null, host: string): string[] => {
    if (!configYaml) return [`${host}: config.yaml unreadable`]
    let settings: Record<string, unknown> = {}
    try { settings = ((parseYaml(configYaml) ?? {}) as { settings?: Record<string, unknown> }).settings ?? {} } catch (e) {
        return [`${host}: config.yaml unparsable (${e instanceof Error ? e.message : String(e)})`]
    }
    const problems: string[] = []
    for (const [k, want] of Object.entries(STAGE2_ENGINE_SETTINGS)) {
        const got = settings[k]
        if (got === undefined) { problems.push(`${host}: settings.${k} not set (Stage 2 pins it explicitly${want === null ? '' : ` = ${JSON.stringify(want)}`})`); continue }
        const norm = typeof got === 'string' ? got.replace(/\/+$/, '') : got
        if (want !== null && norm !== want) problems.push(`${host}: settings.${k} = ${JSON.stringify(got)}, Stage 2 needs ${JSON.stringify(want)}`)
    }
    const sp = settings.staticPeers
    if (sp != null && String(sp).trim() !== '') problems.push(`${host}: settings.staticPeers = ${JSON.stringify(sp)} (Stage 2: none)`)
    return problems
}

// ── Stage 2 preflight verdict (pure) ────────────────────────────────────────

export interface Stage2PreflightInput {
    pool: readonly string[]
    hosts: Record<string, string>
    status: Record<string, Stage2Status | Error>
    configYaml: Record<string, string | null | Error>
    /** Store view from the Console engine: diskId → {dockedTo, diskTypes, instances}. */
    store: Record<string, { dockedTo: string | null; diskTypes: string[]; instances: string[] } | undefined>
}

export interface Stage2PreflightResult { ok: boolean; problems: string[]; table: string[]; message: string }

export const stage2Preflight = (i: Stage2PreflightInput): Stage2PreflightResult => {
    const problems: string[] = [...validateStage2Layout()]
    const table: string[] = []
    for (const never of STAGE2_NEVER_HOSTS) {
        if (i.pool.includes(never) || i.hosts[never]) problems.push(`${never} in pool/hosts — Stage 2 never touches it`)
    }
    const homes = [...new Set(STAGE2_FIXTURES.map(f => f.host))]
    for (const h of homes) if (!i.pool.includes(h)) problems.push(`fixture home ${h} not in pool_engines`)
    for (const h of i.pool) {
        if ((STAGE2_NEVER_HOSTS as readonly string[]).includes(h)) continue
        const cfg = i.configYaml[h]
        problems.push(...(cfg instanceof Error ? [`${h}: config probe failed (${cfg.message})`] : stage2EngineSettingsProblems(cfg ?? null, h)))
        const st = i.status[h]
        if (!st) { problems.push(`${h}: no stage2-dock status`); continue }
        if (st instanceof Error) { problems.push(`${h}: stage2-dock status failed (${st.message})`); continue }
        if (!st.ok) problems.push(`${h}: stage2-dock status ok=false`)
        if (st.host !== h) problems.push(`${h}: stage2-dock reports host '${st.host}'`)
        if (h === 'idea03' && !st.ugreenDetached) problems.push(`idea03: Ugreen hw-roundtrip stick not detached in software (would mount as an App Disk)`)
        if (st.extraSdDisks.length) problems.push(`${h}: unexpected sd disks besides root + fixture SSD: ${st.extraSdDisks.join(', ')}`)
        const mine = stage2FixturesOn(h)
        const parents = new Set<string>()
        for (const f of mine) {
            const s = st.fixtures.find(x => x.partLabel === f.partLabel)
            if (!s || !s.present) { problems.push(`${h}: partition ${f.partLabel} (${f.diskId}) not present`); continue }
            if (s.parent) parents.add(s.parent)
            if (st.rootDisk && s.parent === st.rootDisk) problems.push(`${h}: ${f.partLabel} sits on the ROOT disk ${st.rootDisk} — refusing`)
            if (s.kname && !new RegExp(`^sd[a-z]${f.partNumber}$`).test(s.kname)) problems.push(`${h}: ${f.partLabel} is ${s.kname}, expected partition ${f.partNumber} (Engine sees sdX1/sdX2 only)`)
            if (s.fsType !== 'ext4') problems.push(`${h}: ${f.partLabel} fs ${s.fsType ?? '?'} (Engine mounts ext4 only)`)
            if (s.fsLabel !== f.fsLabel) problems.push(`${h}: ${f.partLabel} FS label ${s.fsLabel ?? '?'}, expected ${f.fsLabel}`)
            if (s.diskId !== f.diskId) problems.push(`${h}: ${f.partLabel} META diskId ${s.diskId ?? 'none'}, expected ${f.diskId}`)
            if (s.mounted && !(s.kname && s.mounted === `${STAGE2_DISKS_ROOT}/${s.kname}`)) problems.push(`${h}: ${f.partLabel} mounted at ${s.mounted}, expected ${STAGE2_DISKS_ROOT}/${s.kname}`)
            const sv = i.store[f.diskId]
            if (!sv) problems.push(`${f.diskId}: not in the store`)
            else {
                if (sv.dockedTo !== h) problems.push(`${f.diskId}: dockedTo=${sv.dockedTo ?? 'none'}, home is ${h}`)
                if (f.diskTypes && JSON.stringify([...sv.diskTypes].sort()) !== JSON.stringify([...f.diskTypes].sort())) {
                    problems.push(`${f.diskId}: diskTypes=[${sv.diskTypes.join(', ')}], reset state is [${f.diskTypes.join(', ')}]`)
                }
                if (f.diskTypes?.[0] === 'empty' && sv.instances.length) problems.push(`${f.diskId}: Empty fixture holds instances ${sv.instances.join(', ')}`)
            }
            table.push(`${h} p${f.partNumber} ${f.partLabel} ${s.kname ?? '?'} ${f.diskId} ${sv?.dockedTo ?? 'undocked'} [${sv?.diskTypes.join(',') ?? ''}]`)
        }
        if (parents.size > 1) problems.push(`${h}: fixture partitions on more than one disk (${[...parents].join(', ')}) — expected ONE SSD`)
    }
    const ok = problems.length === 0
    return { ok, problems, table, message: ok ? `stage2 preflight OK: ${table.join(' | ')}` : `stage2 preflight FAILED: ${problems.join(' | ')}` }
}

// ── Declared Stage 2 gaps (reported, never silently passed) ─────────────────

export interface Stage2Gap { action: string; semantics: string; reason: string }

export const STAGE2_GAPS: readonly Stage2Gap[] = [
    {
        action: 'infra_move_disk',
        semantics: 'network copy: source partition exported (stage2-dock.sh export) and imported into an Empty partition on the target Pi; the SSD itself never changes hosts',
        reason: 'no hands to move a real SSD between Pis (PLAN §3 / D7); physical move = Stage 3 (USB switch)',
    },
]

/** Steps of the walk whose semantics change under Stage 2 → notCovered-style list for duration_start/summary. */
export const stage2NotCovered = (steps: readonly { action: string }[]): { step: number; action: string; semantics: string }[] =>
    steps.flatMap((s, i) => {
        const g = STAGE2_GAPS.find(x => x.action === s.action)
        return g ? [{ step: i + 1, action: s.action, semantics: g.semantics }] : []
    })

export const stage2SummaryFields = (steps: readonly { action: string }[] | null) => ({
    stage: 2 as const,
    stage2Gaps: STAGE2_GAPS.map(g => ({ ...g })),
    stage2NotCovered: steps ? stage2NotCovered(steps) : [],
})

/**
 * Network-copy target for a move: the Empty fixture homed on the target Pi.
 * OPEN (Atlas/Steve): this consumes that Pi's Empty partition, which also has a walk role
 * (files/backup/erase) — see STAGE2.md open questions.
 */
export const stage2MoveTargetPartition = (toHost: string, sourceDiskId: string): Stage2Fixture => {
    const c = stage2FixturesOn(toHost).filter(f => f.diskTypes?.[0] === 'empty' && f.diskId !== sourceDiskId)
    if (!c.length) throw new Error(`Stage 2 move_disk: ${toHost} has no Empty partition to receive ${sourceDiskId} (network copy needs one)`)
    return c[c.length - 1]!
}
