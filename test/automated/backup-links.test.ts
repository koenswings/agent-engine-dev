/**
 * backup-links.test.ts (idea#451)
 *
 * addBackupLink / removeBackupLink: edit one link in BACKUP.yaml without rewriting
 * the others, plus the createBackupDisk lastBackup fix. Agreed approach: idea#451
 * body and Steve's decisions (issuecomment-6847233193).
 *
 * No hardware: a Backup Disk is a <DISKS_ROOT>/<device>/ folder under the private
 * per-run mount root, its state is set up in the store. processDisk is wrapped in a
 * spy that calls the real one, so "not called" is checked without changing behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { fs, YAML } from 'zx'
import { createHash } from 'crypto'

vi.mock('../../src/data/Disk.js', async (importOriginal) => {
    const actual = await importOriginal<any>()
    return { ...actual, processDisk: vi.fn((...args: any[]) => actual.processDisk(...args)) }
})

import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { DiskID, DiskName, EngineID, InstanceID, Timestamp } from '../../src/data/CommonTypes.js'
import { processDisk } from '../../src/data/Disk.js'
import { commands } from '../../src/data/Commands.js'
import { createBackupDiskConfig } from '../../src/monitors/backupMonitor.js'
import { addBackupLink, removeBackupLink, backupLinkIo, BACKUP_LINK_NEXT_BACKUP_NOTE } from '../../src/data/BackupLinks.js'
import { resourceLock, diskKey } from '../../src/utils/ResourceLock.js'
import { DISKS_ROOT, uniqueTestDevice } from '../harness/diskSim.js'

const A = 'inst-link-a' as InstanceID
const B = 'inst-link-b' as InstanceID
const C = 'inst-link-c' as InstanceID
const GONE = 'inst-link-gone' as InstanceID
const REMOTE = 'inst-link-remote' as InstanceID
const OTHER_ENGINE = 'ENGINE_other-pi' as EngineID

const BASE_YAML = `# Backup Disk config, edited by hand on purpose
mode: immediate
links:
  - instanceId: ${A}
    lastBackup: 1762900000111
  - instanceId: ${B}
    lastBackup: 1762900000222
schedule:
  daily: "02:30"
futureKey:
  nested: [1, 2]
`

let h: DocHandle<Store>
let backupDev: string
let appDev: string
const BACKUP_DISK = 'disk-backup-451' as DiskID
const APP_DISK = 'disk-app-451' as DiskID
const REMOTE_DISK = 'disk-remote-451' as DiskID

const yamlPath = () => `${DISKS_ROOT}/${backupDev}/BACKUP.yaml`
const sha = async (): Promise<string> => createHash('sha256').update(await fs.readFile(yamlPath())).digest('hex')
const readYaml = async (): Promise<any> => YAML.parse(await fs.readFile(yamlPath(), 'utf-8'))
const storeConfig = (): string => JSON.stringify(h.doc().diskDB[BACKUP_DISK]?.backupConfig ?? null)

const createMinimalStore = async (): Promise<DocHandle<Store>> => {
    const repo = new Repo({ network: [], storage: undefined })
    const handle = repo.create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as unknown as Store)
    await handle.whenReady()
    await createOrUpdateEngine(handle, localEngineId)
    return handle
}

const putDisk = (id: DiskID, device: string | null, types: string[], dockedTo: EngineID = localEngineId as EngineID, name?: string) => {
    h.change(doc => {
        doc.diskDB[id] = {
            id, name: (name ?? `${id}-name`) as DiskName, device: device as any, dockedTo,
            created: Date.now() as Timestamp, lastDocked: Date.now() as Timestamp,
            diskTypes: types as any,
            backupConfig: types.includes('backup') ? { mode: 'immediate', links: [A, B] } : null,
        } as any
    })
}

const putInstance = (id: InstanceID, name: string, diskId: DiskID) => {
    h.change(doc => {
        doc.instanceDB[id] = {
            id, instanceOf: 'sample-app' as any, name: name as any, status: 'Running' as any,
            port: 8080 as any, serviceImages: [], created: Date.now() as Timestamp, lastBackup: null,
            lastStarted: Date.now() as Timestamp, statusCondition: null, storedOn: diskId,
            currentStep: null, totalSteps: null, stepLabel: null, metrics: null,
        } as any
    })
}

const expectRefusal = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toThrow(new RegExp(`^${code}: `))
}

/** Every refusal: the file bytes, the store config and the disk lock are unchanged. */
const refusesWithNothingWritten = async (run: () => Promise<unknown>, code: string) => {
    const before = await fs.pathExists(yamlPath()) ? await sha() : null
    const config = storeConfig()
    await expectRefusal(run(), code)
    expect(await fs.pathExists(yamlPath()) ? await sha() : null).toBe(before)
    expect(storeConfig()).toBe(config)
    expect(resourceLock.isLocked(diskKey(BACKUP_DISK))).toBe(false)
    expect((await fs.readdir(`${DISKS_ROOT}/${backupDev}`)).filter(f => f.includes('.tmp-'))).toEqual([])
}

