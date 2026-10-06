/**
 * idea#168 r38@103 (cover-all-skip-copy-cf814f7-r38 FAIL at erase_disk, cover-all@104):
 * cover-all consumes THREE Empty fixture disks, one per role, and each must be a different
 * disk:
 *
 *  - Files  — install_app@88 lands on it, then make_files_disk@91 really converts it
 *             (redockEmpty001BeforeMakeFiles + preflightFilesDiskTarget):
 *             DURATION_EMPTY_DISK_ID, default duration-empty-001 (Path A idea-test-3).
 *  - Backup — make_backup_disk@95 turns it into the Backup Disk that backup_instance@98/@112
 *             and restore_from_backup@100 use for the rest of the walk:
 *             DURATION_BACKUP_DISK_ID, default duration-empty-003 (Path A idea-test-6).
 *  - Erase  — erase_disk@104 (+ confirm_erase@105), then the late install_app@114/@119 and
 *             erase_disk@121 (redockEmpty002AfterErase / BeforeSecondInstall / BeforeErase):
 *             always duration-empty-002 (Path A idea-test-4).
 *
 * r38 ran with two Empty disks: make_files_disk took empty-001, make_backup_disk's
 * EmptyDiskPanel discovery took the only other one (empty-002), and at erase_disk no disk
 * showed EmptyDiskPanel ("empty-badge rows=0"). Erasing the Backup Disk instead would break
 * backup_instance@112, and the Console offers erase only on EmptyDiskPanel by design — a
 * fixture gap, not a product bug. The fix is a third Empty disk (Path A), each
 * EmptyDiskPanel Intent pinned to its role's disk (actions.ts), and this preflight, which
 * refuses a run before step 1 (exit 8) when a role's disk is missing, not docked, not Empty
 * or shared with another role. No walk change, no soft-pass.
 */
import type { SemanticStoreView } from './types.js'
import { DURATION_UI_FIXTURES } from './ui/fixtures.js'

/** Exit code: a fixture disk a walk role needs is missing / not Empty / shared (before step 1). */
export const EXIT_FIXTURE_PREFLIGHT = 8

export type FixtureDiskRole = 'files' | 'backup' | 'erase'

/** The disk make_files_disk converts (and the first install_app lands on). */
export const filesDiskTargetId = (env: NodeJS.ProcessEnv = process.env): string =>
    env.DURATION_EMPTY_DISK_ID?.trim() || DURATION_UI_FIXTURES.empty.diskId

/** The disk make_backup_disk turns into the Backup Disk under test. */
export const backupDiskTargetId = (env: NodeJS.ProcessEnv = process.env): string =>
    env.DURATION_BACKUP_DISK_ID?.trim() || DURATION_UI_FIXTURES.empty3.diskId

/** The disk erase_disk erases (the harness re-docks it Empty for the late installs/erase). */
export const eraseDiskTargetId = (): string => DURATION_UI_FIXTURES.empty2.diskId

/** Walk actions that consume each role's Empty disk. */
export const ROLE_CONSUMERS: Record<FixtureDiskRole, readonly string[]> = {
    files: ['install_app', 'make_files_disk'],
    backup: ['make_backup_disk'],
    erase: ['erase_disk'],
}

export const roleDiskId = (role: FixtureDiskRole, env: NodeJS.ProcessEnv = process.env): string =>
    role === 'files' ? filesDiskTargetId(env) : role === 'backup' ? backupDiskTargetId(env) : eraseDiskTargetId()

export interface DiskEmptiness {
    diskId: string
    known: boolean
    dockedTo: string | null
    diskTypes: string[]
    instances: string[]
    /** Docked, diskTypes exactly ['empty'], no instance stored on it (Console shows EmptyDiskPanel). */
    empty: boolean
}

