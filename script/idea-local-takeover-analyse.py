#!/usr/bin/env python3
"""Analyse the client poll of idea-local-takeover-test.sh (idea#203).

usage: idea-local-takeover-analyse.py POLL.csv CUT_OFFSET_S DEAD_IP TTL_S LIVE_IPS(comma list)
POLL.csv rows: seconds_since_start,resolved_ips('+' joined or FAIL),http_status_of_first_ip
Prints a summary; exit 0 PASS (a live Engine resolved AND served HTTP 200, steadily, within TTL), 1 FAIL.
"""
import sys

def analyse(rows, cut, dead, ttl, live):
    after = [(t - cut, ip, code) for t, ip, code in rows if t >= cut]
    if not after:
        return False, 'no samples after the cut'
    last_dead = max((t for t, ip, _ in after if dead in ip.split('+')), default=None)
    def ok(ip, code):
        ips = ip.split('+')
        return ip != 'FAIL' and dead not in ips and all(x in live for x in ips) and code == 200
    ok_from = None
    for i, (t, ip, code) in enumerate(after):
        if all(ok(x, c) for _, x, c in after[i:]):
            ok_from = t
            break
    fails = sum(ip == 'FAIL' for _, ip, _ in after)
    new = sorted({ip for _, ip, c in after if ok(ip, c)})
    passed = ok_from is not None and ok_from <= ttl
    line = ('%s: %d samples after cut; dead IP last returned at +%s s; steady on live Engine (%s) with HTTP 200 from +%s s '
            '(limit %d s); FAIL lookups %d') % (
        'PASS' if passed else 'FAIL', len(after),
        'never' if last_dead is None else '%.1f' % last_dead, '+'.join(new) or 'none',
        'never' if ok_from is None else '%.1f' % ok_from, ttl, fails)
    return passed, line

def main(argv):
    path, cut, dead, ttl, live = argv[1], float(argv[2]), argv[3], int(argv[4]), [x for x in argv[5].split(',') if x]
    rows = []
    for l in open(path):
        p = l.strip().split(',')
        if len(p) == 3 and p[0].replace('.', '', 1).isdigit():
            rows.append((float(p[0]), p[1], int(p[2])))
    passed, line = analyse(rows, cut, dead, ttl, live)
    print(line)
    return 0 if passed else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv))
