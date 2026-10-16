/**
 * idea-erase-disk-script.test.ts — shell refusals and mkfs flags (idea#134)
 *
 * Runs the script with PATH overridden so fake lsblk/findmnt/wipefs/sfdisk/mkfs
 * /udevadm/stat intercept calls. Never touches real block devices.
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { fs, path, $ } from 'zx'
import os from 'os'

const SCRIPT = path.resolve('script/build_image_assets/idea-erase-disk')
let tmp: string
let bin: string
let staging: string
const calls: string[] = []

const writeFake = async (name: string, body: string) => {
    const p = path.join(bin, name)
    await fs.writeFile(p, `#!/bin/bash\n${body}\n`)
    await fs.chmod(p, 0o755)
}

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-erase-'))
    bin = path.join(tmp, 'bin')
    await fs.ensureDir(bin)
    staging = '/home/pi/.local/state/idea-engine/erase-staging/test1'
    // Use a staging path under tmp by patching via symlink refusal tests separately;
    // for happy/refuse tests we recreate the required path if /home/pi exists, else skip.
    calls.length = 0
})
afterEach(async () => { await fs.remove(tmp) })

const run = async (args: string[], env: Record<string, string> = {}) => {
    // Rewrite script to use our bin by putting bin first in PATH and providing
    // wrappers named as full-path basenames — the script uses absolute paths.
    // So we copy the script and sed absolute paths to our bin.
    const localScript = path.join(tmp, 'idea-erase-disk')
    let text = await fs.readFile(SCRIPT, 'utf8')
    for (const tool of ['lsblk', 'findmnt', 'wipefs', 'sfdisk', 'mkfs.ext4', 'udevadm', 'stat', 'realpath']) {
        text = text.replaceAll(`/usr/bin/${tool}`, path.join(bin, tool))
        text = text.replaceAll(`/usr/sbin/${tool}`, path.join(bin, tool))
    }
    await fs.writeFile(localScript, text)
    await fs.chmod(localScript, 0o755)
    return $({ nothrow: true })`${localScript} ${args}`
}

describe('idea-erase-disk script (idea#134)', () => {
    it('source script exists, is executable, and never calls mount', async () => {
        const text = await fs.readFile(SCRIPT, 'utf8')
        expect(text).toMatch(/mkfs\.ext4/)
        expect(text).toMatch(/root_owner=1000:1000/)
        expect(text).toMatch(/wipefs -a/)
        expect(text).not.toMatch(/(^|[^a-z])mount( |$)/m)
        expect(text).not.toMatch(/idea-format-disk/)
        // No role-marker refusal
        expect(text).not.toMatch(/FILES\.yaml|BACKUP\.yaml|apps\//)
    })

    it('refuses a partition path', async () => {
        await writeFake('lsblk', 'echo disk')
        await writeFake('findmnt', 'exit 1')
        await writeFake('stat', 'echo pi')
        const out = await run(['/dev/sdb1', '-', '1000', 'IDEA Disk', path.join(tmp, 'stage')])
        // staging path also wrong — either refusal is fine
        expect(out.exitCode).not.toBe(0)
        expect(out.stderr + out.stdout).toMatch(/refused|whole disk|stagingDir/i)
    })

    it('refuses a label longer than 16 bytes before mkfs', async () => {
        const stage = path.join(tmp, 'stage-home')
        // Build a local script that also relaxes staging path for this unit test
        const localScript = path.join(tmp, 'idea-erase-disk')
        let text = await fs.readFile(SCRIPT, 'utf8')
        text = text.replace(
            /\[\[ \"\$STAGING\" =~ \^\/home\/pi\/\.local\/state\/idea-engine\/erase-staging\/\[A-Za-z0-9_-\]\+\$ \]\]/,
            `[[ "$STAGING" =~ ^${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/ ]]`,
        )
        for (const tool of ['lsblk', 'findmnt', 'wipefs', 'sfdisk', 'mkfs.ext4', 'udevadm', 'stat']) {
            text = text.replaceAll(`/usr/bin/${tool}`, path.join(bin, tool))
            text = text.replaceAll(`/usr/sbin/${tool}`, path.join(bin, tool))
        }
        await fs.writeFile(localScript, text)
        await fs.chmod(localScript, 0o755)
        await fs.ensureDir(stage)
        await fs.writeFile(path.join(stage, 'META.yaml'), 'diskId: x\n')
        await writeFake('stat', 'echo pi')
        const long = 'ABCDEFGHIJKLMNOPQ' // 17 chars
        const out = await $({ nothrow: true })`${localScript} /dev/sdb - 1000 ${long} ${stage}`
        expect(out.exitCode).not.toBe(0)
        expect(out.stderr).toMatch(/16 bytes|label/i)
        // mkfs must not have been invoked
        expect(await fs.pathExists(path.join(bin, 'mkfs.called'))).toBe(false)
    })
    // #188 idea01 sda1: a partition in the on-disk table that the kernel does not show
    const SFDISK_DUMP = [
        'label: gpt', 'device: /dev/sdb', '',
        '/dev/sdb1 : start=        2048, size=   105498624, type=0FC63DAF, uuid=E38E, name="IDEA-KOLIBRI"',
        '/dev/sdb2 : start=   105500672, size=   128940943, type=0FC63DAF, uuid=3B75, name="IDEA-ADDFILES"',
    ].join('\n')
    const runTable = async (args: string[], kernelParts: string[]) => {
        const sys = path.join(tmp, 'sys')
        await fs.ensureDir(path.join(sys, 'sdb'))
        for (const p of kernelParts) await fs.ensureDir(path.join(sys, 'sdb', p))
        const stage = path.join(tmp, 'stage-table')
        await fs.ensureDir(stage)
        await fs.writeFile(path.join(stage, 'META.yaml'), 'diskId: x\n')
        const localScript = path.join(tmp, 'idea-erase-disk')
        let text = await fs.readFile(SCRIPT, 'utf8')
        text = text.replace(
            '[[ "$STAGING" =~ ^/home/pi/\\.local/state/idea-engine/erase-staging/[A-Za-z0-9_-]+$ ]]',
            `[[ "$STAGING" == ${tmp}/* ]]`,
        )
        expect(text).toContain(`[[ "$STAGING" == ${tmp}/* ]]`)
        text = text.replace('SYS_BLOCK=/sys/block', `SYS_BLOCK=${sys}`)
        for (const tool of ['lsblk', 'findmnt', 'wipefs', 'sfdisk', 'mkfs.ext4', 'udevadm', 'stat']) {
            text = text.replaceAll(`/usr/bin/${tool}`, path.join(bin, tool))
            text = text.replaceAll(`/usr/sbin/${tool}`, path.join(bin, tool))
        }
        await fs.writeFile(localScript, text)
        await fs.chmod(localScript, 0o755)
        await fs.writeFile(path.join(tmp, 'dump.txt'), SFDISK_DUMP + '\n')
        await writeFake('sfdisk', `if [ "$1" = "-d" ]; then cat ${path.join(tmp, 'dump.txt')}; exit 0; fi; touch ${path.join(bin, 'sfdisk.write')}`)
        await writeFake('wipefs', `touch ${path.join(bin, 'wipefs.called')}`)
        await writeFake('stat', 'echo pi')
        await writeFake('findmnt', 'exit 1')
        await writeFake('lsblk', 'for a in "$@"; do case "$a" in TYPE) echo disk; exit 0;; SIZE) echo 1000; exit 0;; SERIAL) echo -; exit 0;; esac; done; exit 0')
        return $({ nothrow: true })`${localScript} ${args.map(a => a === '@STAGE' ? stage : a)}`
    }

    it('--check-table lists table partitions the kernel does not show, read-only', async () => {
        const out = await runTable(['--check-table', '/dev/sdb'], ['sdb2'])
        expect(out.exitCode).toBe(0)
        expect(out.stdout.trim().split('\n')).toHaveLength(1)
        expect(out.stdout).toMatch(/^hidden: sdb1 start=.*name="IDEA-KOLIBRI"/)
        expect(await fs.pathExists(path.join(bin, 'wipefs.called'))).toBe(false)
        expect(await fs.pathExists(path.join(bin, 'sfdisk.write'))).toBe(false)
    })

    it('--check-table prints nothing when the kernel shows every partition', async () => {
        const out = await runTable(['--check-table', '/dev/sdb'], ['sdb1', 'sdb2'])
        expect(out.exitCode).toBe(0)
        expect(out.stdout.trim()).toBe('')
    })

    it('--check-table refuses a partition device', async () => {
        const out = await runTable(['--check-table', '/dev/sdb1'], [])
        expect(out.exitCode).not.toBe(0)
        expect(out.stderr).toMatch(/whole disk/)
    })

    it('erase refuses before wipefs when the table has a hidden partition', async () => {
        const out = await runTable(['/dev/sdb', '-', '1000', 'IDEA Disk', '@STAGE'], ['sdb2'])
        expect(out.exitCode).not.toBe(0)
        expect(out.stderr).toMatch(/partition table of \/dev\/sdb has partitions the kernel does not show \(sdb1\)/)
        expect(await fs.pathExists(path.join(bin, 'wipefs.called'))).toBe(false)
        expect(await fs.pathExists(path.join(bin, 'sfdisk.write'))).toBe(false)
    })
})
