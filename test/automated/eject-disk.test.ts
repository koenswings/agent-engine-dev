/**
 * eject-disk.test.ts
 *
 * Tests the ejectDisk command:
 *   - Validation guards (disk not found, not docked, wrong engine)
 *   - Happy path: disk is ejected, store reflects Undocked state
 *
 * Uses handleCommand so the full command dispatch path is exercised.
 * No physical hardware required — disk state is set up directly in the store.
 */

import { describe, it, beforeEach, expect, vi, afterEach } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'

// ── helpers ──────────────────────────────────────────────────────────────────

const createMinimalStore = async (): Promise<{ repo: Repo; storeHandle: DocHandle<Store> }> => {
    const repo = new Repo({ network: [], storage: undefined })
    const storeHandle = repo.create<Store>({
        engineDB: {},
        diskDB: {},
        appDB: {},
        instanceDB: {},
        userDB: {},
    })
    await storeHandle.whenReady()
    await createOrUpdateEngine(storeHandle, localEngineId)
    return { repo, storeHandle }
}

const addDockedDisk = (storeHandle: DocHandle<Store>, diskId: DiskID, diskName: DiskName, engineId: EngineID, device = 'sdz1'): void => {
    storeHandle.change(doc => {
        doc.diskDB[diskId] = {
            id: diskId,
            name: diskName,
            device: device as any,
            dockedTo: engineId,
            created: Date.now() as Timestamp,
            lastDocked: Date.now() as Timestamp,
        }
    })
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ejectDisk command', () => {
    let storeHandle: DocHandle<Store>
    let repo: Repo
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(async () => {
        const ctx = await createMinimalStore()
        storeHandle = ctx.storeHandle
        repo = ctx.repo
        consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        consoleSpy.mockRestore()
    })

    it('errors when the store is not available', async () => {
        await handleCommand(commands, null, 'engine', 'ejectDisk MyDisk')
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Store is not available'))
    })

    it('errors when the named disk is not found', async () => {
        await handleCommand(commands, storeHandle, 'engine', 'ejectDisk NonExistentDisk')
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not found"))
    })

    it('errors when the disk exists but is not currently docked', async () => {
        // Create an undocked disk (device = null)
        storeHandle.change(doc => {
            doc.diskDB['undocked-disk-id' as DiskID] = {
                id: 'undocked-disk-id' as DiskID,
                name: 'UndockedDisk' as DiskName,
                device: null,
                dockedTo: null,
                created: Date.now() as Timestamp,
                lastDocked: Date.now() as Timestamp,
            }
        })
        await handleCommand(commands, storeHandle, 'engine', 'ejectDisk UndockedDisk')
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not currently docked'))
    })

    it('errors when the disk is docked to a different engine', async () => {
        const otherId = 'other-engine-0000-0000-0000-000000000000' as EngineID
        addDockedDisk(storeHandle, 'remote-disk-id' as DiskID, 'RemoteDisk' as DiskName, otherId)
        await handleCommand(commands, storeHandle, 'engine', 'ejectDisk RemoteDisk')
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not docked to this engine'))
    })

    it('updates the store when ejecting a locally docked disk (testMode — no sudo)', async () => {
        // Add a disk docked to the local engine
        const diskId = 'eject-test-disk-id' as DiskID
        const diskName = 'TestDisk' as DiskName
        addDockedDisk(storeHandle, diskId, diskName, localEngineId as EngineID)

        // Confirm it starts docked
        expect(storeHandle.doc()!.diskDB[diskId].device).to.equal('sdz1')
        expect(storeHandle.doc()!.diskDB[diskId].dockedTo).to.equal(localEngineId)

        // Eject it
        await handleCommand(commands, storeHandle, 'engine', `ejectDisk ${diskName}`)

        // Store should reflect Undocked state
        const disk = storeHandle.doc()!.diskDB[diskId]
        expect(disk.device).to.be.null
        expect(disk.dockedTo).to.be.null
    })

    it('is rejected when called from console scope', async () => {
        const scopeSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        await handleCommand(commands, storeHandle, 'console', 'ejectDisk MyDisk')
        expect(scopeSpy).toHaveBeenCalledWith(expect.stringContaining("can only be executed on an engine"))
        scopeSpy.mockRestore()
    })
})
