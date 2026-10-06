/**
 * idea#168 r38@103 (cover-all-skip-copy-cf814f7-r38 FAIL at erase_disk = cover-all@104):
 * three Empty fixture roles (Files / Backup / Erase), each its own disk; the preflight
 * refuses before step 1 (exit 8) and the live make_backup_disk / erase_disk Intents are
 * pinned to their role's disk.
 */
import { describe, expect, it } from 'vitest'
import {
    EXIT_FIXTURE_PREFLIGHT,
    ROLE_CONSUMERS,
    backupDiskTargetId,
    diskEmptiness,
    eraseDiskTargetId,
    filesDiskTargetId,
    fixtureDiskPreflight,
    waitDiskEmpty,
} from '../duration/fixtureDisks.js'
import { FakeFleetOps, assertBackupRoleOnDisk, dispatchAction, pinEmptyDiskForIntent } from '../duration/actions.js'
import { loadWalk } from '../duration/scenario.js'
import { REQUIRED_SLOT_COUNT, requiredSlotNames } from '../duration/slotLayout.js'
import { DURATION_UI_FIXTURES, StubUiDriver } from '../duration/ui/index.js'
import type { SemanticStoreView } from '../duration/types.js'

const POOL = ['idea01', 'idea03', 'idea04']
const E1 = 'duration-empty-001'
const E2 = 'duration-empty-002'
const E3 = 'duration-empty-003'
const KOL = 'duration-kolibri-grade5a-001'
const NC = 'duration-nextcloud-grade5a-001'
const ADD = 'duration-add-files-001'

type DiskSpec = { dockedTo?: string | null; types?: string[] }
const view = (disks: Record<string, DiskSpec>, instances: Record<string, string> = {}): SemanticStoreView => ({
    engineId: 'idea01',
    diskDB: Object.fromEntries(
        Object.entries(disks).map(([id, d]) => [id, { id, dockedTo: d.dockedTo === undefined ? 'idea01' : d.dockedTo, diskTypes: d.types }]),
    ),
    instanceDB: Object.fromEntries(
        Object.entries(instances).map(([id, diskId]) => [id, { id, status: 'Running', diskId }]),
    ),
    engineDB: {},
})

/** Path A after Atlas's reset (with the third Empty disk). */
const GOOD = (): SemanticStoreView =>
    view(
        {
            [KOL]: { types: ['app'] },
            [NC]: { types: ['app', 'files'] },
            [ADD]: { types: ['app'] },
            [E1]: { types: ['empty'] },
            [E2]: { types: ['empty'] },
            [E3]: { types: ['empty'] },
            i3qlubws0txx4k23wje: { types: ['system'] },
        },
        { 'kolibri-grade5a-001': KOL, 'nextcloud-grade5a-001': NC, 'add-files-001': ADD },
    )

/** Live store after r38 aborted at @103 (read-only /api read 2026-10-06). */
const R38_END = (): SemanticStoreView =>
    view(
        {
            [KOL]: { types: ['app'] },
            [NC]: { types: ['app', 'files'] },
            [ADD]: { types: ['app', 'files'] },
            [E1]: { types: ['files'] },
            [E2]: { types: ['backup'] },
            i3qlubws0txx4k23wje: { types: ['system'] },
        },
        { 'kolibri-grade5a-001': NC, 'nextcloud-grade5a-001': NC, 'add-files-001': ADD },
    )

const ENV_OK = { DURATION_EMPTY_DISK_ID: E1, DURATION_BACKUP_DISK_ID: E3 }
const ENV_R38 = { DURATION_EMPTY_DISK_ID: E1, DURATION_BACKUP_DISK_ID: E1 }

const coverAll = loadWalk('cover-all')
const skipCopy = loadWalk('cover-all-skip-copy')
const run = (steps: { action: string }[], v: SemanticStoreView, env: NodeJS.ProcessEnv, startIndex = 0) =>
    fixtureDiskPreflight({ steps, startIndex, consoleEngine: 'idea01', poolEngines: POOL, view: v, env })

