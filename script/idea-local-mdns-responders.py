#!/usr/bin/env python3
"""Raw mDNS query for idea.local that collects EVERY responder (idea#203 takeover test).

getaddrinfo()/nss-mdns return only the first answer, which hid a second holder in the
2026-10-15 takeover run. This sends a legacy-unicast query (RFC 6762 §6.7: from an
ephemeral port, so each responder answers straight back to us) a few times and prints
one JSON line: {"responders": {"<source ip>": ["<A address>", ...]}}.
Read-only: it only sends queries.

usage:
  idea-local-mdns-responders.py [--name idea.local] [--wait 2.0]
      query only; prints the JSON line.
  idea-local-mdns-responders.py --pool 10.99.0.13,10.99.0.14 --judge [--name ..] [--wait ..]
      standalone: query now, print the JSON line, then the verdict.
  idea-local-mdns-responders.py --judge-json '<json line>' --pool <ips>
  idea-local-mdns-responders.py --judge '<json line>' <ips>          (old form, still accepted)
      judge a JSON line from an earlier query.
  Verdict: "ONE <ip>" (exit 0) when exactly one responder answers with exactly one pool
  address, else "NOT-ONE <details>" (exit 1). Bad arguments: usage on stderr, exit 2.
"""
import json, random, socket, struct, sys, time

def encode_query(name, qid):
    q = struct.pack('>HHHHHH', qid, 0, 1, 0, 0, 0)
    for l in name.rstrip('.').split('.'):
        b = l.encode(); q += bytes([len(b)]) + b
    return q + b'\x00' + struct.pack('>HH', 1, 0x8001)

def read_name(buf, off):
    labels, end, jumps = [], None, 0
    while True:
        n = buf[off]
        if n == 0:
            off += 1; break
        if n & 0xC0 == 0xC0:
            jumps += 1
            if jumps > 20: raise ValueError('loop')
            if end is None: end = off + 2
            off = ((n & 0x3F) << 8) | buf[off + 1]; continue
        labels.append(buf[off + 1:off + 1 + n].decode('utf-8', 'replace')); off += 1 + n
    return '.'.join(labels), (end if end is not None else off)

def parse_answers(buf, name):
    try:
        if len(buf) < 12 or not buf[2] & 0x80: return []
        qd, an, ns, ar = struct.unpack('>HHHH', buf[4:12]); off = 12
        for _ in range(qd): off = read_name(buf, off)[1] + 4
        out = []
        for _ in range(an + ns + ar):
            n, off = read_name(buf, off)
            t, _c, ttl, ln = struct.unpack('>HHIH', buf[off:off + 10]); off += 10
            if t == 1 and ln == 4 and ttl > 0 and n.lower() == name.rstrip('.').lower():
                out.append(socket.inet_ntoa(buf[off:off + 4]))
            off += ln
        return out
    except Exception:
        return []

def query(name='idea.local', wait=2.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
    s.bind(('', 0)); s.settimeout(0.2)
    qid = random.randint(1, 65535); q = encode_query(name, qid)
    res, sends, t0 = {}, [0.0, 0.5, 1.0], time.time()
    while time.time() - t0 < wait:
        while sends and time.time() - t0 >= sends[0]:
            s.sendto(q, ('224.0.0.251', 5353)); sends.pop(0)
        try:
            data, (src, _p) = s.recvfrom(9000)
        except socket.timeout:
            continue
        if len(data) < 2 or struct.unpack('>H', data[:2])[0] != qid: continue
        a = parse_answers(data, name)
        if a: res.setdefault(src, set()).update(a)
    return {k: sorted(v) for k, v in res.items()}

def judge(responders, pool):
    addrs = sorted({a for v in responders.values() for a in v})
    if len(responders) == 1 and len(addrs) == 1 and addrs[0] in pool:
        return True, 'ONE %s' % addrs[0]
    return False, 'NOT-ONE responders=%s' % json.dumps(responders, sort_keys=True)

USAGE = __doc__.split('usage:', 1)[1].rstrip()

def usage(msg):
    print('error: %s\nusage:%s' % (msg, USAGE), file=sys.stderr)
    return 2

def parse_pool(v):
    ips = [x.strip() for x in (v or '').split(',') if x.strip()]
    for ip in ips:
        try: socket.inet_aton(ip)
        except OSError: raise ValueError('not an IPv4 address in --pool: %r' % ip)
        if ip.count('.') != 3: raise ValueError('not an IPv4 address in --pool: %r' % ip)
    return ips

def responders_of(line):
    d = json.loads(line)
    r = d.get('responders') if isinstance(d, dict) else None
    if not isinstance(r, dict): raise ValueError('JSON has no "responders" object')
    return r

def main(argv):
    args = argv[1:]
    name, wait, pool, judge_mode, judge_json = 'idea.local', 2.0, None, False, None
    # old form: --judge '<json>' <ips>
    if len(args) == 3 and args[0] == '--judge' and args[1].lstrip().startswith('{'):
        judge_json, pool, args = args[1], args[2], []
    i = 0
    try:
        while i < len(args):
            a = args[i]
            need = lambda: args[i + 1] if i + 1 < len(args) else (_ for _ in ()).throw(ValueError('%s needs a value' % a))
            if a == '--name': name = need(); i += 2
            elif a == '--wait': wait = float(need()); i += 2
            elif a == '--pool': pool = need(); i += 2
            elif a == '--judge-json': judge_json = need(); i += 2
            elif a == '--judge': judge_mode = True; i += 1
            elif a in ('-h', '--help'): print('usage:' + USAGE); return 0
            else: return usage('unknown argument %s' % a)
        ips = parse_pool(pool) if pool is not None else None
        if judge_json is not None:
            if not ips: return usage('--judge-json needs --pool <ip,ip,...>')
            ok, line = judge(responders_of(judge_json), ips)
            print(line); return 0 if ok else 1
        if judge_mode:
            if not ips: return usage('--judge needs --pool <ip,ip,...> (e.g. --pool 10.99.0.13,10.99.0.14 --judge)')
            res = query(name, wait)
            print(json.dumps({'t': time.strftime('%H:%M:%S'), 'responders': res}, sort_keys=True))
            ok, line = judge(res, ips)
            print(line); return 0 if ok else 1
    except ValueError as e:
        return usage(str(e))
    print(json.dumps({'t': time.strftime('%H:%M:%S'), 'responders': query(name, wait)}, sort_keys=True))
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv))
