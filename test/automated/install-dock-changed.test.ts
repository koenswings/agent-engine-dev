/**
 * install-dock-changed.test.ts (#170): an installApp whose target disk is ejected,
 * erased or re-docked while it copies stops before it registers the instance, so no
 * store record points at a dock that is gone. The dock change is injected from the
 * app-registration step, which runs between the two re-checks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'

const onRegisterApp = vi.hoisted(() => ({ fn: null as null | ((h: any) => void) }))
vi.mock('../../src/data/App.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, createOrUpdateApp: vi.fn(async (h: any) => { onRegisterApp.fn?.(h) }) }
})
const processInstance = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, processInstance }
})

import { fs } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { disksRoot } from '../../src/data/Config.js'
import { setRootDeviceForTests } from '../../src/data/Disk.js'
import { installAppFromDisk } from '../../src/data/InstallApp.js'
import { AppID, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'

const SRC = 'DISK_src-dc' as DiskID
const TGT = 'DISK_tgt-dc' as DiskID
const SRC_DEV = 'idea-test-74'
const TGT_DEV = 'idea-test-75'
const APP = 'kolibri-1.0' as AppID
const COMPOSE = 'x-app:\n  name: kolibri\n  version: "1.0"\nservices:\n  kolibri:\n    image: koenswings/kolibri:1.0\n'
const root = (dev: string) => `${disksRoot()}/${dev}`

const makeDisk = (id: DiskID, device: string, dockedTo: EngineID) => ({
    id, name: id.replace('DISK_', '') as DiskName, device: device as any, dockedTo, created: 0 as Timestamp,
    lastDocked: 5 as Timestamp, diskTypes: ['app'], backupConfig: null,
})

describe('installApp re-checks the target dock before registering (#170)', () => {
    let h: DocHandle<Store>
    beforeEach(async () => {
        setRootDeviceForTests('mmcblk-not-a-test-disk')
        await fs.remove(root(SRC_DEV)); await fs.remove(root(TGT_DEV))
        await fs.ensureDir(`${root(SRC_DEV)}/apps/${APP}`)
        await fs.writeFile(`${root(SRC_DEV)}/apps/${APP}/compose.yaml`, COMPOSE)
        await fs.ensureDir(root(TGT_DEV))
        h = new Repo({ network: [], storage: undefined }).create<Store>({
            engineDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
            diskDB: { [SRC]: makeDisk(SRC, SRC_DEV, localEngineId), [TGT]: makeDisk(TGT, TGT_DEV, localEngineId) },
        } as any)
        await h.whenReady()
        await createOrUpdateEngine(h, localEngineId)
        processInstance.mockClear()
        onRegisterApp.fn = null
    })
    afterEach(async () => {
        setRootDeviceForTests(null)
        onRegisterApp.fn = null
        await fs.remove(root(SRC_DEV)); await fs.remove(root(TGT_DEV))
    })

    const install = () => installAppFromDisk(h, APP, h.doc().diskDB[SRC] as any, h.doc().diskDB[TGT] as any, 'k' as any, { fresh: true })

    it('same dock throughout → the instance is registered', async () => {
        await install()
        expect(processInstance).toHaveBeenCalledTimes(1)
    })

    it('target ejected mid-install → stops, instance never registered', async () => {
        onRegisterApp.fn = (hh) => hh.change((d: any) => { d.diskDB[TGT].dockedTo = null; d.diskDB[TGT].device = null })
        await expect(install()).rejects.toThrow(/installApp 'kolibri-1\.0' on 'tgt-dc' \(before registering the instance\): stopped, disk is no longer docked \(was idea-test-75\); nothing registered/)
        expect(processInstance).not.toHaveBeenCalled()
    })

    it('target erased and re-docked mid-install (new dock generation) → stops', async () => {
        onRegisterApp.fn = (hh) => hh.change((d: any) => { d.diskDB[TGT].lastDocked = 6 })
        await expect(install()).rejects.toThrow(/dock generation 5 → 6/)
        expect(processInstance).not.toHaveBeenCalled()
    })

    it('target re-docked on another device mid-install → stops', async () => {
        onRegisterApp.fn = (hh) => hh.change((d: any) => { d.diskDB[TGT].device = 'idea-test-76' })
        await expect(install()).rejects.toThrow(/re-docked on idea-test-76 \(was idea-test-75\)/)
        expect(processInstance).not.toHaveBeenCalled()
    })
})
