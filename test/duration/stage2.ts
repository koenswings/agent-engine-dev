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
    /** Which fixture SSD on that Pi (1 = first, 2 = idea04's second SSD). ≤2 partitions per SSD. */
    ssd: 1 | 2
    /** false = kept out of the Engine (partition removed); only the spare. */
    expectDocked?: boolean
    /** Free-text role, for the evidence table. */
    role: string
    partLabel: string
    fsLabel: string
    /** Exact diskTypes the reset fixture must carry; null = per Stage 1 META, not pinned yet (PLAN §1 [unverified]). */
    diskTypes: string[] | null
    /** Stage 1 slot it replaces (for the evidence table only). */
    stage1Slot: string
}

/** PLAN §1 partition layout — 2 fixtures per Pi, one Prefer A app per Pi. */
export const STAGE2_FIXTURES: readonly Stage2Fixture[] = [
    { diskId: 'duration-kolibri-grade5a-001', host: 'idea01', ssd: 1, partNumber: 1, partLabel: 'IDEA-KOLIBRI', fsLabel: 'DUR-KOLIBRI', diskTypes: ['app'], stage1Slot: 'idea-test-1', role: 'Prefer A app, move source' },
    { diskId: 'duration-add-files-001', host: 'idea01', ssd: 1, partNumber: 2, partLabel: 'IDEA-ADDFILES', fsLabel: 'ADDFILES01', diskTypes: ['app'], stage1Slot: 'idea-test-5', role: 'add_files_role (app only)' },
    // Nextcloud seed carries FILES.yaml + files/ → the Engine derives [app, files] (Atlas AXLE-ANSWERS §3; seed kept).
    { diskId: 'duration-nextcloud-grade5a-001', host: 'idea03', ssd: 1, partNumber: 1, partLabel: 'IDEA-NEXTCLOUD', fsLabel: 'DUR-NEXTCLOUD', diskTypes: ['app', 'files'], stage1Slot: 'idea-test-2', role: 'Prefer A app' },
    { diskId: 'duration-empty-001', host: 'idea03', ssd: 1, partNumber: 2, partLabel: 'IDEA-EMPTY001', fsLabel: 'DUR-EMPTY001', diskTypes: ['empty'], stage1Slot: 'idea-test-3', role: 'Files' },
    { diskId: 'duration-empty-002', host: 'idea04', ssd: 1, partNumber: 1, partLabel: 'IDEA-EMPTY002', fsLabel: 'DUR-EMPTY002', diskTypes: ['empty'], stage1Slot: 'idea-test-4', role: 'Erase + late installs' },
    { diskId: 'duration-empty-003', host: 'idea04', ssd: 1, partNumber: 2, partLabel: 'IDEA-EMPTY003', fsLabel: 'DUR-EMPTY003', diskTypes: ['empty'], stage1Slot: 'idea-test-6', role: 'Backup' },
    // idea04 SSD2 (Steve option a): dedicated move target + spare. Ids stay duration-empty-* (stage2-dock.sh reset accepts only those).
    { diskId: 'duration-empty-004', host: 'idea04', ssd: 2, partNumber: 1, partLabel: 'IDEA-MOVE001', fsLabel: 'DUR-MOVE001', diskTypes: ['empty'], stage1Slot: '(new)', role: 'move target (infra_move_disk)' },
    { diskId: 'duration-empty-005', host: 'idea04', ssd: 2, partNumber: 2, partLabel: 'IDEA-SPARE001', fsLabel: 'DUR-SPARE001', diskTypes: ['empty'], stage1Slot: '(new)', role: 'spare (kept out of the Engine)', expectDocked: false },
]