beforeEach(async () => {
    vi.mocked(processDisk).mockClear()
    backupLinkIo.rename = (from: string, to: string) => fs.rename(from, to)
    h = await createMinimalStore()
    backupDev = uniqueTestDevice()
    appDev = uniqueTestDevice()
    await fs.ensureDir(`${DISKS_ROOT}/${backupDev}`)
    await fs.ensureDir(`${DISKS_ROOT}/${appDev}`)
    await fs.writeFile(yamlPath(), BASE_YAML)
    putDisk(BACKUP_DISK, backupDev, ['backup'])
    putDisk(APP_DISK, appDev, ['app'])
    putDisk(REMOTE_DISK, 'sdq9', ['app'], OTHER_ENGINE)
    putInstance(A, 'alpha', APP_DISK)
    putInstance(B, 'bravo', APP_DISK)
    putInstance(C, 'charlie', APP_DISK)
    putInstance(REMOTE, 'remote', REMOTE_DISK)
})

afterEach(() => {
    resourceLock.releaseAll([diskKey(BACKUP_DISK)])
})

describe('registration and capability (idea#451)', () => {
    it('advertises backupLinks, separate from backupVerify', () => {
        expect(ENGINE_CAPABILITIES).toContain('backupLinks')
        expect(ENGINE_CAPABILITIES).toContain('backupVerify')
    })

    it('registers both commands with instanceName + backupDiskId trace args, engine scope', () => {
        for (const name of ['addBackupLink', 'removeBackupLink']) {
            const def = commands.find(c => c.name === name)
            expect(def, name).toBeDefined()
            expect(def!.scope).toBe('engine')
            expect(def!.args.map((a: any) => a.name)).toEqual(['instanceName', 'backupDiskId'])
        }
    })
})

