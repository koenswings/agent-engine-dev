/**
 * idea-write-home-engine.test.ts — idea#203 §2: the flash helper writes the home-Engine
 * name (idea-home.txt) on the FAT boot partition of the card it JUST wrote and verified,
 * and refuses every other disk (§10 rule 1, API-CONTRACT §5 codes).
 *
 * Runs a sandbox copy of script/build_image_assets/idea-write-home-engine with its
 * constants rewritten: a temp /dev, /dev/disk/by-id, /sys/class/block and fake
 * lsblk/findmnt/blkid/udevadm/mount/umount/sync. Never runs as root, never mounts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { fs, path } from 'zx'
import os from 'os'

const SRC = path.join(process.cwd(), 'script/build_image_assets/idea-write-home-engine')
const SIZE = 31914983424 // 62333952 sectors

interface Sb { tmp: string, dev: string, byId: string, sys: string, script: string, state: string, mnt: string }
let sb: Sb

const fake = async (sb: Sb, name: string, body: string) => {
    const p = path.join(sb.tmp, 'bin', name)
    await fs.outputFile(p, `#!/bin/bash\nS=${sb.state}\n${body}\n`)
    await fs.chmod(p, 0o755)
    return p
}

const makeSandbox = async (): Promise<Sb> => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-home-'))
    const s: Sb = { tmp, dev: path.join(tmp, 'dev'), byId: path.join(tmp, 'dev/disk/by-id'), sys: path.join(tmp, 'sys'),
        script: path.join(tmp, 'idea-write-home-engine'), state: path.join(tmp, 'state'), mnt: path.join(tmp, 'run') }
    await fs.ensureDir(s.byId); await fs.ensureDir(s.state); await fs.ensureDir(s.mnt)
    // state files: mounted (lines "source mountpoint"), fstype.<part>, tran.<disk>, pk.<src>
    await fs.writeFile(path.join(s.state, 'mounted'), '')
    const lsblk = await fake(s, 'lsblk', `
args="$*"; dev="\${@: -1}"; d=\${dev##*/}
if [[ "$args" == *"-dno TRAN"* ]]; then cat "$S/tran.$d" 2>/dev/null; exit 0; fi
if [[ "$args" == *"-no PKNAME"* ]]; then cat "$S/pk.$d" 2>/dev/null; exit 0; fi
if [[ "$args" == *"-lno NAME"* ]]; then echo "$d"; ls "$S" | sed -n "s/^part\\.\\($d.*\\)$/\\1/p"; exit 0; fi
exit 1`)
    const findmnt = await fake(s, 'findmnt', `