export const stage2Fixture = (diskId: string): Stage2Fixture => {
    const f = STAGE2_FIXTURES.find(x => x.diskId === diskId)
    if (!f) throw new Error(`Stage 2: '${diskId}' is not a Stage 2 fixture (${STAGE2_FIXTURES.map(x => x.diskId).join(', ')})`)
    return f
}
export const stage2HomeOf = (diskId: string): string => stage2Fixture(diskId).host
export const stage2FixturesOn = (host: string): Stage2Fixture[] => STAGE2_FIXTURES.filter(f => f.host === host)

/** Static layout sanity: ≤2 partitions (1/2) per SSD, several SSDs per Pi allowed, unique labels, never idea02. */
export const validateStage2Layout = (fixtures: readonly Stage2Fixture[] = STAGE2_FIXTURES): string[] => {
    const problems: string[] = []
    const seen = new Set<string>()
    for (const f of fixtures) {
        if ((STAGE2_NEVER_HOSTS as readonly string[]).includes(f.host)) problems.push(`${f.diskId} homed on ${f.host} (never)`)
        if (f.partNumber !== 1 && f.partNumber !== 2) problems.push(`${f.diskId} on partition ${f.partNumber} (Engine sees only 1-2)`)
        for (const k of [f.diskId, f.partLabel, f.fsLabel, `${f.host}#ssd${f.ssd}#p${f.partNumber}`]) {
            if (seen.has(k)) problems.push(`duplicate ${k}`)
            seen.add(k)
        }
    }
    for (const key of new Set(fixtures.map(f => `${f.host} SSD${f.ssd}`))) {
        const n = fixtures.filter(f => `${f.host} SSD${f.ssd}` === key).length
        if (n > 2) problems.push(`${key} carries ${n} fixtures (max 2 partitions per SSD visible to the Engine)`)
    }
    return problems
}
export const stage2SsdsOn = (host: string): (1 | 2)[] => [...new Set(stage2FixturesOn(host).map(f => f.ssd))].sort()

// ── stage2-dock.sh contract ─────────────────────────────────────────────────

/**
 * The CLI the harness ASSUMES Atlas's stage2-dock.sh implements (script not shipped yet).
 * Every call: `sudo -n <script> <verb> [args] --json`, one JSON object on stdout's last line,
 * exit 0 = done, 2 = usage, 3 = refused (safety), 4 = device/timeout, 5 = state mismatch.
 */
export const STAGE2_DOCK_CONTRACT = {
    script: 'path from DURATION_STAGE2_DOCK (default /usr/local/sbin/stage2-dock.sh), run as `sudo -n`',
    verbs: {
        status: '`status --json` → {ok,host,bootId,rootDisk,ssds:[{kname,serial,model}] (every fixture SSD),fixtures:[{partLabel,diskId|null,kname|null,parent|null,fsType,fsLabel,mounted:"/disks/sdXN"|null,present}],ugreenDetached:bool,extraSdDisks:[kname]}. Read-only.',
        dock: '`dock <diskId> --json` partition-level. Mounted (Engine-docked) → {ok,already:true}; present+unmounted → partx -d then -a (real add uevent, cycled:true); absent → partx -a → {ok,diskId,kname,already:false}.',
        undock: '`undock <diskId> --json` (partition-level: refuses while mounted — Engine eject first; `partx -d --nr N`) → {ok,diskId}.',
        'eject-ssd': '`eject-ssd --ssd <diskId> --json` USB unbind of the fixture SSD that carries <diskId> (by its serial; refuses root disk / Ugreen) → {ok,serial,port,fixtures:[diskId of THAT SSD]}. Both its partitions leave; the Pi\'s other SSD stays.',
        'dock-ssd': '`dock-ssd --ssd <diskId> --json` USB bind of that SSD\'s recorded port (state per serial) → {ok,serial,fixtures:[{diskId,kname}] of THAT SSD}.',
        reset: '`reset <diskId> --json` Empty fixtures only: refuses while mounted; re-mkfs.ext4 -L <fsLabel> (same PARTLABEL) + META.yaml {diskId, diskTypes:[empty]}, root pi:pi 0755 → {ok,diskId}. Stage 2 equivalent of the Stage 1 "fresh Empty pack".',
        yank: '`yank <diskId> --json` removal WITHOUT umount (dirty-unplug path, idea#126) — only when a walk step asks for it.',
        export: '`export <diskId>` → tar stream (numeric-owner, xattrs) on stdout of the partition AFTER Engine eject: script mounts it read-only at a private path (never /disks), tars, unmounts. Refuses while the Engine has it mounted.',
        import: '`import <targetDiskId> --as <diskId> --json` ← tar on stdin into the (empty) target partition; keeps target fs, writes the source META. Refuses non-empty target.',
    },
    exitCodes: { 0: 'ok', 2: 'usage', 3: 'refused (safety: root disk / idea02 / unknown label)', 4: 'device not found / timeout', 5: 'state mismatch' },
    safety: 'resolve diskId → PARTLABEL → /dev/disk/by-partlabel → kname; refuse parent == PKNAME of findmnt /; hostname/machine-id deny idea02',
} as const

