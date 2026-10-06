/**
 * skip-borg.test.ts (idea#168 r36@98)
 *
 * The duration pool runs with settings.testMode = true (fixture disks, no sudo
 * mount/umount), and testMode also skipped borg: a backup ended Done with no Borg
 * repository and restoreApp then refused "No docked Backup Disk with archives".
 * settings.skipBorg (env IDEA_SKIP_BORG) now decides on its own; unset, it
 * follows testMode, like skipImageLoad and skipMetaWrite.
 *
 *   - skipBorg() resolution (unset → testMode; explicit true/false wins)
 *   - the IDEA_SKIP_BORG env override (fresh Config module)
 *   - unset + testMode: backupInstance / restoreApp never call borg
 *   - skipBorg false + testMode: borg init, create and extract all run
 *     (a fake `borg` on PATH records its arguments)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, os, path } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { Disk } from '../../src/data/Disk.js'
import { config, skipBorg } from '../../src/data/Config.js'
import { backupInstance, restoreApp } from '../../src/monitors/backupMonitor.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const INST = 'inst-borg-1' as InstanceID

const createMinimalStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const storeHandle = repo.create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as unknown as Store)
    await storeHandle.whenReady()
    await createOrUpdateEngine(storeHandle, localEngineId)
    return storeHandle
}

const makeDisk = (id: string, device: string, backup: boolean): Disk => ({
    id: id as DiskID,
    name: (backup ? 'Backup Disk' : 'App Disk') as DiskName,
    device: device as any,
    dockedTo: localEngineId as EngineID,
    created: Date.now() as Timestamp,
    lastDocked: Date.now() as Timestamp,
    diskTypes: backup ? ['backup'] : ['app'],
    backupConfig: null,
} as Disk)

const addInstance = (h: DocHandle<Store>, diskId: DiskID) =>
    h.change(doc => {
        doc.instanceDB[INST] = {
            id: INST, instanceOf: 'sample-app' as any, name: INST as any, status: 'Stopped' as any,
            port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
            lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: diskId,
            currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })

// A fake borg: logs each call; `init` creates <repo>/config; `info` returns one
// archive whose command line names instances/<INST>.
const FAKE_BORG = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_BORG_LOG"
case "$1" in
  init) mkdir -p "\${@: -1}" && echo '[repository]' > "\${@: -1}/config" ;;
  info) echo '{"archives":[{"name":"2026-10-06T08-00-00-000Z","command_line":["borg","create","r::a","/disks/x/instances/${INST}"]}]}' ;;
esac
exit 0
`

let appDevice: string
let backupDevice: string
let binDir: string
let borgLog: string
const saved = { testMode: config.settings.testMode, skipBorg: config.settings.skipBorg, path: process.env.PATH, log: process.env.FAKE_BORG_LOG }

beforeEach(async () => {
    appDevice = uniqueTestDevice()
    do { backupDevice = uniqueTestDevice() } while (backupDevice === appDevice)
    await fs.ensureDir(`${DISKS_ROOT}/${appDevice}/instances/${INST}`)
    await fs.ensureDir(`${DISKS_ROOT}/${backupDevice}`)
    await fs.writeFile(`${DISKS_ROOT}/${backupDevice}/BACKUP.yaml`, `mode: on-demand\nlinks:\n  - instanceId: ${INST}\n    lastBackup: 0\n`)
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-borg-'))
    borgLog = path.join(binDir, 'calls.log')
    await fs.writeFile(path.join(binDir, 'borg'), FAKE_BORG, { mode: 0o755 })
    process.env.PATH = `${binDir}:${saved.path}`
    process.env.FAKE_BORG_LOG = borgLog
    config.settings.testMode = true
    vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
    vi.restoreAllMocks()
    config.settings.testMode = saved.testMode
    config.settings.skipBorg = saved.skipBorg
    process.env.PATH = saved.path
    if (saved.log === undefined) delete process.env.FAKE_BORG_LOG
    else process.env.FAKE_BORG_LOG = saved.log
    await fs.remove(`${DISKS_ROOT}/${appDevice}`)
    await fs.remove(`${DISKS_ROOT}/${backupDevice}`)
    await fs.remove(binDir)
})

const calls = async (): Promise<string[]> =>
    (await fs.pathExists(borgLog)) ? (await fs.readFile(borgLog, 'utf8')).split('\n').filter(Boolean) : []

const backupThenRestore = async (): Promise<{ backupOp: any; restoreError: string | null }> => {
    const h = await createMinimalStore()
    const appDisk = makeDisk('borg-ad', appDevice, false)
    const backupDisk = makeDisk('borg-bd', backupDevice, true)
    h.change(doc => { doc.diskDB[appDisk.id] = appDisk; doc.diskDB[backupDisk.id] = backupDisk })
    addInstance(h, appDisk.id)
    await backupInstance(h, INST, backupDisk)
    const backupOp = Object.values(h.doc()!.operationDB ?? {}).find((o: any) => o.kind === 'backupApp')
    let restoreError: string | null = null
    try {
        await restoreApp(h, INST, appDisk)
    } catch (e: any) {
        restoreError = e?.message ?? String(e)
    }
    return { backupOp, restoreError }
}

describe('skipBorg() — follows testMode unless set', () => {
    it('unset → testMode; explicit true/false wins over testMode', () => {
        config.settings.skipBorg = undefined
        config.settings.testMode = true
        expect(skipBorg()).toBe(true)
        config.settings.testMode = false
        expect(skipBorg()).toBe(false)
        config.settings.skipBorg = false
        config.settings.testMode = true
        expect(skipBorg()).toBe(false)
        config.settings.skipBorg = true
        config.settings.testMode = false
        expect(skipBorg()).toBe(true)
    })

    it('IDEA_SKIP_BORG=false|true sets settings.skipBorg at load; other values leave it unset', async () => {
        const prev = process.env.IDEA_SKIP_BORG
        try {
            for (const [env, want] of [['false', false], ['true', true], ['yes', undefined]] as const) {
                vi.resetModules()
                process.env.IDEA_SKIP_BORG = env
                const fresh = await import('../../src/data/Config.js')
                expect(fresh.config.settings.skipBorg, `IDEA_SKIP_BORG=${env}`).toBe(want)
                if (want !== undefined) {
                    fresh.config.settings.testMode = !want
                    expect(fresh.skipBorg()).toBe(want)
                }
            }
        } finally {
            if (prev === undefined) delete process.env.IDEA_SKIP_BORG
            else process.env.IDEA_SKIP_BORG = prev
            vi.resetModules()
        }
    })
})

describe('backupInstance / restoreApp with testMode on', () => {
    it('skipBorg unset: borg is never called; the backup ends Done without a Borg repo and restore refuses', async () => {
        config.settings.skipBorg = undefined
        const { backupOp, restoreError } = await backupThenRestore()
        expect(await calls()).toEqual([])
        expect(backupOp?.status).toBe('Done')
        expect(await fs.pathExists(`${DISKS_ROOT}/${backupDevice}/backups/${INST}/config`)).toBe(false)
        expect(restoreError).toMatch(/No docked Backup Disk with archives/)
    })

    it('skipBorg false: borg init, create and extract all run (real archive path), still in testMode', async () => {
        config.settings.skipBorg = false
        const { backupOp } = await backupThenRestore()
        const log = await calls()
        const repo = `${DISKS_ROOT}/${backupDevice}/backups/${INST}`
        expect(backupOp?.status, JSON.stringify(backupOp)).toBe('Done')
        expect(log[0]).toBe(`init --encryption=none ${repo}`)
        expect(log[1]).toMatch(new RegExp(`^create ${repo}::\\S+ ${DISKS_ROOT}/${appDevice}/instances/${INST}$`))
        expect(log[2]).toBe(`info --json --last 1 ${repo}`)
        expect(log[3]).toBe(`extract --strip-components 3 ${repo}::2026-10-06T08-00-00-000Z`)
        expect(log).toHaveLength(4)
    })
})
