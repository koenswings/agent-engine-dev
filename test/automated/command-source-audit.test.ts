/**
 * command-source-audit.test.ts — command source on traces, the local audit log,
 * createInstance local-only and the git account pin (engine#582).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { CommandLogStore, CommandTrace, commandLogText } from '../../src/data/CommandLogStore.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { appendAudit, rotateAuditFile, AUDIT_FILE_NAME } from '../../src/data/CommandAudit.js'
import { cleanCommandSource, isRemoteSource } from '../../src/data/CommandSource.js'
import { buildInstance } from '../../src/data/Instance.js'
import { config, authFolder } from '../../src/data/Config.js'

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}
const newLog = async (): Promise<DocHandle<CommandLogStore>> => {
    const l = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
    await l.whenReady()
    return l
}
const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}
const auditLines = (dir: string): any[] => {
    const f = path.join(dir, AUDIT_FILE_NAME)
    if (!fs.existsSync(f)) return []
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

describe('command source, audit log, local-only commands (engine#582)', () => {
    let dir: string
    let err: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-audit-'))
        process.env.IDEA_AUTH_DIR = dir
        err = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(() => {
        delete process.env.IDEA_AUTH_DIR
        err.mockRestore()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('authFolder: IDEA_AUTH_DIR wins; testMode default is a per-process temp folder', () => {
        expect(authFolder()).toBe(dir)
        delete process.env.IDEA_AUTH_DIR
        expect(authFolder()).toBe(path.join(os.tmpdir(), `idea-engine-auth-test-${process.pid}`))
        process.env.IDEA_AUTH_DIR = dir
    })

    it('cleanCommandSource keeps known string fields only; isRemoteSource', () => {
        expect(cleanCommandSource({ kind: 'operator', operator: 'admin', session: 'abcd1234', remoteAddr: undefined } as any))
            .toEqual({ kind: 'operator', operator: 'admin', session: 'abcd1234' })
        expect(cleanCommandSource({ kind: 'bogus' } as any)).toBeUndefined()
        expect(cleanCommandSource(undefined)).toBeUndefined()
        expect(isRemoteSource({ kind: 'queue' })).toBe(true)
        expect(isRemoteSource({ kind: 'peer' })).toBe(true)
        expect(isRemoteSource({ kind: 'cli' })).toBe(false)
        expect(isRemoteSource({ kind: 'engine' })).toBe(false)
        expect(isRemoteSource(undefined)).toBe(false)
    })

    it('a command records its source and seq on the trace and one audit line', async () => {
        const h = await newStore()
        const log = await newLog()
        await handleCommand(commands, h, 'engine', 'engines', log, { source: { kind: 'operator', operator: 'admin', session: 'abcd1234', remoteAddr: '10.42.0.5' }, seq: 7 })
        const t = lastTrace(log)
        expect(t.status).toBe('ok')
        expect(t.source).toEqual({ kind: 'operator', operator: 'admin', session: 'abcd1234', remoteAddr: '10.42.0.5' })
        expect(t.seq).toBe(7)
        const lines = auditLines(dir)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ engineId: String(localEngineId), seq: 7, command: 'engines', result: 'ok', source: { kind: 'operator', operator: 'admin' } })
        expect(typeof lines[0].t).toBe('number')
    })

    it('without a source the trace has no source/seq fields (older traces look the same)', async () => {
        const h = await newStore()
        const log = await newLog()
        await handleCommand(commands, h, 'engine', 'engines', log)
        const t = lastTrace(log)
        expect('source' in t).toBe(false)
        expect('seq' in t).toBe(false)
        expect(auditLines(dir)[0]).toMatchObject({ command: 'engines', result: 'ok', source: null, seq: null })
    })

    it('refusals are audited as refused with their code', async () => {
        const log = await newLog()
        await handleCommand(commands, null, 'engine', 'noSuchCommand x', log, { source: { kind: 'queue' } })
        expect(lastTrace(log).source).toEqual({ kind: 'queue' })
        expect(auditLines(dir)[0]).toMatchObject({ command: 'noSuchCommand', result: 'refused' })
    })

    it('createInstance from the store queue, an operator or a peer is refused with COMMAND_REFUSED; nothing runs', async () => {
        const h = await newStore()
        for (const kind of ['queue', 'operator', 'peer'] as const) {
            const log = await newLog()
            await handleCommand(commands, h, 'engine', 'createInstance i1 kolibri someone main sdz9', log, { source: { kind } })
            const t = lastTrace(log)
            expect(t.status).toBe('error')
            expect(t.errorCode).toBe('COMMAND_REFUSED')
            expect(commandLogText(t.errorMessage)).toMatch(/only runs from the command line/)
        }
        expect(auditLines(dir).map(l => l.errorCode)).toEqual(['COMMAND_REFUSED', 'COMMAND_REFUSED', 'COMMAND_REFUSED'])
    })

    it('createInstance from the local CLI goes on to its normal checks', async () => {
        const log = await newLog()
        await handleCommand(commands, null, 'engine', 'createInstance a b c d e', log, { source: { kind: 'cli' } })
        expect(commandLogText(lastTrace(log).errorMessage)).toContain('Store is not available to create instance.')
    })

    it('buildInstance refuses a git account outside settings.allowedGitAccounts', async () => {
        await expect(buildInstance('x' as any, 'kolibri' as any, 'someone', 'main' as any, 'sdz9' as any)).rejects.toThrow(/not allowed on this Engine/)
        config.settings.allowedGitAccounts = ['someone']
        try {
            await expect(buildInstance('x' as any, 'kolibri' as any, 'koenswings', 'main' as any, 'sdz9' as any)).rejects.toThrow(/not allowed on this Engine/)
        } finally { config.settings.allowedGitAccounts = undefined }
    })

    it('audit file is 0600 in a 0700 folder and rotates, keeping 5 older files', () => {
        appendAudit({ t: 1, engineId: 'e', command: 'a', args: '[]', result: 'ok' }, { dir })
        const f = path.join(dir, AUDIT_FILE_NAME)
        expect(fs.statSync(f).mode & 0o777).toBe(0o600)
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
        for (let i = 0; i < 8; i++) appendAudit({ t: i, engineId: 'e', command: `c${i}`, args: '[]', result: 'ok' }, { dir, maxBytes: 10, keep: 5 })
        const names = fs.readdirSync(dir).sort()
        expect(names).toEqual([AUDIT_FILE_NAME, ...[1, 2, 3, 4, 5].map(n => `${AUDIT_FILE_NAME}.${n}`)])
        rotateAuditFile(path.join(dir, 'missing.log'), 1, 5)   // no file: no error
    })

    it('args are redacted in the audit line', () => {
        appendAudit({ t: 1, engineId: 'e', command: 'x', args: JSON.stringify({ h: '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234' }), result: 'ok' }, { dir })
        expect(auditLines(dir)[0].args).not.toContain('$2b$10$')
    })
})