export type Stage2DockVerb = 'status' | 'dock' | 'undock' | 'reset' | 'eject-ssd' | 'dock-ssd' | 'yank' | 'export' | 'import'

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
        case 'status': return `${base} status --json`
        case 'eject-ssd': case 'dock-ssd': return `${base} ${verb} --ssd ${id(args.diskId, 'fixture diskId (selects the SSD)')} --json`
        case 'dock': case 'undock': case 'reset': case 'yank': return `${base} ${verb} ${id(args.diskId, 'diskId')} --json`
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
    /** /proc/sys/kernel/random/boot_id — changes on every reboot (planned or 05:00). */
    bootId: string | null
    rootDisk: string | null
    /** Fixture SSDs (model drives the D4 hardware-id check); [] when the script does not report them. */
    ssds: { kname: string; serial: string | null; model: string | null }[]
    fixtures: Stage2StatusFixture[]
    ugreenDetached: boolean
    extraSdDisks: string[]
}

export const parseStage2Status = (out: string): Stage2Status => {
    const j = parseStage2DockJson(out, 'status') as Partial<Stage2Status> & { ok: boolean }
    if (typeof j.host !== 'string' || !Array.isArray(j.fixtures)) throw new Error('stage2-dock status: missing host/fixtures')
    return {
        ok: j.ok, host: j.host, bootId: typeof j.bootId === 'string' ? j.bootId : null, rootDisk: j.rootDisk ?? null,
        fixtures: j.fixtures.map(f => ({
            partLabel: String(f.partLabel), diskId: f.diskId ?? null, kname: f.kname ?? null, parent: f.parent ?? null,
            fsType: f.fsType ?? null, fsLabel: f.fsLabel ?? null, mounted: f.mounted ?? null, present: !!f.present,
        })),
        ssds: Array.isArray(j.ssds) ? j.ssds.map(x => ({ kname: String(x.kname), serial: x.serial ?? null, model: x.model ?? null })) : [],
        ugreenDetached: j.ugreenDetached === true,
        extraSdDisks: Array.isArray(j.extraSdDisks) ? j.extraSdDisks.map(String) : [],
    }
}

// ── Engine settings = PRODUCTION (golden idea02, read-only 2026-10-07) ────────

/**
 * Source of truth for Stage 2 Engine settings is production, read the way production reads
 * it: `<engineDir>/config.yaml` settings + the IDEA_* env of the running Engine process
 * (pm2 `engine`, pm2.config.cjs). Golden idea02 @745f2c3 (read-only ssh cat + pm2 jlist):
 * config.yaml settings = {mdns: true, isDev: false, testMode: false, port, httpPort,
 * consolePath, storeDataFolder, storeIdentityFolder, heartbeatIntervalMs}; NO disksRoot /
 * skip* / peerAccess / staticPeers keys; pm2 env has NO IDEA_* variables. So production
 * runs every disk gate on its Config.ts default. Stage 2 Pis must match that: same keys
 * unset, no IDEA_* override env (no test-only env), and the EFFECTIVE values below
 * (computed with Config.ts's own default rules).
 */
