/**
 * idea-local-takeover-script.test.ts — the idea.local power-cut takeover test (idea#203 §3)
 * must refuse to touch anything but the pool (idea01/03/04), needs a claim, and its
 * analysis must only PASS a steady takeover (live IP + HTTP 200) within the TTL.
 * Never contacts a Pi: SSH is set to a command that fails, refusals happen before it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { fs, path } from 'zx'
import os from 'os'

const SCRIPT = path.join(process.cwd(), 'script/idea-local-takeover-test.sh')
const ANALYSE = path.join(process.cwd(), 'script/idea-local-takeover-analyse.py')
let tmp = ''
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea203-d-')) })
afterAll(async () => { await fs.remove(tmp) })

const run = (...args: string[]) => {
    const r = spawnSync('bash', [SCRIPT, '--out', tmp, ...args], { encoding: 'utf8', env: { ...process.env, SSH: 'false' } })
    return { code: r.status, err: r.stderr, out: r.stdout }
}

describe('idea-local-takeover-test.sh refusals (idea#203)', () => {
    it('requires a claim', () => {
        const r = run(); expect(r.code).toBe(2); expect(r.err).toMatch(/--claim <id> is required/)
    })
    it('never wh or idea02 as a pool Engine', () => {
        for (const pool of ['idea01,wh', 'idea01,wizardly-hugle', 'idea01,idea02', 'idea01']) {
            const r = run('--claim', 'c1', '--pool', pool); expect(r.code, pool).toBe(2)
        }
    })
    it('the client is never a pool Engine or wh', () => {
        expect(run('--claim', 'c1', '--client', 'idea03').code).toBe(2)
        expect(run('--claim', 'c1', '--client', 'wh').code).toBe(2)
    })
    it('the cut must outlast the TTL, and is bounded', () => {
        expect(run('--claim', 'c1', '--cut', '100', '--ttl', '120').err).toMatch(/must be longer/)
        expect(run('--claim', 'c1', '--cut', '900').err).toMatch(/at most 600/)
    })
    it('--converge is bounded (10-300 s)', () => {
        expect(run('--claim', 'c1', '--converge', '5').err).toMatch(/--converge must be 10-300/)
        expect(run('--claim', 'c1', '--converge', '900').err).toMatch(/--converge must be 10-300/)
        expect(run('--claim', 'c1', '--converge', 'x').code).toBe(2)
    })
    it('checks one holder on the wire (raw mDNS) before the cut and after the restore', () => {
        const src = fs.readFileSync(SCRIPT, 'utf8')
        expect(src).toMatch(/before cut, raw mDNS/)
        expect(src).toMatch(/not answered by exactly one pool Engine on the wire/)
        expect(src).toMatch(/STREAK" -ge 2/)
        expect(src).toMatch(/not exactly one responder for idea.local within/)
    })
    it('refuses unsafe claim, mode, interface and ports', () => {
        expect(run('--claim', 'a;rm').code).toBe(2)
        expect(run('--claim', 'c1', '--mode', 'reboot').code).toBe(2)
        expect(run('--claim', 'c1', '--lan-if', 'eth0;x').code).toBe(2)
        expect(run('--claim', 'c1', '--ports', '80;x').code).toBe(2)
    })
    it('valid arguments go on to the pool checks (exit 3 when a Pi is unreachable, nothing changed)', () => {
        const r = run('--claim', 'c1'); expect(r.code).toBe(3)
        expect(fs.readFileSync(path.join(tmp, 'summary.txt'), 'utf8')).toMatch(/infra: cannot reach idea01/)
    })
})

describe('idea-local-takeover-analyse.py (idea#203)', () => {
    const analyse = async (rows: string[], live = '10.99.0.11,10.99.0.14', ttl = '120') => {
        const f = path.join(tmp, `poll-${Math.random()}.csv`)
        await fs.writeFile(f, rows.join('\n') + '\n')
        const r = spawnSync('python3', [ANALYSE, f, '5', '10.99.0.13', ttl, live], { encoding: 'utf8' })
        return { code: r.status, out: r.stdout }
    }
    const seq = (from: number, to: number, ip: string, code = 200) => {
        const out: string[] = []; for (let t = from; t < to; t += 0.5) out.push(`${t.toFixed(2)},${ip},${code}`); return out
    }
    it('PASS when a live Engine answers steadily with HTTP 200 within the TTL', async () => {
        const r = await analyse([...seq(0, 5, '10.99.0.13'), ...seq(5, 12, '10.99.0.13', 0), ...seq(12, 160, '10.99.0.11')])
        expect(r.code).toBe(0); expect(r.out).toMatch(/^PASS: .*from \+7\.0 s/)
    })
    it('FAIL when the takeover comes after the TTL', async () => {
        const r = await analyse([...seq(0, 130, '10.99.0.13', 0), ...seq(130, 160, '10.99.0.11')])
        expect(r.code).toBe(1); expect(r.out).toMatch(/^FAIL/)
    })
    it('FAIL when lookups flap back to the dead address', async () => {
        const r = await analyse([...seq(0, 20, '10.99.0.11'), ...seq(20, 21, '10.99.0.13', 0), ...seq(21, 30, '10.99.0.11')], undefined, '10')
        expect(r.code).toBe(1)
    })
    it('FAIL when the new address resolves but the Console does not answer', async () => {
        const r = await analyse([...seq(0, 5, '10.99.0.13'), ...seq(5, 160, '10.99.0.11', 0)])
        expect(r.code).toBe(1)
    })
    it('FAIL when a lookup returns two addresses including the dead one', async () => {
        const r = await analyse([...seq(0, 160, '10.99.0.11+10.99.0.13')])
        expect(r.code).toBe(1)
    })
})

describe('idea-local-mdns-responders.py (idea#203: every responder, not just the first)', () => {
    const RESP = path.join(process.cwd(), 'script/idea-local-mdns-responders.py')
    const judge = (responders: object, pool = '10.99.0.13,10.99.0.14') =>
        spawnSync('python3', [RESP, '--judge', JSON.stringify({ responders }), pool], { encoding: 'utf8' })
    it('ONE when exactly one pool Engine answers', () => {
        const r = judge({ '10.99.0.14': ['10.99.0.14'] }); expect(r.status).toBe(0); expect(r.stdout.trim()).toBe('ONE 10.99.0.14')
    })
    it('NOT-ONE for the 2026-10-15 split brain (two responders)', () => {
        const r = judge({ '10.99.0.13': ['10.99.0.13'], '10.99.0.14': ['10.99.0.14'] })
        expect(r.status).toBe(1); expect(r.stdout).toMatch(/^NOT-ONE/)
    })
    it('NOT-ONE for no answer, a non-pool address, or one host giving two addresses', () => {
        expect(judge({}).status).toBe(1)
        expect(judge({ '10.99.0.11': ['10.99.0.11'] }).status).toBe(1)
        expect(judge({ '10.99.0.13': ['10.99.0.13', '172.21.0.1'] }).status).toBe(1)
    })
    it('encodes a QU A query and parses compressed answers, skipping goodbyes', () => {
        const py = `
import sys; sys.dont_write_bytecode = True
import importlib.util, struct, socket
s = importlib.util.spec_from_file_location('r', ${JSON.stringify(RESP)}); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
q = m.encode_query('idea.local', 0x1234)
assert q == bytes([0x12,0x34,0,0,0,1,0,0,0,0,0,0,4]) + b'idea' + bytes([5]) + b'local' + bytes([0,0,1,0x80,1]), q
hdr = struct.pack('>HHHHHH', 0x1234, 0x8400, 1, 2, 0, 0)
rr = lambda ttl, ip: bytes([0xc0, 12]) + struct.pack('>HHIH', 1, 0x8001, ttl, 4) + socket.inet_aton(ip)
msg = hdr + q[12:] + rr(120, '10.99.0.13') + rr(0, '10.99.0.14')
assert m.parse_answers(msg, 'idea.local') == ['10.99.0.13'], m.parse_answers(msg, 'idea.local')
assert m.parse_answers(msg[:30], 'idea.local') == []
print('ok')`
        const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' })
        expect(r.stderr).toBe(''); expect(r.stdout.trim()).toBe('ok')
    })
})

describe('netcut undo removes every rule it added (idea#203 takeover run 2e64e77)', () => {
    /** A stateful fake iptables/ip6tables/nft/sudo in a temp dir: -I/-C/-D/-S on a rules file. */
    const fakeBin = async () => {
        const d = await fs.mkdtemp(path.join(tmp, 'fw-'))
        const ipt = (file: string) => `#!/usr/bin/env bash
f=${file}; touch "$f"; args=("$@"); [ "\${args[0]}" = -w ] && args=("\${args[@]:1}")
if [ "\${args[0]}" = -t ]; then t=\${args[1]}; args=("\${args[@]:2}"); else t=filter; fi
op=\${args[0]}; rule="\${args[*]:1}"
case "$op" in
  -I) echo "$t|$rule" >> "$f" ;;
  -C) grep -qxF "$t|$rule" "$f" ;;
  -D) n=$(grep -nxF "$t|$rule" "$f" | head -1 | cut -d: -f1); [ -n "$n" ] || exit 1; sed -i "\${n}d" "$f" ;;
  -S) grep "^$t|" "$f" | sed "s/^$t|/-A /" ;;
esac
`
        await fs.writeFile(path.join(d, 'iptables'), ipt(path.join(d, 'v4.rules')), { mode: 0o755 })
        await fs.writeFile(path.join(d, 'ip6tables'), ipt(path.join(d, 'v6.rules')), { mode: 0o755 })
        await fs.writeFile(path.join(d, 'nft'), `#!/usr/bin/env bash\n[ "$1 $2" = "list ruleset" ] && cat ${path.join(d, 'nft.rules')} 2>/dev/null; true\n`, { mode: 0o755 })
        await fs.writeFile(path.join(d, 'sudo'), '#!/usr/bin/env bash\nexec "$@"\n', { mode: 0o755 })
        return d
    }
    const cmds = (d: string) => {
        const r = spawnSync('bash', [SCRIPT, '--claim', 'c1', '--print-netcut', '--ports', '80,8080'], {
            encoding: 'utf8', env: { ...process.env, SSH: 'false', IPT: path.join(d, 'iptables'), IP6T: path.join(d, 'ip6tables'), NFT: path.join(d, 'nft') },
        })
        expect(r.status).toBe(0)
        const get = (k: string) => r.stdout.split('\n').find(l => l.startsWith(k + '='))!.slice(k.length + 1)
        return { DO: get('DO'), UNDO: get('UNDO'), LEFTOVER: get('LEFTOVER') }
    }
    const sh = (d: string, c: string) => spawnSync('bash', ['-c', c], { encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}` } })

    it('cuts mDNS in and out and the Console ports in, all tagged, IPv4 only', async () => {
        const d = await fakeBin(); const c = cmds(d)
        expect(sh(d, c.DO).status).toBe(0)
        const rules = fs.readFileSync(path.join(d, 'v4.rules'), 'utf8').trim().split('\n')
        expect(rules.length).toBe(5)
        expect(rules.every(r => r.includes('--comment idea203-takeover'))).toBe(true)
        expect(rules.filter(r => r.startsWith('filter|INPUT')).length).toBe(3)
        expect(rules.filter(r => r.startsWith('filter|OUTPUT')).length).toBe(2)
        expect(sh(d, c.LEFTOVER).stdout.trim().split('\n').length).toBe(5)
    })
    it('undo leaves nothing in iptables, ip6tables or nft, even after a cut that ran twice', async () => {
        const d = await fakeBin(); const c = cmds(d)
        sh(d, c.DO); sh(d, c.DO)
        expect(sh(d, c.UNDO + ' true').status).toBe(0)
        expect(sh(d, c.LEFTOVER).stdout.trim()).toBe('')
        expect(sh(d, c.UNDO + ' true').status).toBe(0) // idempotent
    })
    it('the leftover check catches a rule a single -D would leave, in any of iptables, ip6tables and nft', async () => {
        const d = await fakeBin(); const c = cmds(d)
        sh(d, c.DO); sh(d, c.DO)
        // the pre-fix undo: one -D per rule
        sh(d, `${path.join(d, 'iptables')} -w -D INPUT -i eth0 -p udp --dport 5353 -m comment --comment idea203-takeover -j DROP`)
        expect(sh(d, c.LEFTOVER).stdout).toMatch(/idea203-takeover/)
        sh(d, c.UNDO + ' true')
        await fs.writeFile(path.join(d, 'v6.rules'), 'filter|OUTPUT -o eth0 -p udp --dport 5353 -m comment --comment idea203-takeover -j DROP\n')
        expect(sh(d, c.LEFTOVER).stdout).toMatch(/-A OUTPUT .*idea203-takeover/)
        await fs.writeFile(path.join(d, 'v6.rules'), '')
        await fs.writeFile(path.join(d, 'nft.rules'), 'udp dport 5353 counter drop comment "idea203-takeover"\n')
        expect(sh(d, c.LEFTOVER).stdout).toMatch(/idea203-takeover/)
    })
    it('the run FAILs when a rule is left after the restore', () => {
        const src = fs.readFileSync(SCRIPT, 'utf8')
        expect(src).toMatch(/LEFT=\$\(rsh "\$HOLDER" "\$LEFTOVER"/)
        expect(src).toMatch(/\[ "\$LEFTOVER_FAIL" = 0 \] \|\| RES=1/)
    })
})

describe('idea-local-mdns-responders.py command line (idea#203)', () => {
    const PY = path.join(process.cwd(), 'script/idea-local-mdns-responders.py')
    const py = (...a: string[]) => spawnSync('python3', [PY, ...a], { encoding: 'utf8', timeout: 15000 })
    it('bare --judge is a usage error (exit 2), not an IndexError traceback', () => {
        const r = py('--judge'); expect(r.status).toBe(2)
        expect(r.stderr).toMatch(/--judge needs --pool/); expect(r.stderr).not.toMatch(/Traceback|IndexError/)
    })
    it('standalone --pool <ips> --judge queries, prints the JSON line and a verdict', () => {
        const r = py('--pool', '10.99.0.13,10.99.0.14', '--judge', '--wait', '0.3')
        expect([0, 1]).toContain(r.status)
        const [json, verdict] = r.stdout.trim().split('\n')
        expect(JSON.parse(json).responders).toBeTypeOf('object')
        expect(verdict).toMatch(/^(ONE|NOT-ONE) /)
    })
    it('--judge-json with --pool, and the old positional form, both judge', () => {
        const one = '{"responders":{"10.99.0.14":["10.99.0.14"]}}'
        expect(py('--judge-json', one, '--pool', '10.99.0.13,10.99.0.14').stdout.trim()).toBe('ONE 10.99.0.14')
        expect(py('--judge', one, '10.99.0.13,10.99.0.14').status).toBe(0)
        expect(py('--judge-json', '{"responders":{}}', '--pool', '10.99.0.13').status).toBe(1)
    })
    it('bad pool, bad JSON or a missing value are usage errors', () => {
        expect(py('--pool', '10.99.0.13,nope', '--judge').status).toBe(2)
        expect(py('--judge-json', 'not json', '--pool', '10.99.0.13').status).toBe(2)
        expect(py('--pool').status).toBe(2)
    })
})

describe('--holder: produce the higher-IP holder before the cut (idea#203 run2 only ever cut idea03)', () => {
    const FAKE = path.join(process.cwd(), 'test/fixtures/idea-local-takeover-fake-ssh.sh')
    const runFake = async (extraEnv: Record<string, string>, ...args: string[]) => {
        const d = await fs.mkdtemp(path.join(os.tmpdir(), 'idea203-hold-'))
        fs.writeFileSync(path.join(d, 'holder'), 'idea03\n')
        const r = spawnSync('bash', [SCRIPT, '--claim', 'c1', '--pool', 'idea03,idea04', '--out', path.join(d, 'out'), ...args], {
            encoding: 'utf8', env: { ...process.env, SSH: FAKE, FAKE_DIR: d, ...extraEnv },
        })
        const cmds = fs.existsSync(path.join(d, 'cmds')) ? fs.readFileSync(path.join(d, 'cmds'), 'utf8') : ''
        const out = r.stdout; await fs.remove(d)
        return { code: r.status, out, cmds, err: r.stderr }
    }
    it('refuses a --holder outside the pool, a bad --prep, and --prepare-only without --holder', () => {
        expect(run('--claim', 'c1', '--pool', 'idea03,idea04', '--holder', 'idea01').err).toMatch(/not in --pool/)
        expect(run('--claim', 'c1', '--holder', 'idea04', '--prep', '1').err).toMatch(/--prep must be 5-120/)
        expect(run('--claim', 'c1', '--prepare-only').err).toMatch(/--prepare-only needs --holder/)
    })
    it('freezes avahi on the current holder (idea03) until idea04 alone answers, continues it, checks one holder twice, cuts nothing', async () => {
        const r = await runFake({}, '--holder', 'idea04', '--prepare-only', '--prep', '5', '--converge', '10')
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/freezing avahi-daemon on the current holder idea03/)
        expect(r.out).toMatch(/prepared: idea04 \(10\.99\.0\.14\) is the only holder, Console HTTP 200/)
        const lines = r.cmds.split('\n')
        const stop = lines.findIndex(l => /^idea03: .*systemd-run --unit=idea203-takeover-prep-\d+ --on-active=5 .*pkill -CONT.*&& sudo pkill -STOP -x avahi-daemon/.test(l))
        const cont = lines.findIndex(l => /^idea03: sudo pkill -CONT -x avahi-daemon; sudo systemctl stop idea203-takeover-prep-/.test(l))
        expect(stop).toBeGreaterThanOrEqual(0); expect(cont).toBeGreaterThan(stop)
        expect(r.cmds).not.toMatch(/iptables/)
        expect(r.cmds).not.toMatch(/^idea04: .*pkill/m)
    }, 30000)
    it('stops with exit 3 and continues avahi when the requested holder never takes over (no cut)', async () => {
        const r = await runFake({ FAKE_NO_TAKEOVER: '1' }, '--holder', 'idea04', '--prep', '5', '--converge', '10')
        expect(r.code).toBe(3)
        expect(r.out).toMatch(/idea04 did not take idea.local while idea03 was frozen; not cutting anything/)
        expect(r.cmds).toMatch(/^idea03: sudo pkill -CONT -x avahi-daemon/m)
        expect(r.cmds).not.toMatch(/iptables -w -I/)
    }, 30000)
    it('no preparation when the requested holder already holds the name; dry run prints the preparation', async () => {
        const same = await runFake({}, '--holder', 'idea03', '--dry-run')
        expect(same.code).toBe(0); expect(same.out).not.toMatch(/preparing/)
        const dry = await runFake({}, '--holder', 'idea04', '--dry-run')
        expect(dry.code).toBe(0)
        expect(dry.out).toMatch(/DRY RUN: would first make idea04 the holder: on idea03 run: .*pkill -STOP/)
        expect(dry.cmds).not.toMatch(/pkill/)
    }, 30000)
})

describe('avahi-freeze wording and undo check (idea#203 run3 said "rules removed" and "netcut undo")', () => {
    it('log lines name what was cut and undone per mode', () => {
        const src = fs.readFileSync(SCRIPT, 'utf8')
        expect(src).toMatch(/WHAT="avahi-daemon frozen \(SIGSTOP\)"; UNDONE="avahi-daemon continued \(SIGCONT\)"/)
        expect(src).toMatch(/restored \$HOLDER \(\$UNDONE\)/)
        expect(src).not.toMatch(/rules removed \/ avahi continued/)
        expect(src).toMatch(/avahi-freeze: no firewall rule tagged/)
        expect(src).toMatch(/FAIL: avahi-daemon still stopped on \$HOLDER after the restore/)
    })
    it('the stopped-avahi check prints a stopped daemon and nothing for a running one', () => {
        const r = spawnSync('bash', [SCRIPT, '--claim', 'c1', '--mode', 'avahi-freeze', '--print-netcut'], { encoding: 'utf8', env: { ...process.env, SSH: 'false' } })
        expect(r.status).toBe(0)
        const src = fs.readFileSync(SCRIPT, 'utf8')
        const cmd = src.match(/^AVAHI_STOPPED="(.*)"$/m)![1].replace(/\\\$/g, '$')
        const awk = cmd.split('|')[1].replace(/; true$/, '').trim()
        const t = spawnSync('bash', ['-c', `printf '  123 T avahi-daemon\\n  124 Ss avahi-daemon\\n' | ${awk}`], { encoding: 'utf8' })
        expect(t.stdout.trim()).toBe('123 T avahi-daemon')
    })
})
