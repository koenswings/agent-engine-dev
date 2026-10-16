/**
 * hw-home-engine-card.test.ts: the --dry-run of script/hw-home-engine-card.sh (#213),
 * the on-Pi hardware test for idea-write-home-engine. In a sandbox with a fake /dev,
 * /dev/disk/by-id, /sys/class/block and fake lsblk/findmnt/blkid/sudo it must resolve
 * the card, refuse unsafe targets before doing anything, print the full plan, and
 * never call sudo (so nothing is mounted or written).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { fs, path } from 'zx'
import os from 'os'

const SCRIPT = path.join(process.cwd(), 'script/hw-home-engine-card.sh')
let tmp: string, dev: string, byId: string, sys: string, state: string

const fake = async (name: string, body: string) => {
    const p = path.join(tmp, 'bin', name)
    await fs.outputFile(p, `#!/bin/bash\nS=${state}\n${body}\n`); await fs.chmod(p, 0o755); return p
}
let env: Record<string, string>

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-home-'))
    dev = path.join(tmp, 'dev'); byId = path.join(dev, 'disk/by-id'); sys = path.join(tmp, 'sys'); state = path.join(tmp, 'state')
    await fs.ensureDir(byId); await fs.ensureDir(state)
    for (const d of ['sda', 'sda1', 'sda2', 'mmcblk0', 'mmcblk0p1', 'mmcblk0p2']) await fs.outputFile(path.join(dev, d), '')
    await fs.outputFile(path.join(sys, 'sda/size'), '62333952\n'); await fs.outputFile(path.join(sys, 'mmcblk0/size'), '124735488\n')
    await fs.outputFile(path.join(sys, 'sda1/partition'), '1'); await fs.outputFile(path.join(sys, 'sda1/size'), '1048576')
    await fs.symlink(path.join(dev, 'sda'), path.join(byId, 'usb-Generic_STORAGE_DEVICE_000000000819-0:0'))
    await fs.symlink(path.join(dev, 'sda1'), path.join(byId, 'usb-Generic_STORAGE_DEVICE_000000000819-0:0-part1'))
    await fs.symlink(path.join(dev, 'mmcblk0'), path.join(byId, 'mmc-SD32G_0x1234'))
    await fs.writeFile(path.join(state, 'mounted'), `${dev}/mmcblk0p2 /\n${dev}/mmcblk0p1 /boot/firmware\n`)
    await fs.writeFile(path.join(state, 'fstype.sda1'), 'vfat\n'); await fs.writeFile(path.join(state, 'fstype.mmcblk0p1'), 'vfat\n')
    const lsblk = await fake('lsblk', `args="$*"; d="\${@: -1}"; d=\${d##*/}
if [[ "$args" == *"-no PKNAME"* ]]; then case $d in mmcblk0p*) echo mmcblk0;; sda[0-9]) echo sda;; esac; exit 0; fi
if [[ "$args" == *"-lno NAME"* ]]; then echo $d; case $d in sda) echo sda1; echo sda2;; mmcblk0) echo mmcblk0p1; echo mmcblk0p2;; esac; exit 0; fi
exit 1`)
    const findmnt = await fake('findmnt', `
if [ "$1 $2 $3 $4" = "-n -o SOURCE --mountpoint" ]; then awk -v m="$5" '$2==m{print $1; f=1} END{exit !f}' "$S/mounted"; exit; fi
if [ "$1 $2" = "-n --source" ]; then awk -v x="$3" '$1==x{f=1} END{exit !f}' "$S/mounted"; exit; fi
exit 1`)
    const blkid = await fake('blkid', `d="\${@: -1}"; cat "$S/fstype.\${d##*/}" 2>/dev/null; true`)
    const sudo = await fake('sudo', `echo "$*" >> "$S/sudo.log"; exit 1`)
    env = { ...process.env as Record<string, string>, IDEA_HW_DEV_DIR: dev, IDEA_HW_SYS_BLOCK: sys, IDEA_HW_LSBLK: lsblk,
        IDEA_HW_FINDMNT: findmnt, IDEA_HW_BLKID: blkid, IDEA_HW_SUDO: sudo, IDEA_HW_BOOT_DIRS: '/boot/firmware /boot' }
})
afterEach(async () => { await fs.remove(tmp) })

const run = (...args: string[]) => {
    const r = spawnSync('bash', [SCRIPT, '--evidence', path.join(tmp, 'ev'), '--name', 'brave-otter', ...args], { env, encoding: 'utf8' })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const card = () => path.join(byId, 'usb-Generic_STORAGE_DEVICE_000000000819-0:0')
const sudoCalled = () => fs.existsSync(path.join(state, 'sudo.log'))

describe('hw-home-engine-card.sh --dry-run (#213)', () => {
    it('resolves the card and prints the full plan without calling sudo', () => {
        const r = run('--card', card(), '--dry-run')
        expect(r.code, r.out).toBe(0)
        expect(r.out).toContain(`dev=${dev}/sda size=${62333952 * 512} p1=${dev}/sda1 (vfat) name=brave-otter`)
        expect(r.out).toContain('system disk=mmcblk0')
        for (const s of ['refuse BAD_ARGS:', 'Bad_Name', 'refuse MEDIUM_SWAPPED:', `${dev}/sdz`, String(62333952 * 512 + 512),
            'refuse MOUNTED:', `refuse system disk:    helper ${path.join(byId, 'mmc-SD32G_0x1234')} ${dev}/mmcblk0 ${124735488 * 512}`,
            `write:`, 'idea-home.txt == "brave-otter.local\\n"', 'DRY-RUN OK'])
            expect(r.out).toContain(s)
        expect(sudoCalled()).toBe(false)
    })
    it('refuses the system disk as the card', () => {
        const r = run('--card', path.join(byId, 'mmc-SD32G_0x1234'), '--dry-run')
        expect(r.code).toBe(2); expect(r.out).toMatch(/REFUSE-START: .*mmcblk0 holds \//); expect(sudoCalled()).toBe(false)
    })
    it('refuses a -partN link, a path outside by-id and a missing --card', () => {
        expect(run('--card', card() + '-part1', '--dry-run').out).toContain('whole-card link')
        expect(run('--card', `${dev}/sda`, '--dry-run').code).toBe(2)
        expect(run('--dry-run').out).toContain('--card')
    })
    it('refuses a card with a mounted partition', async () => {
        await fs.appendFile(path.join(state, 'mounted'), `${dev}/sda2 /media/x\n`)
        const r = run('--card', card(), '--dry-run')
        expect(r.code).toBe(2); expect(r.out).toContain(`${dev}/sda2 is mounted`)
    })
    it('refuses a card whose partition 1 is not FAT', async () => {
        await fs.writeFile(path.join(state, 'fstype.sda1'), 'ext4\n')
        const r = run('--card', card(), '--dry-run')
        expect(r.code).toBe(2); expect(r.out).toContain("is 'ext4', not vfat")
    })
    it('real mode stops when sudo -n is not available, before touching the card', () => {
        const r = run('--card', card())
        expect(r.code).toBe(2); expect(r.out).toContain('passwordless sudo')
        expect(fs.readFileSync(path.join(state, 'sudo.log'), 'utf8').trim()).toBe('true')
    })
})
