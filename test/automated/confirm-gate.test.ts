/**
 * confirm-gate.test.ts — second confirmation for disk wipe, card flash and app create (engine#582).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { CommandLogStore, addTrace, setCommandLogHandle } from '../../src/data/CommandLogStore.js'
import { rememberOwnSummaryTrace, clearOwnSummaryTracesForTests } from '../../src/data/SummariseDisk.js'
import {
    CONFIRM_TTL_MS, commandNeedsConfirm, issueConfirm, checkConfirm, prepareConfirm, ConfirmRefusal,
    clearConfirmsForTests, pendingConfirmCountForTests,
} from '../../src/data/ConfirmGate.js'

const LOCAL = localEngineId as EngineID
const PREP = { summary: { label: 'Disk One' }, confirmField: 'label' as const, expected: 'Disk One' }

describe('confirmation lifecycle', () => {
    beforeEach(() => clearConfirmsForTests())

    it('gated commands: eraseDisk, flashCard, installApp; not others', () => {
        expect(commandNeedsConfirm('eraseDisk d1 t1 Disk One')).toBe(true)
        expect(commandNeedsConfirm('flashCard c1 current 32000')).toBe(true)
        expect(commandNeedsConfirm('installApp kolibri-1.0 d1')).toBe(true)
        expect(commandNeedsConfirm('startInstance i1 d1')).toBe(false)
        expect(commandNeedsConfirm('createInstance a b c d e')).toBe(false)
    })

    it('a right confirmation passes once; the second use is refused', () => {
        const c = issueConfirm('s1', 'eraseDisk d1 t1 Disk One', PREP, 1000)
        expect(c.expiresInMs).toBe(CONFIRM_TTL_MS)
        expect(c.confirmField).toBe('label')
        expect(checkConfirm('s1', 'eraseDisk d1 t1 Disk One', c.confirmId, 'Disk One', 2000)).toEqual({ ok: true })
        expect(checkConfirm('s1', 'eraseDisk d1 t1 Disk One', c.confirmId, 'Disk One', 2001)).toEqual({ ok: false, code: 'CONFIRM_INVALID', reason: 'unknown' })
    })

    it('expires after 60 s (monotonic clock)', () => {
        const c = issueConfirm('s1', 'eraseDisk d1 t1 Disk One', PREP, 1000)
        expect(checkConfirm('s1', 'eraseDisk d1 t1 Disk One', c.confirmId, 'Disk One', 1000 + CONFIRM_TTL_MS)).toMatchObject({ ok: false, reason: 'expired' })
    })

    it('tied to the session, the exact command and the typed text; any failed check uses it up', () => {
        const a = issueConfirm('s1', 'eraseDisk d1 t1 Disk One', PREP, 0)
        expect(checkConfirm('s2', 'eraseDisk d1 t1 Disk One', a.confirmId, 'Disk One', 1)).toMatchObject({ ok: false, reason: 'session' })
        expect(checkConfirm('s1', 'eraseDisk d1 t1 Disk One', a.confirmId, 'Disk One', 2)).toMatchObject({ ok: false, reason: 'unknown' })
        const b = issueConfirm('s1', 'eraseDisk d1 t1 Disk One', PREP, 0)
        expect(checkConfirm('s1', 'eraseDisk d2 t1 Disk One', b.confirmId, 'Disk One', 1)).toMatchObject({ ok: false, reason: 'command' })
        const c = issueConfirm('s1', 'eraseDisk d1 t1 Disk One', PREP, 0)
        expect(checkConfirm('s1', 'eraseDisk d1 t1 Disk One', c.confirmId, 'disk one', 1)).toMatchObject({ ok: false, reason: 'text' })
    })

    it('expired confirmations are pruned', () => {
        issueConfirm('s1', 'x', PREP, 0)
        issueConfirm('s1', 'y', PREP, CONFIRM_TTL_MS + 5)
        expect(pendingConfirmCountForTests()).toBe(1)
    })
})

describe('prepareConfirm: strict checks and summaries', () => {
    let h: DocHandle<Store>
    let log: DocHandle<CommandLogStore>
    const disk = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
        id: id as DiskID, name: name as DiskName, device: 'idea-test-1' as any, dockedTo: LOCAL,
        created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: ['app'], backupConfig: null, ...extra,
    })
    const putSummary = (traceId: string, targetId: string, label: string) => addTrace(log, {
        traceId, command: 'summariseDisk', args: JSON.stringify({ targetId }),
        startedAt: Date.now(), completedAt: Date.now(), status: 'ok', errorMessage: null,
        result: JSON.stringify({ targetId, label, serial: null, model: null, sizeBytes: 32e9, fsType: 'ext4', usedBytes: null,
            readable: true, apps: [{ name: 'kolibri', version: '1.0' }], instances: [], backups: [], files: null, other: null,
            otherPartitions: [], computedAt: Date.now() }),
    } as any)

    beforeEach(async () => {
        clearOwnSummaryTracesForTests()
        h = new Repo({ network: [], storage: undefined }).create<Store>({ engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {} } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, LOCAL)
        log = new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
        await log.whenReady()
        setCommandLogHandle(log)
        h.change(doc => {
            doc.diskDB['d1' as DiskID] = disk('d1', 'Disk One') as any
            doc.diskDB['sys' as DiskID] = disk('sys', 'System', { diskTypes: ['system'] }) as any
            doc.diskDB['away' as DiskID] = disk('away', 'Away', { dockedTo: 'ENGINE_other', device: 'sdz1' }) as any
        })
    })

    it('eraseDisk: summary from this Engine → label confirmation with the Engine summary', async () => {
        putSummary('sum-own', 'd1', 'Disk One')
        rememberOwnSummaryTrace('sum-own')
        const p = await prepareConfirm(h, 'eraseDisk d1 sum-own Disk One')
        expect(p.confirmField).toBe('label')
        expect(p.expected).toBe('Disk One')
        expect(p.summary).toMatchObject({ command: 'eraseDisk', label: 'Disk One', sizeBytes: 32e9, device: 'idea-test-1', apps: ['kolibri 1.0'] })
    })

    it('eraseDisk: a summary trace this Engine did not write is refused', async () => {
        putSummary('sum-foreign', 'd1', 'Disk One')
        await expect(prepareConfirm(h, 'eraseDisk d1 sum-foreign Disk One')).rejects.toThrow(/not made by this Engine/)
    })

    it('eraseDisk: system disk, a disk on another Engine and missing args are refused', async () => {
        await expect(prepareConfirm(h, 'eraseDisk sys t1 System')).rejects.toThrow(/system disk/)
        await expect(prepareConfirm(h, 'eraseDisk away t1 Away')).rejects.toThrow(/No disk or unformatted candidate/)
        await expect(prepareConfirm(h, 'eraseDisk d1')).rejects.toBeInstanceOf(ConfirmRefusal)
    })

    it('flashCard: present card with the shown size → sizeBytes confirmation', async () => {
        const deps = {
            findCard: async (_h: any, id: string) => id === 'c1' ? { candidateId: 'c1', sizeBytes: 32000, model: 'SD', refusal: null } as any : null,
            resolveImage: async (_h: any, v: string) => { if (v !== 'current') throw new Error(`Unknown client image '${v}'`); return { version: '2026.11' } },
        }
        const p = await prepareConfirm(h, 'flashCard c1 current 32000', deps)
        expect(p).toMatchObject({ confirmField: 'sizeBytes', expected: '32000', summary: { version: '2026.11', sizeBytes: 32000 } })
        await expect(prepareConfirm(h, 'flashCard c2 current 32000', deps)).rejects.toThrow(/not present/)
        await expect(prepareConfirm(h, 'flashCard c1 current 31999', deps)).rejects.toThrow(/Card size/)
        await expect(prepareConfirm(h, 'flashCard c1 9.9 32000', deps)).rejects.toThrow(/Unknown client image/)
        await expect(prepareConfirm(h, 'flashCard c1 current abc', deps)).rejects.toThrow(/usage/)
    })

    it('flashCard: a card with a refusal is refused', async () => {
        const deps = { findCard: async () => ({ candidateId: 'c1', sizeBytes: 1, model: null, refusal: 'MOUNTED' }) as any, resolveImage: async () => ({ version: 'x' }) }
        await expect(prepareConfirm(h, 'flashCard c1 current 1', deps)).rejects.toThrow(/MOUNTED/)
    })

    it('installApp: docked target → appName confirmation; bad id, undocked target refused', async () => {
        const p = await prepareConfirm(h, 'installApp kolibri-1.0 d1 --name "Kolibri Demo"')
        expect(p).toMatchObject({ confirmField: 'appName', expected: 'kolibri', summary: { appId: 'kolibri-1.0', targetDiskName: 'Disk One', instanceName: 'Kolibri Demo', source: 'catalog' } })
        await expect(prepareConfirm(h, 'installApp ../x-1.0 d1')).rejects.toBeInstanceOf(ConfirmRefusal)
        await expect(prepareConfirm(h, 'installApp kolibri-1.0 away')).rejects.toBeInstanceOf(ConfirmRefusal)
        await expect(prepareConfirm(h, 'installApp kolibri-1.0 d1 --source away')).rejects.toThrow(/Source disk/)
    })

    it('other commands have no confirmation', async () => {
        await expect(prepareConfirm(h, 'startInstance i1 d1')).rejects.toThrow(/does not use a confirmation/)
    })
})