export const PRODUCTION_ENGINE_DIR = '/home/pi/idea/agents/agent-engine-dev'

/** IDEA_* that change an effective setting (Config.ts). None may be set on a Stage 2 Engine. */
export const SETTING_OVERRIDE_ENV = [
    'IDEA_TEST_MODE', 'IDEA_DISKS_ROOT', 'IDEA_WATCH_DIR', 'IDEA_SKIP_IMAGE_LOAD', 'IDEA_SKIP_META_WRITE',
    'IDEA_SKIP_BORG', 'IDEA_SKIP_HARDWARE_ID', 'IDEA_SKIP_META_UPDATE', 'IDEA_MDNS_DISABLE', 'IDEA_STATIC_PEERS',
    'IDEA_SYSTEM_DISK_SKIP', 'IDEA_DOCKER_AVAILABLE', 'IDEA_STORE_DIR',
] as const

export interface EffectiveEngineSettings {
    testMode: boolean; isDev: boolean; mdns: boolean; disksRoot: string; staticPeers: string | null
    skipImageLoad: boolean; skipMetaWrite: boolean; skipBorg: boolean; skipHardwareId: boolean; skipMetaUpdate: boolean; peerAccess: boolean
}

/** Same default rules as src/data/Config.ts (skip* ← testMode; hwId/metaUpdate ← isDev||testMode; peerAccess ← !(isDev||testMode)). */
export const effectiveEngineSettings = (settings: Record<string, unknown>, env: Record<string, string> = {}): EffectiveEngineSettings => {
    const b = (k: string): boolean | undefined => (typeof settings[k] === 'boolean' ? (settings[k] as boolean) : undefined)
    const eb = (k: string): boolean | undefined => (env[k] === 'true' ? true : env[k] === 'false' ? false : undefined)
    const testMode = env.IDEA_TEST_MODE === 'true' ? true : b('testMode') ?? false
    const isDev = b('isDev') ?? false
    const devOrTest = isDev || testMode
    const sp = env.IDEA_STATIC_PEERS ?? (settings.staticPeers == null ? null : String(settings.staticPeers))
    return {
        testMode, isDev,
        mdns: b('mdns') === true && env.IDEA_MDNS_DISABLE !== 'true',
        disksRoot: (env.IDEA_DISKS_ROOT || (typeof settings.disksRoot === 'string' && settings.disksRoot) || STAGE2_DISKS_ROOT).replace(/\/+$/, '') || '/',
        staticPeers: sp && sp.trim() ? sp : null,
        skipImageLoad: eb('IDEA_SKIP_IMAGE_LOAD') ?? b('skipImageLoad') ?? testMode,
        skipMetaWrite: eb('IDEA_SKIP_META_WRITE') ?? b('skipMetaWrite') ?? testMode,
        skipBorg: eb('IDEA_SKIP_BORG') ?? b('skipBorg') ?? testMode,
        skipHardwareId: eb('IDEA_SKIP_HARDWARE_ID') ?? b('skipHardwareId') ?? devOrTest,
        skipMetaUpdate: eb('IDEA_SKIP_META_UPDATE') ?? b('skipMetaUpdate') ?? devOrTest,
        peerAccess: b('peerAccess') ?? !devOrTest,
    }
}