describe('fixture disk roles (idea#168 r38@103)', () => {
    it('role → disk: Files empty-001, Backup empty-003, Erase empty-002 (distinct by default)', () => {
        expect(filesDiskTargetId({})).toBe(E1)
        expect(backupDiskTargetId({})).toBe(E3)
        expect(eraseDiskTargetId()).toBe(E2)
        expect(backupDiskTargetId({ DURATION_BACKUP_DISK_ID: ' x ' })).toBe('x')
        expect(DURATION_UI_FIXTURES.empty3).toEqual({
            diskId: E3,
            packPath: 'tests/duration-tests/fixtures/empty-003',
            preferredDevice: 'idea-test-6',
        })
        expect(EXIT_FIXTURE_PREFLIGHT).toBe(8)
        expect(ROLE_CONSUMERS.erase).toEqual(['erase_disk'])
    })

    it('slot layout: six required slots (idea-test-6 holds the Backup Disk)', () => {
        expect(REQUIRED_SLOT_COUNT).toBe(6)
        expect(requiredSlotNames()).toContain('idea-test-6')
    })

    it('diskEmptiness: docked + diskTypes exactly [empty] + no instances', () => {
        expect(diskEmptiness(GOOD(), E3).empty).toBe(true)
        expect(diskEmptiness(view({ [E3]: { types: ['empty'], dockedTo: null } }), E3).empty).toBe(false)
        expect(diskEmptiness(view({ [E3]: { types: ['empty', 'backup'] } }), E3).empty).toBe(false)
        expect(diskEmptiness(view({ [E3]: { types: ['empty'] } }, { x: E3 }), E3).empty).toBe(false)
        expect(diskEmptiness(view({}), E3)).toMatchObject({ known: false, empty: false })
    })
})

