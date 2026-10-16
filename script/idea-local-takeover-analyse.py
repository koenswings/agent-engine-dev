#!/usr/bin/env python3
"""Analyse the client poll of idea-local-takeover-test.sh (idea#203).

usage: idea-local-takeover-analyse.py POLL.csv CUT_OFFSET_S DEAD_IP TTL_S LIVE_IPS(comma list) [RESUME_S GRACE_S]
POLL.csv rows: seconds_since_start,resolved_ips('+' joined or FAIL),http_status_of_first_ip
Prints a summary; exit 0 PASS (a live Engine resolved AND served HTTP 200, steadily, within TTL), 1 FAIL.

RESUME_S/GRACE_S are passed for --mode avahi-freeze ONLY (Steve, 2026-10-15; GRACE_S at most 3 s,
raised from 2 s after the 856589f pool runs saw the resume burst last 2.5-2.7 s). RESUME_S is when
avahi-daemon got SIGCONT on the frozen holder, in poll seconds. A SIGSTOPped avahi-daemon has
queued every query the LAN sent it while frozen; on SIGCONT it first answers that backlog from
memory (with the old idea.local record, before the Engine's freed entry group is processed) and
then sends the goodbye within ~10 ms. A client can therefore see the dead IP in a short burst
right after the resume, which no Engine code can prevent and which a real power cut never
causes. Only samples in [RESUME_S, RESUME_S + GRACE_S] may carry the dead IP; one later is a
FAIL, and so is a poll that ends before RESUME_S + GRACE_S + 1 s (the resume was not observed).
netcut runs pass no RESUME_S and stay strict: the dead IP after the takeover always fails.
"""
import sys

def analyse(rows, cut, dead, ttl, live, resume=None, grace=0.0):
    after = [(t - cut, ip, code) for t, ip, code in rows if t >= cut]
    if not after:
        return False, 'no samples after the cut'
    last_dead = max((t for t, ip, _ in after if dead in ip.split('+')), default=None)
    res = None if resume is None else resume - cut  # resume, in seconds after the cut
    def in_grace(t):
        return res is not None and res <= t <= res + grace
    def ok(t, ip, code):
        ips = ip.split('+')
        if in_grace(t) and dead in ips:
            return True  # avahi backlog burst right after SIGCONT (avahi-freeze only, see above)
        return ip != 'FAIL' and dead not in ips and all(x in live for x in ips) and code == 200
    ok_from = None
    for i, (t, ip, code) in enumerate(after):
        if all(ok(u, x, c) for u, x, c in after[i:]):
            ok_from = t
            break
    if res is not None:
        tolerated = [t for t, ip, _ in after if in_grace(t) and dead in ip.split('+')]
        late = [t for t, ip, _ in after if t > res + grace and dead in ip.split('+')]
        observed = any(t >= res + grace + 1.0 for t, _, _ in after)
        passed = ok_from is not None and ok_from <= ttl and not late and observed
        line = ('%s: %d samples after cut; avahi resumed at +%.1f s; dead IP %d time(s) within the %.1f s resume grace%s; '
                'dead IP after the grace: %s; steady on live Engine with HTTP 200 from +%s s (limit %d s); %s') % (
            'PASS' if passed else 'FAIL', len(after), res, len(tolerated), grace,
            (' (+%s s)' % ', +'.join('%.1f' % t for t in tolerated)) if tolerated else '',
            ', '.join('+%.1f s' % t for t in late) if late else 'never',
            'never' if ok_from is None else '%.1f' % ok_from, ttl,
            'resume observed' if observed else 'resume NOT observed (poll ended before resume + grace + 1 s)')
        return passed, line
    fails = sum(ip == 'FAIL' for _, ip, _ in after)
    new = sorted({ip for t, ip, c in after if ok(t, ip, c) and dead not in ip.split("+")})
    passed = ok_from is not None and ok_from <= ttl
    line = ('%s: %d samples after cut; dead IP last returned at +%s s; steady on live Engine (%s) with HTTP 200 from +%s s '
            '(limit %d s); FAIL lookups %d') % (
        'PASS' if passed else 'FAIL', len(after),
        'never' if last_dead is None else '%.1f' % last_dead, '+'.join(new) or 'none',
        'never' if ok_from is None else '%.1f' % ok_from, ttl, fails)
    return passed, line

def main(argv):
    path, cut, dead, ttl, live = argv[1], float(argv[2]), argv[3], int(argv[4]), [x for x in argv[5].split(',') if x]
    resume = float(argv[6]) if len(argv) > 6 and argv[6] else None
    grace = float(argv[7]) if len(argv) > 7 else 0.0
    if resume is not None and not 0 < grace <= 3.0:
        print('FAIL: the resume grace must be > 0 and at most 3 s (Steve, idea#203)')
        return 1
    rows = []
    for l in open(path):
        p = l.strip().split(',')
        if len(p) == 3 and p[0].replace('.', '', 1).isdigit():
            rows.append((float(p[0]), p[1], int(p[2])))
    passed, line = analyse(rows, cut, dead, ttl, live, resume, grace)
    print(line)
    return 0 if passed else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv))
