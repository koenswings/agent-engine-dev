/**
 * docking-rule-install.test.ts — engine#479: an Engine update (install-root-helpers,
 * via installRootHelpers) installs the current udev docking rule 90-docking.rules, so
 * the first start after an update passes the disk-detection self-check without a reboot.
 *   - old one-liner installed: kept in quarantine, new rule written, udev reloaded,
 *     a `change` event replayed only for devices without a /dev/engine link
 *   - rule already current: no write, no quarantine, no reload, no trigger
 *   - rule missing: installed and reloaded, nothing quarantined
 *   - devices that already have a link (docked disks) never get a udev event
 *   - image build: installed, udev untouched
 *   - end to end on temp files: after the install, checkDiskDetection reports nothing
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fsp from 'fs/promises'
import fsSync from 'fs'
import { installDockingRule, installRootHelpers, linklessRuleDevices, utcStamp, DOCKING_RULE_QUARANTINE_DIR } from '../../src/data/Engine.js'
import { checkDiskDetection, UDEV_RULE_PATH } from '../../src/monitors/diskDetection.js'
import { APP_DATA_HELPER_VERSION } from '../../src/utils/appDataHelper.js'

const OLD_RULE = 'KERNEL=="sd?|sd?1|sd?2", SYMLINK+="engine/%k"\n'
const ASSET = path.resolve('script/build_image_assets/90-docking.rules')
const NOW = new Date('2026-11-17T07:44:00.123Z')
const STAMP = '20261117T074400Z'

const join = (strings: TemplateStringsArray, vals: unknown[]) =>
    strings.reduce((acc, s, i) => acc + s + (i < vals.length ? (Array.isArray(vals[i]) ? (vals[i] as string[]).join(' ') : String(vals[i])) : ''), '')

/** Scripted exec: `state` says whether the installed rule is current / differs / missing. */
const scriptedExec = (state: 'current' | 'differs' | 'missing') => {
    const cmds: string[] = []
    const exec = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const cmd = join(strings, vals)
        cmds.push(cmd)
        if (/^if sudo cmp -s /.test(cmd)) return { stdout: state === 'current' ? 'same\n' : '' }
        if (/^if sudo test -e .* && ! sudo cmp -s /.test(cmd)) return { stdout: state === 'differs' ? 'differs\n' : '' }
        return { stdout: '' }
    }
    return { exec, cmds }
}

const quiet = () => vi.spyOn(console, 'info').mockImplementation(() => undefined)
const run = async <T>(f: () => Promise<T>): Promise<T> => { const q = quiet(); try { return await f() } finally { q.mockRestore() } }

afterEach(() => { delete process.env.IDEA_IMAGE_BUILD })

describe('utcStamp', () => {
    it('is a compact UTC stamp without milliseconds', () => {
        expect(utcStamp(NOW)).toBe(STAMP)
    })
})

