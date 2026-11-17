/**
 * idea-app-data-swap-quarantine.test.ts — helper v22 (engine#506, Steve's decision): updateApp's
 * Swap moves the files the old bundle had and the new one dropped out of instances/<id>/ into
 * <root>/.idea-quarantine/<id>-swap-dropped-<stamp>/ (mv, never rm), as root, because
 * .idea-quarantine is root 0700.
 *
 * Same sandbox as idea-app-data-script.test.ts (test/harness/appDataSandbox.ts): the test user
 * plays root and docker is a fake (FAKE_DOCKER_PS = running containers). Never touches /disks.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { fs, path } from 'zx'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'
import {
    APP_DATA_HELPER_VERSION, SWAP_QUARANTINE_HELPER_MIN, swapQuarantineArgs, swapQuarantineInput, parseSwapQuarantine,
    appDataErrorMessage,
} from '../../src/utils/appDataHelper.js'

const created: AppDataSandbox[] = []
const sandbox = async () => {
    const s = await makeAppDataSandbox()
    created.push(s)
    return s
}
afterEach(async () => { for (const s of created.splice(0)) await fs.remove(s.tmp) })

const refused = (r: { exitCode: number | null, stderr: string }, re: RegExp) => {
    expect(r.exitCode, r.stderr).toBe(2)
    expect(r.stderr).toMatch(/^refused: /m)
    expect(r.stderr).toMatch(re)
}

const OLD_TGZ = 'bundled-apps/richdocuments-v8.8.3.tar.gz'
const SPACED = 'demo/content/Teacher Notes/Old lesson.md'

/** An instance after a 1.8 install: the 1.8 bundle files next to data/. */
const addUpdatedInstance = async (sb: AppDataSandbox, dev: string, id: string) => {
    const root = await sb.addDisk(dev)
    const inst = await sb.addInstance(root, id)
    await fs.outputFile(path.join(inst, OLD_TGZ), 'v8 tarball')
    await fs.outputFile(path.join(inst, 'bundled-apps/richdocuments-v9.2.3.tar.gz'), 'v9 tarball')
    await fs.outputFile(path.join(inst, SPACED), 'old lesson')
    await fs.outputFile(path.join(inst, 'hooks/old-hook.sh'), '#!/bin/sh\n')
    await fs.outputFile(path.join(inst, 'SHA256SUMS'), 'x  compose.yaml\n')
    return { root, inst }
}
const swap = (sb: AppDataSandbox, dev: string, id: string, paths: string[], env: Record<string, string> = {}) =>
    sb.run(['swap-quarantine', dev, id], { FAKE_STDIN: paths.map(p => `${p}\n`).join(''), ...env })

