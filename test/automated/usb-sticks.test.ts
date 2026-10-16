/**
 * usb-sticks.test.ts: teacher USB sticks (idea#193, Engine step 1 + §8.2a)
 *
 *   - §3.1 fstype routing (ext4 / vfat / exfat / ntfs / none) and the monitor route
 *   - §3.2 exact mount / umount argv, pinned against the 11-engine-files lines
 *     (sudo glob → regex, escaped ',' and '='), visudo -cf when available
 *   - §3.3 Engine.usbSticks, display names with ' (2)', kolibri folder flag
 *   - §3.4 unplug order (store → JSON → sync → umount → rmdir), lazy umount only
 *     when busy, startup cleanup; nothing is ever written under a stick
 *   - §4 x-app.usbMount (app-nextcloud#7): ro rslave bind /run/idea-usb → /mnt/idea-usb,
 *     `docker exec -u www-data <id>-nextcloud-app-1 /idea/usb-sync.sh` at plug,
 *     unplug, Engine start and instance start; .idea-usb.json {"sticks":[…]} tmp+rename
 *   - removeSticksOnDrive (used by eraseDisk before it erases a drive)
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import os from 'os'
import { $, fs, path, YAML } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { localEngineId } from '../../src/data/Engine.js'
import { config } from '../../src/data/Config.js'
import {
    addStick, removeStick, removeSticksOnDrive, usbStartupCleanup, syncUsbApps, classifyFsType,
    stickMountArgv, stickUmountArgv, setUsbStickOpsForTests, resetUsbSticksForTests, uniqueDisplayName,
    findKolibriFolder, defaultUsbStickOps, stickBlockedBySiblings, UsbStickOps, StickProbe, IDEA_USB_JSON, STICK_MOUNT_OPTIONS,
} from '../../src/data/UsbSticks.js'
import { parseUsbMount, buildOverride, NEXTCLOUD_USB_SYNC } from '../../src/data/FilesMount.js'
import { setBuilderAutoStartDepsForTests } from '../../src/data/ChannelBuilderAutoStart.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import { createTestStore, waitFor, DEV_ROOT } from '../harness/diskSim.js'
import type { MountEntry } from '../../src/monitors/mounts.js'

const ROOT = process.cwd()
const SUDOERS_11 = path.join(ROOT, 'script/build_image_assets/11-engine-files.sudoers')

// ── sudoers helpers ─────────────────────────────────────────────────────────

/** Commands of all `pi ALL=(root) NOPASSWD:` lines, split on unescaped ',', unescaped. */
const sudoersCommands = (): string[] => fs.readFileSync(SUDOERS_11, 'utf-8').split('\n')
    .filter(l => /^pi\s/.test(l))
    .flatMap(l => l.replace(/^pi ALL=\(root\) NOPASSWD: /, '').split(/(?<!\\),\s*/))
    .map(c => c.replace(/\\([,=:])/g, '$1').trim())
const globToRegex = (glob: string): RegExp => new RegExp('^' + glob.split(/(\[[^\]]+\])/).map(p =>
    p.startsWith('[') ? p : p.replace(/[.*+?^${}()|\\/]/g, c => '\\' + c)).join('') + '$')
const allowed = (argv: string[]): boolean => sudoersCommands().some(c => globToRegex(c).test(argv.join(' ')))

// ── fakes ───────────────────────────────────────────────────────────────────