describe('installDockingRule (scripted exec)', () => {
    it('old one-liner: quarantines it, installs the shipped rule, reloads, replays only linkless devices', async () => {
        const { exec, cmds } = scriptedExec('differs')
        const r = await run(() => installDockingRule(exec, '/e', { now: () => NOW, linklessDevices: () => ['sda3', 'sdb4'] }))
        const q = `${DOCKING_RULE_QUARANTINE_DIR}/${STAMP}`
        expect(r).toEqual({ changed: true, quarantined: `${q}/90-docking.rules`, reloaded: true, triggered: ['sda3', 'sdb4'] })
        const idx = (c: string) => cmds.indexOf(c)
        expect(idx(`sudo install -d -o root -g root -m 0700 ${q}`)).toBeGreaterThan(-1)
        expect(idx(`sudo cp -p ${UDEV_RULE_PATH} ${q}/90-docking.rules`)).toBeGreaterThan(idx(`sudo install -d -o root -g root -m 0700 ${q}`))
        const install = idx(`sudo install -o root -g root -m 0644 /e/script/build_image_assets/90-docking.rules ${UDEV_RULE_PATH}`)
        expect(install).toBeGreaterThan(idx(`sudo cp -p ${UDEV_RULE_PATH} ${q}/90-docking.rules`))
        expect(idx('sudo udevadm control --reload-rules')).toBeGreaterThan(install)
        const trigger = idx('sudo udevadm trigger --action=change --subsystem-match=block --name-match=/dev/sda3 --name-match=/dev/sdb4')
        expect(trigger).toBeGreaterThan(idx('sudo udevadm control --reload-rules'))
        expect(idx('sudo udevadm settle --timeout=30')).toBeGreaterThan(trigger)
        // never deletes, never moves the old rule away, never pipes into a root shell
        expect(cmds.join('\n')).not.toMatch(/\brm\b|\bmv\b|bash -s|--action=add|--action=remove/)
    })
    it('already current: no write, no quarantine, no udev reload or trigger', async () => {
        const { exec, cmds } = scriptedExec('current')
        const linkless = vi.fn(() => ['sda3'])
        const r = await run(() => installDockingRule(exec, '/e', { linklessDevices: linkless }))
        expect(r).toEqual({ changed: false, quarantined: null, reloaded: false, triggered: [] })
        expect(cmds).toHaveLength(1)
        expect(cmds[0]).toMatch(/^if sudo cmp -s \/e\/script\/build_image_assets\/90-docking.rules \/etc\/udev\/rules.d\/90-docking.rules/)
        expect(linkless).not.toHaveBeenCalled()
    })
    it('missing: installs and reloads, quarantines nothing', async () => {
        const { exec, cmds } = scriptedExec('missing')
        const r = await run(() => installDockingRule(exec, '/e', { linklessDevices: () => [] }))
        expect(r).toEqual({ changed: true, quarantined: null, reloaded: true, triggered: [] })
        expect(cmds.some(c => /udev-quarantine|cp -p/.test(c))).toBe(false)
        expect(cmds).toContain('sudo udevadm control --reload-rules')
    })
    it('every device already linked (docked disks): reload only, no udev event at all', async () => {
        const { exec, cmds } = scriptedExec('differs')
        const r = await run(() => installDockingRule(exec, '/e', { now: () => NOW, linklessDevices: () => [] }))
        expect(r.reloaded).toBe(true)
        expect(r.triggered).toEqual([])
        expect(cmds.some(c => /udevadm (trigger|settle)/.test(c))).toBe(false)
    })
    it('image build (IDEA_IMAGE_BUILD=1): installs the rule, never touches udev', async () => {
        process.env.IDEA_IMAGE_BUILD = '1'
        const { exec, cmds } = scriptedExec('missing')
        const linkless = vi.fn(() => ['sda'])
        const r = await run(() => installDockingRule(exec, '/e', { linklessDevices: linkless }))
        expect(r).toEqual({ changed: true, quarantined: null, reloaded: false, triggered: [] })
        expect(cmds.some(c => /udevadm/.test(c))).toBe(false)
        expect(linkless).not.toHaveBeenCalled()
    })
    it('a failed reload fails the install loudly', async () => {
        const base = scriptedExec('missing')
        const exec = async (s: TemplateStringsArray, ...v: unknown[]) => {
            if (/udevadm control/.test(join(s, v))) throw new Error('udevadm control: exit 1')
            return base.exec(s, ...v)
        }
        await expect(run(() => installDockingRule(exec, '/e', { linklessDevices: () => [] }))).rejects.toThrow(/udevadm control/)
    })
})

