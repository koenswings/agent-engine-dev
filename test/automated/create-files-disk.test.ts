/**
 * create-files-disk.test.ts (idea#131, Files Disk step 1)
 *
 * createFilesDisk <diskId> [<shareName…>] end to end through handleCommand:
 *   - success on an empty disk, an App Disk, a Backup Disk and an App + Backup
 *     disk: disk ID kept, apps/ instances/ services/ backups/ untouched,
 *     diskTypes gains 'files', FILES.yaml and an empty files/
 *   - a root-owned disk: exactly `/usr/bin/chown -h pi:pi <root>`, with the previous
 *     uid:gid and mode in the trace before it; chown only when the root isn't writable
 *   - refusals (trace `error`, args.diskId recorded): unknown ID, a disk name,
 *     undocked, docked elsewhere, system disk, not processed, already a Files
 *     Disk, Upgrade Disk, non-IDEA root entries (a stray files/ too), non-ext4,
 *     missing sudoers entry, unwritable after chown, locked disk, running backup,
 *     erase in progress, bad share names; nothing is written on a refusal
 *   - the share name: default "School Files", rest of the line ("My Share (2)"),
 *     never a filesystem label
 *   - the only chown in the Engine's code
 *
 * Disks are folders under the private DISKS_ROOT; the ext4 check and chown are
 * replaced with setFilesDiskOpsForTests. Nothing touches a real disk or sudo.
 */

import { describe, it, beforeAll, beforeEach, afterEach, expect, vi } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { $, fs, path, YAML } from 'zx'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId } from '../../src/data/Engine.js'
import { commands } from '../../src/data/Commands.js'
import { handleCommand } from '../../src/utils/commandUtils.js'
import { CommandLogStore, CommandTrace } from '../../src/data/CommandLogStore.js'
import { DeviceName, DiskID, DiskName, DiskType, EngineID, Timestamp } from '../../src/data/CommonTypes.js'
import { SUDO_CHOWN, SUDO_CHOWN_ROOT, chownRootCommand, runSudoChownRoot, setFilesDiskOpsForTests, MISSING_PERMISSION_MESSAGE } from '../../src/data/CreateFilesDisk.js'
import { resourceLock, diskKey } from '../../src/utils/ResourceLock.js'
import { initCommandLogger } from '../../src/utils/CommandLogger.js'
import { DISKS_ROOT, FIXTURES_DIR, uniqueTestDevice } from '../harness/diskSim.js'

const LOCAL = localEngineId as EngineID
const OTHER = 'ENGINE_other-engine-000000' as EngineID
const ROOT = process.cwd()

const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}
const newLog = (): DocHandle<CommandLogStore> =>
    new Repo({ network: [], storage: undefined }).create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
const lastTrace = (h: DocHandle<CommandLogStore>): CommandTrace => {
    const ids = h.doc()!.recentTraceIds
    return h.doc()!.traces[ids[ids.length - 1]]
}
const traceText = (t: CommandTrace): string => (t.logs ?? []).map(l => l.message).join('\n')

/** Recursive listing with file contents, to prove folders were not touched. */
const snapshot = async (dir: string): Promise<string> => {
    if (!(await fs.pathExists(dir))) return '(absent)'
    const out: string[] = []
    const walk = async (d: string) => {
        for (const e of (await fs.readdir(d)).sort()) {
            const p = path.join(d, e)
            const st = await fs.lstat(p)
            if (st.isDirectory()) { out.push(`${path.relative(dir, p)}/ ${st.mode.toString(8)}`); await walk(p) }
            else out.push(`${path.relative(dir, p)} ${st.mode.toString(8)} ${await fs.readFile(p, 'utf8')}`)
        }
    }
    await walk(dir)
    return out.join('\n')
}

