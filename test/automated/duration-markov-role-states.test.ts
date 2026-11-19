/**
 * Markov graph role guard (idea#166, run random-c1cc4bb-markov-20261118 step 109): open_file_drop (learner-only)
 * was drawn after open_nextcloud_as_teacher because both sign-ins led to one nc_browse state. The Intent guard was
 * right; the graph was wrong.
 *
 * This test derives, for every state of the unified graph, which role(s) can be signed in when the walker is there
 * (from the open_console_as_* sign-in edges, following every edge), and fails if a role-gated Intent hangs off a
 * state whose role does not match. It also walks 2000 seed-42 draws and every deterministic walk with the same
 * tracker.
 */
import { describe, expect, it } from 'vitest'
import { loadScenario, loadWalk, makeRng } from '../duration/scenario.js'
import type { Scenario } from '../duration/types.js'

type Role = 'teacher' | 'learner'
type Tracked = Role | 'none'

/** Intents that only one role may run (Nextcloud share is the teacher's; the File Drop trio is the learner's). */
const GATED: Record<string, Role> = {
    open_file_drop: 'learner',
    after_upload: 'learner',
    leave_file_drop: 'learner',
    share_to_class: 'teacher',
    done_sharing: 'teacher',
    back_to_console_from_share: 'teacher',
    create_class: 'teacher',
    enroll_learners: 'teacher',
    build_lesson: 'teacher',
    create_quiz: 'teacher',
    read_reports: 'teacher',
    preview_as_learner: 'teacher',
    back_to_console: 'teacher',
}

/** open_<app>_as_<role>, leave_<app>_as_<role>, stay_on_<role>_overview carry their role in the name. */
const roleOfAction = (action: string): Role | null => {
    if (/^open_console_as_/.test(action)) return null // the sign-in itself
    if (GATED[action]) return GATED[action] // preview_as_learner is the teacher's (ends in _as_learner, runs as teacher)
    const m = /_as_(teacher|learner)$/.exec(action) ?? /^stay_on_(teacher|learner)_overview$/.exec(action)
    if (m) return m[1] as Role
    return GATED[action] ?? null
}

/** Role after an edge: console_<role> is the sign-in; start / operator / infra have none; everything else keeps it. */
const roleAfter = (before: Tracked, action: string, to: string): Tracked => {
    const su = /^open_console_as_(teacher|learner)$/.exec(action)
    if (su) return su[1] as Role
    const c = /^console_(teacher|learner)$/.exec(to)
    if (c) return c[1] as Role
    if (to === 'start' || /^(op|infra)_/.test(to)) return 'none'
    return before
}

/** Every role each state can be entered with, and every role-gated edge taken from the wrong role. */
export const roleAudit = (scenario: Pick<Scenario, 'states' | 'initial_state'>): { roles: Record<string, Set<Tracked>>; leaks: string[] } => {
    const roles: Record<string, Set<Tracked>> = { [scenario.initial_state]: new Set<Tracked>(['none']) }
    const queue: string[] = [scenario.initial_state]
    const leaks = new Set<string>()
    while (queue.length) {
        const from = queue.shift()!
        for (const role of [...roles[from]!]) {
            for (const t of scenario.states[from]!.transitions) {
                const need = roleOfAction(t.action)
                if (need && role !== need) leaks.add(`${from} (signed in as ${role}) --${t.action}--> ${t.to} needs ${need}`)
                const next = roleAfter(role, t.action, t.to)
                const set = (roles[t.to] ??= new Set<Tracked>())
                if (!set.has(next)) {
                    set.add(next)
                    queue.push(t.to)
                }
            }
        }
    }
    return { roles, leaks: [...leaks].sort() }
}

/**
 * Doc-open audit (random-c1cc4bb-875a10e-markov-20261119 FAIL@105): return_to_start from nc_collab_learner left the
 * Nextcloud Text viewer open, and the next open_nextcloud_as_teacher clicked into the modal.
 * A state entered by an opener Intent holds an open doc / viewer / player. Every edge out of such a state to a state
 * that does NOT hold one must be a closer Intent (close_doc, exit_lesson, finish_exercise); anything else leaves the doc open.
 */