describe('installRootHelpers runs the docking rule step (update path)', () => {
    it('installs 90-docking.rules and reloads udev before the final borg/helper checks', async () => {
        const cmds: string[] = []
        const exec = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
            const cmd = join(strings, vals)
            cmds.push(cmd)
            if (/^dpkg-query/.test(cmd)) return { stdout: 'install ok installed' }
            if (/sshd -T/.test(cmd)) return { stdout: 'authorizedkeysfile .ssh/authorized_keys /etc/ssh/idea_authorized_keys/%u /etc/ssh/idea_usage_keys/%u\n' }
            if (cmd === 'sudo /usr/local/sbin/idea-dhcp-vendor-class') return { stdout: 'nm unchanged\n' }
            if (/sysctl -n/.test(cmd)) return { stdout: '1024\n' }
            if (/idea-app-data version$/.test(cmd)) return { stdout: `idea-app-data ${APP_DATA_HELPER_VERSION}\n` }
            return { stdout: '' }
        }
        await run(() => installRootHelpers(exec, '/e'))
        const install = cmds.indexOf(`sudo install -o root -g root -m 0644 /e/script/build_image_assets/90-docking.rules ${UDEV_RULE_PATH}`)
        expect(install).toBeGreaterThan(-1)
        expect(cmds.indexOf('sudo udevadm control --reload-rules')).toBeGreaterThan(install)
        expect(cmds.indexOf('test -x /usr/bin/borg')).toBeGreaterThan(cmds.indexOf('sudo udevadm control --reload-rules'))
    })
})

describe('linklessRuleDevices', () => {
    it('lists covered sd* devices without a /dev/engine link; ignores nvme/mmcblk/loop', async () => {
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'idea-479-'))
        try {
            const sys = path.join(tmp, 'sys'), watch = path.join(tmp, 'engine')
            for (const d of ['sda', 'sda1', 'sda2', 'sda3', 'sdb', 'sdb1', 'nvme0n1', 'nvme0n1p2', 'mmcblk0', 'loop0']) await fsp.mkdir(path.join(sys, d), { recursive: true })
            await fsp.mkdir(watch)
            for (const d of ['sda', 'sda1', 'sda2', 'sdb', 'sdb1']) await fsp.writeFile(path.join(watch, d), '')
            expect(linklessRuleDevices(sys, watch)).toEqual(['sda3'])
            await fsp.rm(watch, { recursive: true })
            expect(linklessRuleDevices(sys, watch)).toEqual(['sda', 'sda1', 'sda2', 'sda3', 'sdb', 'sdb1'])
            expect(linklessRuleDevices(path.join(tmp, 'nope'), watch)).toEqual([])
        } finally { await fsp.rm(tmp, { recursive: true, force: true }) }
    })
})