/** Golden idea02's effective settings (all defaults). skipHardwareId: not enforced until D4 (SSD model). */
export const PRODUCTION_EFFECTIVE: EffectiveEngineSettings = effectiveEngineSettings({ mdns: true, isDev: false, testMode: false })
export const NOT_ENFORCED_PENDING: Partial<Record<keyof EffectiveEngineSettings, string>> = {
    skipHardwareId: 'D4 (SSD model/size): Intenso/Samsung FIT serial may replace the META diskId and collide across 2 partitions',
}
/** config.yaml settings keys production does NOT set (must stay unset so defaults apply). */
export const PRODUCTION_UNSET_KEYS = ['disksRoot', 'skipImageLoad', 'skipMetaWrite', 'skipBorg', 'skipMetaUpdate', 'peerAccess', 'staticPeers', 'watchDir'] as const

/** Read-only remote probe: config.yaml + pm2.config.cjs + IDEA_* of the running Engine (same sources production uses). */
export const buildEngineConfigProbe = (engineDir = PRODUCTION_ENGINE_DIR): string => [
    `d='${engineDir}'`,
    `echo '@@S2 config'; cat "$d/config.yaml" 2>/dev/null || echo '@@S2_MISSING'`,
    `echo '@@S2 env'`,
    `pid=$(pgrep -f "$d/dist/src/index.js" | head -1); echo "pid=\${pid:-none}"`,
    `if [ -n "$pid" ]; then if sudo -n true 2>/dev/null; then S='sudo -n'; else S=''; fi; ` +
        `$S cat /proc/$pid/environ 2>/dev/null | tr '\\0' '\\n' | grep -E '^IDEA_' | sed 's/^/env:/' ; fi`,
    `echo '@@S2 end'`,
].join('; ')

export interface EngineConfigProbe { configYaml: string | null; pid: string | null; env: Record<string, string> }
export const parseEngineConfigProbe = (out: string): EngineConfigProbe => {
    let cur = ''; const cfg: string[] = []; const env: Record<string, string> = {}; let pid: string | null = null; let missing = false
    for (const line of String(out ?? '').split('\n')) {
        const m = /^@@S2 (\w+)$/.exec(line.trim())
        if (m) { cur = m[1]!; continue }
        if (cur === 'config') { if (line.trim() === '@@S2_MISSING') missing = true; else cfg.push(line) }
        if (cur === 'env') {
            const p = /^pid=(.*)$/.exec(line.trim()); if (p) pid = p[1] === 'none' ? null : p[1]!
            const e = /^env:(IDEA_[A-Z0-9_]+)=(.*)$/.exec(line); if (e) env[e[1]!] = e[2]!
        }
    }
    return { configYaml: missing ? null : cfg.join('\n'), pid, env }
}

/** Stage 2 Pi vs production: same effective settings, production-unset keys unset, no IDEA_* overrides, Engine running. */
export const stage2EngineSettingsProblems = (probe: EngineConfigProbe | string | null, host: string): string[] => {
    const pr: EngineConfigProbe = typeof probe === 'string' || probe === null ? { configYaml: probe, pid: 'n/a', env: {} } : probe
    if (!pr.configYaml) return [`${host}: ${PRODUCTION_ENGINE_DIR}/config.yaml unreadable`]
    let settings: Record<string, unknown> = {}
    try { settings = ((parseYaml(pr.configYaml) ?? {}) as { settings?: Record<string, unknown> }).settings ?? {} } catch (e) {
        return [`${host}: config.yaml unparsable (${e instanceof Error ? e.message : String(e)})`]
    }
    const problems: string[] = []
    if (pr.pid === null) problems.push(`${host}: no running Engine (${PRODUCTION_ENGINE_DIR}/dist/src/index.js)`)
    for (const k of SETTING_OVERRIDE_ENV) if (pr.env[k] !== undefined) problems.push(`${host}: Engine env ${k}=${pr.env[k]} (production sets no IDEA_* override; no test-only env)`)
    for (const k of PRODUCTION_UNSET_KEYS) if (settings[k] !== undefined) problems.push(`${host}: settings.${k} = ${JSON.stringify(settings[k])} (production leaves it unset → default)`)
    const eff = effectiveEngineSettings(settings, pr.env)
    for (const k of Object.keys(PRODUCTION_EFFECTIVE) as (keyof EffectiveEngineSettings)[]) {
        if (NOT_ENFORCED_PENDING[k]) continue
        if (eff[k] !== PRODUCTION_EFFECTIVE[k]) problems.push(`${host}: effective ${k} = ${JSON.stringify(eff[k])}, production = ${JSON.stringify(PRODUCTION_EFFECTIVE[k])}`)
    }
    return problems
}