describe('createFilesDisk <diskId> [<shareName…>] (idea#131)', () => {
    let h: DocHandle<Store>
    // One command log for the file: console capture (initCommandLogger) writes into it
    const logH: DocHandle<CommandLogStore> = newLog()
    beforeAll(() => { initCommandLogger(logH) })
    let chown: ReturnType<typeof vi.fn<(mountPoint: string) => Promise<void>>>
    const roots: string[] = []
    let errSpy: ReturnType<typeof vi.spyOn>

    const run = async (cmd: string): Promise<CommandTrace> => {
        await handleCommand(commands, h, 'engine', cmd, logH)
        return lastTrace(logH)
    }
    /** A disk folder with the given root entries, registered as docked here. */
    const disk = async (id: string, types: DiskType[], setup: (root: string) => Promise<void> = async () => {}, opts: { dockedTo?: EngineID | null, device?: string | null, meta?: boolean } = {}) => {
        const device = opts.device === undefined ? uniqueTestDevice() : opts.device
        const root = `${DISKS_ROOT}/${device}`
        roots.push(root)
        await fs.ensureDir(root)
        if (opts.meta !== false) await fs.writeFile(`${root}/META.yaml`, YAML.stringify({ diskId: id, isHardwareId: false, diskName: `Disk ${id}`, created: 1, lastDocked: 1 }))
        await setup(root)
        h.change(doc => {
            doc.diskDB[id as DiskID] = {
                id: id as DiskID, name: `Disk ${id}` as DiskName, device: device as DeviceName | null,
                dockedTo: opts.dockedTo === undefined ? LOCAL : opts.dockedTo,
                created: 1 as Timestamp, lastDocked: 1 as Timestamp, diskTypes: types, backupConfig: null,
            }
        })
        return root
    }
    const appRoot = async (r: string) => {
        await fs.copy(path.join(FIXTURES_DIR, 'disk-files-app/apps'), `${r}/apps`)
        await fs.ensureDir(`${r}/instances`)
        await fs.ensureDir(`${r}/services`)
        await fs.writeFile(`${r}/services/image.tar`, 'not a real image')
    }
    const backupRoot = async (r: string) => {
        await fs.writeFile(`${r}/BACKUP.yaml`, 'mode: on-demand\nlinks: []\n')
        await fs.ensureDir(`${r}/backups/inst-1`)
        await fs.writeFile(`${r}/backups/inst-1/config`, 'borg repo stand-in')
    }
    const expectRefused = async (cmd: string, message: RegExp, root?: string, diskId?: string) => {
        const before = root ? await snapshot(root) : ''
        const t = await run(cmd)
        expect(t.command).toBe('createFilesDisk')
        expect(t.status).toBe('error')
        expect(t.errorMessage).toMatch(message)
        expect(JSON.parse(t.args).diskId).toBe(diskId ?? cmd.split(' ')[1])
        if (root) expect(await snapshot(root)).toBe(before)
        return t
    }

    beforeEach(async () => {
        h = await newStore()
        chown = vi.fn<(mountPoint: string) => Promise<void>>(async () => { throw new Error('chown must not be called') })
        setFilesDiskOpsForTests({ fsType: async () => 'ext4', chownRoot: chown })
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(async () => {
        setFilesDiskOpsForTests(null)
        errSpy.mockRestore()
        for (const r of roots.splice(0)) { await fs.chmod(r, 0o755).catch(() => {}); await fs.remove(r) }
    })

    // ── success ──────────────────────────────────────────────────────────────

    it('empty disk: default share "School Files", FILES.yaml + empty files/, [files], disk ID and META kept, no chown', async () => {
        const root = await disk('e-1', ['empty'])
        const meta = await fs.readFile(`${root}/META.yaml`, 'utf8')
        const t = await run('createFilesDisk e-1')
        expect(t.status, t.errorMessage ?? '').toBe('ok')
        expect(JSON.parse(t.args)).toEqual({ diskId: 'e-1', shareName: [] })
        const y = YAML.parse(await fs.readFile(`${root}/FILES.yaml`, 'utf8'))
        expect(y).toMatchObject({ version: 1, createdBy: LOCAL, shareName: 'School Files', readOnly: false, password: null })
        expect(typeof y.created).toBe('number')
        expect(await fs.readdir(`${root}/files`)).toEqual([])
        expect((await fs.readdir(root)).sort()).toEqual(['FILES.yaml', 'META.yaml', 'files'])
        expect(await fs.readFile(`${root}/META.yaml`, 'utf8')).toBe(meta)
        const d = h.doc()!.diskDB['e-1' as DiskID]
        expect([...d.diskTypes]).toEqual(['files'])
        expect({ ...d.filesConfig }).toEqual({ shareName: 'School Files', readOnly: false, passwordProtected: false, error: null })
        expect(d.name).toBe('Disk e-1')
        expect(d.sizeBytes).toBeGreaterThan(0)
        expect(chown).not.toHaveBeenCalled()
    })

    it('App Disk: the share name takes the rest of the line; apps/ instances/ services/ untouched; [app, files]', async () => {
        const root = await disk('a-1', ['app'], appRoot)
        const before = { apps: await snapshot(`${root}/apps`), instances: await snapshot(`${root}/instances`), services: await snapshot(`${root}/services`) }
        const t = await run('createFilesDisk a-1 My Share (2)')
        expect(t.status, t.errorMessage ?? '').toBe('ok')
        expect(JSON.parse(t.args)).toEqual({ diskId: 'a-1', shareName: ['My', 'Share', '(2)'] })
        expect(YAML.parse(await fs.readFile(`${root}/FILES.yaml`, 'utf8')).shareName).toBe('My Share (2)')
        expect(await snapshot(`${root}/apps`)).toBe(before.apps)
        expect(await snapshot(`${root}/instances`)).toBe(before.instances)
        expect(await snapshot(`${root}/services`)).toBe(before.services)
        const d = h.doc()!.diskDB['a-1' as DiskID]
        expect([...d.diskTypes]).toEqual(['app', 'files'])
        expect(d.filesConfig?.shareName).toBe('My Share (2)')
        expect(h.doc()!.appDB['sample-files-1.0' as any]).toBeDefined()
    })

    it('Backup Disk: BACKUP.yaml and backups/ untouched; [backup, files]', async () => {
        const root = await disk('b-1', ['backup'], backupRoot)
        const before = { yaml: await fs.readFile(`${root}/BACKUP.yaml`, 'utf8'), backups: await snapshot(`${root}/backups`) }
        const t = await run('createFilesDisk b-1 Backup_Share')
        expect(t.status, t.errorMessage ?? '').toBe('ok')
        expect(await fs.readFile(`${root}/BACKUP.yaml`, 'utf8')).toBe(before.yaml)
        expect(await snapshot(`${root}/backups`)).toBe(before.backups)
        const d = h.doc()!.diskDB['b-1' as DiskID]
        expect([...d.diskTypes]).toEqual(['backup', 'files'])
        expect(d.backupConfig?.mode).toBe('on-demand')
    })

    it('App + Backup disk: [app, backup, files], disk ID kept', async () => {
        const root = await disk('ab-1', ['app', 'backup'], async r => { await appRoot(r); await backupRoot(r) })
        const t = await run('createFilesDisk ab-1')
        expect(t.status, t.errorMessage ?? '').toBe('ok')
        expect([...h.doc()!.diskDB['ab-1' as DiskID].diskTypes]).toEqual(['app', 'backup', 'files'])
        expect(YAML.parse(await fs.readFile(`${root}/META.yaml`, 'utf8')).diskId).toBe('ab-1')
        expect(Object.keys(h.doc()!.diskDB)).toEqual(['ab-1'])
    })

    it('META.yaml missing: written with the existing disk ID', async () => {
        const root = await disk('m-1', ['empty'], async () => {}, { meta: false })
        const t = await run('createFilesDisk m-1')
        expect(t.status, t.errorMessage ?? '').toBe('ok')
        const meta = YAML.parse(await fs.readFile(`${root}/META.yaml`, 'utf8'))
        expect(meta.diskId).toBe('m-1')
        expect(meta.diskName).toBe('Disk m-1')
    })

    it('root-owned App Disk: previous uid:gid and mode in the trace, then exactly /usr/bin/chown -h pi:pi <root>', async () => {
        const root = await disk('ro-1', ['app'], appRoot)
        await fs.chmod(root, 0o555)
        const calls: string[] = []
        chown.mockImplementation(async (mp: string) => { calls.push(chownRootCommand(mp)); await fs.chmod(mp, 0o755) })
        setFilesDiskOpsForTests({ fsType: async () => 'ext4', chownRoot: chown, rootOwner: async () => ({ uid: 0, gid: 0, mode: 0o755 }) })
        const t = await run('createFilesDisk ro-1')
        expect(t.status, t.errorMessage ?? '').toBe('ok')
        expect(chown).toHaveBeenCalledTimes(1)
        expect(calls).toEqual([`/usr/bin/chown -h pi:pi ${root}`])
        const text = traceText(t)
        expect(text).toContain(`Previous owner uid:gid 0:0, mode 0755. Running: sudo /usr/bin/chown -h pi:pi ${root}`)
        expect(text.indexOf('Previous owner')).toBeLessThan(text.indexOf('is now owned by pi:pi'))
        expect([...h.doc()!.diskDB['ro-1' as DiskID].diskTypes]).toEqual(['app', 'files'])
    })

    it('root-owned empty disk (real unwritable folder): the real previous owner and mode are recorded', async () => {
        const root = await disk('ro-2', ['empty'])
        await fs.chmod(root, 0o555)
        chown.mockImplementation(async (mp: string) => { await fs.chmod(mp, 0o755) })
        const t = await run('createFilesDisk ro-2')
        expect(t.status, t.errorMessage ?? '').toBe('ok')
        expect(chown).toHaveBeenCalledWith(root)
        expect(traceText(t)).toContain(`Previous owner uid:gid ${process.getuid!()}:${process.getgid!()}, mode 0555`)
    })

    // ── refusals ─────────────────────────────────────────────────────────────

    it('unknown ID, a disk name (no name fallback), undocked, docked elsewhere', async () => {
        const root = await disk('n-1', ['empty'])
        await disk('gone-1', ['empty'], async () => {}, { dockedTo: null, device: null })
        const remote = await disk('r-1', ['empty'], async () => {}, { dockedTo: OTHER })
        await expectRefused('createFilesDisk no-such-disk', /Disk 'no-such-disk' not found/)
        await expectRefused('createFilesDisk Disk n-1', /Disk 'Disk' not found/, root, 'Disk')
        await expectRefused('createFilesDisk gone-1', /not currently docked/)
        await expectRefused('createFilesDisk r-1', /not docked to this engine/, remote)
    })

    it('system disk', async () => {
        const root = await disk('sys-1', ['system'])
        await expectRefused('createFilesDisk sys-1', /system disk/, root)
    })

    it('already a Files Disk (by type or by FILES.yaml), an Upgrade Disk, a disk not processed yet', async () => {
        const f1 = await disk('f-1', ['app', 'files'], appRoot)
        const f2 = await disk('f-2', ['empty'], async r => { await fs.writeFile(`${r}/FILES.yaml`, 'version: 1\n') })
        const up = await disk('up-1', ['upgrade'])
        const np = await disk('np-1', [])
        await expectRefused('createFilesDisk f-1', /Disk f-1 is already a Files Disk/, f1)
        await expectRefused('createFilesDisk f-2', /Disk f-2 is already a Files Disk/, f2)
        await expectRefused('createFilesDisk up-1', /Upgrade Disk/, up)
        await expectRefused('createFilesDisk np-1', /has not been processed yet/, np)
    })

    it('non-IDEA root entries, including a stray files/ and App folders on a Backup-only disk', async () => {
        const o1 = await disk('o-1', ['empty'], async r => { await fs.writeFile(`${r}/holiday.jpg`, 'x') })
        const o2 = await disk('o-2', ['app'], async r => { await appRoot(r); await fs.ensureDir(`${r}/files`) })
        const o3 = await disk('o-3', ['backup'], async r => { await backupRoot(r); await fs.ensureDir(`${r}/apps`) })
        await expectRefused('createFilesDisk o-1', /Disk o-1 has other files on it \(holiday\.jpg\)\. Use Make this a Files Disk to erase it, or empty it on another computer\./, o1)
        await expectRefused('createFilesDisk o-2', /has other files on it \(files\)/, o2)
        await expectRefused('createFilesDisk o-3', /has other files on it \(apps\)/, o3)
    })

    it('non-ext4', async () => {
        const root = await disk('v-1', ['empty'])
        setFilesDiskOpsForTests({ fsType: async () => 'vfat', chownRoot: chown })
        await expectRefused('createFilesDisk v-1', /not an ext4 disk \(filesystem: vfat\)/, root)
    })

    it('missing sudoers entry: a clear error and nothing written', async () => {
        const root = await disk('p-1', ['empty'])
        await fs.chmod(root, 0o555)
        chown.mockImplementation(async () => { const e: any = new Error('exit 1'); e.stderr = 'sudo: a password is required'; throw e })
        const t = await expectRefused('createFilesDisk p-1', new RegExp(`${MISSING_PERMISSION_MESSAGE}.*a password is required.*Nothing was written`), root)
        expect(traceText(t)).toContain('Previous owner')
    })

    it('still unwritable after chown: nothing written', async () => {
        const root = await disk('w-1', ['empty'])
        await fs.chmod(root, 0o555)
        chown.mockImplementation(async () => {})
        await expectRefused('createFilesDisk w-1', /not writable by the Engine\. Nothing was written/, root)
        expect(chown).toHaveBeenCalledTimes(1)
    })

    it('locked disk and running backup: refused before any chown', async () => {
        const l1 = await disk('l-1', ['empty'])
        await fs.chmod(l1, 0o555)
        resourceLock.acquire(diskKey('l-1'), 'restoreApp')
        try {
            await expectRefused('createFilesDisk l-1', /locked by an active 'restoreApp' operation/, l1)
        } finally { resourceLock.release(diskKey('l-1')) }
        const b1 = await disk('bk-1', ['backup'], backupRoot)
        h.change(doc => {
            doc.operationDB['op-1'] = { id: 'op-1', kind: 'backupApp', status: 'Running', args: { backupDiskId: 'bk-1', instanceId: 'inst-1' } } as any
        })
        await expectRefused('createFilesDisk bk-1', /running backup of instance inst-1/, b1)
        expect(chown).not.toHaveBeenCalled()
        expect(resourceLock.isLocked(diskKey('bk-1'))).toBe(false)
    })

    it('erase in progress for that disk: refused; an erase of another disk does not block it', async () => {
        const root = await disk('er-1', ['empty'])
        await disk('er-2', ['empty'])
        h.change(doc => { (doc.engineDB[LOCAL] as any).eraseInProgress = { targetId: 'er-1', label: 'IDEA Disk', step: 'mounting' } })
        await expectRefused('createFilesDisk er-1', /being erased \(mounting\)/, root)
        const t = await run('createFilesDisk er-2')
        expect(t.status, t.errorMessage ?? '').toBe('ok')
    })

    it('share names: over 16 bytes, other characters, leading/trailing space are refused and nothing is written', async () => {
        const root = await disk('s-1', ['empty'])
        await expectRefused('createFilesDisk s-1 12345678901234567', /Share name '12345678901234567' is not allowed/, root)
        await expectRefused('createFilesDisk s-1 Sch/ool', /is not allowed/, root)
        await expectRefused('createFilesDisk s-1 Ümlaut', /is not allowed/, root)
        await expectRefused('createFilesDisk s-1 a.b', /is not allowed/, root)
        const ok = await run('createFilesDisk s-1 1234567890123456')
        expect(ok.status, ok.errorMessage ?? '').toBe('ok')
    })

    it('the lock is released after success and after a refusal', async () => {
        await disk('lk-1', ['empty'])
        await disk('lk-2', ['empty'], async r => { await fs.writeFile(`${r}/junk`, 'x') })
        await run('createFilesDisk lk-1')
        await run('createFilesDisk lk-2')
        expect(resourceLock.isLocked(diskKey('lk-1'))).toBe(false)
        expect(resourceLock.isLocked(diskKey('lk-2'))).toBe(false)
    })

    it('createFilesDisk with no disk ID leaves an error trace (idea#122)', async () => {
        const n = logH.doc()!.recentTraceIds.length
        await handleCommand(commands, h, 'engine', 'createFilesDisk', logH)
        expect(logH.doc()!.recentTraceIds.length).toBe(n + 1)
        const t = lastTrace(logH)
        expect(t.status).toBe('error')
        expect(t.errorMessage).toMatch(/Insufficient arguments/)
    })
})

describe('the chown -h path (idea#131)', () => {
    it('runs exactly sudo -n /usr/bin/chown -h pi:pi <mount point>, and only on /disks/sd[a-z][12]', async () => {
        expect(SUDO_CHOWN).toBe('/usr/bin/chown')
        expect(chownRootCommand('/disks/sdb1')).toBe('/usr/bin/chown -h pi:pi /disks/sdb1')
        for (const ok of ['/disks/sda1', '/disks/sdb2', '/disks/sdz1']) expect(SUDO_CHOWN_ROOT.test(ok)).toBe(true)
        for (const bad of ['/disks', '/disks/', '/disks/sdb3', '/disks/sdb1/', '/disks/sdb1/files', '/disks/old', '/', '/tmp/x', '/disks/../etc']) {
            expect(SUDO_CHOWN_ROOT.test(bad)).toBe(false)
            await expect(runSudoChownRoot(bad)).rejects.toThrow(/never changed/)
        }
        const text = fs.readFileSync(path.join(ROOT, 'src/data/CreateFilesDisk.ts'), 'utf8')
        expect(text).toContain('$`sudo -n ${SUDO_CHOWN} -h pi:pi ${mountPoint}`')
        expect(text).not.toMatch(/chown -R|--recursive|e2label|tune2fs/)
    })

    it('no other path in src/ runs chown on a disk', async () => {
        const files = (await $`find src -name '*.ts'`.quiet()).stdout.split('\n').filter(Boolean).sort()
        // Code lines only: comments may mention the entry
        const code = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')
            .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
        const withChownH = files.filter(f => /chown -h|SUDO_CHOWN\} -h/.test(code(f)))
        expect(withChownH).toEqual(['src/data/CreateFilesDisk.ts'])
        for (const f of files) {
            if (f === 'src/data/CreateFilesDisk.ts') continue
            const text = code(f)
            expect(text, f).not.toMatch(/chown[^`\n]*(\/disks|disksRoot|SUDO_CHOWN)/)
            expect(text, f).not.toMatch(/runSudoChownRoot|chownRoot\(/)
        }
    })
})