describe('end to end on temp files: the self-check is clean right after the update-path install', () => {
    /**
     * A fake root shell over temp files: cmp / test / install / cp do what they say;
     * `udevadm trigger --name-match=/dev/X` plays udev and creates the /dev/engine/X
     * link the new rule would make; reload just records. Old rule: sd?|sd?1|sd?2 only,
     * so sda3 had no link before the update.
     */
    const fakeRoot = (watch: string, events: string[]) => async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const cmd = join(strings, vals)
        let m: RegExpExecArray | null
        if ((m = /^if sudo cmp -s (\S+) (\S+) && /.exec(cmd))) {
            const same = fsSync.existsSync(m[2]) && fsSync.readFileSync(m[1], 'utf8') === fsSync.readFileSync(m[2], 'utf8')
            const st = same ? fsSync.statSync(m[2]) : null
            return { stdout: same && st && (st.mode & 0o777) === 0o644 ? 'same\n' : '' }
        }
        if ((m = /^if sudo test -e (\S+) && ! sudo cmp -s (\S+) (\S+);/.exec(cmd))) {
            const differs = fsSync.existsSync(m[1]) && fsSync.readFileSync(m[2], 'utf8') !== fsSync.readFileSync(m[3], 'utf8')
            return { stdout: differs ? 'differs\n' : '' }
        }
        if ((m = /^sudo install -d -o root -g root -m 0700 (\S+)$/.exec(cmd))) { fsSync.mkdirSync(m[1], { recursive: true }); return { stdout: '' } }
        if ((m = /^sudo cp -p (\S+) (\S+)$/.exec(cmd))) { fsSync.copyFileSync(m[1], m[2]); return { stdout: '' } }
        if ((m = /^sudo install -o root -g root -m 0644 (\S+) (\S+)$/.exec(cmd))) { fsSync.copyFileSync(m[1], m[2]); fsSync.chmodSync(m[2], 0o644); return { stdout: '' } }
        if (cmd === 'sudo udevadm control --reload-rules') { events.push('reload'); return { stdout: '' } }
        if (/^sudo udevadm trigger /.test(cmd)) {
            for (const n of cmd.matchAll(/--name-match=\/dev\/(\S+)/g)) { events.push(`change ${n[1]}`); fsSync.writeFileSync(path.join(watch, n[1]), '') }
            return { stdout: '' }
        }
        if (/^sudo udevadm settle/.test(cmd)) return { stdout: '' }
        throw new Error(`unexpected command: ${cmd}`)
    }

    it('old rule + sda1..sda3: after install, checkDiskDetection has no problems; linked devices got no event; second run is a no-op', async () => {
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'idea-479e2e-'))
        try {
            const engine = path.join(tmp, 'engine-checkout')
            await fsp.mkdir(path.join(engine, 'script/build_image_assets'), { recursive: true })
            await fsp.copyFile(ASSET, path.join(engine, 'script/build_image_assets/90-docking.rules'))
            const rulePath = path.join(tmp, 'rules.d/90-docking.rules')
            await fsp.mkdir(path.dirname(rulePath), { recursive: true })
            await fsp.writeFile(rulePath, OLD_RULE)
            const sys = path.join(tmp, 'sys'), watch = path.join(tmp, 'dev-engine'), quarantineDir = path.join(tmp, 'quarantine')
            for (const d of ['sda', 'sda1', 'sda2', 'sda3']) await fsp.mkdir(path.join(sys, d), { recursive: true })
            await fsp.mkdir(watch)
            for (const d of ['sda', 'sda1', 'sda2']) await fsp.writeFile(path.join(watch, d), '')
            const paths = { rulePath, ruleAsset: path.join(engine, 'script/build_image_assets/90-docking.rules'), watchDir: watch, sysBlockDir: sys }
            const before = checkDiskDetection(paths)
            expect(before.join('; ')).toMatch(/differs/)
            expect(before.join('; ')).toMatch(/no .* entry for sda3/)

            const events: string[] = []
            const exec = fakeRoot(watch, events)
            const deps = { rulePath, quarantineDir, now: () => NOW, linklessDevices: () => linklessRuleDevices(sys, watch) }
            const r = await run(() => installDockingRule(exec, engine, deps))
            expect(r.changed).toBe(true)
            expect(events).toEqual(['reload', 'change sda3'])
            expect(checkDiskDetection(paths)).toEqual([])
            // old rule kept, not deleted
            expect(await fsp.readFile(path.join(quarantineDir, STAMP, '90-docking.rules'), 'utf8')).toBe(OLD_RULE)

            // second run: nothing written, nothing reloaded
            const mtime = (await fsp.stat(rulePath)).mtimeMs
            const events2: string[] = []
            const r2 = await run(() => installDockingRule(fakeRoot(watch, events2), engine, { ...deps, now: () => new Date('2026-11-18T00:00:00Z') }))
            expect(r2).toEqual({ changed: false, quarantined: null, reloaded: false, triggered: [] })
            expect(events2).toEqual([])
            expect((await fsp.stat(rulePath)).mtimeMs).toBe(mtime)
            expect(await fsp.readdir(quarantineDir)).toEqual([STAMP])
        } finally { await fsp.rm(tmp, { recursive: true, force: true }) }
    })
})