/** readHardwareId special-cases these models (src: Intenso + Samsung FIT). */
export const HWID_MODELS = /intenso|samsung.*fit|\bfit\b/i
const effectiveFromProbe = (p: EngineConfigProbe | string): EffectiveEngineSettings | null => {
    const text = typeof p === 'string' ? p : p.configYaml
    if (!text) return null
    try {
        const settings = ((parseYaml(text) ?? {}) as { settings?: Record<string, unknown> }).settings ?? {}
        return effectiveEngineSettings(settings, typeof p === 'string' ? {} : p.env)
    } catch { return null }
}

// ── Role map + move target (Steve 2026-10-07) ───────────────────────────────

/**
 * Files = empty-001 (idea03). Erase = empty-002, Backup = empty-003 (idea04 SSD1).
 * move_disk target = empty-004 on idea04 SSD2 (Steve option a), never a role disk; empty-005 = spare.
 */
export const STAGE2_MOVE_TARGET_HOST = 'idea04'
export const STAGE2_MOVE_TARGET_ID = 'duration-empty-004'
export const STAGE2_SPARE_ID = 'duration-empty-005'
export const STAGE2_ROLE_MAP = {
    files: 'duration-empty-001',
    backup: 'duration-empty-003',
    erase: 'duration-empty-002',
} as const
export const stage2MoveTargetId = (): string => STAGE2_MOVE_TARGET_ID

/** Steps that need each role disk Empty / its role (fixtureDisks ROLE_CONSUMERS + later users). */
const ROLE_USERS: Record<keyof typeof STAGE2_ROLE_MAP, readonly string[]> = {
    files: ['install_app', 'make_files_disk'],
    backup: ['make_backup_disk', 'backup_instance', 'restore_from_backup'],
    erase: ['erase_disk'],
}
/** Steps that need the MOVED app disk (Kolibri) live after infra_move_disk. */
const MOVED_APP_USERS = ['open_kolibri_as_teacher', 'open_kolibri_as_learner', 'backup_instance', 'restore_from_backup']

export interface Stage2Conflict { role: string; diskId: string; moveStep: number; roleStep: number; action: string; heldUntil: number }

/**
 * After infra_move_disk@N the move target partition holds the moved app until the last step
 * that still needs that app. Any role step on the same partition inside [N, lastNeed] is a
 * conflict. Install_app steps on the erase disk (the late installs) count as erase-role use.
 */
export const stage2RoleTimeline = (steps: readonly { action: string }[], target: string = STAGE2_MOVE_TARGET_ID): Stage2Conflict[] => {
    const role = (Object.entries(STAGE2_ROLE_MAP).find(([, id]) => id === target)?.[0] ?? null) as keyof typeof STAGE2_ROLE_MAP | null
    const out: Stage2Conflict[] = []
    steps.forEach((s, i) => {
        if (s.action !== 'infra_move_disk') return
        const moveStep = i + 1
        let heldUntil = moveStep
        steps.forEach((t, j) => { if (j > i && MOVED_APP_USERS.includes(t.action)) heldUntil = j + 1 })
        if (!role) return
        const firstFiles = steps.findIndex(x => x.action === 'make_files_disk')
        steps.forEach((t, j) => {
            const n = j + 1
            if (n <= moveStep || n > heldUntil) return
            const lateInstall = role === 'erase' && t.action === 'install_app' && firstFiles >= 0 && j > firstFiles
            if (ROLE_USERS[role].includes(t.action) || lateInstall) out.push({ role, diskId: target, moveStep, roleStep: n, action: t.action, heldUntil })
        })
    })
    return out
}

