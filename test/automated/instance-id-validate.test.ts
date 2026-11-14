/**
 * instance-id-validate.test.ts — idea#479: instance ids are checked before any
 * compose or Docker action; a legacy dotted id is accepted on the removal path
 * only; compose project names are derived the way compose-go does it; containers
 * are matched by the exact com.docker.compose.project label, never a name prefix.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, path } from 'zx'
import os from 'node:os'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import {
    removeInstance, RemoveDeps, removeContainersByComposeProject, REMOVE_HELPER_MIN, REMOVE_LEGACY_ID_HELPER_MIN,
} from '../../src/data/RemoveInstance.js'
import { updateApp } from '../../src/data/UpdateApp.js'
import { moveApp } from '../../src/data/CopyMoveApp.js'
import { composeDownAt, pruneUnusedInstanceNetworks } from '../../src/utils/instanceNetworks.js'
import {
    composeProjectName, checkInstanceIdForDocker, isLegacyDottedInstanceId, isStrictInstanceId,
    composeProjectLabelFilter, containerInInstanceProject, composeProjectFor, containerNameBelongsToInstance,
} from '../../src/utils/instanceIds.js'
import { quarantineArgs, removalQuarantineArgs } from '../../src/utils/appDataHelper.js'
import { assertComposeContainersHealthy } from '../../src/data/Instance.js'

const ME = String(localEngineId)
const LIVE = 'nextcloud-yj8ral61js46bphogbi'
const DOTTED = 'nextcloud-yj8ral61js46bphogbi.backup-20261027-181633'
const DOTTED_PROJECT = 'nextcloud-yj8ral61js46bphogbibackup-20261027-181633'

let h: DocHandle<Store>
let calls: string[]

const deps = (over: Partial<RemoveDeps> = {}): Partial<RemoveDeps> => ({
    helperProblem: async (min) => { calls.push(`helper>=${min}`); return null },
    instanceDir: async (_d, id) => `/fake/instances/${id}`,
    composeDown: async (dir, id) => { calls.push(`down ${dir} -p ${composeProjectFor(String(id), { allowLegacyDotted: true })}`) },
    removeProjectContainers: async (id) => { calls.push(`rm-project ${composeProjectFor(String(id), { allowLegacyDotted: true })}`) },
    listVolumes: async () => [],
    quarantine: async (_d, id) => { calls.push(`quarantine ${id}`); return `/fake/.idea-quarantine/${id}-20261113T090000Z` },
    refreshSnapshots: async () => { calls.push('refresh') },
    pruneNetworks: async (id) => { calls.push(`prune ${id}`) },
    ...over,
})
const add = (id: string, disk = 'd1', status = 'Stopped') => h.change(doc => {
    doc.instanceDB[id as any] = { id, name: id, storedOn: disk, instanceOf: 'nextcloud-1.0', status, port: 50001 } as any
})
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return String((e as Error).message).split(':')[0] } }

beforeEach(async () => {
    calls = []
    h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    h.change(doc => {
        doc.diskDB['d1' as any] = { id: 'd1', name: 'd1', device: 'idea-test-1', dockedTo: ME, diskTypes: ['app'] } as any
        doc.diskDB['d2' as any] = { id: 'd2', name: 'd2', device: 'idea-test-2', dockedTo: ME, diskTypes: ['app'] } as any
    })
})

describe('instance id rules and compose project names (idea#479)', () => {
    it('composeProjectName matches compose-go NormalizeProjectName: lowercase, keep [a-z0-9_-], trim leading _ and -', () => {
        expect(composeProjectName(DOTTED)).toBe(DOTTED_PROJECT)
        expect(composeProjectName(LIVE)).toBe(LIVE)
        expect(composeProjectName('My.App_1')).toBe('myapp_1')
        expect(composeProjectName('-_.abc')).toBe('abc')
        expect(composeProjectName('...')).toBe('')
    })
    it('strict ids stay strict; dotted ids are only legacy-valid with single dots between [a-z0-9]-led segments', () => {
        expect(isStrictInstanceId(LIVE)).toBe(true)
        expect(isStrictInstanceId(DOTTED)).toBe(false)
        expect(isLegacyDottedInstanceId(DOTTED)).toBe(true)
        for (const bad of ['a..b', '.a', 'a.', 'a/b.c', 'A.b', '-a.b', 'a.-b', 'a b.c', '', `a.${'x'.repeat(127)}`]) {
            expect(isLegacyDottedInstanceId(bad), bad).toBe(false)
        }
    })
    it('checkInstanceIdForDocker: a dotted id is accepted only with allowLegacyDotted; garbage never', () => {
        expect(checkInstanceIdForDocker(LIVE)).toEqual({ ok: true, project: LIVE, legacy: false })
        expect(checkInstanceIdForDocker(DOTTED).ok).toBe(false)
        expect(checkInstanceIdForDocker(DOTTED, { allowLegacyDotted: true })).toEqual({ ok: true, project: DOTTED_PROJECT, legacy: true })
        for (const bad of ['../etc', 'a;rm -rf', 'Inst', '', '-p']) {
            expect(checkInstanceIdForDocker(bad, { allowLegacyDotted: true }).ok, bad).toBe(false)
        }
        expect(() => composeProjectFor(DOTTED)).toThrow(/^INVALID_INSTANCE_ID: .*only removeInstance/)
    })
    it('helper args: quarantine accepts the dotted id only through removalQuarantineArgs', () => {
        expect(removalQuarantineArgs('sdb1', DOTTED)).toEqual(['quarantine', 'sdb1', DOTTED])
        expect(removalQuarantineArgs('sdb1', LIVE)).toEqual(['quarantine', 'sdb1', LIVE])
        expect(() => quarantineArgs('sdb1', DOTTED)).toThrow(/not an instance id/)
        expect(() => removalQuarantineArgs('sdb1', 'a..b')).toThrow(/not an instance id/)
        expect(() => removalQuarantineArgs('sdb1', '../x')).toThrow(/not an instance id/)
    })
})

describe('removeInstance with a legacy dotted id (idea#479)', () => {
    it('validates first, needs helper v13, downs and cleans the normalised project, quarantines the dotted folder, drops the record', async () => {
        add(LIVE, 'd1', 'Running')
        add(DOTTED)
        const r = await removeInstance(h, DOTTED, ME, deps())
        expect(REMOVE_LEGACY_ID_HELPER_MIN).toBe(13)
        expect(calls).toEqual([
            'helper>=13',
            `down /fake/instances/${DOTTED} -p ${DOTTED_PROJECT}`,
            `rm-project ${DOTTED_PROJECT}`,
            `quarantine ${DOTTED}`,
            'refresh',
            `prune ${DOTTED}`,
        ])
        expect(r.instanceId).toBe(DOTTED)
        expect(h.doc().instanceDB[DOTTED as any]).toBeUndefined()
        expect(h.doc().instanceDB[LIVE as any]).toBeDefined()
    })
    it('a strict id still needs only helper v4', async () => {
        add(LIVE)
        await removeInstance(h, LIVE, ME, deps())
        expect(calls[0]).toBe(`helper>=${REMOVE_HELPER_MIN}`)
    })
    it('HELPER_OUTDATED for a dotted id on a helper older than v13, before any Docker call', async () => {
        add(DOTTED)
        const code = await codeOf(removeInstance(h, DOTTED, ME, deps({ helperProblem: async (min) => min >= 13 ? 'needs v13' : null })))
        expect(code).toBe('HELPER_OUTDATED')
        expect(calls).toEqual([])
        expect(h.doc().instanceDB[DOTTED as any]).toBeDefined()
    })
    it('an invalid id is refused INVALID_INSTANCE_ID before the helper or any compose/Docker call; store untouched', async () => {
        for (const bad of ['Bad_Id', 'a..b', 'x/../y']) {
            add(bad)
            expect(await codeOf(removeInstance(h, bad, ME, deps())), bad).toBe('INVALID_INSTANCE_ID')
            expect(h.doc().instanceDB[bad as any]).toBeDefined()
        }
        expect(calls).toEqual([])
    })
    it('PROJECT_CLASH when the dotted id normalises to another instance\'s project; nothing is touched', async () => {
        add(DOTTED)
        add(DOTTED_PROJECT, 'd1', 'Running')
        expect(await codeOf(removeInstance(h, DOTTED, ME, deps()))).toBe('PROJECT_CLASH')
        expect(calls).toEqual([])
    })
    it('the real fallback, compose down and network prune use the exact normalised project label', async () => {
        const ran: string[][] = []
        const run = async (args: string[]) => { ran.push(args); return args[0] === 'ps' ? 'c1\n' : '' }
        await removeContainersByComposeProject(DOTTED as any, run)
        expect(ran).toEqual([['ps', '-aq', '--filter', `label=com.docker.compose.project=${DOTTED_PROJECT}`], ['rm', '-f', 'c1']])

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-479-'))
        try {
            fs.writeFileSync(path.join(tmp, 'compose.yaml'), 'services: {}\n')
            ran.length = 0
            await composeDownAt(tmp, DOTTED as any, run, { allowLegacyDotted: true })
            expect(ran).toEqual([['compose', '-p', DOTTED_PROJECT, '-f', path.join(tmp, 'compose.yaml'), 'down']])
            ran.length = 0
            await composeDownAt(tmp, DOTTED as any, run, { allowLegacyDotted: true, timeoutSec: 0 })
            expect(ran).toEqual([['compose', '-p', DOTTED_PROJECT, '-f', path.join(tmp, 'compose.yaml'), 'down', '-t', '0']])
            ran.length = 0
            await expect(composeDownAt(tmp, DOTTED as any, run)).rejects.toThrow(/^INVALID_INSTANCE_ID/)
            await expect(composeDownAt(tmp, 'Bad;id' as any, run, { allowLegacyDotted: true })).rejects.toThrow(/^INVALID_INSTANCE_ID/)
            expect(ran).toEqual([])
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true })
        }

        ran.length = 0
        await pruneUnusedInstanceNetworks(DOTTED, { run: async (a) => { ran.push(a); return '' }, allowLegacyDotted: true })
        expect(ran[0]).toContain(`label=com.docker.compose.project=${DOTTED_PROJECT}`)
        ran.length = 0
        const res = await pruneUnusedInstanceNetworks(DOTTED, { run: async (a) => { ran.push(a); return '' } })
        expect(ran).toEqual([])
        expect(res.errors.join(' ')).toMatch(/legacy dotted id/)
    })
})

describe('other destructive commands refuse a dotted or invalid id before any Docker action (idea#479)', () => {
    it('updateApp: INVALID_INSTANCE_ID before the helper check, stop, compose or snapshot', async () => {
        add(DOTTED)
        const touched: string[] = []
        const trap = (name: string) => async () => { touched.push(name); throw new Error(`${name} must not run`) }
        const code = await codeOf(updateApp(h, DOTTED, 'nextcloud-1.1', ME, {}, {
            helperProblem: trap('helper') as any, stop: trap('stop') as any, composeDown: trap('down') as any,
            containerIds: trap('ps') as any, snapshot: trap('snapshot') as any,
        }))
        expect(code).toBe('INVALID_INSTANCE_ID')
        expect(touched).toEqual([])
    })
    it('moveApp: refuses a dotted id before any disk, rsync or compose step', async () => {
        add(DOTTED)
        await expect(moveApp(h, DOTTED as any, 'd1' as any, 'd2' as any)).rejects.toThrow(/^moveApp: INVALID_INSTANCE_ID: .*only removeInstance/)
        expect(h.doc().instanceDB[DOTTED as any].storedOn).toBe('d1')
    })
})

describe('container matching is by exact compose-project label, never a name prefix (idea#479)', () => {
    it('label helpers do not cross-match a similarly prefixed instance', () => {
        expect(composeProjectLabelFilter(LIVE)).toBe(`label=com.docker.compose.project=${LIVE}`)
        expect(composeProjectLabelFilter(DOTTED)).toBe(`label=com.docker.compose.project=${DOTTED_PROJECT}`)
        expect(composeProjectLabelFilter('...')).toBeNull()
        expect(containerInInstanceProject({ 'com.docker.compose.project': DOTTED_PROJECT }, LIVE)).toBe(false)
        expect(containerInInstanceProject({ 'com.docker.compose.project': DOTTED_PROJECT }, DOTTED)).toBe(true)
        expect(containerInInstanceProject({ 'com.docker.compose.project': 'kolibri-a-b' }, 'kolibri-a')).toBe(false)
        expect(containerInInstanceProject({ 'com.docker.compose.project': 'kolibri-a' }, 'kolibri-a')).toBe(true)
        expect(containerInInstanceProject(undefined, 'kolibri-a')).toBe(false)
    })
    it('containerNameBelongsToInstance is exact-project, never a live-id prefix of <id>backup-… (engine#367)', () => {
        const liveC = `${LIVE}-nextcloud-1`
        const bakC = `${DOTTED_PROJECT}-nextcloud-1`
        expect(bakC.startsWith(LIVE)).toBe(true) // the prefix trap: name= and startsWith(id) would both hit this
        expect(containerNameBelongsToInstance(liveC, LIVE)).toBe(true)
        expect(containerNameBelongsToInstance(LIVE, LIVE)).toBe(true)
        expect(containerNameBelongsToInstance(bakC, LIVE)).toBe(false)
        expect(containerNameBelongsToInstance(bakC, DOTTED)).toBe(true)
        expect(containerNameBelongsToInstance('a-builder-1', 'a')).toBe(true)
        expect(containerNameBelongsToInstance('ab-builder-1', 'a')).toBe(false)
    })
    it('Instance.ts has no docker name filter and no name-prefix container match left', async () => {
        const src = await fs.readFile(path.join(process.cwd(), 'src/data/Instance.ts'), 'utf8')
        expect(src).not.toMatch(/--filter name=/)
        expect(src).not.toMatch(/startsWith\(`\/\$\{instance\.id\}/)
        expect(src).toMatch(/composeProjectLabelFilter\(String\(instanceId\)\)/)
        expect(src).toMatch(/containerInInstanceProject\(/)
    })

    describe('assertComposeContainersHealthy with a fake docker (the live NC Error case)', () => {
        let bin: string
        let savedPath: string | undefined
        beforeEach(async () => {
            bin = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-479-bin-'))
            // Fake docker: `ps -a --filter name=X` is a substring match (as docker does);
            // `--filter label=com.docker.compose.project=P` is exact. The dotted backup
            // stack's container (project without the dot) has exited; the live one is Up.
            fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
LIVE_N='${LIVE}-nextcloud-1'; LIVE_P='${LIVE}'
BAK_N='${DOTTED_PROJECT}-nextcloud-1'; BAK_P='${DOTTED_PROJECT}'
if [[ "$1" == ps ]]; then
  for a in "$@"; do
    case "$a" in
      name=*) f="\${a#name=}"; [[ "$LIVE_N" == *"$f"* ]] && printf '%s\\tUp 2 hours\\tid1\\n' "$LIVE_N"; [[ "$BAK_N" == *"$f"* ]] && printf '%s\\tExited (1) 5 minutes ago\\tid2\\n' "$BAK_N";;
      label=com.docker.compose.project=*) p="\${a#label=com.docker.compose.project=}"; [[ "$p" == "$LIVE_P" ]] && printf '%s\\tUp 2 hours\\tid1\\n' "$LIVE_N"; [[ "$p" == "$BAK_P" ]] && printf '%s\\tExited (1) 5 minutes ago\\tid2\\n' "$BAK_N";;
    esac
  done
  exit 0
fi
[[ "$1" == logs ]] && exit 0
exit 1
`, { mode: 0o755 })
            savedPath = process.env.PATH
            process.env.PATH = `${bin}:${process.env.PATH}`
        })
        afterEach(() => {
            process.env.PATH = savedPath
            fs.rmSync(bin, { recursive: true, force: true })
        })
        it('the live instance is not marked Error by the dotted backup stack\'s exited container', async () => {
            await expect(assertComposeContainersHealthy('/fake', LIVE as any)).resolves.toBeUndefined()
        }, 15_000)
        // engine#367 ask 2: the start check ("Container(s) exited after compose up")
        // for a live strict id <id> must not match containers of project <id>backup-…
        // (exact project-label match from idea#479, already on main).
        it('engine#367: start check for live <id> does not match containers of project <id>backup-…', async () => {
            await expect(assertComposeContainersHealthy('/fake', LIVE as any)).resolves.toBeUndefined()
            await expect(assertComposeContainersHealthy('/fake', DOTTED as any)).rejects.toThrow(/Container\(s\) exited after compose up/)
        }, 20_000)
        it('the dotted instance still sees its own exited container', async () => {
            await expect(assertComposeContainersHealthy('/fake', DOTTED as any)).rejects.toThrow(/exited after compose up/)
        }, 15_000)
    })
})