describe('addBackupLink (idea#451)', () => {
    it('appends one link and keeps mode, the other links lastBackup, order and unknown keys', async () => {
        const before = await readYaml()
        const r = await addBackupLink(h, 'charlie', BACKUP_DISK)
        expect(r).toEqual({ backupDiskId: BACKUP_DISK, instanceId: C, links: [A, B, C], added: true, note: BACKUP_LINK_NEXT_BACKUP_NOTE })

        const after = await readYaml()
        expect(Object.keys(after)).toEqual(Object.keys(before))
        expect(after.mode).toBe('immediate')
        expect(after.schedule).toEqual({ daily: '02:30' })
        expect(after.futureKey).toEqual({ nested: [1, 2] })
        expect(after.links).toEqual([...before.links, { instanceId: C, lastBackup: 0 }])
        expect(await fs.readFile(yamlPath(), 'utf-8')).toContain('# Backup Disk config, edited by hand on purpose')

        expect(h.doc().diskDB[BACKUP_DISK].backupConfig).toEqual({ mode: 'immediate', links: [A, B, C] })
        expect(processDisk).not.toHaveBeenCalled()
        expect(Object.values(h.doc().operationDB ?? {}).filter((o: any) => o?.kind === 'backupApp')).toEqual([])
        expect(resourceLock.isLocked(diskKey(BACKUP_DISK))).toBe(false)
    })

    it('accepts the instance id and a disk given by name', async () => {
        await addBackupLink(h, C, `${BACKUP_DISK}-name`)
        expect((await readYaml()).links.map((l: any) => l.instanceId)).toEqual([A, B, C])
    })

    it('turns an empty flow list into a block list', async () => {
        await fs.writeFile(yamlPath(), 'mode: on-demand\nlinks: []\n')
        await addBackupLink(h, C, BACKUP_DISK)
        expect(await readYaml()).toEqual({ mode: 'on-demand', links: [{ instanceId: C, lastBackup: 0 }] })
    })

    it('is not blocked by a recorded stale lock (BUSY only, Steve decision 5)', async () => {
        h.change(doc => { doc.diskDB[BACKUP_DISK].backupStaleLocks = [{ instanceId: C, startedAt: null, detectedAt: Date.now() as Timestamp }] as any })
        await fs.ensureDir(`${DISKS_ROOT}/${backupDev}/backups/${C}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDev}/backups/${C}/.backup-in-progress`, '{}')
        const r = await addBackupLink(h, C, BACKUP_DISK)
        expect(r.added).toBe(true)
    })

    it('refuses ALREADY_LINKED', async () => {
        await refusesWithNothingWritten(() => addBackupLink(h, A, BACKUP_DISK), 'ALREADY_LINKED')
    })

    it('refuses INSTANCE_NOT_FOUND for an unknown instance and for one on another Engine (local-only)', async () => {
        await refusesWithNothingWritten(() => addBackupLink(h, 'nope', BACKUP_DISK), 'INSTANCE_NOT_FOUND')
        await refusesWithNothingWritten(() => addBackupLink(h, GONE, BACKUP_DISK), 'INSTANCE_NOT_FOUND')
        await refusesWithNothingWritten(() => addBackupLink(h, REMOTE, BACKUP_DISK), 'INSTANCE_NOT_FOUND')
    })

    it('refuses AMBIGUOUS for an instance name shared on this Engine', async () => {
        putInstance('inst-link-c2' as InstanceID, 'charlie', APP_DISK)
        await refusesWithNothingWritten(() => addBackupLink(h, 'charlie', BACKUP_DISK), 'AMBIGUOUS')
    })
})