/** Same criterion as preflightFilesDiskTarget: the Console's empty badge needs all three. */
export const diskEmptiness = (view: SemanticStoreView, diskId: string): DiskEmptiness => {
    const disk = view.diskDB[diskId]
    const diskTypes = [...(disk?.diskTypes ?? [])]
    const instances = Object.values(view.instanceDB)
        .filter(i => i.diskId === diskId)
        .map(i => i.id)
        .sort()
    const dockedTo = disk?.dockedTo ?? null
    return {
        diskId,
        known: !!disk,
        dockedTo,
        diskTypes,
        instances,
        empty: !!dockedTo && diskTypes.length === 1 && diskTypes[0] === 'empty' && instances.length === 0,
    }
}

export const describeDisk = (d: DiskEmptiness): string =>
    !d.known
        ? `${d.diskId} not in the store`
        : `${d.diskId} dockedTo=${d.dockedTo ?? 'none'} diskTypes=[${d.diskTypes.join(', ')}] ` +
          `instances=${d.instances.length ? `[${d.instances.join(', ')}]` : '0'}`

export interface FixtureRoleCheck {
    role: FixtureDiskRole
    diskId: string
    /** 1-based walk steps (of the steps this run executes) that consume this role. */
    steps: number[]
    state: DiskEmptiness
    ok: boolean
    problem?: string
}

export interface FixtureDiskPreflight {
    ok: boolean
    /** true: the run starts at step 1 → every role's disk must be Empty on the Console engine. */
    fromStart: boolean
    consoleEngine: string
    roles: FixtureRoleCheck[]
    problems: string[]
    message: string
}

const PATH_A_HINT: Record<FixtureDiskRole, string> = {
    files: 'Path A idea-test-3 (META.yaml only)',
    backup: 'Path A idea-test-6 (META.yaml only)',
    erase: 'Path A idea-test-4 (META.yaml only)',
}

const ROLE_DEFAULT_ID: Record<FixtureDiskRole, string> = {
    files: DURATION_UI_FIXTURES.empty.diskId,
    backup: DURATION_UI_FIXTURES.empty3.diskId,
    erase: DURATION_UI_FIXTURES.empty2.diskId,
}

/** Path A slot hint only for the role's default disk (an env-overridden id gets a generic hint). */
const pathAHint = (role: FixtureDiskRole, diskId: string): string =>
    diskId === ROLE_DEFAULT_ID[role] ? PATH_A_HINT[role] : 'its Path A slot (META.yaml only)'

const ROLE_ENV: Record<FixtureDiskRole, string> = {
    files: 'DURATION_EMPTY_DISK_ID',
    backup: 'DURATION_BACKUP_DISK_ID',
    erase: '(fixed: duration-empty-002)',
}

/**
 * Pure verdict. `steps` are the walk's actions (index 0 = step 1); `startIndex` the 0-based
 * first step this run executes. From step 1 every consumed role's disk must be docked on
 * the Console engine and Empty; with --start-from the walk state is mid-run (an earlier
 * step may legitimately have converted a disk), so only docked-on-a-pool-engine and
 * distinctness are checked. Role ids must always be pairwise distinct.
 */
