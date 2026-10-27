/**
 * client-timezone.test.ts — idea#208: the client time zone is a flash-time parameter.
 * The Engine reads its own zone (timedatectl, as pi), validates it and passes it to
 * idea-flash-card --timezone; the helper re-validates it as root and has
 * idea-write-card-timezone write idea-timezone.txt = "<zone>\n" on FAT partition 1
 * (next to idea-home.txt). Image side: koenswings/idea#319.
 * Scripts run in sandbox copies with fake binaries; never root, never mounts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { fs, path } from 'zx'
import os from 'os'
import { validateClientTimezone, clientTimezoneFileContent, TIMEZONE_RE, CLIENT_TIMEZONE_FILE } from '../../src/data/ClientTimezone.js'

const SRC = path.join(process.cwd(), 'script/build_image_assets/idea-write-card-timezone')
const FLASH = path.join(process.cwd(), 'script/build_image_assets/idea-flash-card')
const SIZE = 31914983424

const VALID = ['UTC', 'Africa/Harare', 'Africa/Lusaka', 'America/Argentina/Buenos_Aires', 'Etc/GMT+2']
const INVALID = ['Europe/Nowhere', 'africa harare', '/etc/passwd', '../etc/passwd', 'Africa/../../etc/shadow', 'Africa/..', 'Africa/.',
    'Africa/Harare/', 'A/B/C/D', '1Africa/Harare', 'Africa/Harare; rm -rf /', 'Africa/Harare\nUTC', '$(id)']

interface Sb { tmp: string, dev: string, byId: string, sys: string, script: string, state: string, mnt: string }
let sb: Sb

let zi = ''
const mkZoneinfo = () => {
    zi = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-test-zoneinfo-'))
    for (const z of VALID) { fs.ensureDirSync(path.dirname(path.join(zi, z))); fs.writeFileSync(path.join(zi, z), 'TZif2') }
    fs.ensureDirSync(path.join(zi, 'Europe'))   // a folder is not a zone
    return zi
}

describe('validateClientTimezone (Engine side, idea#208)', () => {
    beforeEach(() => { mkZoneinfo() })
    afterEach(() => { fs.rmSync(zi, { recursive: true, force: true }) })

    it('valid zones pass (trimmed, as timedatectl prints them)', () => {
        for (const z of VALID) expect(validateClientTimezone(z, zi), z).toEqual({ ok: true, zone: z })
        expect(validateClientTimezone('Africa/Harare\n', zi)).toEqual({ ok: true, zone: 'Africa/Harare' })
    })
    it('empty / null → skipped', () => {
        for (const z of ['', '   ', '\n', null, undefined]) expect(validateClientTimezone(z as any, zi).ok).toBe(false)
        expect(validateClientTimezone('', zi)).toMatchObject({ ok: false, reason: expect.stringMatching(/empty/) })
    })
    it('invalid names and traversal are rejected', () => {
        for (const z of INVALID) expect(validateClientTimezone(z, zi).ok, z).toBe(false)
        // the regex alone already blocks '..' (traversal) and absolute paths
        for (const z of ['..', '../x', 'a/../b', '/UTC', 'Africa/..']) expect(TIMEZONE_RE.test(z), z).toBe(false)
    })
    it('a well-formed name with no zoneinfo file (or a folder) is rejected', () => {
        expect(validateClientTimezone('Europe/Nowhere', zi)).toMatchObject({ ok: false, reason: expect.stringMatching(/not in/) })
        expect(validateClientTimezone('Europe', zi)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a file/) })
        expect(validateClientTimezone('Africa/Harare', path.join(zi, 'missing')).ok).toBe(false)
    })
    it('file content is one line with a trailing newline', () => {
        expect(CLIENT_TIMEZONE_FILE).toBe('idea-timezone.txt')
        expect(clientTimezoneFileContent('Africa/Harare')).toBe('Africa/Harare\n')
    })
})

describe('idea-flash-card --timezone: re-validated as root before anything is touched (idea#208)', () => {
    beforeEach(() => { mkZoneinfo() })
    afterEach(() => { fs.rmSync(zi, { recursive: true, force: true }) })
    const block = () => { const t = fs.readFileSync(FLASH, 'utf8'); return t.slice(t.indexOf('# >>> tz-check'), t.indexOf('# <<< tz-check')) }
    const check = (zone: string | null) => spawnSync('bash', ['-c',
        `refuse() { echo "refused: $1: $2" >&2; exit 2; }; ZONEINFO=${zi}; TZ_SET=${zone === null ? 0 : 1}; TZONE="$1"\n${block()}\necho PASSED`, 'x', zone ?? ''],
        { encoding: 'utf8' })

    it('version 3, --timezone documented, writer called before flush + power-off', () => {
        const t = fs.readFileSync(FLASH, 'utf8')
        expect(spawnSync('bash', [FLASH, '--version'], { encoding: 'utf8' }).stdout.trim()).toBe('idea-flash-card 3')
        expect(t).toMatch(/^TZ_WRITER=\/usr\/local\/sbin\/idea-write-card-timezone$/m)
        expect(t).toMatch(/^ZONEINFO=\/usr\/share\/zoneinfo$/m)
        const w = t.indexOf('"$TZ_WRITER" "$BYID" "$DEVPATH" "$SIZE" "$TZONE"')
        expect(w).toBeGreaterThan(t.indexOf('VERIFY_FAILED'))
        expect(w).toBeLessThan(t.indexOf('emit flushing'))
        expect(t).toContain('"timezoneFile":"%s"')
    })
    it('valid zones pass, no --timezone passes', () => {
        for (const z of VALID) expect(check(z).stdout, z).toContain('PASSED')
        expect(check(null).stdout).toContain('PASSED')
    })
    it('empty, invalid, traversal and missing-zoneinfo zones → BAD_ARGS', () => {
        for (const z of ['', ...INVALID, 'Europe']) {
            const r = check(z)
            expect(r.status, z).toBe(2)
            expect(r.stderr).toMatch(/^refused: BAD_ARGS: timezone/)
        }
    })
    it('the real helper refuses a bad --timezone with exit 2 before any device check', () => {
        const base = ['--by-id', '/dev/disk/by-id/usb-Generic_X-0:0', '--expect-device', 'sdz', '--expect-size', '100',
            '--image', '/var/lib/idea/client-images/26.04-20261016-8be2435/idea-client-26.04-20261016-8be2435.img.xz', '--sha256', 'a'.repeat(64)]
        for (const z of ['../etc/passwd', 'Europe/Nowhere', '']) {
            const r = spawnSync('bash', [FLASH, ...base, '--timezone', z], { encoding: 'utf8' })
            expect(r.status, z).toBe(2)
            expect(r.stderr).toMatch(/^refused: BAD_ARGS: timezone/)
        }
    })
})

const fake = async (sb: Sb, name: string, body: string) => {
    const p = path.join(sb.tmp, 'bin', name)
    await fs.outputFile(p, `#!/bin/bash\nS=${sb.state}\n${body}\n`)
    await fs.chmod(p, 0o755)
    return p
}

const makeSandbox = async (): Promise<Sb> => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-cardtz-'))
    const s: Sb = { tmp, dev: path.join(tmp, 'dev'), byId: path.join(tmp, 'dev/disk/by-id'), sys: path.join(tmp, 'sys'),
        script: path.join(tmp, 'idea-write-card-timezone'), state: path.join(tmp, 'state'), mnt: path.join(tmp, 'run') }
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
    set('MOUNT', mount); await fs.ensureDir(path.join(s.tmp, 'zoneinfo/Africa')); await fs.writeFile(path.join(s.tmp, 'zoneinfo/Africa/Harare'), 'TZif2'); await fs.writeFile(path.join(s.tmp, 'zoneinfo/UTC'), 'TZif2'); await fs.ensureDir(path.join(s.tmp, 'zoneinfo/America/Argentina')); await fs.writeFile(path.join(s.tmp, 'zoneinfo/America/Argentina/Buenos_Aires'), 'TZif2'); set('ZONEINFO', path.join(s.tmp, 'zoneinfo')); set('UMOUNT', umount); set('SYNC', sync)
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
const tzFile = async () => {
    const mp = (await fs.readFile(path.join(sb.state, 'mount.log'), 'utf8')).trim().split(' ').pop()!
    return { mp, text: await fs.readFile(path.join(mp, 'idea-timezone.txt'), 'utf8').catch(() => null) }
}


beforeEach(async () => { sb = await makeSandbox() })
afterEach(async () => { await fs.remove(sb.tmp) })

describe('idea-write-card-timezone: idea-timezone.txt on the card just flashed (idea#208)', () => {
    it('writes "<zone>\\n" to idea-timezone.txt on FAT partition 1 (nosuid,nodev,noexec), then unmounts', async () => {
        const c = await addCard(sb, 'sdc', 'usb-Generic_STORAGE_DEVICE_000000001206-0:0')
        const r = run(c.byId, c.dev, String(SIZE), 'Africa/Harare')
        expect(r.code, r.err).toBe(0)
        expect(r.out).toContain('idea-timezone.txt = Africa/Harare')
        expect(await fs.readFile(path.join(sb.state, 'mount.log'), 'utf8')).toMatch(new RegExp(`^-t vfat -o rw,nosuid,nodev,noexec,umask=022 ${c.part} `))
        const { mp, text } = await tzFile()
        expect(text).toBe('Africa/Harare\n')
        expect(fs.readdirSync(mp).filter(f => f.endsWith('.tmp'))).toEqual([])
        expect(await fs.readFile(path.join(sb.state, 'umount.log'), 'utf8')).toContain(mp)
        expect((await fs.readFile(path.join(sb.state, 'mounted'), 'utf8')).trim()).toBe('')
    })
    it('three-part zone works', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        expect(run(c.byId, c.dev, String(SIZE), 'America/Argentina/Buenos_Aires').code).toBe(0)
        expect((await tzFile()).text).toBe('America/Argentina/Buenos_Aires\n')
    })
    it('BAD_ARGS for empty, invalid, traversal and missing-zoneinfo zones; nothing mounted', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        for (const z of ['', ...INVALID, 'Africa']) refused(run(c.byId, c.dev, String(SIZE), z), 'BAD_ARGS')
    })
    it('same identity refusals as idea-write-home-engine', async () => {
        const c = await addCard(sb, 'sdc', 'usb-A-0:0')
        await addCard(sb, 'sdd', 'usb-B-0:0', { fstype: 'ext4' })
        refused(run(c.byId, path.join(sb.dev, 'sdd'), String(SIZE), 'UTC'), 'MEDIUM_SWAPPED')
        refused(run(path.join(sb.byId, 'usb-B-0:0'), path.join(sb.dev, 'sdd'), String(SIZE), 'UTC'), 'NOT_FAT')
        await fs.writeFile(path.join(sb.state, 'mounted'), `${c.part} /\n`)
        refused(run(c.byId, c.dev, String(SIZE), 'UTC'), 'SYSTEM_DISK')
    })
})