export const describeStage2Conflicts = (c: Stage2Conflict[]): string =>
    c.length
        ? `move target ${c[0]!.diskId} (${c[0]!.role} role) holds the moved app from infra_move_disk@${c[0]!.moveStep} ` +
          `until @${c[0]!.heldUntil}, but the ${c[0]!.role} role needs it at ${c.map(x => `@${x.roleStep} ${x.action}`).join(', ')} — ` +
          `the move target must not be a role disk`
        : 'move target fits'

// ── Stage 2 preflight verdict (pure) ────────────────────────────────────────

export interface Stage2PreflightInput {
    pool: readonly string[]
    hosts: Record<string, string>
    status: Record<string, Stage2Status | Error>
    configYaml: Record<string, EngineConfigProbe | string | null | Error>
    /** Walk steps this run executes (role/move-target timeline). */
    steps?: readonly { action: string }[]
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
        const parentOfSsd = new Map<number, Set<string>>()
        for (const f of mine) {
            const s = st.fixtures.find(x => x.partLabel === f.partLabel)
            if (f.expectDocked === false) {
                if (i.store[f.diskId]?.dockedTo) problems.push(`${f.diskId} (spare) is docked on ${i.store[f.diskId]!.dockedTo} — keep it out of the Engine`)
                if (s?.present && s.mounted) problems.push(`${h}: spare ${f.partLabel} mounted at ${s.mounted}`)
                if (s?.parent) parentOfSsd.set(f.ssd, new Set([...(parentOfSsd.get(f.ssd) ?? []), s.parent]))
                table.push(`${h} ssd${f.ssd} p${f.partNumber} ${f.partLabel} ${f.diskId} (spare, not docked)`)
                continue
            }
            if (!s || !s.present) { problems.push(`${h}: partition ${f.partLabel} (${f.diskId}) not present`); continue }
            if (s.parent) parentOfSsd.set(f.ssd, new Set([...(parentOfSsd.get(f.ssd) ?? []), s.parent]))
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
            table.push(`${h} ssd${f.ssd} p${f.partNumber} ${f.partLabel} ${s.kname ?? '?'} ${f.diskId} ${sv?.dockedTo ?? 'undocked'} [${sv?.diskTypes.join(',') ?? ''}]`)
        }
        const ssdParents: string[] = []
        for (const [n, ps] of parentOfSsd) {
            if (ps.size > 1) problems.push(`${h}: SSD${n} fixtures sit on more than one disk (${[...ps].join(', ')}) — ≤2 partitions of ONE SSD`)
            ssdParents.push(...ps)
        }
        if (new Set(ssdParents).size !== ssdParents.length) problems.push(`${h}: two fixture SSDs resolve to the same disk (${ssdParents.join(', ')})`)
        // D4: hardware-id collision. With skipHardwareId off, readHardwareId gives Intenso / Samsung FIT
        // disks the SCSI serial as diskId — the SAME id for both partitions of one SSD.
        const eff = cfg instanceof Error || !cfg ? null : effectiveFromProbe(cfg)
        for (const d of st.ssds) {
            if (d.model && HWID_MODELS.test(d.model) && eff && !eff.skipHardwareId) {
                problems.push(`${h}: D4 hw-id collision risk — SSD ${d.kname} model '${d.model}' is Intenso/Samsung FIT and effective skipHardwareId=false: both partitions would get diskId = serial ${d.serial ?? '?'}`)
            }
        }
    }
    // D4: no two fixture partitions may resolve to one diskId (META / hardware id), on any Pi.
    const byId = new Map<string, string[]>()
    for (const h of i.pool) {
        const st = i.status[h]
        if (!st || st instanceof Error) continue
        for (const x of st.fixtures) if (x.present && x.diskId) byId.set(x.diskId, [...(byId.get(x.diskId) ?? []), `${h}:${x.partLabel}`])
    }
    for (const [id, where] of byId) if (where.length > 1) problems.push(`D4: diskId ${id} resolves for ${where.length} partitions (${where.join(', ')}) — hardware-id/META collision`)
    if (i.steps) {
        const c = stage2RoleTimeline(i.steps)
        if (c.length) problems.push(describeStage2Conflicts(c))
    }
    const ok = problems.length === 0
    return { ok, problems, table, message: ok ? `stage2 preflight OK: ${table.join(' | ')}` : `stage2 preflight FAILED: ${problems.join(' | ')}` }
}

