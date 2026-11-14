/**
 * initialise-disk-role.test.ts (engine#394)
 *
 * initialiseDisk's role must stay required at the dispatcher: a one-arg
 * `initialiseDisk <candidateId>` is refused with 'Insufficient arguments'
 * and never reaches the wrapper. The two-arg form still does.
 */
import { describe, it, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'

const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })

const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}

const initialiseDisk = () => {
    const cmd = commands.find(c => c.name === 'initialiseDisk')
    if (!cmd) throw new Error('initialiseDisk is not in the command registry')
    return cmd
}

describe('initialiseDisk role is required at dispatch (engine#394)', () => {
    it('the registry marks role required', () => {
        const roleArg = initialiseDisk().args.find(a => a.name === 'role')
        expect(roleArg).toMatchObject({ type: 'string', name: 'role' })
        expect(roleArg?.optional).not.toBe(true)
        expect(roleArg?.variadic).not.toBe(true)
    })

    it("initialiseDisk <candidateId> with no role is refused with Insufficient arguments and never reaches the wrapper", async () => {
        const log = newLog()
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        await handleCommand(commands, null, 'engine', 'initialiseDisk cand-1', log)
        expect(err).toHaveBeenCalledWith('Error: Insufficient arguments')
        err.mockRestore()

        const t = lastTrace(log)
        expect(t.command).toBe('initialiseDisk')
        expect(t.status).toBe('error')
        expect(t.errorMessage).toBe('Error: Insufficient arguments')
        // The wrapper's first act with no store is to throw 'Store is not available.'
        // That must not appear: the dispatcher refused the command first.
        expect(t.errorMessage).not.toMatch(/Store is not available/)
        expect(JSON.parse(t.args)).toEqual(['cand-1'])
    })

    it('the two-arg form still reaches the wrapper', async () => {
        const log = newLog()
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        await handleCommand(commands, null, 'engine', 'initialiseDisk cand-1 empty', log)
        expect(err).toHaveBeenCalledWith('Error: Store is not available.')
        err.mockRestore()

        const t = lastTrace(log)
        expect(t.command).toBe('initialiseDisk')
        expect(t.status).toBe('error')
        expect(t.errorMessage).toBe('Store is not available.')
        expect(t.errorMessage).not.toMatch(/Insufficient arguments/)
        expect(JSON.parse(t.args)).toEqual({ candidateId: 'cand-1', role: 'empty' })
    })
})