interface Fake { mounts: MountEntry[]; calls: string[]; umountBusy: boolean; writes: string[]; execs: { container: string, user: string | null, env: Record<string, string>, command: string }[] }
let usbRootDir = ''
const fakeOps = (st: Fake): Partial<UsbStickOps> => ({
    listMounts: async () => [...st.mounts],
    isMountPoint: async (p) => st.mounts.some(m => m.target === p),
    sudo: async (argv) => {
        st.calls.push(argv.join(' '))
        if (argv[1] === '-t') {
            const mp = argv[argv.length - 1]
            st.mounts.push({ source: argv[argv.length - 2], target: mp, fstype: argv[2] })
            // pretend content of the stick
            await fs.ensureDir(path.join(mp, 'Kolibri', 'Grade 5 Science'))
            await fs.writeFile(path.join(mp, 'video.mp4'), 'x')
        } else if (argv[1] === '-l' || !st.umountBusy) {
            const mp = argv[argv.length - 1]
            st.mounts = st.mounts.filter(m => m.target !== mp)
            await fs.remove(path.join(mp, 'Kolibri')); await fs.remove(path.join(mp, 'video.mp4'))
        } else {
            throw Object.assign(new Error('busy'), { stderr: 'target is busy' })
        }
    },
    mkdir: async (p) => { st.calls.push(`mkdir ${p}`); await fs.mkdir(p) },
    rmdir: async (p) => { st.calls.push(`rmdir ${p}`); await fs.rmdir(p) },
    statfs: async () => ({ sizeBytes: 32_000_000_000, usedBytes: 3_200_000_000 }),
    writeFileAtomic: async (p, c) => { st.writes.push(p); st.calls.push('json'); await defaultUsbStickOps.writeFileAtomic(p, c) },
    dockerExec: async (container, user, env, command) => { st.calls.push(`exec ${container}`); st.execs.push({ container, user, env, command }) },
})
const newFake = (): Fake => ({ mounts: [], calls: [], umountBusy: false, writes: [], execs: [] })
const probe = (over: Partial<StickProbe> = {}): StickProbe => ({ fsType: 'vfat', label: 'MARY-STICK', uuid: 'ABCD-1234', sizeBytes: 32e9, model: 'SanDisk', ...over })

const NC_APP = 'nextcloud-1.0'
const NC_INST = 'nc-inst-1'
const seedNextcloud = (h: DocHandle<Store>, status = 'Running') => h.change(doc => {
    doc.diskDB['nc-disk' as any] = { id: 'nc-disk', name: 'nc', dockedTo: localEngineId, device: 'sdh1', diskTypes: ['app'] } as any
    doc.appDB[NC_APP as any] = { id: NC_APP, name: 'nextcloud', usbMount: { path: '/mnt/idea-usb', services: ['nextcloud-app'], sync: { ...NEXTCLOUD_USB_SYNC } } } as any
    doc.instanceDB[NC_INST as any] = { id: NC_INST, name: 'nextcloud', instanceOf: NC_APP, storedOn: 'nc-disk', status, lastStarted: 1 } as any
})