describe('removeBackupLink (idea#451)', () => {
    it('removes a raw id that is not in instanceDB and leaves backups/<id>/ in place', async () => {
        await fs.writeFile(yamlPath(), BASE_YAML.replace(`  - instanceId: ${B}`, `  - instanceId: ${GONE}\n    lastBackup: 5\n  - instanceId: ${B}`))
        h.change(doc => { doc.diskDB[BACKUP_DISK].backupConfig!.links.push(GONE) })
        const repo = `${DISKS_ROOT}/${backupDev}/backups/${GONE}`
        await fs.ensureDir(repo)
        await fs.writeFile(`${repo}/config`, 'repo')
        expect(h.doc().instanceDB[GONE]).toBeUndefined()

        const r = await removeBackupLink(h, GONE, BACKUP_DISK)
        expect(r).toEqual({ backupDiskId: BACKUP_DISK, instanceId: GONE, links: [A, B], removed: true, repoLeft: repo })
        const after = await readYaml()
        expect(after.links).toEqual([{ instanceId: A, lastBackup: 1762900000111 }, { instanceId: B, lastBackup: 1762900000222 }])
        expect(after.schedule).toEqual({ daily: '02:30' })
        expect(after.futureKey).toEqual({ nested: [1, 2] })
        expect(after.mode).toBe('immediate')
        expect(await fs.readFile(`${repo}/config`, 'utf-8')).toBe('repo')
        expect(h.doc().diskDB[BACKUP_DISK].backupConfig).toEqual({ mode: 'immediate', links: [A, B] })
        expect(processDisk).not.toHaveBeenCalled()
        expect(resourceLock.isLocked(diskKey(BACKUP_DISK))).toBe(false)
    })

    it('removes by instance name, keeps the other link and reports repoLeft null without a repo', async () => {
        const r = await removeBackupLink(h, 'alpha', BACKUP_DISK)
        expect(r.instanceId).toBe(A)
        expect(r.repoLeft).toBeNull()
        expect((await readYaml()).links).toEqual([{ instanceId: B, lastBackup: 1762900000222 }])
        expect(h.doc().diskDB[BACKUP_DISK].backupConfig!.links).toEqual([B])
    })

    it('refuses NOT_LINKED for an unknown raw id and for a known but unlinked instance', async () => {
        await refusesWithNothingWritten(() => removeBackupLink(h, 'never-linked', BACKUP_DISK), 'NOT_LINKED')
        await refusesWithNothingWritten(() => removeBackupLink(h, C, BACKUP_DISK), 'NOT_LINKED')
    })

    it('refuses BACKUP_IN_PROGRESS while the lock file exists', async () => {
        await fs.ensureDir(`${DISKS_ROOT}/${backupDev}/backups/${A}`)
        await fs.writeFile(`${DISKS_ROOT}/${backupDev}/backups/${A}/.backup-in-progress`, '{"startedAt":1}')
        await refusesWithNothingWritten(() => removeBackupLink(h, A, BACKUP_DISK), 'BACKUP_IN_PROGRESS')
    })

    it('refuses BACKUP_IN_PROGRESS while the instance is in Disk.backupStaleLocks', async () => {
        h.change(doc => { doc.diskDB[BACKUP_DISK].backupStaleLocks = [{ instanceId: A, startedAt: null, detectedAt: Date.now() as Timestamp }] as any })
        await refusesWithNothingWritten(() => removeBackupLink(h, A, BACKUP_DISK), 'BACKUP_IN_PROGRESS')
    })
})