const DOC_OPENERS = new Set(['open_collab_doc', 'open_video', 'open_exercise'])
const DOC_CLOSERS = new Set(['close_doc', 'exit_lesson', 'finish_exercise'])

export const docAudit = (scenario: Pick<Scenario, 'states'>): { docStates: string[]; leaks: string[] } => {
    const docStates = new Set<string>()
    for (const st of Object.values(scenario.states)) {
        for (const t of st.transitions) if (DOC_OPENERS.has(t.action)) docStates.add(t.to)
    }
    const leaks: string[] = []
    for (const from of docStates) {
        for (const t of scenario.states[from]!.transitions) {
            if (t.walkOnly) continue // never drawn by the Markov sampler; the harness closes the leftover tab
            if (!docStates.has(t.to) && !DOC_CLOSERS.has(t.action)) leaks.push(`${from} --${t.action}--> ${t.to} leaves the doc open`)
        }
    }
    return { docStates: [...docStates].sort(), leaks: leaks.sort() }
}

describe('Markov graph: role-gated Intents are reachable only from the matching role', () => {
    const scenario = loadScenario('unified')

    it('no role-gated Intent is reachable from a state whose signed-in role does not match', () => {
        expect(roleAudit(scenario).leaks).toEqual([])
    })

    it('the Nextcloud and Wikipedia states are split by role', () => {
        const { roles } = roleAudit(scenario)
        const only = (s: string) => [...(roles[s] ?? [])].sort()
        expect(only('nc_browse_teacher')).toEqual(['teacher'])
        expect(only('nc_browse_learner')).toEqual(['learner'])
        expect(only('nc_collab_teacher')).toEqual(['teacher'])
        expect(only('nc_collab_learner')).toEqual(['learner'])
        expect(only('wiki_browse_teacher')).toEqual(['teacher'])
        expect(only('wiki_browse_learner')).toEqual(['learner'])
        expect(only('nc_share')).toEqual(['teacher'])
        expect(only('nc_drop')).toEqual(['learner'])
        expect(only('kolibri_manage')).toEqual(['teacher'])
        expect(scenario.states.nc_browse).toBeUndefined()
        const actions = (s: string) => scenario.states[s]!.transitions.map(t => t.action)
        expect(actions('nc_browse_teacher')).not.toContain('open_file_drop')
        expect(actions('nc_browse_learner')).toContain('open_file_drop')
        expect(actions('nc_browse_learner')).not.toContain('share_to_class')
        for (const s of ['nc_browse_teacher', 'nc_browse_learner', 'wiki_browse_teacher', 'wiki_browse_learner']) {
            expect(actions(s)).toContain('return_to_start')
        }
        // doc-open states: the sampler closes the doc first; return_to_start stays for deterministic walks only
        for (const s of ['nc_collab_teacher', 'nc_collab_learner']) {
            expect(actions(s)).toContain('close_doc')
            expect(scenario.states[s]!.transitions.find(t => t.action === 'return_to_start')?.walkOnly).toBe(true)
        }
    })

    it('the checker catches the old shape: one nc_browse shared by both sign-ins (run random-c1cc4bb step 109)', () => {
        const old = {
            initial_state: 'start',
            states: {
                start: { transitions: [
                    { to: 'console_teacher', weight: 1, action: 'open_console_as_teacher' },
                    { to: 'console_learner', weight: 1, action: 'open_console_as_learner' },
                ] },
                console_teacher: { transitions: [{ to: 'nc_browse', weight: 1, action: 'open_nextcloud_as_teacher' }] },
                console_learner: { transitions: [{ to: 'nc_browse', weight: 1, action: 'open_nextcloud_as_learner' }] },
                nc_browse: { transitions: [
                    { to: 'nc_drop', weight: 1, action: 'open_file_drop' },
                    { to: 'nc_share', weight: 1, action: 'share_to_class' },
                    { to: 'console_learner', weight: 1, action: 'leave_nextcloud_as_learner' },
                    { to: 'console_teacher', weight: 1, action: 'leave_nextcloud_as_teacher' },
                ] },
                nc_drop: { transitions: [{ to: 'start', weight: 1, action: 'return_to_start' }] },
                nc_share: { transitions: [{ to: 'start', weight: 1, action: 'return_to_start' }] },
            },
        } as never as Scenario
        const leaks = roleAudit(old).leaks
        expect(leaks).toContain('nc_browse (signed in as teacher) --open_file_drop--> nc_drop needs learner')
        expect(leaks).toContain('nc_browse (signed in as learner) --share_to_class--> nc_share needs teacher')
    })

    it('2000 seed-42 weighted draws over the real graph never take a gated Intent with the wrong role', () => {
        const rng = makeRng(42)
        let state = scenario.initial_state
        let role: Tracked = 'none'
        const bad: string[] = []
        const seen = new Set<string>()
        for (let i = 0; i < 2000; i++) {
            const ts = scenario.states[state]!.transitions.filter(t => !t.walkOnly)
            const total = ts.reduce((a, t) => a + t.weight, 0)
            let x = rng() * total
            let pick = ts[ts.length - 1]!
            for (const t of ts) {
                x -= t.weight
                if (x < 0) { pick = t; break }
            }
            const need = roleOfAction(pick.action)
            if (need && role !== need) bad.push(`draw ${i + 1} ${state}(${role}) --${pick.action}--> ${pick.to}`)
            if (need) seen.add(pick.action)
            role = roleAfter(role, pick.action, pick.to)
            state = pick.to
        }
        expect(bad).toEqual([])
        expect(seen.has('open_file_drop')).toBe(true)
        expect(seen.has('share_to_class')).toBe(true)
    })

    it('every deterministic walk keeps its roles straight', () => {
        for (const name of ['cover-all', 'cover-all-skip-copy', 'cover-registered-intents', 'nextcloud-file-drop-smoke', 'nextcloud-share-smoke', 'nextcloud-collab-smoke', 'wikipedia-smoke']) {
            const walk = loadWalk(name)
            let role: Tracked = 'none'
            const bad: string[] = []
            for (const [i, s] of walk.steps.entries()) {
                const need = roleOfAction(s.action)
                if (need && role !== need) bad.push(`${name} step ${i + 1} ${s.from}(${role}) --${s.action}--> ${s.to}`)
                role = roleAfter(role, s.action, s.to)
            }
            expect(bad).toEqual([])
        }
    })
    it('no exit from a doc-open state leaves the doc / viewer open (every exit closes it)', () => {
        const { docStates, leaks } = docAudit(scenario)
        expect(docStates).toEqual(['kolibri_exercise', 'kolibri_watching', 'nc_collab_learner', 'nc_collab_teacher'])
        expect(leaks).toEqual([])
    })

    it('walk_only edges out of a doc-open state are only return_to_start (the harness closes the tab), never drawn', () => {
        const { docStates } = docAudit(scenario)
        for (const from of docStates) {
            for (const t of scenario.states[from]!.transitions.filter(x => x.walkOnly)) expect(t.action).toBe('return_to_start')
        }
    })

    it('the doc-open checker catches the old shape: return_to_start straight out of nc_collab (FAIL@105)', () => {
        const old = {
            states: {
                nc_browse_learner: { transitions: [{ to: 'nc_collab_learner', weight: 1, action: 'open_collab_doc' }] },
                nc_collab_learner: { transitions: [
                    { to: 'nc_browse_learner', weight: 1, action: 'close_doc' },
                    { to: 'nc_collab_learner', weight: 1, action: 'keep_editing' },
                    { to: 'start', weight: 1, action: 'return_to_start' },
                ] },
                start: { transitions: [] },
            },
        } as never as Scenario
        expect(docAudit(old).leaks).toEqual(['nc_collab_learner --return_to_start--> start leaves the doc open'])
    })
})
