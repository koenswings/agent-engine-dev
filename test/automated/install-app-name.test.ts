/**
 * install-app-name.test.ts (Kid's request for idea#235 demo instances):
 *
 *   1. parseInstallAppArgs: `--name "Kolibri Demo"` is one value (quote-aware);
 *      unquoted lines parse as before; --fresh is a flag; unknown args refused.
 *   2. validateInstanceName: empty, too long and control characters refused.
 *   3. installAppFromDisk writes --name into x-app.instanceName and the store
 *      record; the instance id and folder (= Docker project name) stay the
 *      generated id, free of spaces.
 *   4. --fresh starts from the app bundle: no source instance data is copied.
 *
 * Real files in pretend disks under the disks root (idea-test-7x);
 * processInstance registers the instance from compose.yaml but never runs Docker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo'

vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        processInstance: vi.fn(async (handle: any, disk: any, instanceId: any) => {
            const { createOrUpdateInstance } = await import('../../src/data/Instance.js')
            return createOrUpdateInstance(handle, instanceId, disk)
        }),
    }
})

import { fs, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { disksRoot } from '../../src/data/Config.js'
import { setRootDeviceForTests } from '../../src/data/Disk.js'
import { installAppFromDisk, parseInstallAppArgs, validateInstanceName, MAX_INSTANCE_NAME_LENGTH, sameRealPath, diskAppId } from '../../src/data/InstallApp.js'
import { parseAppId } from '../../src/data/App.js'
import { extractAppName as StoreExtractAppName } from '../../src/data/Store.js'
import { isCommitSha } from '../../src/data/AppIdParse.js'
import { AppID, DiskID, DiskName, EngineID, Timestamp } from '../../src/data/CommonTypes.js'

const SRC = 'DISK_src-name' as DiskID
const TGT = 'DISK_tgt-name' as DiskID
const SRC_DEV = 'idea-test-71'
const TGT_DEV = 'idea-test-72'
const ORIG = 'kolibri-school-001'
const APP = 'kolibri-1.0' as AppID

const srcRoot = () => `${disksRoot()}/${SRC_DEV}`
const tgtRoot = () => `${disksRoot()}/${TGT_DEV}`

const COMPOSE = `x-app:
  name: kolibri
  version: "1.0"
  instanceName: kolibri
services:
  kolibri:
    image: koenswings/kolibri:1.0
    network_mode: host
`

const makeDisk = (id: DiskID, name: string, device: string, dockedTo: EngineID) => ({
    id, name: name as DiskName, device: device as any, dockedTo, created: 0 as Timestamp,
    lastDocked: 0 as Timestamp, diskTypes: ['app'], backupConfig: null,
})

const makeHandle = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {},
        diskDB: { [SRC]: makeDisk(SRC, 'src', SRC_DEV, localEngineId), [TGT]: makeDisk(TGT, 'tgt', TGT_DEV, localEngineId) },
        appDB: {},
        instanceDB: {
            [ORIG]: {
                id: ORIG, instanceOf: APP, name: 'kolibri', status: 'Stopped', port: 0, serviceImages: [], created: 100,
                lastBackup: null, lastStarted: 0, statusCondition: null, storedOn: SRC,
                currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
            },
        },
        userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, localEngineId)
    return h
}

const newInstanceIds = async () => fs.readdir(`${tgtRoot()}/instances`)

describe('installApp --name / --fresh (Kid, idea#235)', () => {
    describe('parseInstallAppArgs', () => {
        it('keeps a quoted name with a space as one value', () => {
            const p = parseInstallAppArgs('kolibri-1.0 DISK_x --source DISK_y --name "Kolibri Demo" --fresh')
            expect(p).toEqual({ appId: 'kolibri-1.0', targetDiskId: 'DISK_x', sourceDiskId: 'DISK_y', instanceName: 'Kolibri Demo', fresh: true })
        })
        it('parses unquoted lines as before (backward compatible)', () => {
            expect(parseInstallAppArgs('  kolibri-1.0   DISK_x  --name my-kolibri ')).toEqual(
                { appId: 'kolibri-1.0', targetDiskId: 'DISK_x', sourceDiskId: undefined, instanceName: 'my-kolibri', fresh: false })
            expect(parseInstallAppArgs('kolibri-1.0 DISK_x').instanceName).toBeUndefined()
        })
        it('refuses a missing value, a missing disk and an unexpected argument', () => {
            expect(() => parseInstallAppArgs('kolibri-1.0 DISK_x --name')).toThrow(/--name needs a value/)
            expect(() => parseInstallAppArgs('kolibri-1.0 DISK_x --name --fresh')).toThrow(/--name needs a value/)
            expect(() => parseInstallAppArgs('kolibri-1.0')).toThrow(/Usage: installApp/)
            expect(() => parseInstallAppArgs('kolibri-1.0 DISK_x --name Kolibri Demo')).toThrow(/unexpected argument 'Demo'/)
        })
        it('refuses an empty quoted name', () => {
            expect(() => parseInstallAppArgs('kolibri-1.0 DISK_x --name ""')).toThrow(/must not be empty/)
        })
    })

    describe('validateInstanceName', () => {
        it('accepts spaces, refuses blank, too long and control characters', () => {
            expect(validateInstanceName('Nextcloud Demo')).toBe('Nextcloud Demo')
            expect(validateInstanceName('x'.repeat(MAX_INSTANCE_NAME_LENGTH))).toHaveLength(MAX_INSTANCE_NAME_LENGTH)
            expect(() => validateInstanceName('   ')).toThrow(/must not be empty/)
            expect(() => validateInstanceName('x'.repeat(MAX_INSTANCE_NAME_LENGTH + 1))).toThrow(/longer than/)
            expect(() => validateInstanceName('Kolibri\nDemo')).toThrow(/control characters/)
            expect(() => validateInstanceName('Kolibri\tDemo')).toThrow(/control characters/)
            expect(() => validateInstanceName('Kolibri\u007fDemo')).toThrow(/control characters/)
        })
    })

    describe('installAppFromDisk', () => {
        let h: DocHandle<Store>
        beforeEach(async () => {
            setRootDeviceForTests('mmcblk-not-a-test-disk')
            await fs.remove(srcRoot()); await fs.remove(tgtRoot())
            await fs.ensureDir(`${srcRoot()}/apps/${APP}`)
            await fs.writeFile(`${srcRoot()}/apps/${APP}/compose.yaml`, COMPOSE)
            await fs.writeFile(`${srcRoot()}/apps/${APP}/idea-files-entrypoint.sh`, '#!/bin/sh\n')
            await fs.writeFile(`${srcRoot()}/apps/${APP}/usb-sync.sh`, '#!/bin/sh\n')
            await fs.ensureDir(`${srcRoot()}/apps/${APP}/docker-entrypoint-hooks.d/post-installation`)
            await fs.writeFile(`${srcRoot()}/apps/${APP}/docker-entrypoint-hooks.d/post-installation/10-x.sh`, 'echo\n')
            await fs.ensureDir(`${srcRoot()}/apps/${APP}/bundled-apps/files_usb`)
            await fs.writeFile(`${srcRoot()}/apps/${APP}/bundled-apps/files_usb/info.xml`, '<info/>')
            await fs.ensureDir(`${srcRoot()}/instances/${ORIG}/data/kolibri`)
            await fs.writeFile(`${srcRoot()}/instances/${ORIG}/data/kolibri/db.sqlite3`, 'school-data')
            await fs.writeFile(`${srcRoot()}/instances/${ORIG}/compose.yaml`, COMPOSE)
            await fs.writeFile(`${srcRoot()}/instances/${ORIG}/.env`, 'port=18080\n')
            await fs.ensureDir(tgtRoot())
            h = await makeHandle()
        })
        afterEach(async () => {
            setRootDeviceForTests(null)
            await fs.remove(srcRoot()); await fs.remove(tgtRoot())
        })

        it('writes the name into compose x-app.instanceName and the store; id/folder stay space-free', async () => {
            await installAppFromDisk(h, APP, h.doc().diskDB[SRC] as any, h.doc().diskDB[TGT] as any, 'Kolibri Demo' as any, { fresh: true })
            const [id] = await newInstanceIds()
            expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
            const compose = YAML.parse(await fs.readFile(`${tgtRoot()}/instances/${id}/compose.yaml`, 'utf8'))
            expect(compose['x-app'].instanceName).toBe('Kolibri Demo')
            // No top-level compose `name:` was added: the Docker project name stays the folder (the id)
            expect(compose.name).toBeUndefined()
            expect(compose['x-app'].name).toBe('kolibri')
            const rec = (h.doc().instanceDB as any)[id]
            expect(rec.name).toBe('Kolibri Demo')
            expect(rec.id).toBe(id)
        })

        it('--fresh copies the whole app bundle (entrypoints, hooks, bundled apps) and no source instance data', async () => {
            await installAppFromDisk(h, APP, h.doc().diskDB[SRC] as any, h.doc().diskDB[TGT] as any, 'Kolibri Demo' as any, { fresh: true })
            const [id] = await newInstanceIds()
            expect((await fs.readdir(`${tgtRoot()}/instances/${id}`)).sort()).toEqual(
                ['bundled-apps', 'compose.yaml', 'docker-entrypoint-hooks.d', 'idea-files-entrypoint.sh', 'usb-sync.sh'])
            expect(await fs.pathExists(`${tgtRoot()}/instances/${id}/data`)).toBe(false)
            expect(await fs.pathExists(`${tgtRoot()}/instances/${id}/.env`)).toBe(false)
        })

        it('--source on the target disk: the bundle is not copied onto itself and the install succeeds', async () => {
            await fs.ensureDir(`${tgtRoot()}/apps/${APP}`)
            await fs.writeFile(`${tgtRoot()}/apps/${APP}/compose.yaml`, COMPOSE)
            await fs.writeFile(`${tgtRoot()}/apps/${APP}/usb-sync.sh`, '#!/bin/sh\n')
            const tgt = h.doc().diskDB[TGT] as any
            await installAppFromDisk(h, APP, tgt, tgt, 'Nextcloud Demo' as any, { fresh: true })
            const ids = (await newInstanceIds())
            expect(ids).toHaveLength(1)
            expect((await fs.readdir(`${tgtRoot()}/instances/${ids[0]}`)).sort()).toEqual(['compose.yaml', 'usb-sync.sh'])
            expect((h.doc().instanceDB as any)[ids[0]].name).toBe('Nextcloud Demo')
        })

        it('without --fresh the source instance data is still copied (unchanged behaviour), with the new name', async () => {
            await installAppFromDisk(h, APP, h.doc().diskDB[SRC] as any, h.doc().diskDB[TGT] as any, 'Kolibri Copy' as any)
            const [id] = await newInstanceIds()
            expect(await fs.readFile(`${tgtRoot()}/instances/${id}/data/kolibri/db.sqlite3`, 'utf8')).toBe('school-data')
            expect(YAML.parse(await fs.readFile(`${tgtRoot()}/instances/${id}/compose.yaml`, 'utf8'))['x-app'].instanceName).toBe('Kolibri Copy')
        })
    })
})

describe('installApp: same-disk source, app id parsing, SHA refs (Kid, #221 live run)', () => {
    it('sameRealPath: same folder (also through a symlink) is detected, different or missing is not', async () => {
        const os = await import('os'); const path = await import('path')
        const d = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-same-'))
        await fs.ensureDir(`${d}/a/apps/x`); await fs.ensureDir(`${d}/b/apps/x`)
        await fs.symlink(`${d}/a`, `${d}/link`)
        expect(await sameRealPath(`${d}/a/apps/x`, `${d}/a/apps/x`)).toBe(true)
        expect(await sameRealPath(`${d}/a/apps/x`, `${d}/link/apps/x`)).toBe(true)
        expect(await sameRealPath(`${d}/a/apps/x`, `${d}/b/apps/x`)).toBe(false)
        expect(await sameRealPath(`${d}/a/apps/x`, `${d}/nope/apps/x`)).toBe(false)
        await fs.remove(d)
    })

    it('parseAppId: explicit <name>@<ref>, trailing SHA, and every existing id form', () => {
        const cases: Array<[string, string, string]> = [
            ['nextcloud@feat/nextcloud-demo', 'nextcloud', 'feat/nextcloud-demo'],
            ['nextcloud@21d7f75efaaa6590efb93098120626e677732903', 'nextcloud', '21d7f75efaaa6590efb93098120626e677732903'],
            ['kolibri-channel-builder@main', 'kolibri-channel-builder', 'main'],
            ['nextcloud-21d7f75efaaa6590efb93098120626e677732903', 'nextcloud', '21d7f75efaaa6590efb93098120626e677732903'],
            ['kolibri-channel-builder-2551b7d9830151ff0b9636a335f86cb7018b37d8', 'kolibri-channel-builder', '2551b7d9830151ff0b9636a335f86cb7018b37d8'],
            ['Seafile-f3817b7669269abe2dfd3bcc347d0db8d2033ad6', 'Seafile', 'f3817b7669269abe2dfd3bcc347d0db8d2033ad6'],
            ['nextcloud-1.0-31.0.1', 'nextcloud', '1.0-31.0.1'],
            ['kolibri-1.0-duration', 'kolibri', '1.0-duration'],
            ['kolibri-channel-builder-2.1-rc.1', 'kolibri-channel-builder', '2.1-rc.1'],
            ['kolibri-latest', 'kolibri', 'latest'],
        ]
        for (const [id, name, version] of cases) {
            expect(parseAppId(id)).toEqual({ name, version })
            expect(StoreExtractAppName(id as any)).toBe(name)
        }
    })

    it('diskAppId: <name>@<ref> becomes the folder-safe <name>-<ref>; other ids unchanged', () => {
        expect(diskAppId('nextcloud@feat/nextcloud-demo')).toBe('nextcloud-feat-nextcloud-demo')
        expect(diskAppId('nextcloud@21d7f75')).toBe('nextcloud-21d7f75')
        expect(diskAppId('kolibri-1.0')).toBe('kolibri-1.0')
    })

    it('isCommitSha: SHAs (7-40 hex) yes; branches, tags, latest no', () => {
        expect(isCommitSha('21d7f75')).toBe(true)
        expect(isCommitSha('21d7f75efaaa6590efb93098120626e677732903')).toBe(true)
        for (const r of ['main', 'feat/nextcloud-demo', '1.0', 'latest', 'abc', 'DEADBEEF1']) expect(isCommitSha(r)).toBe(false)
    })
})
