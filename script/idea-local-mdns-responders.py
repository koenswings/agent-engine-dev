#!/usr/bin/env python3
"""Raw mDNS query for idea.local that collects EVERY responder (idea#203 takeover test).

getaddrinfo()/nss-mdns return only the first answer, which hid a second holder in the
2026-10-15 takeover run. This sends a legacy-unicast query (RFC 6762 §6.7: from an
ephemeral port, so each responder answers straight back to us) a few times and prints
one JSON line: {"responders": {"<source ip>": ["<A address>", ...]}}.
Read-only: it only sends queries.

usage:
  idea-local-mdns-responders.py [--name idea.local] [--wait 2.0]
  idea-local-mdns-responders.py --judge '<json line>' <pool ips comma list>
      prints "ONE <ip>" (exit 0) when exactly one responder answers with exactly one pool
      address, else "NOT-ONE <details>" (exit 1).
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

def main(argv):
    if len(argv) >= 2 and argv[1] == '--judge':
        ok, line = judge(json.loads(argv[2])['responders'], [x for x in argv[3].split(',') if x])
        print(line); return 0 if ok else 1
    name, wait, i = 'idea.local', 2.0, 1
    while i < len(argv):
        if argv[i] == '--name': name = argv[i + 1]; i += 2
        elif argv[i] == '--wait': wait = float(argv[i + 1]); i += 2
        else: print('unknown argument %s' % argv[i], file=sys.stderr); return 2
    print(json.dumps({'t': time.strftime('%H:%M:%S'), 'responders': query(name, wait)}, sort_keys=True))
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv))