describe('refusals shared by both commands (idea#451)', () => {
    const both: Array<[string, (disk: string) => Promise<unknown>]> = [
        ['addBackupLink', (disk) => addBackupLink(h, C, disk)],
        ['removeBackupLink', (disk) => removeBackupLink(h, A, disk)],
    ]

    for (const [name, run] of both) {
        it(`${name}: NOT_DOCKED for an undocked, unknown or remote disk`, async () => {
            await refusesWithNothingWritten(() => run('disk-unknown'), 'NOT_DOCKED')
            h.change(doc => { doc.diskDB[BACKUP_DISK].dockedTo = OTHER_ENGINE })
            await refusesWithNothingWritten(() => run(BACKUP_DISK), 'NOT_DOCKED')
            h.change(doc => { doc.diskDB[BACKUP_DISK].dockedTo = localEngineId as EngineID; doc.diskDB[BACKUP_DISK].device = null as any })
            await refusesWithNothingWritten(() => run(BACKUP_DISK), 'NOT_DOCKED')
        })

        it(`${name}: AMBIGUOUS for a disk name docked twice here`, async () => {
            putDisk('disk-twin-451' as DiskID, uniqueTestDevice(), ['backup'], localEngineId as EngineID, `${BACKUP_DISK}-name`)
            await refusesWithNothingWritten(() => run(`${BACKUP_DISK}-name`), 'AMBIGUOUS')
        })

        it(`${name}: SYSTEM_DISK`, async () => {
            h.change(doc => { doc.diskDB[BACKUP_DISK].diskTypes = ['system', 'backup'] as any })
            await refusesWithNothingWritten(() => run(BACKUP_DISK), 'SYSTEM_DISK')
        })

        it(`${name}: NOT_A_BACKUP_DISK`, async () => {
            h.change(doc => { doc.diskDB[BACKUP_DISK].diskTypes = ['app'] as any })
            await refusesWithNothingWritten(() => run(BACKUP_DISK), 'NOT_A_BACKUP_DISK')
        })

        it(`${name}: BUSY while the disk lock is held (a backupApp holds it)`, async () => {
            expect(resourceLock.acquire(diskKey(BACKUP_DISK), 'backupApp')).toBe(true)
            const before = await sha()
            const config = storeConfig()
            await expectRefusal(run(BACKUP_DISK), 'BUSY')
            expect(await sha()).toBe(before)
            expect(storeConfig()).toBe(config)
            expect(resourceLock.getLockInfo(diskKey(BACKUP_DISK))?.kind).toBe('backupApp')
        })

        it(`${name}: BUSY while a backupApp to this disk is Running`, async () => {
            h.change(doc => {
                (doc as any).operationDB['op-451'] = {
                    id: 'op-451', kind: 'backupApp', status: 'Running', args: { instanceId: B, backupDiskId: BACKUP_DISK },
                    createdAt: Date.now(), cause: 'console-command',
                }
            })
            await refusesWithNothingWritten(() => run(BACKUP_DISK), 'BUSY')
        })

        it(`${name}: BAD_BACKUP_YAML for a missing, unparsable or wrongly shaped file`, async () => {
            for (const text of ['mode: [unclosed\n', '- just\n- a list\n', 'links:\n  - instanceId: x\n', 'mode: immediate\nlinks: nope\n', 'mode: immediate\nlinks:\n  - lastBackup: 3\n']) {
                await fs.writeFile(yamlPath(), text)
                await refusesWithNothingWritten(() => run(BACKUP_DISK), 'BAD_BACKUP_YAML')
            }
            await fs.remove(yamlPath())
            await refusesWithNothingWritten(() => run(BACKUP_DISK), 'BAD_BACKUP_YAML')
            expect(await fs.pathExists(yamlPath())).toBe(false)
        })

        it(`${name}: a failure between the temp write and the rename leaves the old file`, async () => {
            backupLinkIo.rename = async () => { throw new Error('simulated rename failure') }
            const before = await sha()
            const config = storeConfig()
            await expect(run(BACKUP_DISK)).rejects.toThrow('simulated rename failure')
            expect(await sha()).toBe(before)
            expect(storeConfig()).toBe(config)
            expect((await fs.readdir(`${DISKS_ROOT}/${backupDev}`)).filter(f => f.includes('.tmp-'))).toEqual([])
            expect(resourceLock.isLocked(diskKey(BACKUP_DISK))).toBe(false)
        })
    }
})

describe('createBackupDisk keeps lastBackup of links it keeps (idea#451, Steve decision 6)', () => {
    it('kept links keep their lastBackup, new links start at 0, dropped links go, processDisk still runs', async () => {
        const disk = h.doc().diskDB[BACKUP_DISK] as any
        await createBackupDiskConfig(h, disk, 'on-demand', [A, C])
        // idea#400 PR B: createBackupDisk edits an existing BACKUP.yaml as a document, so
        // the schedule and unknown keys stay (mode and links are replaced as before).
        expect((await readYaml())).toEqual({
            mode: 'on-demand',
            links: [{ instanceId: A, lastBackup: 1762900000111 }, { instanceId: C, lastBackup: 0 }],
            schedule: { daily: '02:30' },
            futureKey: { nested: [1, 2] },
        })
        expect(processDisk).toHaveBeenCalledTimes(1)
        expect(h.doc().diskDB[BACKUP_DISK].backupConfig).toEqual({ mode: 'on-demand', links: [A, C], schedule: { daily: '02:30' }, scheduleError: null })
    })

    it('starts every link at 0 on a disk without a readable BACKUP.yaml', async () => {
        await fs.remove(yamlPath())
        await createBackupDiskConfig(h, h.doc().diskDB[BACKUP_DISK] as any, 'on-demand', [A])
        expect((await readYaml()).links).toEqual([{ instanceId: A, lastBackup: 0 }])
    })
})