describe('idea#193 teacher USB sticks', () => {
    let h: DocHandle<Store>
    let st: Fake
    const savedRoot = process.env.IDEA_USB_ROOT
    beforeEach(async () => {
        usbRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-usb-'))
        process.env.IDEA_USB_ROOT = usbRootDir
        st = newFake()
        setUsbStickOpsForTests(fakeOps(st))
        resetUsbSticksForTests()
        setBuilderAutoStartDepsForTests({ start: async () => { throw new Error('no builder start expected') } })
        h = (await createTestStore()).storeHandle
    })
    afterEach(async () => {
        setUsbStickOpsForTests(null)
        setBuilderAutoStartDepsForTests(null)
        resetUsbSticksForTests()
        if (savedRoot === undefined) delete process.env.IDEA_USB_ROOT; else process.env.IDEA_USB_ROOT = savedRoot
        await fs.remove(usbRootDir)
    })

    describe('§3.1 routing', () => {
        it('ext4 / vfat / exfat / ntfs / none', () => {
            expect(classifyFsType('ext4')).toBe('ext4')
            expect(classifyFsType('vfat')).toBe('stick')
            expect(classifyFsType('exfat')).toBe('stick')
            expect(classifyFsType('EXFAT')).toBe('stick')
            expect(classifyFsType('ntfs')).toBe('other')
            expect(classifyFsType(null)).toBe('other')
            expect(classifyFsType('')).toBe('other')
            expect(classifyFsType('swap')).toBe('other')
        })
    })

    describe('§3.2 exact commands = 11-engine-files', () => {
        it('the vfat and exfat mounts carry exactly the proposal options', () => {
            expect(STICK_MOUNT_OPTIONS.vfat).toBe('ro,nosuid,nodev,noexec,uid=1000,gid=1000,fmask=0222,dmask=0222,iocharset=utf8,shortname=mixed')
            expect(STICK_MOUNT_OPTIONS.exfat).toBe('ro,nosuid,nodev,noexec,uid=1000,gid=1000,fmask=0222,dmask=0222,iocharset=utf8')
        })
        it('mount / umount / umount -l argv match a sudoers line, for partitions and whole disks', () => {
            for (const dev of ['sda1', 'sdb2', 'sdz1', 'sdb']) {
                for (const t of ['vfat', 'exfat'] as const) {
                    const argv = stickMountArgv(t, dev, `/run/idea-usb/${dev}`)
                    expect(argv.slice(0, 5)).toEqual(['/usr/bin/mount', '-t', t, '-o', STICK_MOUNT_OPTIONS[t]])
                    expect(allowed(argv), argv.join(' ')).toBe(true)
                }
                expect(allowed(stickUmountArgv(`/run/idea-usb/${dev}`))).toBe(true)
                expect(allowed(stickUmountArgv(`/run/idea-usb/${dev}`, true))).toBe(true)
            }
        })
        it('nothing else matches: /disks, partition 3, rw, other fs, mismatched options, other root', () => {
            expect(allowed(['/usr/bin/mount', '-t', 'vfat', '-o', STICK_MOUNT_OPTIONS.vfat, '/dev/sdb1', '/disks/sdb1'])).toBe(false)
            expect(allowed(['/usr/bin/mount', '-t', 'vfat', '-o', STICK_MOUNT_OPTIONS.vfat, '/dev/sdb3', '/run/idea-usb/sdb3'])).toBe(false)
            expect(allowed(['/usr/bin/mount', '-t', 'vfat', '-o', STICK_MOUNT_OPTIONS.vfat.replace('ro,', 'rw,'), '/dev/sdb1', '/run/idea-usb/sdb1'])).toBe(false)
            expect(allowed(['/usr/bin/mount', '-t', 'ntfs', '-o', STICK_MOUNT_OPTIONS.exfat, '/dev/sdb1', '/run/idea-usb/sdb1'])).toBe(false)
            expect(allowed(['/usr/bin/mount', '-t', 'exfat', '-o', STICK_MOUNT_OPTIONS.vfat, '/dev/sdb1', '/run/idea-usb/sdb1'])).toBe(false)
            expect(allowed(['/usr/bin/mount', '-t', 'vfat', '-o', STICK_MOUNT_OPTIONS.vfat, '/dev/sdb1', '/run/idea-usb/sdc1'.replace('sdc1', '../etc')])).toBe(false)
            expect(allowed(['/usr/bin/umount', '/run/idea-usb/sdb1/x'])).toBe(false)
            expect(allowed(['/usr/bin/umount', '-l', '/disks/sdb1'])).toBe(false)
        })
        it('the sudoers file parses (visudo -cf), when visudo is available', async () => {
            const visudo = ['/usr/sbin/visudo', '/sbin/visudo'].find(p => fs.existsSync(p))
            if (!visudo) return
            const out = await $`${visudo} -cf ${SUDOERS_11}`.nothrow()
            expect(out.exitCode, out.stderr).toBe(0)
        })
        it('the tmpfiles.d entry makes /run/idea-usb pi:pi 0755', () => {
            const t = fs.readFileSync(path.join(ROOT, 'script/build_image_assets/idea-usb.tmpfiles.conf'), 'utf-8')
            expect(t.split('\n').filter(l => l && !l.startsWith('#'))).toEqual(['d /run/idea-usb 0755 pi pi -'])
        })
    })

    describe('§3.3 plug', () => {
        it('mounts read-only with the exact argv, publishes Engine.usbSticks and the JSON', async () => {
            const r = await addStick(h, 'sdb1', probe(), { autoStart: false })
            expect(r.ok).toBe(true)
            const mp = path.join(usbRootDir, 'sdb1')
            expect(st.calls).toContain(`mkdir ${mp}`)
            expect(st.calls).toContain(stickMountArgv('vfat', 'sdb1', mp).join(' '))
            const pub = h.doc().engineDB[localEngineId].usbSticks!
            expect(pub).toEqual([expect.objectContaining({
                stickId: 'usb-ABCD-1234', device: 'sdb1', label: 'MARY-STICK', displayName: 'USB: MARY-STICK',
                fsType: 'vfat', sizeBytes: 32e9, usedBytes: 3.2e9, readOnly: true, hasKolibriFolder: true, builderAutoStart: null,
            })])
            const json = JSON.parse(await fs.readFile(path.join(usbRootDir, IDEA_USB_JSON), 'utf-8'))
            expect(Object.keys(json)).toContain('sticks')
            expect(json.sticks).toEqual([expect.objectContaining({ device: 'sdb1', displayName: 'USB: MARY-STICK', label: 'MARY-STICK', kolibriFolder: 'Kolibri' })])
            // never a Disk entry
            expect(Object.values(h.doc().diskDB).some(d => d.device === 'sdb1')).toBe(false)
        })
        it('stickId = "usb-<filesystem UUID>" in Engine.usbSticks and the JSON (FAT and exFAT); folder is /mnt/idea-usb/<device>', async () => {
            await addStick(h, 'sdb1', probe({ fsType: 'vfat', uuid: 'ABCD-1234' }), { autoStart: false })
            await addStick(h, 'sdc1', probe({ fsType: 'exfat', uuid: '5E8B-1C2D', label: 'EXSTICK' }), { autoStart: false })
            const pub = h.doc().engineDB[localEngineId].usbSticks!
            expect(pub.map(s => [s.device, s.stickId, s.fsType])).toEqual([['sdb1', 'usb-ABCD-1234', 'vfat'], ['sdc1', 'usb-5E8B-1C2D', 'exfat']])
            const json = JSON.parse(await fs.readFile(path.join(usbRootDir, IDEA_USB_JSON), 'utf-8'))
            expect(json.sticks.map((x: any) => ({ stickId: x.stickId, device: x.device, label: x.label, displayName: x.displayName, dir: x.dir }))).toEqual([
                { stickId: 'usb-ABCD-1234', device: 'sdb1', label: 'MARY-STICK', displayName: 'USB: MARY-STICK', dir: 'sdb1' },
                { stickId: 'usb-5E8B-1C2D', device: 'sdc1', label: 'EXSTICK', displayName: 'USB: EXSTICK', dir: 'sdc1' },
            ])
            expect(await fs.pathExists(path.join(usbRootDir, 'sdc1'))).toBe(true)
        })
        it('the JSON is written with tmp + rename: no tmp file left, and readers never see a partial file', async () => {
            const p = path.join(usbRootDir, IDEA_USB_JSON)
            await defaultUsbStickOps.writeFileAtomic(p, '{"sticks":[]}\n')
            const ino = (await fs.stat(p)).ino
            await defaultUsbStickOps.writeFileAtomic(p, '{"sticks":[{"device":"sdb1"}]}\n')
            expect((await fs.stat(p)).ino).not.toBe(ino)   // a new file renamed over the old one
            expect((await fs.readdir(usbRootDir)).filter(n => n.includes('.tmp'))).toEqual([])
        })
        it('label clash gets " (2)"; label falls back to the model, then "USB stick"', async () => {
            await addStick(h, 'sdb1', probe(), { autoStart: false })
            await addStick(h, 'sdc1', probe({ uuid: 'EEEE-0000', fsType: 'exfat' }), { autoStart: false })
            await addStick(h, 'sdd1', probe({ uuid: null, label: null }), { autoStart: false })
            await addStick(h, 'sde1', probe({ uuid: 'F', label: null, model: null }), { autoStart: false })
            const names = h.doc().engineDB[localEngineId].usbSticks!.map(s => s.displayName)
            expect(names).toEqual(['USB: MARY-STICK', 'USB: MARY-STICK (2)', 'USB: SanDisk', 'USB: USB stick'])
            expect(h.doc().engineDB[localEngineId].usbSticks![2].stickId).toBe('usb-nouuid-sdd1')
            expect(st.calls).toContain(stickMountArgv('exfat', 'sdc1', path.join(usbRootDir, 'sdc1')).join(' '))
            expect(uniqueDisplayName('A', ['USB: A', 'USB: A (2)'])).toBe('USB: A (3)')
        })
        it('kolibri folder: top-level directory, any case; a file named kolibri does not count', () => {
            expect(findKolibriFolder([{ name: 'KOLIBRI', isDirectory: true }])).toBe('KOLIBRI')
            expect(findKolibriFolder([{ name: 'kolibri', isDirectory: false }])).toBe(null)
            expect(findKolibriFolder([{ name: 'kolibri-old', isDirectory: true }])).toBe(null)
        })
        it('refuses a target that is already a mount point, or a device mounted elsewhere', async () => {
            st.mounts.push({ source: '/dev/sdx9', target: path.join(usbRootDir, 'sdb1'), fstype: 'ext4' })
            expect((await addStick(h, 'sdb1', probe(), { autoStart: false })).ok).toBe(false)
            st.mounts = [{ source: '/dev/sdb1', target: '/media/x', fstype: 'vfat' }]
            expect((await addStick(h, 'sdb1', probe(), { autoStart: false })).ok).toBe(false)
            expect(st.calls.filter(c => c.startsWith('/usr/bin/mount'))).toEqual([])
            expect((await addStick(h, 'sdb3', probe(), { autoStart: false })).ok).toBe(false)
            expect((await addStick(h, 'sdb1', probe({ fsType: 'ntfs' }), { autoStart: false })).ok).toBe(false)
        })
        it('reuses an existing mount of the same device (no second mount)', async () => {
            const mp = path.join(usbRootDir, 'sdb1'); await fs.ensureDir(mp)
            st.mounts.push({ source: '/dev/sdb1', target: mp, fstype: 'vfat' })
            const r = await addStick(h, 'sdb1', probe(), { autoStart: false })
            expect(r.ok && r.alreadyMounted).toBe(true)
            expect(st.calls.filter(c => c.startsWith('/usr/bin/mount'))).toEqual([])
        })
        it('nothing is written under the stick mount point', async () => {
            await addStick(h, 'sdb1', probe(), { autoStart: false })
            const mp = path.join(usbRootDir, 'sdb1')
            expect(st.writes.every(w => !w.startsWith(mp + '/'))).toBe(true)
            expect((await fs.readdir(mp)).sort()).toEqual(['Kolibri', 'video.mp4'])
        })
    })

    describe('§3.4 unplug and startup', () => {
        it('order: store → JSON → sync → umount → rmdir; folder removed after unmount', async () => {
            seedNextcloud(h)
            await addStick(h, 'sdb1', probe(), { autoStart: false })
            await syncUsbApps(h, 'plug')
            st.calls = []
            expect(await removeStick(h, 'sdb1')).toBe(true)
            const mp = path.join(usbRootDir, 'sdb1')
            expect(st.calls).toEqual(['json', `exec ${NC_INST}-nextcloud-app-1`, `/usr/bin/umount ${mp}`, `rmdir ${mp}`])
            expect(h.doc().engineDB[localEngineId].usbSticks).toEqual([])
            expect(await fs.pathExists(mp)).toBe(false)
            const json = JSON.parse(await fs.readFile(path.join(usbRootDir, IDEA_USB_JSON), 'utf-8'))
            expect(json.sticks).toEqual([])
            expect(await removeStick(h, 'sdb1')).toBe(false)
        })
        it('lazy umount only when the plain umount fails (busy), then rmdir', async () => {
            await addStick(h, 'sdb1', probe(), { autoStart: false })
            st.umountBusy = true; st.calls = []
            await removeStick(h, 'sdb1')
            const mp = path.join(usbRootDir, 'sdb1')
            expect(st.calls.filter(c => c.includes('umount') || c.startsWith('rmdir'))).toEqual([`/usr/bin/umount ${mp}`, `/usr/bin/umount -l ${mp}`, `rmdir ${mp}`])
        })
        it('removeSticksOnDrive removes every stick of a drive (whole-disk unplug, erase)', async () => {
            await addStick(h, 'sdb1', probe(), { autoStart: false })
            await addStick(h, 'sdb2', probe({ uuid: 'X' }), { autoStart: false })
            await addStick(h, 'sdc1', probe({ uuid: 'Y' }), { autoStart: false })
            expect((await removeSticksOnDrive(h, 'sdb', 'erase requested')).sort()).toEqual(['sdb1', 'sdb2'])
            expect(h.doc().engineDB[localEngineId].usbSticks!.map(s => s.device)).toEqual(['sdc1'])
        })
        it('startup cleanup unmounts leftovers, removes empty folders and clears the store', async () => {
            const left = path.join(usbRootDir, 'sdb1'); await fs.ensureDir(left)
            const empty = path.join(usbRootDir, 'sdc1'); await fs.ensureDir(empty)
            const other = path.join(usbRootDir, 'notes'); await fs.ensureDir(other)
            st.mounts.push({ source: '/dev/sdb1', target: left, fstype: 'vfat' })
            st.mounts.push({ source: '/dev/sda2', target: '/', fstype: 'ext4' })
            h.change(doc => { doc.engineDB[localEngineId].usbSticks = [{ device: 'sdb1' } as any] })
            await usbStartupCleanup(h)
            expect(st.calls).toContain(`/usr/bin/umount ${left}`)
            expect(await fs.pathExists(left)).toBe(false)
            expect(await fs.pathExists(empty)).toBe(false)
            expect(await fs.pathExists(other)).toBe(true)    // only sdX folders
            expect(st.calls.some(c => c.includes(' /'+'\n'))).toBe(false)
            expect(h.doc().engineDB[localEngineId].usbSticks).toEqual([])
            expect(JSON.parse(await fs.readFile(path.join(usbRootDir, IDEA_USB_JSON), 'utf-8'))).toMatchObject({ sticks: [] })
        })
    })

    describe('USB root missing at start (before install-root-helpers)', () => {
        const swapRoot = async (parentMode: number) => {
            const parent = path.join(usbRootDir, 'run'); await fs.ensureDir(parent); await fs.chmod(parent, parentMode)
            const root = path.join(parent, 'idea-usb'); process.env.IDEA_USB_ROOT = root
            return { parent, root }
        }
        it('creates the root itself (0755) at startup when the parent is writable, and writes the JSON', async () => {
            const { root } = await swapRoot(0o755)
            await usbStartupCleanup(h)
            expect((await fs.stat(root)).mode & 0o777).toBe(0o755)
            expect(JSON.parse(await fs.readFile(path.join(root, IDEA_USB_JSON), 'utf-8'))).toMatchObject({ sticks: [] })
        })
        it('parent not writable: startup leaves it missing; the first plug creates it once allowed, no restart', async () => {
            const { parent, root } = await swapRoot(0o555)
            await usbStartupCleanup(h)
            expect(await fs.pathExists(root)).toBe(false)
            const r1 = await addStick(h, 'sdb1', probe(), { autoStart: false })
            expect(r1.ok).toBe(false)
            expect(st.calls.some(c => c.includes('/usr/bin/mount'))).toBe(false)
            await fs.chmod(parent, 0o755)   // e.g. install-root-helpers / tmpfiles ran meanwhile
            const r2 = await addStick(h, 'sdb1', probe(), { autoStart: false })
            expect(r2.ok).toBe(true)
            expect(await fs.pathExists(root)).toBe(true)
            const json = JSON.parse(await fs.readFile(path.join(root, IDEA_USB_JSON), 'utf-8'))
            expect(json.sticks.map((s: any) => s.device)).toEqual(['sdb1'])
        })
        it('root made by someone else later: the next JSON write (unplug/sync) uses it', async () => {
            const { parent, root } = await swapRoot(0o555)
            await usbStartupCleanup(h)
            await fs.chmod(parent, 0o755); await fs.mkdir(root)
            await addStick(h, 'sdb1', probe(), { autoStart: false })
            await removeStick(h, 'sdb1')
            expect(JSON.parse(await fs.readFile(path.join(root, IDEA_USB_JSON), 'utf-8')).sticks).toEqual([])
        })
    })

    describe('§4 x-app.usbMount (app-nextcloud#7)', () => {
        const kidXapp = { usbMount: { path: '/mnt/idea-usb', services: ['nextcloud-app'] }, filesMount: { path: '/mnt/idea-files', services: ['nextcloud-app'] } }
        it("Kid's compose (no sync key) gets the Nextcloud default sync", () => {
            expect(parseUsbMount(kidXapp)).toEqual({ path: '/mnt/idea-usb', services: ['nextcloud-app'], sync: { service: 'nextcloud-app', user: 'www-data', command: '/idea/usb-sync.sh' } })
            expect(parseUsbMount({ usbMount: { path: '/mnt/idea-usb', services: ['builder'] } })!.sync).toBe(null)
            expect(parseUsbMount({ usbMount: { path: 'rel', services: ['a'] } })).toBe(null)
            expect(parseUsbMount({ usbMount: { path: '/x', services: [] } })).toBe(null)
            expect(parseUsbMount({ usbMount: { path: '/x', services: ['a'], sync: { command: '/s.sh; rm -rf /' } } })!.sync).toBe(null)
            expect(parseUsbMount({})).toBe(null)
        })
        it('override: one read-only rslave bind /run/idea-usb → /mnt/idea-usb next to the Files binds', () => {
            const um = parseUsbMount(kidXapp)!
            const { yaml } = buildOverride(kidXapp.filesMount, [{ id: 'abcdef12' as any, shareName: 'School', hostFilesPath: '/disks/sdc1/files' }], '/s/x.json', { usbMount: um, hostRoot: '/run/idea-usb' })
            const vols = YAML.parse(yaml).services['nextcloud-app'].volumes
            expect(vols).toContainEqual({ type: 'bind', source: '/run/idea-usb', target: '/mnt/idea-usb', read_only: true, bind: { create_host_path: false, propagation: 'rslave' } })
            expect(vols.filter((v: any) => v.source === '/disks/sdc1/files')).toHaveLength(1)
            const only = YAML.parse(buildOverride(null, [], '', { usbMount: um, hostRoot: '/run/idea-usb' }).yaml)
            expect(only.services['nextcloud-app'].volumes).toEqual([{ type: 'bind', source: '/run/idea-usb', target: '/mnt/idea-usb', read_only: true, bind: { create_host_path: false, propagation: 'rslave' } }])
        })
        it('sync: docker exec -u www-data <id>-nextcloud-app-1 /idea/usb-sync.sh at plug, unplug and start; only Running local instances', async () => {
            seedNextcloud(h)
            await addStick(h, 'sdb1', probe(), { autoStart: false })
            await syncUsbApps(h, 'plug')     // addStick's own sync is queued on the same chain
            await removeStick(h, 'sdb1')
            await syncUsbApps(h, 'start', false, NC_INST)
            expect(st.execs.map(e => e.env.IDEA_USB_EVENT)).toEqual(['plug', 'plug', 'unplug', 'start'])
            for (const e of st.execs) {
                expect(e).toEqual({ container: `${NC_INST}-nextcloud-app-1`, user: 'www-data', command: '/idea/usb-sync.sh',
                    env: { IDEA_USB_EVENT: e.env.IDEA_USB_EVENT, IDEA_USB_ROOT: '/mnt/idea-usb', IDEA_USB_JSON: '/mnt/idea-usb/.idea-usb.json' } })
            }
            st.execs = []
            h.change(doc => { doc.instanceDB[NC_INST as any].status = 'Stopped' as any })
            await syncUsbApps(h, 'plug', false)
            h.change(doc => { doc.instanceDB[NC_INST as any].status = 'Running' as any; doc.diskDB['nc-disk' as any].dockedTo = 'ENGINE_other' as any })
            await syncUsbApps(h, 'plug', false)
            expect(st.execs).toEqual([])
        })
        it('the real dockerExec runs exactly `timeout 120 docker exec -u www-data -e … <container> /idea/usb-sync.sh`', async () => {
            const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-usb-bin-'))
            const logf = path.join(bin, 'log')
            await fs.writeFile(path.join(bin, 'timeout'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${logf}\n`, { mode: 0o755 })
            const saved = process.env.PATH
            process.env.PATH = `${bin}:${saved}`
            try {
                await defaultUsbStickOps.dockerExec('nc-inst-1-nextcloud-app-1', 'www-data', { IDEA_USB_EVENT: 'start' }, '/idea/usb-sync.sh')
            } finally { process.env.PATH = saved }
            expect((await fs.readFile(logf, 'utf-8')).trim().split('\n')).toEqual(['120', 'docker', 'exec', '-u', 'www-data', '-e', 'IDEA_USB_EVENT=start', 'nc-inst-1-nextcloud-app-1', '/idea/usb-sync.sh'])
            await fs.remove(bin)
        })
        it('a failed sync is logged, not thrown', async () => {
            seedNextcloud(h)
            setUsbStickOpsForTests({ ...fakeOps(st), dockerExec: async () => { throw new Error('exit 1') } })
            await expect(syncUsbApps(h, 'plug', false)).resolves.toBeUndefined()
        })
    })

    describe('usbDeviceMonitor routes FAT/exFAT to the stick path', () => {
        let watcher: any
        const savedTest = config.settings.testMode
        afterAll(async () => { await watcher?.close() })
        it('plug → mounted stick, never a Disk; unplug → gone', { timeout: 20_000 }, async () => {
            setUsbStickOpsForTests({ ...fakeOps(st), probe: async (d) => d === 'sdq1' ? probe({ uuid: 'Q' }) : null })
            await fs.ensureDir(DEV_ROOT)
            watcher = await enableUsbDeviceMonitor(h)
            await fs.writeFile(path.join(DEV_ROOT, 'sdq1'), '')
            try {
                expect(await waitFor(h, s => (s.engineDB[localEngineId].usbSticks ?? []).some(x => x.device === 'sdq1'))).toBe(true)
                expect(Object.values(h.doc().diskDB).some(d => d.device === 'sdq1')).toBe(false)
                await fs.remove(path.join(DEV_ROOT, 'sdq1'))
                expect(await waitFor(h, s => (s.engineDB[localEngineId].usbSticks ?? []).length === 0)).toBe(true)
                expect(await waitFor(h, () => !fs.existsSync(path.join(usbRootDir, 'sdq1')))).toBe(true)
            } finally {
                await fs.remove(path.join(DEV_ROOT, 'sdq1'))
                config.settings.testMode = savedTest
            }
        })
        it('FAT boot partition next to an ext4 root (RPi OS card) → never mounted, no stick, no Disk (idea#201 §10)', { timeout: 20_000 }, async () => {
            const asked: string[] = []
            setUsbStickOpsForTests({
                ...fakeOps(st),
                probe: async (d) => d === 'sdr1' ? probe({ uuid: 'BOOT', label: 'bootfs' }) : null,
                drivePartitions: async (d) => { asked.push(d); return [
                    { name: 'sdr1', fsType: 'vfat', partType: '0xc' },
                    { name: 'sdr2', fsType: 'ext4', partType: '0x83' },
                ] },
            })
            await fs.ensureDir(DEV_ROOT)
            if (!watcher) watcher = await enableUsbDeviceMonitor(h)
            await fs.writeFile(path.join(DEV_ROOT, 'sdr1'), '')
            try {
                expect(await waitFor(h, () => asked.includes('sdr1'))).toBe(true)
                await new Promise(r => setTimeout(r, 300))
                expect(st.calls.filter(c => c.includes('mount'))).toEqual([])
                expect(st.mounts).toEqual([])
                expect(h.doc().engineDB[localEngineId].usbSticks ?? []).toEqual([])
                expect(Object.values(h.doc().diskDB).some(d => d.device === 'sdr1')).toBe(false)
                expect(fs.existsSync(path.join(usbRootDir, 'sdr1'))).toBe(false)
            } finally {
                await fs.remove(path.join(DEV_ROOT, 'sdr1'))
                config.settings.testMode = savedTest
            }
        })
    })
})

describe('stickBlockedBySiblings (idea#201 §10 follow-up)', () => {
    const P = (name: string, fsType: string | null, partType: string | null = null) => ({ name, fsType, partType })
    it('FAT-only drive is a stick', () => {
        expect(stickBlockedBySiblings('sdb1', [P('sdb1', 'vfat', '0xc')])).toBeNull()
        expect(stickBlockedBySiblings('sdb1', [P('sdb1', 'exfat', '0x7'), P('sdb2', 'vfat', '0xc')])).toBeNull()
        expect(stickBlockedBySiblings('sdb1', [])).toBeNull()
    })
    it('RPi OS / Ubuntu card (vfat boot + ext4 root) is blocked', () => {
        expect(stickBlockedBySiblings('sdc1', [P('sdc1', 'vfat', '0xc'), P('sdc2', 'ext4', '0x83')])).toMatch(/sdc2.*ext4/)
    })
    it('IDEA disk (ext4 with META) next to a FAT partition is blocked', () => {
        expect(stickBlockedBySiblings('sda1', [P('sda1', 'vfat'), P('sda2', 'ext4', '0fc63daf-8483-4772-8e79-3d69d8477de4')])).not.toBeNull()
    })
    it('Linux partition whose fstype udev has not probed yet is blocked by its type', () => {
        expect(stickBlockedBySiblings('sdc1', [P('sdc1', 'vfat'), P('sdc2', null, '0x83')])).toMatch(/Linux partition/)
        expect(stickBlockedBySiblings('sdc1', [P('sdc1', 'vfat'), P('sdc2', null, '0FC63DAF-8483-4772-8E79-3D69D8477DE4')])).not.toBeNull()
    })
    it('the device itself is ignored', () => {
        expect(stickBlockedBySiblings('sdc2', [P('sdc2', 'ext4', '0x83')])).toBeNull()
    })
})
