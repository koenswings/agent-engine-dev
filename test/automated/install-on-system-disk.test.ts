/**
 * install-on-system-disk.test.ts
 *
 * On wizardly-hugle (Engine 745f2c3) installApp onto the System Disk (root on
 * /dev/sda2) built the instance under /disks/sda2 (an empty root-owned mount
 * point) instead of /apps and /instances, so Kolibri failed at mkdir.
 * buildInstance (the GitHub route of installApp) hard-coded <disksRoot>/<device>.
 *
 * Covers buildInstance on a Pi 4 USB root (sda2), a Pi 5 NVMe root (nvme0n1p2),
 * an SD/eMMC root (mmcblk0p2), and a regular App Disk control (sdb1), and that
 * the system disk never gets a new META.yaml. Shell commands are recorded only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cmds: string[] = []
vi.mock('zx', async (orig) => {
    const real: any = await orig()
    const fake: any = (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const cmd = strings.reduce((a, s, i) => a + s + (i < vals.length ? String(vals[i]) : ''), '')
        // Engine start-up reads (Engine id from /META.yaml, findmnt, lsblk) use the real shell
        if (/META\.yaml|^findmnt|^lsblk/.test(cmd) && !cmd.startsWith('mkdir')) return real.$(strings, ...vals)
        cmds.push(cmd)
        let stdout = ''
        if (cmd.startsWith('cat ') && cmd.endsWith('compose.yaml')) {
            stdout = 'x-app:\n  version: x\nservices:\n  web:\n    image: test/img:1\n'
        } else if (cmd.includes('git log')) stdout = 'abc123'
        const p: any = Promise.resolve({ stdout, stderr: '', exitCode: 0 })
        p.nothrow = () => p; p.quiet = () => p
        return p
    }
    // Only the instance/service paths under test are reported missing; everything
    // else (e.g. /META.yaml for the Engine id) keeps the real answer.
    const fs = { ...real.fs, existsSync: (p: any) => /\/(instances|services|apps)\/|\/sdb1\/META\.yaml$/.test(String(p)) ? false : real.fs.existsSync(p) }
    return { ...real, $: fake, fs }
})
vi.mock('../../src/data/Meta.js', async (orig) => {
    const real: any = await orig()
    return { ...real, createMeta: vi.fn(async (device: string) => { cmds.push(`createMeta ${device}`); return {} }) }
})

const { buildInstance } = await import('../../src/data/Instance.js')
const { setRootDeviceForTests } = await import('../../src/data/Disk.js')
const { disksRoot } = await import('../../src/data/Config.js')

const build = (device: string) => buildInstance('k' as any, 'kolibri' as any, 'koenswings', '1.0' as any, device as any)

describe('installApp (buildInstance) on the system disk', () => {
    beforeEach(() => { cmds.length = 0 })
    afterEach(() => setRootDeviceForTests(null))

    for (const [label, dev] of [['Pi 4 USB root', 'sda2'], ['Pi 5 NVMe root', 'nvme0n1p2'], ['SD/eMMC root', 'mmcblk0p2']]) {
        it(`${label} (${dev}) builds under /apps and /instances, never <disksRoot>/${dev}`, async () => {
            setRootDeviceForTests(dev)
            await build(dev)
            const all = cmds.join('\n')
            expect(all).toContain('sudo -n /usr/bin/mkdir -p /apps /instances /services')
            expect(all).toContain('sudo -n /usr/bin/chown pi:pi /apps /instances /services')
            expect(all).toMatch(/cp -fr \/tmp\/apps\/kolibri\/\. \/instances\/[^/\s]+\//)
            expect(all).not.toContain(`${disksRoot()}/${dev}`)
            expect(all).not.toContain(`/disks/${dev}`)
            expect(all).not.toContain('createMeta')
        })
    }

    it('a regular App Disk (sdb1) still builds under <disksRoot>/sdb1', async () => {
        setRootDeviceForTests('sda2')
        await build('sdb1')
        const all = cmds.join('\n')
        expect(all).toContain(`mkdir -p ${disksRoot()}/sdb1/apps`)
        expect(all).toContain(`${disksRoot()}/sdb1/instances/`)
        expect(all).toContain('createMeta sdb1')
        expect(all).not.toContain('chown')
    })
})