// ── Declared Stage 2 gaps (reported, never silently passed) ─────────────────

export interface Stage2Gap { action: string; semantics: string; reason: string }

export const STAGE2_GAPS: readonly Stage2Gap[] = [
    {
        action: 'infra_move_disk',
        semantics: 'network copy: source partition exported (stage2-dock.sh export) and imported into the dedicated move target duration-empty-004 (idea04 SSD2 p1); the SSD itself never changes hosts',
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

/** Network-copy target for a move: always the configured Empty on idea04 (Steve), never the source. */
export const stage2MoveTargetPartition = (toHost: string, sourceDiskId: string): Stage2Fixture => {
    if (toHost !== STAGE2_MOVE_TARGET_HOST) throw new Error(`Stage 2 move_disk: target must be ${STAGE2_MOVE_TARGET_HOST} (got ${toHost}); ${sourceDiskId} cannot be network-copied elsewhere`)
    const f = stage2Fixture(STAGE2_MOVE_TARGET_ID)
    if (f.diskId === sourceDiskId) throw new Error(`Stage 2 move_disk: ${sourceDiskId} is the move target itself`)
    return f
}

/**
 * Dock split (Steve): partition-level verbs for per-disk steps; whole-SSD verbs only for
 * yank / reboot-type steps.
 */
export const STAGE2_DOCK_SPLIT: Record<string, { level: 'partition' | 'ssd' | 'none'; verbs: string }> = {
    infra_dock_fixture: { level: 'partition', verbs: 'dock (each fixture on its home Pi)' },
    infra_undock_fixtures: { level: 'partition', verbs: 'Engine eject → undock' },
    enter_infra_fleet_walk: { level: 'partition', verbs: 'Engine eject → undock (unless preserveDockedOnReturn)' },
    return_to_start: { level: 'partition', verbs: 'Engine eject → undock (unless preserveDockedOnReturn)' },
    infra_move_disk: { level: 'partition', verbs: 'Engine eject source + move target → reset target → export | import → undock source → dock target' },
    install_app: { level: 'partition', verbs: 'empty-002 fresh: Engine eject → reset → dock (re-add cycle)' },
    make_files_disk: { level: 'partition', verbs: 'empty-001 fresh: Engine eject → reset → dock (re-add cycle)' },
    erase_disk: { level: 'partition', verbs: 'empty-002 fresh after/before erase: Engine eject → reset → dock (re-add cycle)' },
    add_files_role: { level: 'partition', verbs: 'add-files home dock if absent' },
    eject_disk: { level: 'none', verbs: 'Console/Engine eject only (Intent); no device change' },
    infra_reboot_engine: { level: 'ssd', verbs: 'after boot: status (bootId) → dock-ssd --ssd <fixture> for each SSD whose partitions are all missing → re-apply partition state' },
    reboot_engine: { level: 'ssd', verbs: 'same as infra_reboot_engine' },
    '05:00 daily reboot': { level: 'ssd', verbs: 'detected by bootId change before the next fixture op → same redock' },
    yank: { level: 'ssd', verbs: 'yank <diskId> (unbinds that SSD without Engine eject) → dock-ssd --ssd <diskId>; no cover-all step uses it yet' },
}