if [ "$1 $2 $3 $4" = "-n -o SOURCE --mountpoint" ]; then awk -v m="$5" '$2==m{print $1; f=1} END{exit !f}' "$S/mounted"; exit; fi
if [ "$1 $2" = "-n --source" ]; then awk -v x="$3" '$1==x{f=1} END{exit !f}' "$S/mounted"; exit; fi
if [ "$1 $2" = "-n --mountpoint" ]; then awk -v m="$3" '$2==m{f=1} END{exit !f}' "$S/mounted"; exit; fi
exit 1`)
    const blkid = await fake(s, 'blkid', `d="\${@: -1}"; cat "$S/fstype.\${d##*/}" 2>/dev/null; true`)
    const udevadm = await fake(s, 'udevadm', 'true')
    const mount = await fake(s, 'mount', `echo "$*" >> "$S/mount.log"; echo "\${@: -2:1} \${@: -1}" >> "$S/mounted"; [ ! -e "$S/fail-mount" ]`)
    const umount = await fake(s, 'umount', `echo "$1" >> "$S/umount.log"; grep -v " $1\$" "$S/mounted" > "$S/m2" || true; mv "$S/m2" "$S/mounted"`)
    const sync = await fake(s, 'sync', 'true')
    let text = await fs.readFile(SRC, 'utf8')
    const set = (k: string, v: string) => { const re = new RegExp(`^${k}=.*$`, 'm'); expect(text).toMatch(re); text = text.replace(re, `${k}=${v}`) }
    set('DEV_DIR', s.dev); set('BYID_DIR', s.byId); set('SYS_BLOCK', s.sys); set('MNT_BASE', s.mnt)
    set('LSBLK', lsblk); set('FINDMNT', findmnt); set('BLKID', blkid); set('UDEVADM', udevadm)
    set('MOUNT', mount); set('UMOUNT', umount); set('SYNC', sync)
    text = text.replace('is_block() { [ -b "$1" ]; }', 'is_block() { [ -e "$1" ]; }')
    await fs.writeFile(s.script, text); await fs.chmod(s.script, 0o755)
    return s
}

/** A whole disk <name> with a FAT partition 1, removable, linked from by-id/<link>. */
const addCard = async (s: Sb, name: string, link: string, o: { removable?: string, fstype?: string, sizeBytes?: number, tran?: string } = {}) => {
    const part = name.startsWith('mmcblk') ? `${name}p1` : `${name}1`
    await fs.writeFile(path.join(s.dev, name), ''); await fs.writeFile(path.join(s.dev, part), '')
    await fs.ensureDir(path.join(s.sys, name)); await fs.ensureDir(path.join(s.sys, part))
    await fs.writeFile(path.join(s.sys, name, 'size'), String((o.sizeBytes ?? SIZE) / 512) + '\n')
    await fs.writeFile(path.join(s.sys, name, 'removable'), (o.removable ?? '1') + '\n')
    await fs.writeFile(path.join(s.sys, part, 'partition'), '1\n')
    await fs.writeFile(path.join(s.state, `part.${part}`), '')
    await fs.writeFile(path.join(s.state, `fstype.${part}`), (o.fstype ?? 'vfat') + '\n')
    await fs.writeFile(path.join(s.state, `pk.${part}`), name + '\n')
    if (o.tran) await fs.writeFile(path.join(s.state, `tran.${name}`), o.tran + '\n')
    await fs.symlink(path.join(s.dev, name), path.join(s.byId, link))
    return { dev: path.join(s.dev, name), part: path.join(s.dev, part), byId: path.join(s.byId, link) }
}

const run = (...args: string[]) => {
    const r = spawnSync(sb.script, args, { encoding: 'utf8' })
    return { code: r.status, out: r.stdout, err: r.stderr }
}
const refused = (r: ReturnType<typeof run>, code: string) => {
    expect(r.code, r.err).toBe(2)
    expect(r.err).toMatch(new RegExp(`^refused: ${code}: `, 'm'))
    expect(fs.existsSync(path.join(sb.state, 'mount.log'))).toBe(false) // nothing mounted
}
/** The home file as written into the (fake) mount point. */
const homeFile = async () => {
    const mp = (await fs.readFile(path.join(sb.state, 'mount.log'), 'utf8')).trim().split(' ').pop()!
    return { mp, text: await fs.readFile(path.join(mp, 'idea-home.txt'), 'utf8').catch(() => null) }
}

beforeEach(async () => { sb = await makeSandbox() })
afterEach(async () => { await fs.remove(sb.tmp) })

describe('idea-write-home-engine: writes only on the card just flashed (idea#203)', () => {
    it('the source is executable bash with fixed PATH/umask and absolute binaries', async () => {
        const t = await fs.readFile(SRC, 'utf8')
        expect((await fs.stat(SRC)).mode & 0o111).not.toBe(0)
        expect(t.split('\n')[0]).toBe('#!/bin/bash')
        expect(t).toMatch(/^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m)
        expect(t).toMatch(/^umask 022$/m)
        expect(t).toMatch(/^BYID_DIR=\/dev\/disk\/by-id$/m)
    })

    it('writes "<name>.local" to idea-home.txt on FAT partition 1, mounted nosuid,nodev,noexec, then unmounts', async () => {
        const c = await addCard(sb, 'sdc', 'usb-Generic_STORAGE_DEVICE_000000001206-0:0')
        const r = run(c.byId, c.dev, String(SIZE), 'brave-otter')
        expect(r.code, r.err).toBe(0)
        expect(r.out).toContain('idea-home.txt = brave-otter.local')
        const log = await fs.readFile(path.join(sb.state, 'mount.log'), 'utf8')
        expect(log).toMatch(new RegExp(`^-t vfat -o rw,nosuid,nodev,noexec,umask=022 ${c.part} `))
        const { mp, text } = await homeFile()
        expect(text).toBe('brave-otter.local\n')
        expect(await fs.readFile(path.join(sb.state, 'umount.log'), 'utf8')).toContain(mp)
        expect((await fs.readFile(path.join(sb.state, 'mounted'), 'utf8')).trim()).toBe('')
    })

    it('works for an SD slot card (mmcblkN, partition p1)', async () => {
        const c = await addCard(sb, 'mmcblk1', 'mmc-SD32G_0x1234abcd', { removable: '0' })
        const r = run(c.byId, c.dev, String(SIZE), 'idea04')
        expect(r.code, r.err).toBe(0)
        expect((await homeFile()).text).toBe('idea04.local\n')
    })

    it('accepts a USB reader that reports removable=0 (TRAN usb)', async () => {
        const c = await addCard(sb, 'sdd', 'usb-Reader_X-0:0', { removable: '0', tran: 'usb' })
        expect(run(c.byId, c.dev, String(SIZE), 'brave-otter').code).toBe(0)
    })

    it('MEDIUM_SWAPPED: the by-id link now points at another disk', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        await addCard(sb, 'sdd', 'usb-B-0:0')
        refused(run(c.byId, path.join(sb.dev, 'sdd'), String(SIZE), 'brave-otter'), 'MEDIUM_SWAPPED')
    })

    it('MEDIUM_SWAPPED: same device name but a different size (another card in the reader)', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0', { sizeBytes: 15931539456 })
        refused(run(c.byId, c.dev, String(SIZE), 'brave-otter'), 'MEDIUM_SWAPPED')
    })

    it('MEDIUM_SWAPPED: the by-id link is gone', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        await fs.remove(c.byId)
        refused(run(c.byId, c.dev, String(SIZE), 'brave-otter'), 'MEDIUM_SWAPPED')
    })

    it('BAD_ARGS: a partition link, a path outside by-id, a non-whole-disk device, bad size, bad names', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        await fs.symlink(c.part, path.join(sb.byId, 'usb-A-0:0-part1'))
        refused(run(path.join(sb.byId, 'usb-A-0:0-part1'), c.dev, String(SIZE), 'x'), 'BAD_ARGS')
        refused(run(c.dev, c.dev, String(SIZE), 'x'), 'BAD_ARGS')
        refused(run(path.join(sb.byId, '../usb-A-0:0'), c.dev, String(SIZE), 'x'), 'BAD_ARGS')
        refused(run(c.byId, c.part, String(SIZE), 'x'), 'BAD_ARGS')
        refused(run(c.byId, c.dev, '12GB', 'x'), 'BAD_ARGS')
        for (const bad of ['Brave-Otter', 'brave otter', '-x', 'x-', '../x', 'x.local', 'a'.repeat(64), '']) {
            refused(run(c.byId, c.dev, String(SIZE), bad), 'BAD_ARGS')
        }
        refused(run(c.byId, c.dev, String(SIZE)), 'BAD_ARGS')
    })

    it('NOT_REMOVABLE: a fixed disk (removable=0, not USB, not an SD slot)', async () => {
        const c = await addCard(sb, 'sdc', 'ata-Fixed-0', { removable: '0', tran: 'sata' })
        refused(run(c.byId, c.dev, String(SIZE), 'brave-otter'), 'NOT_REMOVABLE')
    })

    it('SYSTEM_DISK: the disk holding /', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        await fs.writeFile(path.join(sb.state, 'mounted'), `${c.part} /\n`)
        refused(run(c.byId, c.dev, String(SIZE), 'brave-otter'), 'SYSTEM_DISK')
    })

    it('BOOT_DEVICE: the disk holding /boot/firmware', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        await fs.writeFile(path.join(sb.state, 'mounted'), `${c.part} /boot/firmware\n`)
        refused(run(c.byId, c.dev, String(SIZE), 'brave-otter'), 'BOOT_DEVICE')
    })

    it('MOUNTED: any partition of the card is mounted', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        await fs.writeFile(path.join(sb.state, 'mounted'), `${c.part} /media/pi/system-boot\n`)
        refused(run(c.byId, c.dev, String(SIZE), 'brave-otter'), 'MOUNTED')
    })

    it('NOT_FAT: partition 1 is ext4 (e.g. an IDEA disk or anything not a client image)', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0', { fstype: 'ext4' })
        refused(run(c.byId, c.dev, String(SIZE), 'brave-otter'), 'NOT_FAT')
    })

    it('a failed mount leaves nothing mounted and no file', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        await fs.writeFile(path.join(sb.state, 'fail-mount'), '')
        const r = run(c.byId, c.dev, String(SIZE), 'brave-otter')
        expect(r.code).not.toBe(0)
        const { mp } = await homeFile()
        expect(fs.existsSync(mp)).toBe(false) // temp mount point removed by the EXIT trap
    })
})