export const fixtureDiskPreflight = (input: {
    steps: readonly { action: string }[]
    startIndex: number
    consoleEngine: string
    poolEngines: readonly string[]
    view: SemanticStoreView
    env?: NodeJS.ProcessEnv
}): FixtureDiskPreflight => {
    const env = input.env ?? process.env
    const fromStart = input.startIndex <= 0
    const roles: FixtureRoleCheck[] = []
    for (const role of ['files', 'backup', 'erase'] as const) {
        const steps: number[] = []
        input.steps.forEach((s, i) => {
            if (i >= input.startIndex && ROLE_CONSUMERS[role].includes(s.action)) steps.push(i + 1)
        })
        if (!steps.length) continue
        const diskId = roleDiskId(role, env)
        const state = diskEmptiness(input.view, diskId)
        let problem: string | undefined
        const first = `${ROLE_CONSUMERS[role].filter(a => steps.some(n => input.steps[n - 1]!.action === a)).join('/')}@${steps[0]}`
        if (!state.known) {
            problem = `${role} disk ${diskId} (${first}) is not in the store — dock it Empty: ${pathAHint(role, diskId)}`
        } else if (!state.dockedTo) {
            problem = `${role} disk ${diskId} (${first}) is not docked — dock it Empty: ${pathAHint(role, diskId)}`
        } else if (fromStart && state.dockedTo !== input.consoleEngine) {
            problem =
                `${role} disk ${diskId} (${first}) is docked on ${state.dockedTo}, not on the Console engine ` +
                `${input.consoleEngine} — ${pathAHint(role, diskId)} on ${input.consoleEngine}`
        } else if (!fromStart && !input.poolEngines.includes(state.dockedTo)) {
            problem = `${role} disk ${diskId} (${first}) is docked on ${state.dockedTo}, outside the pool`
        } else if (fromStart && !state.empty) {
            problem =
                `${role} disk ${diskId} (${first}) is not Empty (${describeDisk(state)}) — the Console shows ` +
                `EmptyDiskPanel only for diskTypes=[empty] with no instances; reset it to ${pathAHint(role, diskId)}`
        }
        roles.push({ role, diskId, steps, state, ok: !problem, ...(problem ? { problem } : {}) })
    }
    const problems = roles.flatMap(r => (r.problem ? [r.problem] : []))
    const byId = new Map<string, FixtureRoleCheck[]>()
    for (const r of roles) byId.set(r.diskId, [...(byId.get(r.diskId) ?? []), r])
    for (const [id, rs] of byId) {
        if (rs.length < 2) continue
        problems.push(
            `${rs.map(r => `${r.role} (${ROLE_ENV[r.role]})`).join(' and ')} resolve to the same disk ${id} — ` +
                `each role consumes its own Empty disk (files ${filesDiskTargetId(env)}, backup ` +
                `${backupDiskTargetId(env)}, erase ${eraseDiskTargetId()}); set DURATION_BACKUP_DISK_ID=` +
                `${DURATION_UI_FIXTURES.empty3.diskId} and DURATION_EMPTY_DISK_ID=${DURATION_UI_FIXTURES.empty.diskId}`,
        )
        for (const r of rs) r.ok = false
    }
    const ok = problems.length === 0
    const summary = roles.length
        ? roles.map(r => `${r.role}=${r.diskId}@${r.state.dockedTo ?? 'undocked'}${r.state.empty ? ' Empty' : ''} (steps ${r.steps.join(',')})`).join('; ')
        : 'walk consumes no Empty fixture disk'
    const mode = fromStart
        ? `from step 1: Empty on Console engine ${input.consoleEngine}`
        : `from step ${input.startIndex + 1}: docked + distinct only (mid-walk state)`
    const message = ok
        ? `fixture disk preflight OK (${mode}): ${summary}`
        : `fixture disk preflight FAILED (${mode}): ${problems.join(' | ')}`
    return { ok, fromStart, consoleEngine: input.consoleEngine, roles, problems, message }
}

/** Wait until `diskId` is docked on a pool engine and Empty (shared store); throws with the last state. */
export const waitDiskEmpty = async (
    readStore: (engine: string) => Promise<SemanticStoreView>,
    engines: readonly string[],
    diskId: string,
    budgetMs: number,
    sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
): Promise<DiskEmptiness & { engine: string }> => {
    const deadline = Date.now() + budgetMs
    let last: DiskEmptiness | null = null
    let lastErr: string | null = null
    for (;;) {
        for (const eng of engines) {
            try {
                const st = diskEmptiness(await readStore(eng), diskId)
                last = st
                if (st.empty && st.dockedTo && engines.includes(st.dockedTo)) return { ...st, engine: st.dockedTo }
                if (st.known) break
            } catch (e) {
                lastErr = e instanceof Error ? e.message : String(e)
            }
        }
        if (Date.now() >= deadline) break
        await sleep(500)
    }
    throw new Error(
        `${last ? describeDisk(last) : `${diskId} unread${lastErr ? ` (${lastErr})` : ''}`} — not docked Empty on a pool ` +
            `engine (${engines.join(', ')}) within ${budgetMs}ms`,
    )
}