describe('fixtureDiskPreflight — before step 1', () => {
    it('cover-all (128) and skip-copy (125) consume all three roles at the expected steps', () => {
        expect(coverAll.steps).toHaveLength(128)
        expect(skipCopy.steps).toHaveLength(125)
        const a = run(coverAll.steps, GOOD(), ENV_OK)
        expect(a.ok, a.message).toBe(true)
        expect(a.roles.map(r => [r.role, r.diskId, r.steps])).toEqual([
            ['files', E1, [88, 91, 114, 119]],
            ['backup', E3, [95]],
            ['erase', E2, [104, 121]],
        ])
        const b = run(skipCopy.steps, GOOD(), ENV_OK)
        expect(b.ok, b.message).toBe(true)
        // variant 44-114 = parent 45-115, 115-125 = parent 118-128
        expect(b.roles.map(r => [r.role, r.diskId, r.steps])).toEqual([
            ['files', E1, [87, 90, 113, 116]],
            ['backup', E3, [94]],
            ['erase', E2, [103, 118]],
        ])
        expect(a.message).toMatch(/^fixture disk preflight OK \(from step 1: Empty on Console engine idea01\): files=duration-empty-001@idea01 Empty/)
    })

    it('r38 env (DURATION_BACKUP_DISK_ID = DURATION_EMPTY_DISK_ID = empty-001) → FAIL distinct', () => {
        for (const w of [coverAll, skipCopy]) {
            const r = run(w.steps, GOOD(), ENV_R38)
            expect(r.ok).toBe(false)
            expect(r.problems).toHaveLength(1)
            expect(r.problems[0]).toBe(
                'files (DURATION_EMPTY_DISK_ID) and backup (DURATION_BACKUP_DISK_ID) resolve to the same disk duration-empty-001 — ' +
                    'each role consumes its own Empty disk (files duration-empty-001, backup duration-empty-001, erase duration-empty-002); ' +
                    'set DURATION_BACKUP_DISK_ID=duration-empty-003 and DURATION_EMPTY_DISK_ID=duration-empty-001',
            )
        }
        // r38 env against the live store as r38 left it (read-only 2026-10-06): four problems.
        const live = run(coverAll.steps, R38_END(), ENV_R38)
        expect(live.problems).toHaveLength(4)
        expect(live.problems[1]).toBe(
            'backup disk duration-empty-001 (make_backup_disk@95) is not Empty (duration-empty-001 dockedTo=idea01 diskTypes=[files] instances=0) — ' +
                'the Console shows EmptyDiskPanel only for diskTypes=[empty] with no instances; reset it to its Path A slot (META.yaml only)',
        )
    })

    it('r38 Path A (two Empty disks, no empty-003) → FAIL: Backup disk not in the store', () => {
        const v = GOOD()
        delete v.diskDB[E3]
        const r = run(skipCopy.steps, v, ENV_OK)
        expect(r.ok).toBe(false)
        expect(r.problems).toEqual([
            'backup disk duration-empty-003 (make_backup_disk@94) is not in the store — dock it Empty: Path A idea-test-6 (META.yaml only)',
        ])
        expect(r.message).toMatch(/^fixture disk preflight FAILED \(from step 1/)
    })

    it('r38 end state not reset (empty-001 Files, empty-002 Backup) → FAIL per role, names state', () => {
        const r = run(coverAll.steps, R38_END(), ENV_OK)
        expect(r.ok).toBe(false)
        expect(r.problems).toEqual([
            'files disk duration-empty-001 (install_app/make_files_disk@88) is not Empty (duration-empty-001 dockedTo=idea01 diskTypes=[files] instances=0) — ' +
                'the Console shows EmptyDiskPanel only for diskTypes=[empty] with no instances; reset it to Path A idea-test-3 (META.yaml only)',
            'backup disk duration-empty-003 (make_backup_disk@95) is not in the store — dock it Empty: Path A idea-test-6 (META.yaml only)',
            'erase disk duration-empty-002 (erase_disk@104) is not Empty (duration-empty-002 dockedTo=idea01 diskTypes=[backup] instances=0) — ' +
                'the Console shows EmptyDiskPanel only for diskTypes=[empty] with no instances; reset it to Path A idea-test-4 (META.yaml only)',
        ])
    })

    it('Empty disk docked off the Console engine, undocked, or holding an instance → FAIL', () => {
        const off = GOOD()
        off.diskDB[E3]!.dockedTo = 'idea03'
        expect(run(coverAll.steps, off, ENV_OK).problems).toEqual([
            'backup disk duration-empty-003 (make_backup_disk@95) is docked on idea03, not on the Console engine idea01 — Path A idea-test-6 (META.yaml only) on idea01',
        ])
        const und = GOOD()
        und.diskDB[E2]!.dockedTo = null
        expect(run(coverAll.steps, und, ENV_OK).problems).toEqual([
            'erase disk duration-empty-002 (erase_disk@104) is not docked — dock it Empty: Path A idea-test-4 (META.yaml only)',
        ])
        const inst = GOOD()
        inst.instanceDB['start-x'] = { id: 'start-x', status: 'Running', diskId: E2 }
        expect(run(coverAll.steps, inst, ENV_OK).problems[0]).toMatch(/^erase disk duration-empty-002 \(erase_disk@104\) is not Empty \(.*instances=\[start-x\]\)/)
    })

    it('--start-from (mid-walk): docked + distinct only, consumers counted from the start step', () => {
        // From parent @96 (after make_backup_disk): only erase + late Files installs remain.
        const r = run(coverAll.steps, R38_END(), ENV_OK, 95)
        expect(r.ok, r.message).toBe(true)
        expect(r.fromStart).toBe(false)
        expect(r.roles.map(x => x.role)).toEqual(['files', 'erase'])
        expect(r.message).toMatch(/from step 96: docked \+ distinct only/)
        // From 44 the Backup role is still ahead → empty-003 must be docked (not necessarily Empty).
        const v = R38_END()
        expect(run(skipCopy.steps, v, ENV_OK, 43).problems).toEqual([
            'backup disk duration-empty-003 (make_backup_disk@94) is not in the store — dock it Empty: Path A idea-test-6 (META.yaml only)',
        ])
        v.diskDB[E3] = { id: E3, dockedTo: 'idea04', diskTypes: ['backup'] }
        expect(run(skipCopy.steps, v, ENV_OK, 43).ok).toBe(true)
        v.diskDB[E3]!.dockedTo = 'idea02'
        expect(run(skipCopy.steps, v, ENV_OK, 43).problems[0]).toMatch(/docked on idea02, outside the pool/)
        expect(run(skipCopy.steps, v, ENV_R38, 43).problems[0]).toMatch(/files .* and backup .* resolve to the same disk duration-empty-001/)
    })

    it('a walk without Empty consumers passes untouched; a truncated walk only checks its own steps', () => {
        const r = run([{ action: 'open_console_as_teacher' }, { action: 'create_class' }], view({}), ENV_R38)
        expect(r).toMatchObject({ ok: true, roles: [], problems: [] })
        expect(r.message).toMatch(/walk consumes no Empty fixture disk/)
        // --iterations 92 of cover-all: Files only (install@88, make_files@91), Backup/Erase not reached.
        const t = run(coverAll.steps.slice(0, 92), GOOD(), ENV_R38)
        expect(t.ok, t.message).toBe(true)
        expect(t.roles.map(x => x.role)).toEqual(['files'])
    })
})

describe('live pins: make_backup_disk → empty-003, erase_disk → empty-002', () => {
    const ctxWith = (ops: unknown, action: string, extra: Record<string, unknown> = {}) => ({
        opts: { ops, rng: () => 0, settleTimeoutMs: 500, fast: true, ...extra },
        walker: { current: 'op_disk', layer: 'operator' as const, dockedEngine: 'idea01', step: 95 },
        from: 'op_disk',
        to: action === 'erase_disk' ? 'op_erase' : 'op_backup',
        action,
        excludeEngines: ['idea02'],
        poolEngines: POOL,
        fixtureDisk: KOL,
        fixtureInstance: 'kolibri-grade5a-001',
        fixtureDisks: [KOL, NC, E1, E2],
        fixtureInstances: { [KOL]: 'kolibri-grade5a-001', [NC]: 'nextcloud-grade5a-001' },
    })
    const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
        const prev: Record<string, string | undefined> = {}
        for (const k of Object.keys(vars)) {
            prev[k] = process.env[k]
            if (vars[k] === undefined) delete process.env[k]
            else process.env[k] = vars[k]
        }
        try {
            await fn()
        } finally {
            for (const k of Object.keys(prev)) {
                if (prev[k] === undefined) delete process.env[k]
                else process.env[k] = prev[k]
            }
        }
    }
    /** FakeFleetOps that looks live (findDockedEngine) with Path A's three Empty disks on idea01. */
    const liveOps = async (dock: string[] = [E1, E2, E3]) => {
        const ops = new FakeFleetOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared', fixtureInstances: {} })
        await ops.dockFixture('idea01', KOL)
        for (const d of dock) {
            await ops.dockFixture('idea01', d)
            await ops.purgeInstancesStoredOn('idea01', d)
        }
        return Object.assign(ops, { findDockedEngine: async () => 'idea01' })
    }
    const recordingDriver = () => {
        const driver = new StubUiDriver()
        const seen: { action: string; diskId?: string; emptyEnv?: string }[] = []
        const selected: string[] = []
        const orig = driver.runIntent.bind(driver)
        return Object.assign(driver, {
            seen,
            selected,
            selectDisk: async (id: string, o?: { requireEmptyPanel?: boolean }) => {
                expect(o?.requireEmptyPanel).toBe(true)
                selected.push(id)
                return `selected [data-testid="disk-${id}"]`
            },
            runIntent: async (c: Parameters<StubUiDriver['runIntent']>[0]) => {
                seen.push({ action: c.action, diskId: c.diskId, emptyEnv: process.env.DURATION_EMPTY_DISK_ID })
                return orig(c)
            },
        })
    }
    const ENV = { DURATION_SWITCH_ENGINE_HOST: 'idea01', DURATION_EMPTY_DISK_ID: E1, DURATION_BACKUP_DISK_ID: undefined, DURATION_FIXTURE_PIN_MS: '200' }

    it('make_backup_disk: Intent targets empty-003 (row selected, DURATION_EMPTY_DISK_ID pinned for the Intent, restored after)', async () => {
        await withEnv(ENV, async () => {
            const ops = await liveOps()
            const driver = recordingDriver()
            const r = await dispatchAction(ctxWith(ops, 'make_backup_disk', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok, r.message).toBe(true)
            expect(driver.selected).toEqual([E3])
            expect(driver.seen).toEqual([{ action: 'make_backup_disk', diskId: E3, emptyEnv: E3 }])
            expect(process.env.DURATION_EMPTY_DISK_ID).toBe(E1)
            expect(r.message).toMatch(/make_backup_disk pinned to duration-empty-003 dockedTo=idea01 diskTypes=\[empty\] instances=0 \(Empty\)/)
            // RestorePanel Intents (restore_from_backup / backup_configured_restored) now select empty-003.
            expect(process.env.DURATION_BACKUP_DISK_ID).toBe(E3)
            expect(r.message).toMatch(/; DURATION_BACKUP_DISK_ID=duration-empty-003$/)
        })
    })

    it('erase_disk: Intent targets empty-002, never the Backup Disk; env restored', async () => {
        await withEnv(ENV, async () => {
            const ops = await liveOps()
            const driver = recordingDriver()
            const r = await dispatchAction(ctxWith(ops, 'erase_disk', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok, r.message).toBe(true)
            expect(driver.selected).toEqual([E2])
            expect(driver.seen).toEqual([{ action: 'erase_disk', diskId: E2, emptyEnv: E2 }])
            expect(process.env.DURATION_EMPTY_DISK_ID).toBe(E1)
        })
    })

    it('r38 replay: Backup Disk took empty-002 → erase_disk aborts BEFORE the Intent (no fallback to another disk)', async () => {
        await withEnv(ENV, async () => {
            const ops = await liveOps([E1, E2])
            // r38@94: empty-002 became the Backup Disk.
            const base = ops.readStore.bind(ops)
            const patched = Object.assign(ops, {
                readStore: async (e: string) => {
                    const v = await base(e)
                    if (v.diskDB[E2]) v.diskDB[E2] = { ...v.diskDB[E2]!, diskTypes: ['backup'] }
                    return v
                },
            })
            const driver = recordingDriver()
            const r = await dispatchAction(ctxWith(patched, 'erase_disk', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(
                /^erase_disk aborted before Intent: erase_disk target duration-empty-002: duration-empty-002 dockedTo=idea01 diskTypes=\[backup\] instances=0 — not docked Empty on a pool engine \(idea01, idea03, idea04\) within 200ms/,
            )
            expect(r.message).toMatch(/Files duration-empty-001, Backup duration-empty-003, Erase duration-empty-002/)
            expect(driver.seen).toEqual([])
            expect(driver.selected).toEqual([])
        })
    })

    it('make_backup_disk aborts before the Intent when empty-003 is not docked (two-disk Path A)', async () => {
        await withEnv(ENV, async () => {
            const ops = await liveOps([E1, E2])
            const driver = recordingDriver()
            const r = await dispatchAction(ctxWith(ops, 'make_backup_disk', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok).toBe(false)
            expect(r.message).toMatch(/^make_backup_disk aborted before Intent: make_backup_disk target duration-empty-003: duration-empty-003 not in the store/)
            expect(driver.seen).toEqual([])
        })
    })

    it('Fake walks (no findDockedEngine) keep the pre-r38 behaviour (no pin, no wait)', async () => {
        await withEnv(ENV, async () => {
            const ops = new FakeFleetOps({ poolEngines: POOL, excludeEngines: ['idea02'], storeMode: 'shared', fixtureInstances: {} })
            const driver = recordingDriver()
            expect(await pinEmptyDiskForIntent(ctxWith(ops, 'erase_disk') as any, driver, E2, 'erase_disk', 50)).toBeNull()
            const r = await dispatchAction(ctxWith(ops, 'make_backup_disk', { stubUi: true, uiDriver: driver }) as any)
            expect(r.ok, r.message).toBe(true)
            expect(driver.selected).toEqual([])
            expect(driver.seen).toEqual([{ action: 'make_backup_disk', diskId: E1, emptyEnv: E1 }])
            expect(process.env.DURATION_BACKUP_DISK_ID).toBeUndefined()
        })
    })

    it('assertBackupRoleOnDisk: passes only when the PINNED disk carries backup', async () => {
        await withEnv(ENV, async () => {
            const ops = await liveOps()
            const base = ops.readStore.bind(ops)
            let backupOn = E2
            const patched = Object.assign(ops, {
                readStore: async (e: string) => {
                    const v = await base(e)
                    if (v.diskDB[backupOn]) v.diskDB[backupOn] = { ...v.diskDB[backupOn]!, diskTypes: ['backup'] }
                    return v
                },
            })
            // r38: the backup badge landed on empty-002 — the Console Intent's check would pass.
            await expect(assertBackupRoleOnDisk(ctxWith(patched, 'make_backup_disk') as any, E3, 50)).rejects.toThrow(
                /^make_backup_disk soft-pass: duration-empty-003 dockedTo=idea01 diskTypes=\[empty\] instances=0 lacks 'backup' within 50ms/,
            )
            backupOn = E3
            expect(await assertBackupRoleOnDisk(ctxWith(patched, 'make_backup_disk') as any, E3)).toBe(
                'store backup role on duration-empty-003 (backup) @idea01',
            )
        })
    }, 40_000)

    it('waitDiskEmpty: resolves once the disk turns Empty; throws with the last state otherwise', async () => {
        let n = 0
        const read = async () => view({ [E3]: { types: n++ < 2 ? ['backup'] : ['empty'] } })
        await expect(waitDiskEmpty(read, POOL, E3, 5_000, async () => {})).resolves.toMatchObject({ engine: 'idea01', empty: true })
        await expect(waitDiskEmpty(async () => view({ [E3]: { types: ['files'] } }), POOL, E3, 10, async () => {}))
            .rejects.toThrow('duration-empty-003 dockedTo=idea01 diskTypes=[files] instances=0 — not docked Empty on a pool engine (idea01, idea03, idea04) within 10ms')
    })
})
