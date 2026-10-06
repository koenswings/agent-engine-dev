/**
 * peer-verify-script.test.ts — script/peer-verify.sh (rollout step 7) without a Pi.
 *
 * The guards must refuse idea02 by name, Tailscale IP, reported hostname, Engine id
 * and store entry name, and anything that is not idea01/03/04, BEFORE any change.
 * The preflight runs against a fake ssh and a fake store tool (PV_SSH / PV_STORE);
 * every remote command is recorded, and a refused or preflight-only run must send
 * nothing that changes a Pi. The refusal calls the script sends through the gate
 * (system root) are checked against the sandboxed gate → helper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { $, fs, path, os } from 'zx'
import { makeAppDataSandbox, AppDataSandbox } from '../harness/appDataSandbox.js'

const SCRIPT = path.resolve('script/peer-verify.sh')
const IP = { idea01: '100.99.231.94', idea03: '100.126.117.80', idea04: '100.108.39.45' }
const ID = { idea03: 'ENGINE_gge6zxyl6ftmnri4qx6', idea04: 'ENGINE_5vyahbut147hw5dp4e1' }

let tmp: string
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-')) })
afterEach(async () => { await fs.remove(tmp) })

const run = async (args: string[], env: Record<string, string> = {}) => {
    $.verbose = false
    const r = await $({ env: { ...process.env, PV_EVIDENCE_ROOT: path.join(tmp, 'evidence'), PV_SSH: '/bin/false', PV_STORE: '/bin/false', ...env }, nothrow: true })`bash ${SCRIPT} ${args}`
    return { code: r.exitCode, out: r.stdout + r.stderr }
}

describe('peer-verify.sh: argument guards (nothing is contacted)', () => {
    const refused: [string, string[], RegExp][] = [
        ['idea02 by name', ['idea03', 'idea02'], /idea02/],
        ['idea02 by Tailscale IP', ['100.85.108.118', 'idea04'], /idea02/],
        ['idea02 with a suffix', ['idea03', 'IDEA02.local'], /idea02/],
        ['a host outside the pool', ['idea03', '100.64.0.9'], /not one of the pool Pis/],
        ['a made-up name', ['idea03', 'idea05'], /not one of the pool Pis/],
        ['one host', ['idea03'], /give 2 or 3 pool hosts/],
        ['four hosts', ['idea01', 'idea03', 'idea04', 'idea03'], /give 2 or 3 pool hosts/],
        ['the same Pi twice (name and IP)', ['idea03', IP.idea03], /given twice/],
        ['an unknown option', ['--frobnicate', 'idea03', 'idea04'], /unknown option/],
    ]
    for (const [name, args, re] of refused) {
        it(`refuses ${name} with exit 2`, async () => {
            const r = await run(['--guards-only', ...args])
            expect(r.code, r.out).toBe(2)
            expect(r.out).toMatch(/REFUSED: /)
            expect(r.out).toMatch(re)
            expect(await fs.pathExists(path.join(tmp, 'evidence'))).toBe(false)
        })
    }

    it('accepts the idea03 + idea04 pair by IP or name', async () => {
        const r = await run(['--guards-only', IP.idea03, 'idea04.local'])
        expect(r.code, r.out).toBe(0)
        expect(r.out).toMatch(/GUARDS OK: idea03 100\.126\.117\.80\nGUARDS OK: idea04 100\.108\.39\.45/)
    })

    it('has a help text', async () => {
        const r = await run(['--help'])
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/cross-Pi verify of per-Pi Engine keys/)
    })
})

// ── preflight against fakes ─────────────────────────────────────────────────
interface FakeHost { hostname: string, meta?: string, tsip?: string }
const fakes = async (hosts: Record<string, FakeHost>, engineDB: Record<string, unknown>) => {
    const log = path.join(tmp, 'ssh.log')
    const sshCases = Object.entries(hosts).map(([ip, h]) => `  pi@${ip}) H='${h.hostname}' M='${h.meta ?? ''}' T='${h.tsip ?? ''}' ;;`).join('\n')
    await fs.writeFile(path.join(tmp, 'ssh'), `#!/bin/bash
target=""; for a in "$@"; do case "$a" in pi@*) target=$a ;; esac; done
cmd="\${*: -1}"
stdin=""; if [[ "$cmd" == "bash -s" || "\${@: -2:1}" == bash ]]; then stdin=$(cat); fi
printf '%s\\t%s\\t%s\\n' "$target" "$cmd" "\${stdin//$'\\n'/ }" >> ${log}
case "$target" in
${sshCases}
  *) exit 255 ;;
esac
if [[ "$cmd" == *'HOST=$(hostname)'* ]]; then echo "HOST=$H"; echo "TSIP=$T"; echo "META=$M"; echo HTTP=8080; exit 0; fi
if [[ "$stdin" == *'HEAD='* ]]; then
  printf 'HEAD=46d4d57b1191906ab8796c07e671d7feb50c34b2\\nHAS_COMMIT=yes\\nSTOREURL=automerge:doc1\\nRESTORED=no\\nCFGSHA=abc\\nPEERACCESS=true\\nSTALEH=\\nHB=30000\\nAUTHSHA=a\\nKHSHA=k\\nLEFTOVER=no\\nPM2=online\\nCWD=/home/pi/idea/agents/agent-engine-dev\\nLOG=/home/pi/.pm2/logs/engine-out.log\\nDISKSROOT=/home/pi/idea/duration-disks\\n'
  exit 0
fi
exit 0
`, { mode: 0o755 })
    await fs.writeFile(path.join(tmp, 'store.json'), JSON.stringify({ docId: 'doc1', engineDB, diskDB: {}, instanceDB: {}, operations: [] }))
    await fs.writeFile(path.join(tmp, 'store'), `#!/bin/bash\necho "$*" >> ${path.join(tmp, 'store.log')}\n[[ "$2" == dump ]] && cat ${path.join(tmp, 'store.json')}\n`, { mode: 0o755 })
    return { PV_SSH: path.join(tmp, 'ssh'), PV_STORE: path.join(tmp, 'store') }
}
const engine = (hostname: string, lastRun = 1) => ({ hostname, lastRun, lastBooted: 1, commands: [], peerAccess: null })
const sshLog = async () => (await fs.readFile(path.join(tmp, 'ssh.log'), 'utf8').catch(() => ''))
const storeLog = async () => (await fs.readFile(path.join(tmp, 'store.log'), 'utf8').catch(() => ''))
const CHANGES = /pm2 (stop|start|restart)|mkdir|rmdir|config\.orig|cp -p|copyApp|push-command|purge|tempdir|engine-stopped/

describe('peer-verify.sh: identity guards (fake ssh + store)', () => {
    const okHosts = { [IP.idea03]: { hostname: 'idea03', meta: 'gge6zxyl6ftmnri4qx6' }, [IP.idea04]: { hostname: 'idea04', meta: '5vyahbut147hw5dp4e1' } }
    const okDB = { [ID.idea03]: engine('idea03'), [ID.idea04]: engine('idea04') }

    it('a clean preflight-only run reads and changes nothing', async () => {
        const env = await fakes(okHosts, okDB)
        const r = await run(['--preflight-only', 'idea03', 'idea04'], env)
        expect(r.code, r.out).toBe(0)
        expect(r.out).toMatch(new RegExp(`idea03 100\\.126\\.117\\.80: hostname idea03, Engine ${ID.idea03} \\(/META.yaml agrees\\)`))
        expect(r.out).toMatch(/preflight only: nothing changed/)
        expect(await sshLog()).not.toMatch(CHANGES)
        expect(await storeLog()).not.toMatch(/push-command|purge/)
    })

    it('refuses a Pi that reports hostname idea02', async () => {
        const env = await fakes({ ...okHosts, [IP.idea04]: { hostname: 'idea02' } }, okDB)
        const r = await run(['idea03', 'idea04'], env)
        expect(r.code, r.out).toBe(2)
        expect(r.out).toMatch(/REFUSED: 100\.108\.39\.45 reports hostname 'idea02' \(idea02\)/)
        expect(await sshLog()).not.toMatch(CHANGES)
    })

    it('refuses a Pi that reports the idea02 Tailscale IP', async () => {
        const env = await fakes({ ...okHosts, [IP.idea04]: { hostname: 'idea04', tsip: '100.85.108.118' } }, okDB)
        const r = await run(['idea03', 'idea04'], env)
        expect(r.code, r.out).toBe(2)
        expect(r.out).toMatch(/Tailscale IP 100\.85\.108\.118 \(idea02\)/)
    })

    it('refuses a Pi whose hostname does not match its IP', async () => {
        const env = await fakes({ ...okHosts, [IP.idea04]: { hostname: 'idea01' } }, okDB)
        const r = await run(['idea03', 'idea04'], env)
        expect(r.code, r.out).toBe(2)
        expect(r.out).toMatch(/reports hostname 'idea01', expected idea04/)
    })

    it('refuses when the Engine id is an idea02 store entry', async () => {
        // idea04's /META.yaml id is listed in the store under hostname idea02
        const env = await fakes({ ...okHosts, [IP.idea04]: { hostname: 'idea04', meta: 'golden' } },
            { [ID.idea03]: engine('idea03'), ENGINE_golden: engine('idea02', 5), ENGINE_x: engine('idea04') })
        const r = await run(['idea03', 'idea04'], env)
        expect(r.code, r.out).toBe(2)
        expect(r.out).toMatch(/REFUSED: idea04: \/META.yaml says ENGINE_golden but the store entry for idea04 is ENGINE_x/)
        expect(await sshLog()).not.toMatch(CHANGES)
    })

    it('refuses an Engine entry that resolves to an idea02 id', async () => {
        const env = await fakes({ ...okHosts, [IP.idea04]: { hostname: 'idea04' } },
            { [ID.idea03]: engine('idea03'), ENGINE_idea02golden: engine('idea04') })
        const r = await run(['idea03', 'idea04'], env)
        expect(r.code, r.out).toBe(2)
        expect(r.out).toMatch(/resolves to Engine ENGINE_idea02golden, an idea02 entry/)
    })

    it('refuses a host without an Engine entry in the store', async () => {
        const env = await fakes({ [IP.idea03]: { hostname: 'idea03' }, [IP.idea04]: { hostname: 'idea04' } },
            { ENGINE_same: { ...engine('idea03'), hostname: 'idea03' } })
        // idea04 has no entry at all → refused before anything else
        const r = await run(['idea03', 'idea04'], env)
        expect(r.code, r.out).toBe(2)
        expect(r.out).toMatch(/no Engine entry with hostname idea04/)
    })

    it('exits 3 when a Pi cannot be reached', async () => {
        const env = await fakes({ [IP.idea03]: { hostname: 'idea03' } }, okDB)
        const r = await run(['idea03', 'idea04'], env)
        expect(r.code, r.out).toBe(3)
        expect(r.out).toMatch(/cannot ssh to idea04/)
    })
})

// ── the refusal calls the script makes, through the real gate and helper ────
describe('peer-verify.sh check 4: the exact gate calls on the system root', () => {
    let sb: AppDataSandbox
    beforeEach(async () => { sb = await makeAppDataSandbox() })
    afterEach(async () => { await fs.remove(sb.tmp) })
    const H = '/usr/local/sbin/idea-app-data'
    const PEER = 'ENGINE_gge6zxyl6ftmnri4qx6'

    it('plain id, delete (absent and existing) and receive into an existing folder are refused; nothing changes', async () => {
        await fs.writeFile(path.join(sb.sys, 'META.yaml'), 'diskId: sys\n')
        const tmpid = 'pv-verify-20261006153000-01'
        await fs.ensureDir(path.join(sb.sys, 'instances', tmpid))
        const id = await sb.runGate([PEER], 'id')
        expect(id.exitCode).toBe(2)
        expect(id.stderr).toMatch(/^refused: /)
        expect(await fs.readFile(sb.journal, 'utf8')).toMatch(new RegExp(`refused peer=${PEER} .*cmd=id `))
        const absent = await sb.runGate([PEER], `sudo -n ${H} delete system ${tmpid}x`)
        expect(absent.exitCode).toBe(2)
        expect(absent.stderr).toMatch(/did not create/)
        const existing = await sb.runGate([PEER], `sudo -n ${H} delete system ${tmpid}`)
        expect(existing.exitCode).toBe(2)
        expect(existing.stderr).toMatch(/did not create/)
        const recv = await sb.runGate([PEER], `sudo -n ${H} receive system ${tmpid} --server -logDtpre.iLsfxCIvu . .`)
        expect(recv.exitCode).toBe(2)
        expect(recv.stderr).toMatch(/already exists/)
        expect(await fs.readdir(path.join(sb.sys, 'instances', tmpid))).toEqual([])
        expect(await sb.calls('rrsync')).toEqual([])
        const version = await sb.runGate([PEER], `sudo -n ${H} version`)
        expect(version.exitCode, version.stderr).toBe(0)
        expect(version.stdout).toMatch(/idea-app-data 3/)
    })
})

describe('peer-verify.sh: lint', () => {
    it('is shellcheck-clean (when shellcheck is installed)', async () => {
        const which = await $({ nothrow: true })`command -v shellcheck`
        if (which.exitCode !== 0) return
        const r = await $({ nothrow: true })`shellcheck ${SCRIPT}`
        expect(r.exitCode, r.stdout).toBe(0)
    })
})