describe('idea-app-data v22: swap-quarantine (engine#506)', () => {
    it('is version 22, and the Engine needs v22 to quarantine at Swap', async () => {
        const sb = await sandbox()
        expect(APP_DATA_HELPER_VERSION).toBe('22')
        expect(SWAP_QUARANTINE_HELPER_MIN).toBe(22)
        expect((await sb.run(['version'])).stdout.trim()).toBe('idea-app-data 22')
    })

    it('moves each listed file into .idea-quarantine/<id>-swap-dropped-<stamp>/ keeping its relative path; deletes nothing; data/ untouched', async () => {
        const sb = await sandbox()
        const { root, inst } = await addUpdatedInstance(sb, 'sdb2', 'nc1')
        const r = await swap(sb, 'sdb2', 'nc1', [OLD_TGZ, SPACED, 'hooks/old-hook.sh', 'docs/gone.md'])
        expect(r.exitCode, r.stderr).toBe(0)
        const res = parseSwapQuarantine(r.stdout)
        expect(res.quarantine).toMatch(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.idea-quarantine/nc1-swap-dropped-\\d{8}T\\d{6}Z$`))
        expect(res.moved).toEqual([OLD_TGZ, SPACED, 'hooks/old-hook.sh'])
        expect(res.absent).toEqual(['docs/gone.md'])
        for (const p of [OLD_TGZ, SPACED, 'hooks/old-hook.sh']) {
            expect(await fs.pathExists(path.join(inst, p)), p).toBe(false)
            expect(await fs.pathExists(path.join(res.quarantine!, p)), p).toBe(true)
        }
        expect(await fs.readFile(path.join(res.quarantine!, OLD_TGZ), 'utf8')).toBe('v8 tarball')
        // the new bundle's file, the identity files and the data stay where they are
        expect(await fs.readFile(path.join(inst, 'bundled-apps/richdocuments-v9.2.3.tar.gz'), 'utf8')).toBe('v9 tarball')
        expect(await fs.readFile(path.join(inst, 'data', 'sessions', 's1'), 'utf8')).toBe('session\n')
        expect(await fs.pathExists(path.join(inst, '.env'))).toBe(true)
        expect(await fs.pathExists(path.join(inst, 'SHA256SUMS'))).toBe(true)
        // root-only folders
        expect((await fs.stat(path.join(root, '.idea-quarantine'))).mode & 0o777).toBe(0o700)
        expect((await fs.stat(res.quarantine!)).mode & 0o777).toBe(0o700)
        const j = await sb.journalText()
        expect(j).toMatch(/swap-quarantine: 3 file\(s\) the new bundle dropped: .*instances\/nc1 -> .*nc1-swap-dropped-.* \(1 path\(s\) already absent\)/)
        expect(j).toMatch(/user=pi sub=swap-quarantine args=swap-quarantine sdb2 nc1 exit=0/)
        // a second update in the same second gets its own folder (-2), never overwrites
        await fs.outputFile(path.join(inst, OLD_TGZ), 'v8 again')
        const again = parseSwapQuarantine((await swap(sb, 'sdb2', 'nc1', [OLD_TGZ])).stdout)
        expect(again.quarantine).not.toBe(res.quarantine)
        expect(await fs.readFile(path.join(res.quarantine!, OLD_TGZ), 'utf8')).toBe('v8 tarball')
    })

    it('nothing to move (empty stdin, or every path already gone): quarantine=none and no folder is created', async () => {
        const sb = await sandbox()
        const { root } = await addUpdatedInstance(sb, 'sdb2', 'nc1')
        const r = await swap(sb, 'sdb2', 'nc1', ['docs/gone.md'])
        expect(r.exitCode, r.stderr).toBe(0)
        expect(parseSwapQuarantine(r.stdout)).toEqual({ quarantine: null, moved: [], absent: ['docs/gone.md'] })
        const e = await sb.run(['swap-quarantine', 'sdb2', 'nc1'])
        expect(e.exitCode, e.stderr).toBe(0)
        expect(e.stdout.trim()).toBe('quarantine=none')
        expect(await fs.pathExists(path.join(root, '.idea-quarantine'))).toBe(false)
    })

    it('refuses every bad path before anything moves: data/, markers, identity files, absolute, .., //, control characters, duplicates', async () => {
        const sb = await sandbox()
        const { root, inst } = await addUpdatedInstance(sb, 'sdb2', 'nc1')
        const bad: [string, RegExp][] = [
            ['data/sessions/s1', /is instance data \(data\/\)/],
            ['data', /is instance data/],
            ['.idea-update-in-flight', /is an Engine marker/],
            ['.env', /is the instance's \.env/],
            ['SHA256SUMS', /is the instance's SHA256SUMS/],
            ['compose.yaml', /is the instance's compose\.yaml/],
            ['/etc/passwd', /is absolute/],
            ['hooks/../data/sessions/s1', /'\.' or '\.\.' component/],
            ['../nc2/compose.yaml', /'\.' or '\.\.' component/],
            ['./hooks/old-hook.sh', /'\.' or '\.\.' component/],
            ['hooks//old-hook.sh', /trailing '\/' or '\/\/'/],
            ['hooks/', /trailing '\/' or '\/\/'/],
            ['hooks/a\tb', /control character or a backslash/],
            ['hooks\\old-hook.sh', /control character or a backslash/],
            ['x'.repeat(1025), /longer than 1024 characters/],
        ]
        for (const [p, re] of bad) {
            // the bad line comes after a good one: the good one must not have moved either
            refused(await swap(sb, 'sdb2', 'nc1', [OLD_TGZ, p]), re)
            expect(await fs.pathExists(path.join(inst, OLD_TGZ)), p).toBe(true)
        }
        refused(await swap(sb, 'sdb2', 'nc1', [OLD_TGZ, OLD_TGZ]), /is listed twice/)
        refused(await swap(sb, 'sdb2', 'nc1', Array.from({ length: 4097 }, (_, i) => `docs/f${i}.md`)), /more than 4096 paths/)
        refused(await swap(sb, 'sdb2', 'nc1', ['hooks']), /is not a regular file/)
        refused(await sb.run(['swap-quarantine', 'sdb2', 'nc1'], { FAKE_STDIN: `${OLD_TGZ}\n\n` }), /empty line/)
        expect(await fs.pathExists(path.join(root, '.idea-quarantine'))).toBe(false)
        expect(await fs.readFile(path.join(inst, 'data', 'sessions', 's1'), 'utf8')).toBe('session\n')
    })

    it('refuses a symlink or a path through a symlinked folder (nothing outside the instance moves)', async () => {
        const sb = await sandbox()
        const { root, inst } = await addUpdatedInstance(sb, 'sdb2', 'nc1')
        const outside = path.join(sb.tmp, 'outside')
        await fs.outputFile(path.join(outside, 'secret.txt'), 'outside')
        await fs.symlink(outside, path.join(inst, 'linked'))
        refused(await swap(sb, 'sdb2', 'nc1', ['linked/secret.txt']), /is a symlink or has a symlink in its path/)
        await fs.symlink(path.join(outside, 'secret.txt'), path.join(inst, 'hooks', 'link.sh'))
        refused(await swap(sb, 'sdb2', 'nc1', ['hooks/link.sh']), /is a symlink or has a symlink in its path|is not a regular file/)
        // another instance's files are out of reach (no '..')
        const other = await sb.addInstance(root, 'nc2')
        refused(await swap(sb, 'sdb2', 'nc1', ['../nc2/compose.yaml']), /'\.' or '\.\.' component/)
        expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside')
        expect(await fs.pathExists(path.join(other, 'compose.yaml'))).toBe(true)
        expect(await fs.pathExists(path.join(root, '.idea-quarantine'))).toBe(false)
    })

    it('refuses while a container of the instance runs, and with a quarantine folder that is not root-only', async () => {
        const sb = await sandbox()
        const { root, inst } = await addUpdatedInstance(sb, 'sdb2', 'nc1')
        refused(await swap(sb, 'sdb2', 'nc1', [OLD_TGZ], { FAKE_DOCKER_PS: 'abc123' }), /RUNNING: the containers of nc1 are still running/)
        expect(await fs.pathExists(path.join(inst, OLD_TGZ))).toBe(true)
        await fs.ensureDir(path.join(root, '.idea-quarantine'))
        await fs.chmod(path.join(root, '.idea-quarantine'), 0o777)
        refused(await swap(sb, 'sdb2', 'nc1', [OLD_TGZ]), /quarantine folder .* must not be group or other writable/)
        expect(await fs.pathExists(path.join(inst, OLD_TGZ))).toBe(true)
        await fs.remove(path.join(root, '.idea-quarantine'))
        await fs.symlink(sb.tmp, path.join(root, '.idea-quarantine'))
        refused(await swap(sb, 'sdb2', 'nc1', [OLD_TGZ]), /quarantine folder .* is missing or a symlink/)
        expect(await fs.pathExists(path.join(inst, OLD_TGZ))).toBe(true)
    })

    it('refuses bad tokens and a missing instance folder', async () => {
        const sb = await sandbox()
        await addUpdatedInstance(sb, 'sdb2', 'nc1')
        for (const id of ['../nc1', '-rf', 'NC1', 'a/b', '']) refused(await swap(sb, 'sdb2', id, [OLD_TGZ]), /instance id/)
        for (const root of ['/disks/sdb2', '..', 'SDB2']) refused(await swap(sb, root, 'nc1', [OLD_TGZ]), /root '.*' is not|unknown root/)
        refused(await swap(sb, 'sdb2', 'missing1', [OLD_TGZ]), /instance folder .* is not a folder/)
        refused(await sb.run(['swap-quarantine', 'sdb2']), /swap-quarantine takes exactly 2 argument/)
    })

    it('a peer cannot reach it through idea-peer-gate', async () => {
        const sb = await sandbox()
        const { inst } = await addUpdatedInstance(sb, 'sdb2', 'nc1')
        const r = await sb.runGate(['ENGINE_gge6zxyl6ftmnri4qx6'], 'sudo -n /usr/local/sbin/idea-app-data swap-quarantine sdb2 nc1', { FAKE_STDIN: `${OLD_TGZ}\n` })
        expect(r.exitCode).toBe(2)
        expect(r.stderr).toMatch(/^refused: /)
        expect(await fs.pathExists(path.join(inst, OLD_TGZ))).toBe(true)
    })

    it('Engine → helper: swapQuarantineArgs + swapQuarantineInput run as-is, and a refusal reads as the helper wrote it', async () => {
        const sb = await sandbox()
        const { inst } = await addUpdatedInstance(sb, 'sdb2', 'nc1')
        const r = await sb.run(swapQuarantineArgs('sdb2', 'nc1'), { FAKE_STDIN: swapQuarantineInput([OLD_TGZ, SPACED]) })
        expect(r.exitCode, r.stderr).toBe(0)
        expect(parseSwapQuarantine(r.stdout).moved).toEqual([OLD_TGZ, SPACED])
        expect(await fs.pathExists(path.join(inst, OLD_TGZ))).toBe(false)
        const bad = await sb.run(swapQuarantineArgs('sdb2', 'nc1'), { FAKE_STDIN: 'hooks\n' })
        expect(appDataErrorMessage('swap-quarantine', bad.exitCode, null, bad.stderr)).toMatch(/^idea-app-data swap-quarantine refused: path hooks \(line 1\): is not a regular file/)
    })
})
