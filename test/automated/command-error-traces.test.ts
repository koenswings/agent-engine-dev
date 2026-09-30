/**
 * command-error-traces.test.ts (idea#122)
 *
 * Unknown commands, scope mismatches and argument parse errors must leave an
 * error trace so the Console can show the operator what went wrong. Previously
 * handleCommand printed and returned before creating a trace.
 */

import { describe, it, expect } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { CommandDefinition } from '../../src/data/CommandDefinition.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { handleCommand } from '../../src/utils/commandUtils.js'

const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })

const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace | undefined => {
    const ids = h.doc()!.recentTraceIds
    if (!ids.length) return undefined
    return h.doc()!.traces[ids[ids.length - 1]]
}

const engineOnly: CommandDefinition[] = [{
    name: 'engineOnlyCmd',
    scope: 'engine',
    args: [{ type: 'string', name: 'diskId' }],
    execute: async () => { throw new Error('should not run') },
}]

const consoleOnly: CommandDefinition[] = [{
    name: 'consoleOnlyCmd',
    scope: 'console',
    args: [],
    execute: async () => { throw new Error('should not run') },
}]

const needsArgs: CommandDefinition[] = [{
    name: 'needsTwo',
    scope: 'engine',
    args: [{ type: 'string', name: 'a' }, { type: 'string', name: 'b' }],
    execute: async () => { throw new Error('should not run') },
}]

describe('handleCommand error traces (idea#122)', () => {
    it('records an error trace for an unknown command', async () => {
        const log = newLog()
        await handleCommand([], null, 'engine', 'createFilesDisk mystery-disk School', log)
        const t = lastTrace(log)
        expect(t).toBeTruthy()
        expect(t!.command).toBe('createFilesDisk')
        expect(t!.status).toBe('error')
        expect(t!.errorMessage).toBe('Unknown command: createFilesDisk')
        expect(t!.completedAt).not.toBeNull()
    })

    it('records an error trace for a console-only command run on the engine', async () => {
        const log = newLog()
        await handleCommand(consoleOnly, null, 'engine', 'consoleOnlyCmd', log)
        const t = lastTrace(log)!
        expect(t.status).toBe('error')
        expect(t.errorMessage).toMatch(/can only be executed on a console/)
    })

    it('records an error trace for an engine-only command run on the console', async () => {
        const log = newLog()
        await handleCommand(engineOnly, null, 'console', 'engineOnlyCmd disk-1', log)
        const t = lastTrace(log)!
        expect(t.status).toBe('error')
        expect(t.errorMessage).toMatch(/can only be executed on an engine/)
    })

    it('records an error trace for insufficient arguments', async () => {
        const log = newLog()
        await handleCommand(needsArgs, null, 'engine', 'needsTwo only-one', log)
        const t = lastTrace(log)!
        expect(t.status).toBe('error')
        expect(t.errorMessage).toMatch(/Insufficient arguments/)
    })

    it('records an error trace when a wrapper throws', async () => {
        const cmds: CommandDefinition[] = [{
            name: 'failing',
            scope: 'engine',
            args: [],
            execute: async () => { throw new Error('boom from wrapper') },
        }]
        const log = newLog()
        await handleCommand(cmds, null, 'engine', 'failing', log)
        const t = lastTrace(log)!
        expect(t.status).toBe('error')
        expect(t.errorMessage).toBe('boom from wrapper')
    })
})
