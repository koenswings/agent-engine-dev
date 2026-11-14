/**
 * install-root-helpers.test.ts — the root-owned install step that build-engine,
 * ./install-root-helpers and sync-engine all run (wizardly-hugle had no borg,
 * 2026-10-13), plus the borg preflight:
 *   - borgbackup + rsync are installed only when dpkg says they are missing
 *   - the helpers are (re)installed every time, so an outdated helper is upgraded
 *   - the step verifies /usr/bin/borg and `idea-app-data version` and fails loudly
 *   - borgProblem / reportBorgAtStartup name the missing binary and the fix
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { installRootHelpers, ensureAptPackages, ROOT_HELPER_PACKAGES, IGMP_SYSCTL_CONF, IGMP_SYSCTL_ASSET } from '../../src/data/Engine.js'
import { borgProblem, BORG_PATH, APP_DATA_HELPER_VERSION } from '../../src/utils/appDataHelper.js'

const recordingExec = (opts: { installed?: string[], fail?: RegExp[], version?: string } = {}) => {
    const cmds: string[] = []
    const exec = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const cmd = strings.reduce((acc, s, i) => acc + s + (i < vals.length ? (Array.isArray(vals[i]) ? (vals[i] as string[]).join(' ') : String(vals[i])) : ''), '')
        cmds.push(cmd)
        if ((opts.fail ?? []).some(re => re.test(cmd))) throw new Error(`${cmd}: exit 1`)
        const m = /^dpkg-query -W -f=\$\{Status\} (\S+)$/.exec(cmd)
        if (m) {
            if ((opts.installed ?? []).includes(m[1])) return { stdout: 'install ok installed' }
            throw new Error(`dpkg-query: no packages found matching ${m[1]}`)
        }
        if (/sshd -T/.test(cmd)) return { stdout: 'authorizedkeysfile .ssh/authorized_keys /etc/ssh/idea_authorized_keys/%u /etc/ssh/idea_usage_keys/%u\n' }
        if (/idea-app-data version$/.test(cmd)) return { stdout: `${opts.version ?? `idea-app-data ${APP_DATA_HELPER_VERSION}`}\n` }
        return { stdout: '' }
    }
    return { exec, cmds }
}

const quiet = () => vi.spyOn(console, 'info').mockImplementation(() => undefined)

describe('ensureAptPackages', () => {
    it('installs only the missing packages (borgbackup on a Pi that has rsync)', async () => {
        const { exec, cmds } = recordingExec({ installed: ['rsync'] })
        const q = quiet()
        try { expect(await ensureAptPackages(exec, ROOT_HELPER_PACKAGES)).toEqual(['borgbackup']) } finally { q.mockRestore() }
        expect(cmds).toContain('sudo apt-get update -y')
        expect(cmds).toContain('sudo DEBIAN_FRONTEND=noninteractive apt-get install -y borgbackup')
    })
    it('is a no-op when everything is installed (no apt at all)', async () => {
        const { exec, cmds } = recordingExec({ installed: ['rsync', 'borgbackup'] })
        const q = quiet()
        try { expect(await ensureAptPackages(exec, ROOT_HELPER_PACKAGES)).toEqual([]) } finally { q.mockRestore() }
        expect(cmds.some(c => /apt-get/.test(c))).toBe(false)
    })
    it('lists borgbackup and rsync', () => {
        expect(ROOT_HELPER_PACKAGES).toEqual(expect.arrayContaining(['rsync', 'borgbackup']))
    })
})

describe('installRootHelpers', () => {
    it('installs packages, sudoers, both helpers and peer access, then verifies borg + helper version', async () => {
        const { exec, cmds } = recordingExec({ installed: ['rsync'] })
        const q = quiet()
        try { await installRootHelpers(exec, '/e') } finally { q.mockRestore() }
        const idx = (re: RegExp) => cmds.findIndex(c => re.test(c))
        expect(idx(/apt-get install -y borgbackup/)).toBeGreaterThanOrEqual(0)
        expect(idx(/visudo -cf \/e\/script\/build_image_assets\/11-engine-files.sudoers/)).toBeGreaterThan(idx(/apt-get install/))
        expect(cmds).toContain('sudo install -o root -g root -m 0755 /e/script/build_image_assets/idea-app-data /usr/local/sbin/idea-app-data')
        expect(cmds).toContain('sudo install -o root -g root -m 0755 /e/script/build_image_assets/idea-erase-disk /usr/local/sbin/idea-erase-disk')
        expect(cmds).toContain('sudo install -o root -g root -m 0755 /e/script/build_image_assets/idea-usage-settings /usr/local/sbin/idea-usage-settings')
        expect(cmds).toContain('sudo install -d -o pi -g pi -m 0750 /var/lib/idea/usage')
        expect(cmds.some(c => /idea-usage\.tmpfiles\.conf/.test(c))).toBe(true)
        expect(idx(/idea-peer-gate/)).toBeGreaterThan(idx(/idea-app-data \/usr\/local/))
        expect(idx(/idea-usage-export/)).toBeGreaterThan(idx(/idea-app-data \/usr\/local/))
        expect(cmds.slice(-2)).toEqual([`test -x ${BORG_PATH}`, 'sudo -n /usr/local/sbin/idea-app-data version'])
    })
    it('a second run reinstalls the helper (upgrade) but runs no apt', async () => {
        const { exec, cmds } = recordingExec({ installed: ['rsync', 'borgbackup'] })
        const q = quiet()
        try { await installRootHelpers(exec, '/e') } finally { q.mockRestore() }
        expect(cmds.some(c => /apt-get/.test(c))).toBe(false)
        expect(cmds.some(c => /install .* \/usr\/local\/sbin\/idea-app-data$/.test(c))).toBe(true)
    })
    it('fails loudly when borg is still missing afterwards', async () => {
        const { exec } = recordingExec({ installed: ['rsync', 'borgbackup'], fail: [/^test -x \/usr\/bin\/borg$/] })
        const q = quiet()
        try { await expect(installRootHelpers(exec, '/e')).rejects.toThrow(/\/usr\/bin\/borg is still missing/) } finally { q.mockRestore() }
    })
    it('fails loudly when the installed helper reports another version', async () => {
        const { exec } = recordingExec({ installed: ['rsync', 'borgbackup'], version: 'idea-app-data 2' })
        const q = quiet()
        try { await expect(installRootHelpers(exec, '/e')).rejects.toThrow(/reports 'idea-app-data 2' after install/) } finally { q.mockRestore() }
    })
})

describe('installRootHelpers applies the DHCP vendor class on every update (idea#284)', () => {
    const helper = '/usr/local/sbin/idea-dhcp-vendor-class'
    it('installs and runs idea-dhcp-vendor-class, only reloads NM config, before the final checks', async () => {
        const { exec, cmds } = recordingExec({ installed: ['rsync', 'borgbackup'] })
        const q = quiet()
        try { await installRootHelpers(exec, '/e') } finally { q.mockRestore() }
        const idx = (c: string) => cmds.indexOf(c)
        const inst = idx(`sudo install -o root -g root -m 0755 /e/script/build_image_assets/idea-dhcp-vendor-class ${helper}`)
        const run = idx(`sudo ${helper}`)
        const reload = idx('if systemctl is-active --quiet NetworkManager; then sudo nmcli general reload conf; fi')
        expect(inst).toBeGreaterThanOrEqual(0)
        expect(run).toBeGreaterThan(inst)
        expect(reload).toBeGreaterThan(run)
        expect(reload).toBeLessThan(idx(`test -x ${BORG_PATH}`))
        for (const c of cmds) expect(c).not.toMatch(/restart NetworkManager|connection (up|down)|device (disconnect|reapply)|dhcpcd -[nk]/)
    })
    it('runs it again on a second update (the helper itself is idempotent)', async () => {
        const { exec, cmds } = recordingExec({ installed: ['rsync', 'borgbackup'] })
        const q = quiet()
        try { await installRootHelpers(exec, '/e'); await installRootHelpers(exec, '/e') } finally { q.mockRestore() }
        expect(cmds.filter(c => c === `sudo ${helper}`)).toHaveLength(2)
    })
    it('a failing vendor-class step does not abort the update (the fleet health check reports it)', async () => {
        const { exec, cmds } = recordingExec({ installed: ['rsync', 'borgbackup'], fail: [/^sudo \/usr\/local\/sbin\/idea-dhcp-vendor-class$/] })
        const q = quiet()
        const e = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        try { await expect(installRootHelpers(exec, '/e')).resolves.toBeUndefined() } finally { q.mockRestore(); e.mockRestore() }
        expect(cmds.slice(-1)).toEqual(['sudo -n /usr/local/sbin/idea-app-data version'])
    })
})

describe('installRootHelpers applies the IGMP sysctl drop-in on every update (idea#467)', () => {
    const inst = `sudo install -o root -g root -m 0644 /e/script/build_image_assets/${IGMP_SYSCTL_ASSET} ${IGMP_SYSCTL_CONF}`
    const apply = `sudo sysctl -p ${IGMP_SYSCTL_CONF}`
    const imageBuild = process.env.IDEA_IMAGE_BUILD
    afterEach(() => {
        if (imageBuild === undefined) delete process.env.IDEA_IMAGE_BUILD
        else process.env.IDEA_IMAGE_BUILD = imageBuild
    })

    it('installs 90-idea-igmp.conf and applies it with sysctl -p, before the final checks', async () => {
        const { exec, cmds } = recordingExec({ installed: ['rsync', 'borgbackup'] })
        const q = quiet()
        try { await installRootHelpers(exec, '/e') } finally { q.mockRestore() }
        const idx = (c: string) => cmds.indexOf(c)
        expect(idx(inst)).toBeGreaterThanOrEqual(0)
        expect(idx(apply)).toBeGreaterThan(idx(inst))
        expect(idx(apply)).toBeLessThan(idx(`test -x ${BORG_PATH}`))
    })
    it('runs it again on a second update (idempotent)', async () => {
        const { exec, cmds } = recordingExec({ installed: ['rsync', 'borgbackup'] })
        const q = quiet()
        try { await installRootHelpers(exec, '/e'); await installRootHelpers(exec, '/e') } finally { q.mockRestore() }
        expect(cmds.filter(c => c === inst)).toHaveLength(2)
        expect(cmds.filter(c => c === apply)).toHaveLength(2)
    })
    it('still installs the file in an image build, but skips sysctl -p (would touch the build host /proc)', async () => {
        process.env.IDEA_IMAGE_BUILD = '1'
        const { exec, cmds } = recordingExec({ installed: ['rsync', 'borgbackup'] })
        const q = quiet()
        try { await installRootHelpers(exec, '/e') } finally { q.mockRestore() }
        expect(cmds).toContain(inst)
        expect(cmds.some(c => c === apply)).toBe(false)
        expect(cmds.slice(-2)).toEqual([`test -x ${BORG_PATH}`, 'sudo -n /usr/local/sbin/idea-app-data version'])
    })
    it('a failing sysctl -p aborts the update so the default of 20 is not left unnoticed', async () => {
        const { exec } = recordingExec({ installed: ['rsync', 'borgbackup'], fail: [/^sudo sysctl -p \/etc\/sysctl\.d\/90-idea-igmp\.conf$/] })
        const q = quiet()
        try { await expect(installRootHelpers(exec, '/e')).rejects.toThrow(/sysctl -p/) } finally { q.mockRestore() }
    })
})

describe('borgProblem (startup + backup preflight)', () => {
    it('null when /usr/bin/borg exists', () => {
        expect(borgProblem(p => p === '/usr/bin/borg')).toBeNull()
    })
    it('names the binary and the fix when it is missing (instead of exit 127 at backup time)', () => {
        const msg = borgProblem(() => false)!
        expect(msg).toMatch(/\/usr\/bin\/borg is not installed/)
        expect(msg).toMatch(/\.\/install-root-helpers/)
        expect(msg).toMatch(/borgbackup/)
    })
})
