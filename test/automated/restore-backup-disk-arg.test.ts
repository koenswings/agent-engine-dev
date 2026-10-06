/**
 * restore-backup-disk-arg.test.ts (idea#168 r29@97)
 *
 * Duration test r29 step 97: the Console sent
 * `restoreApp kolibri Duration Tests — Add Files App` (a disk name with spaces);
 * the parser refused it ('Too many arguments') and restoreApp / backupApp
 * matched disk and instance by name only. Covers:
 *   - restoreApp / backupApp: disk by id, disk by unique name (warning),
 *     ambiguous / unknown / other-engine disk refused
 *   - restoreApp / backupApp: instance by id, by unique name, two instances
 *     with the same name refused as ambiguous, unknown refused
 *   - splitArgs / handleCommand: quoted args with spaces; unquoted unchanged
 *
 * backupInstance / restoreApp (backupMonitor) are mocked: only the argument
 * resolution of the command wrappers is under test.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DeviceName, DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { CommandDefinition } from '../../src/data/CommandDefinition.js'

vi.mock('../../src/monitors/backupMonitor.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        backupInstance: vi.fn(async () => {}),
        restoreApp: vi.fn(async () => {}),
    }
})

import { backupInstance, restoreApp } from '../../src/monitors/backupMonitor.js'
import { commands, resolveInstanceArg } from '../../src/data/Commands.js'
import { handleCommand, splitArgs } from '../../src/utils/commandUtils.js'

const LOCAL = localEngineId as EngineID
const OTHER = 'ENGINE_other-engine-000000' as EngineID
const SPACED = 'Duration Tests — Add Files App'

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}
const addDisk = (h: DocHandle<Store>, id: string, name: string, device: string | null, dockedTo: EngineID | null) => {
    h.change(doc => {
        doc.diskDB[id as DiskID] = {
            id: id as DiskID, name: name as DiskName, device: device as DeviceName | null, dockedTo,
            created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: ['backup'], backupConfig: null,
        }
    })
}
const addInstance = (h: DocHandle<Store>, id: string, name: string, storedOn: string) => {
    h.change(doc => { doc.instanceDB[id as InstanceID] = { id, name, storedOn, instanceOf: 'kolibri-1.0' } as any })
}
const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}

describe('restoreApp / backupApp resolve their disk and instance args (idea#168 r29@97)', () => {
    let h: DocHandle<Store>
    let warn: ReturnType<typeof vi.spyOn>
    let err: ReturnType<typeof vi.spyOn>

    beforeEach(async () => {
        vi.mocked(backupInstance).mockClear()
        vi.mocked(restoreApp).mockClear()
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
        h = await newStore()
        addDisk(h, 'd-spaced', SPACED, 'idea-test-1', LOCAL)
        addDisk(h, 'd-twin-a', 'IDEA Disk', 'idea-test-2', LOCAL)
        addDisk(h, 'd-twin-b', 'IDEA Disk', 'idea-test-3', LOCAL)
        addDisk(h, 'd-solo', 'Backups', 'idea-test-4', LOCAL)
        addDisk(h, 'd-remote', 'Remote', 'idea-test-5', OTHER)
        addInstance(h, 'inst-k1', 'kolibri', 'd-twin-a')
        addInstance(h, 'inst-k2', 'kolibri', 'd-twin-b')
        addInstance(h, 'inst-nc', 'nextcloud', 'd-twin-a')
    })
    afterEach(() => { warn.mockRestore(); err.mockRestore() })

    const run = async (cmd: string) => { const log = newLog(); await handleCommand(commands, h, 'engine', cmd, log); return lastTrace(log) }

    for (const cmd of ['restoreApp', 'backupApp'] as const) {
        const target = () => cmd === 'restoreApp' ? vi.mocked(restoreApp) : vi.mocked(backupInstance)

        it(`${cmd} by disk id and instance id: succeeds even with two instances named 'kolibri', no warning`, async () => {
            const t = await run(`${cmd} inst-k2 d-spaced`)
            expect(t.status).toBe('ok')
            expect(target()).toHaveBeenCalledOnce()
            expect(target().mock.calls[0][1]).toBe('inst-k2')
            expect((target().mock.calls[0][2] as any).id).toBe('d-spaced')
            expect(warn).not.toHaveBeenCalled()
        })

        it(`${cmd} by unique disk name and unique instance name: resolves, with a disk-name warning`, async () => {
            const t = await run(`${cmd} nextcloud Backups`)
            expect(t.status).toBe('ok')
            expect(target().mock.calls[0][1]).toBe('inst-nc')
            expect((target().mock.calls[0][2] as any).id).toBe('d-solo')
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${cmd}: disk 'Backups' was given by name; use the disk id d-solo`))
        })

        it(`${cmd} by a quoted disk name with spaces (the r29@97 command): resolves`, async () => {
            const t = await run(`${cmd} nextcloud "${SPACED}"`)
            expect(t.status).toBe('ok')
            expect((target().mock.calls[0][2] as any).id).toBe('d-spaced')
            expect(JSON.parse(t.args)).toEqual({ instanceName: 'nextcloud', backupDiskId: SPACED })
        })

        it(`${cmd} refuses an ambiguous disk name, listing the ids`, async () => {
            const t = await run(`${cmd} nextcloud "IDEA Disk"`)
            expect(t.status).toBe('error')
            expect(t.errorMessage).toMatch(/Disk name 'IDEA Disk' is ambiguous: d-twin-a \(idea-test-2\), d-twin-b \(idea-test-3\)/)
            expect(target()).not.toHaveBeenCalled()
        })

        it(`${cmd} refuses an unknown disk and a disk docked to another engine`, async () => {
            expect((await run(`${cmd} nextcloud no-such-disk`)).errorMessage).toContain("Disk 'no-such-disk' not found.")
            expect((await run(`${cmd} nextcloud d-remote`)).errorMessage).toContain('not docked to this engine')
            expect(target()).not.toHaveBeenCalled()
        })

        it(`${cmd} refuses an instance name shared by two instances, listing the ids`, async () => {
            const t = await run(`${cmd} kolibri d-spaced`)
            expect(t.status).toBe('error')
            expect(t.errorMessage).toContain(`${cmd}: instance name 'kolibri' is ambiguous: inst-k1 (on disk d-twin-a), inst-k2 (on disk d-twin-b). Use the instance id.`)
            expect(target()).not.toHaveBeenCalled()
        })

        it(`${cmd} refuses an unknown instance`, async () => {
            const t = await run(`${cmd} ghost d-spaced`)
            expect(t.status).toBe('error')
            expect(t.errorMessage).toContain(`${cmd}: instance 'ghost' not found.`)
            expect(target()).not.toHaveBeenCalled()
        })
    }

    it('unquoted disk name with spaces is still refused as too many arguments (no guessing)', async () => {
        const t = await run(`restoreApp nextcloud ${SPACED}`)
        expect(t.status).toBe('error')
        expect(t.errorMessage).toBe('Error: Too many arguments')
        expect(vi.mocked(restoreApp)).not.toHaveBeenCalled()
    })

    it('resolveInstanceArg: id wins over a name, unique name resolves', () => {
        addInstance(h, 'kolibri-id', 'other', 'd-solo')
        expect(resolveInstanceArg(h.doc()!, 'inst-k1', 'restoreApp').id).toBe('inst-k1')
        expect(resolveInstanceArg(h.doc()!, 'nextcloud', 'restoreApp').id).toBe('inst-nc')
        expect(() => resolveInstanceArg(h.doc()!, 'kolibri', 'restoreApp')).toThrow(/ambiguous/)
    })
})

describe('splitArgs: quoted args (idea#168 r29@97)', () => {
    it('unquoted: exactly the old split on spaces, empty tokens dropped', () => {
        for (const s of ['a b c', '  a   b  c ', 'kolibri Duration Tests — Add Files App', '', 'one', 'a\tb c', "it's fine"]) {
            expect(splitArgs(s)).toEqual(s.split(' ').filter(x => x.length > 0))
        }
    })
    it('a quoted token with spaces is one arg, quotes removed', () => {
        expect(splitArgs(`kolibri "${SPACED}"`)).toEqual(['kolibri', SPACED])
        expect(splitArgs(`"My Disk" on-demand kolibri`)).toEqual(['My Disk', 'on-demand', 'kolibri'])
        expect(splitArgs(`a  "b  c"   d`)).toEqual(['a', 'b  c', 'd'])
        expect(splitArgs(`a ""`)).toEqual(['a', ''])
    })
    it('a quote inside a token, or an unclosed quote, stays literal', () => {
        expect(splitArgs(`a"b c`)).toEqual(['a"b', 'c'])
        expect(splitArgs(`"open ended`)).toEqual(['"open', 'ended'])
        expect(splitArgs(`"x"y z"`)).toEqual(['x"y z'])
    })
})

describe('handleCommand: quoted args through the parser (idea#168 r29@97)', () => {
    const seen: any[][] = []
    const testCommands: CommandDefinition[] = [
        { name: 'two', execute: async (_h, ...a: any[]) => { seen.push(a) }, args: [{ type: 'string', name: 'a' }, { type: 'string', name: 'b' }], scope: 'engine' },
        { name: 'rest', execute: async (_h, ...a: any[]) => { seen.push(a) }, args: [{ type: 'string' }], scope: 'engine' },
        { name: 'multi', execute: async (_h, ...a: any[]) => { seen.push(a) }, args: [{ type: 'string', name: 'a' }, { type: 'string', name: 'b', variadic: true }], scope: 'engine' },
    ]
    beforeEach(() => { seen.length = 0 })

    it('restoreApp-style: `two kolibri "Duration Tests — Add Files App"` yields 2 args', async () => {
        await handleCommand(testCommands, null, 'engine', `two kolibri "${SPACED}"`)
        expect(seen).toEqual([['kolibri', SPACED]])
    })
    it('unquoted 2-arg command unchanged', async () => {
        await handleCommand(testCommands, null, 'engine', 'two  x   y ')
        expect(seen).toEqual([['x', 'y']])
    })
    it('single-arg (rest of line) commands keep the raw rest, quotes included', async () => {
        await handleCommand(testCommands, null, 'engine', `rest engine-1 restoreApp kolibri "${SPACED}"`)
        expect(seen).toEqual([[`engine-1 restoreApp kolibri "${SPACED}"`]])
    })
    it('variadic: unquoted tokens unchanged; a quoted token stays one', async () => {
        await handleCommand(testCommands, null, 'engine', 'multi a b c')
        await handleCommand(testCommands, null, 'engine', 'multi a "b c" d')
        expect(seen).toEqual([['a', 'b', 'c'], ['a', 'b c', 'd']])
    })
})
