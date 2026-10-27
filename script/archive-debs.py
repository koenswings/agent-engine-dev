#!/usr/bin/env python3
"""archive-debs.py - archive exact .deb versions for an Engine release (idea#322).

Debian packages come from a dated snapshot.debian.org; Raspberry Pi archive
packages (no snapshots) from archive.raspberrypi.com while upstream still has them.

Usage:
  archive-debs.py --out DIR [--packages packages.tsv] [--rpi-current NAME ...]
                  [--suite trixie] [--snapshot 20261026T000000Z] [--arch arm64] [--index-only]
packages.tsv: "<package>\t<version>[\t<arch>]" (the Engine record's packages.tsv, or apt-rpi-pins.tsv).
--rpi-current: archive the version the Raspberry Pi archive serves today (when exact versions are unknown).
Writes DIR/debian/*.deb, DIR/rpi/*.deb, DIR/indexes/ (the Packages indexes used), DIR/index.tsv,
DIR/missing.tsv and DIR/SHA256SUMS. Every .deb is checked against its Packages SHA256; a mismatch is fatal.
"""
import argparse, gzip, hashlib, lzma, os, sys, urllib.request

def fetch(url, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "idea-archive-debs/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def parse(text):
    for st in text.split("\n\n"):
        d = {}
        for line in st.splitlines():
            if line and not line[0].isspace() and ":" in line:
                k, v = line.split(":", 1); d[k] = v.strip()
        if "Package" in d:
            yield d

def load(origin, mirror, suites, comps, arch, idxdir):
    idx = {}
    for s in suites:
        for c in comps:
            for a in (arch, "all"):
                base = f"{mirror}/dists/{s}/{c}/binary-{a}/Packages"
                for ext, dec in ((".xz", lzma.decompress), (".gz", gzip.decompress)):
                    try:
                        raw = fetch(base + ext)
                    except Exception:
                        continue
                    open(os.path.join(idxdir, f"{origin}_{s}_{c}_{a}_Packages{ext}"), "wb").write(raw)
                    for d in parse(dec(raw).decode("utf-8", "replace")):
                        d["_mirror"] = mirror; d["_origin"] = origin
                        idx.setdefault((d["Package"], d.get("Version", "")), d)
                    break
    return idx

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True); ap.add_argument("--packages")
    ap.add_argument("--rpi-current", nargs="*", default=[])
    ap.add_argument("--suite", default="trixie"); ap.add_argument("--snapshot", default="20261026T000000Z")
    ap.add_argument("--arch", default="arm64"); ap.add_argument("--index-only", action="store_true")
    a = ap.parse_args()
    idxdir = os.path.join(a.out, "indexes"); os.makedirs(idxdir, exist_ok=True)
    s = a.suite
    comps = ["main", "contrib", "non-free", "non-free-firmware"]
    deb = load("debian", f"https://snapshot.debian.org/archive/debian/{a.snapshot}", [s, f"{s}-updates"], comps, a.arch, idxdir)
    for k, v in load("debian", f"https://snapshot.debian.org/archive/debian-security/{a.snapshot}", [f"{s}-security"], comps, a.arch, idxdir).items():
        deb.setdefault(k, v)
    rpi = load("rpi", "https://archive.raspberrypi.com/debian", [s], ["main"], a.arch, idxdir)
    if not deb and not rpi:
        sys.exit("no package index could be read")
    want = []
    if a.packages:
        for line in open(a.packages):
            p = line.rstrip("\n").split("\t")
            if len(p) >= 2 and p[0] and not p[0].startswith("#"):
                want.append((p[0].split(":")[0], p[1]))
    for name in a.rpi_current:
        # the RPi archive serves one version per package and suite; take the last in index order
        vers = [v for (n, v) in rpi if n == name]
        want.append((name, vers[-1] if vers else "?"))
    rows, missing = [], []
    for pkg, ver in want:
        d = rpi.get((pkg, ver)) or deb.get((pkg, ver))
        if not d:
            missing.append(f"{pkg}\t{ver}\tnot in snapshot {a.snapshot} or archive.raspberrypi.com {s}"); continue
        sub = os.path.join(a.out, d["_origin"]); os.makedirs(sub, exist_ok=True)
        fn, exp = d["Filename"], d.get("SHA256", "")
        dest = os.path.join(sub, os.path.basename(fn)); status = "indexed"
        if not a.index_only:
            if not (os.path.exists(dest) and hashlib.sha256(open(dest, "rb").read()).hexdigest() == exp):
                blob = fetch(f"{d['_mirror']}/{fn}")
                got = hashlib.sha256(blob).hexdigest()
                if got != exp:
                    sys.exit(f"sha256 mismatch for {fn}: got {got} expected {exp}")
                open(dest + ".part", "wb").write(blob); os.replace(dest + ".part", dest)
            status = "archived"
        rows.append(f"{pkg}\t{ver}\t{d.get('Architecture','')}\t{d['_origin']}\t{fn}\t{exp}\t{status}")
    open(os.path.join(a.out, "index.tsv"), "w").write("package\tversion\tarch\torigin\tfilename\tsha256\tstatus\n" + "".join(r + "\n" for r in rows))
    open(os.path.join(a.out, "missing.tsv"), "w").write("".join(m + "\n" for m in missing))
    sums = []
    for root, _, files in os.walk(a.out):
        for f in files:
            if f == "SHA256SUMS": continue
            p = os.path.join(root, f)
            sums.append((os.path.relpath(p, a.out), hashlib.sha256(open(p, "rb").read()).hexdigest()))
    open(os.path.join(a.out, "SHA256SUMS"), "w").write("".join(f"{h}  {r}\n" for r, h in sorted(sums)))
    print(f"{len(rows)} archived/indexed, {len(missing)} missing -> {a.out}")

if __name__ == "__main__":
    main()
