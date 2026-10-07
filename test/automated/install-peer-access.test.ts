/**
 * install-peer-access.test.ts — the build-engine step for per-Pi Engine keys
 * (Engine.ts installPeerAccess), run with a recording exec:
 *   - the gate as a root-owned 0755 COPY, the root-owned peer-file folders, the
 *     0700 ledger folder, the sshd drop-in (0644)
 *   - `sshd -t` before the reload; a rejected config removes the drop-in again and stops
 *   - `sshd -T` must show idea_authorized_keys/%u in effect (else a loud warning)
 *   - reload, never restart (open sessions stay); `reload sshd` when the unit is sshd
 */

import { describe, it, expect, vi } from 'vitest'
import { fs, path } from 'zx'
import { installPeerAccess, PEER_SSHD_DROPIN, PEER_LEDGER_DIR } from '../../src/data/Engine.js'

const recordingExec = (opts: { fail?: RegExp[], sshdT?: string } = {}) => {
    const cmds: string[] = []
    const exec = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const cmd = strings.reduce((acc, s, i) => acc + s + (i < vals.length ? String(vals[i]) : ''), '')
        cmds.push(cmd)
        if ((opts.fail ?? []).some(re => re.test(cmd))) throw new Error(`${cmd}: exit 1`)
        if (/sshd -T/.test(cmd)) return { stdout: opts.sshdT ?? 'port 22\nauthorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/idea_authorized_keys/%u\n' }
        return { stdout: '' }
    }
    return { exec, cmds }
}

describe('installPeerAccess (build-engine)', () => {
    it('installs the gate, folders and drop-in, checks sshd, then reloads it', async () => {
        const { exec, cmds } = recordingExec()
        await installPeerAccess(exec, '/home/pi/idea/engine')
        expect(cmds).toEqual([
            'sudo install -o root -g root -m 0755 /home/pi/idea/engine/script/build_image_assets/idea-peer-gate /usr/local/sbin/idea-peer-gate',
            'sudo install -d -o root -g root -m 0755 /etc/ssh/idea_authorized_keys /etc/idea',
            `sudo install -d -o root -g root -m 0700 ${PEER_LEDGER_DIR}`,
            `sudo install -o root -g root -m 0644 /home/pi/idea/engine/script/build_image_assets/10-idea-peer.conf ${PEER_SSHD_DROPIN}`,
            'sudo /usr/sbin/sshd -t',
            'sudo /usr/sbin/sshd -T -C user=pi,host=localhost,addr=127.0.0.1',
            'sudo systemctl reload ssh',
        ])
        expect(PEER_SSHD_DROPIN).toBe('/etc/ssh/sshd_config.d/10-idea-peer.conf')
        expect(cmds.some(c => /restart/.test(c))).toBe(false)
    })

    it('sshd -t fails: the drop-in is removed again and the step throws (no reload)', async () => {
        const { exec, cmds } = recordingExec({ fail: [/sshd -t$/] })
        await expect(installPeerAccess(exec, '/e')).rejects.toThrow(/sshd -t rejected the configuration with \/etc\/ssh\/sshd_config.d\/10-idea-peer.conf; removed it again/)
        expect(cmds.at(-1)).toBe(`sudo rm -f ${PEER_SSHD_DROPIN}`)
        expect(cmds.some(c => /reload/.test(c))).toBe(false)
    })

    it('warns loudly when sshd -T shows another AuthorizedKeysFile in effect; falls back to reload sshd', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
        try {
            const { exec, cmds } = recordingExec({ sshdT: 'authorizedkeysfile .ssh/authorized_keys\n', fail: [/reload ssh$/] })
            await installPeerAccess(exec, '/e')
            expect(info.mock.calls.flat().join('\n')).toMatch(/WARNING: sshd does not use \/etc\/ssh\/idea_authorized_keys\/%u/)
            expect(cmds.slice(-2)).toEqual(['sudo systemctl reload ssh', 'sudo systemctl reload sshd'])
        } finally {
            info.mockRestore()
        }
    })

    it('the drop-in adds the root-owned file and keeps the users\' own authorized_keys; the gate asset is executable', async () => {
        const conf = await fs.readFile(path.resolve('script/build_image_assets/10-idea-peer.conf'), 'utf8')
        expect(conf.split('\n').filter(l => l && !l.startsWith('#'))).toEqual(['AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/idea_authorized_keys/%u'])
        expect((await fs.stat(path.resolve('script/build_image_assets/idea-peer-gate'))).mode & 0o111).not.toBe(0)
    })

    it('installUdev runs installPeerAccess right after the app-data helper', async () => {
        const src = await fs.readFile(path.resolve('src/data/Engine.ts'), 'utf8')
        const helper = src.indexOf('script/build_image_assets/idea-app-data ${APP_DATA_HELPER}')
        const peer = src.indexOf('await installPeerAccess(exec, enginePath)')
        expect(helper).toBeGreaterThan(0)
        expect(peer).toBeGreaterThan(helper)
    })
})
