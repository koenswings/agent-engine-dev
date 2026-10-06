/**
 * idea#168 (Steve GO, option a): app-data root helper slot safety.
 *
 * Two slot layouts, chosen PER ENGINE from what the Pi actually has (read-only ssh):
 *
 *  - `legacy`  — no /usr/local/sbin/idea-app-data on the Pi (the current pool, Engine f65183a).
 *                The harness keeps its pre-helper slot handling unchanged: it creates
 *                idea-test-N slot dirs under the (pi-owned) disks root, rm -rf's them on a fresh
 *                copy, stages moves in `<disksRoot>/.incoming-*` and quarantines a moved-away slot
 *                by renaming it to `<disksRoot>/.moved-away/…`.
 *  - `helper`  — the Pi has the helper (`/usr/local/sbin/idea-app-data` exists and
 *                `sudo -n … version` answers `idea-app-data <N>`). Atlas owns the layout: the disks
 *                root is root-owned and not group/other-writable (the helper's test-only root
 *                bridge requires that), every slot is pre-created. The harness NEVER creates or
 *                removes a slot dir: it only empties a slot's contents (dotfiles included), and
 *                root-owned instance data goes through
 *                `sudo -n /usr/local/sbin/idea-app-data delete <slot> <id>` — never rm.
 *
 * The slot preflight (`slot_layout_preflight`) fails loud (exit 7) when a helper Pi's layout is
 * not what the helper needs, before step 1.
 */

export const APP_DATA_HELPER = '/usr/local/sbin/idea-app-data'
/** The helper's test-only root bridge file (one `<disksRoot>/<slot>` per line, root:root 0644). */
export const APP_DATA_ROOTS_FILE = '/etc/idea/app-data-roots'
export const EXIT_SLOT_PREFLIGHT = 7

export type SlotLayoutMode = 'legacy' | 'helper'

/** Same shape as the helper's instance id token (`^[a-z0-9][a-z0-9-]{0,63}$`). */
const RE_INSTANCE_ID = '^[a-z0-9][a-z0-9-]{0,63}$'
const RE_SLOT_NAME = /^idea-test-[0-9]+$/

/**
 * Slots a walk can need on ONE Pi, derived from the harness:
 *  - dockFixture / moveDisk only ever use idea-test-1..FIXTURE_SLOT_COUNT (8) (the slot scan);
 *  - the walks use at most these six disks — duration-kolibri-grade5a-001,
 *    duration-nextcloud-grade5a-001, duration-empty-001 (Files; prefers idea-test-3),
 *    duration-empty-002 (erase + late installs; prefers idea-test-4), duration-add-files-001
 *    (Path A idea-test-5) and duration-empty-003 (the Backup Disk, idea#168 r38@103; Path A
 *    idea-test-6) — and any of them can end up on any one Pi (infra_move_disk / move_app /
 *    backup co-location), so a Pi needs six slots;
 *  - the preferred slots (3, 4, 6) are inside 1..6, and a slot freed by a move is emptied in
 *    place and reused, so 1..6 is enough.
 */
export const REQUIRED_SLOT_COUNT = 6
export const requiredSlotNames = (count = REQUIRED_SLOT_COUNT): string[] =>
    Array.from({ length: count }, (_, i) => `idea-test-${i + 1}`)

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** TS-side guard: a slot is `idea-test-N`, a direct child (no '/') of an absolute disks root. */
export const assertSlotPath = (disksRoot: string, slot: string): string => {
    if (!RE_SLOT_NAME.test(slot)) {
        throw new Error(`slot safety: refuse slot '${slot}' (must be idea-test-N, a direct child of ${disksRoot})`)
    }
    if (!/^\/[A-Za-z0-9._/-]+$/.test(disksRoot) || disksRoot.endsWith('/') || disksRoot.includes('//') ||
        /(^|\/)\.\.?(\/|$)/.test(disksRoot)) {
        throw new Error(`slot safety: refuse disks root '${disksRoot}' (absolute path of [A-Za-z0-9._/-], no '.', '..', '//' or trailing '/')`)
    }
    return `${disksRoot}/${slot}`
}

export type EmptySlotArgs = {
    disksRoot: string
    slot: string
    mode: SlotLayoutMode
    /** Top-level names kept (always: lost+found, so an ext4-backed slot keeps its fsck dir). */
    keep?: readonly string[]
}

/**
 * Remote bash (one line, joinable with '; ') that EMPTIES a slot and keeps the dir itself.
 *
 * Refuses (stderr `SLOT_REFUSED: …`, exit 7) when the slot path is a symlink, does not exist, is
 * not a directory, or does not resolve to a direct child of the disks root. All work happens
 * after `cd -P` into the slot and re-checking `pwd -P`; removal is `find . -mindepth 1
 * -maxdepth 1 … -exec rm -rf --one-file-system -- {} +` — dotfiles included, no shell glob, no
 * path outside the slot. In `helper` mode each `instances/<id>` folder is first removed by
 * `sudo -n /usr/local/sbin/idea-app-data delete <slot> <id>` (root-owned app data), never rm;
 * the helper needs META.yaml at the slot root, so that runs before anything else is removed.
 * Ends by checking nothing is left (`SLOT_EMPTIED <path>` on stdout).
 */
/** Shared guard: refuse a symlink / missing / non-dir / non-direct-child slot, then `cd -P` into it. */
const slotGuardParts = (args: EmptySlotArgs): { parts: string[]; notKept: string } => {
    const p = assertSlotPath(args.disksRoot, args.slot)
    const keep = ['lost+found', ...(args.keep ?? [])]
    for (const k of keep) {
        if (!/^[A-Za-z0-9._+-]+$/.test(k) || k === '.' || k === '..') throw new Error(`slot safety: bad keep name '${k}'`)
    }
    const notKept = keep.map(k => `! -name ${shq(k)}`).join(' ')
    const parts: string[] = [
        `_sr=${shq(args.disksRoot)}`,
        `_sn=${shq(args.slot)}`,
        `_sp=${shq(p)}`,
        `if [ -L "$_sp" ]; then ${refuse('$_sp is a symlink — refusing to touch it')}; fi`,
        `if [ ! -e "$_sp" ]; then ${refuse(args.mode === 'helper'
            ? '$_sp does not exist — the harness never creates a slot dir (helper layout: Atlas pre-creates every slot)'
            : '$_sp does not exist')}; fi`,
        `if [ ! -d "$_sp" ]; then ${refuse('$_sp is not a directory')}; fi`,
        `_srr=$(cd -P -- "$_sr" && pwd -P) || ${refuse('cannot resolve the disks root $_sr')}`,
        `cd -P -- "$_sp" || ${refuse('cannot enter $_sp')}`,
        `_spr=$(pwd -P)`,
        `if [ "$_spr" != "$_srr/$_sn" ] || [ "$(dirname -- "$_spr")" != "$_srr" ]; then ` +
            `${refuse('$_sp is not a direct child of the disks root $_sr (resolves to $_spr)')}; fi`,
    ]
    return { parts, notKept }
}

const refuse = (msg: string) => `{ echo "SLOT_REFUSED: ${msg}" >&2; exit 7; }`

/**
 * Remote bash (one line, joinable with '; ') that EMPTIES a slot and keeps the dir itself.
 *
 * Refuses (stderr `SLOT_REFUSED: …`, exit 7) when the slot path is a symlink, does not exist, is
 * not a directory, or does not resolve to a direct child of the disks root. All work happens
 * after `cd -P` into the slot and re-checking `pwd -P`; removal is `find . -mindepth 1
 * -maxdepth 1 … -exec rm -rf --one-file-system -- {} +` — dotfiles included, no shell glob, no
 * path outside the slot. In `helper` mode each `instances/<id>` folder is first removed by
 * `sudo -n /usr/local/sbin/idea-app-data delete <slot> <id>` (root-owned app data), never rm;
 * the helper needs META.yaml at the slot root, so that runs before anything else is removed.
 * Ends by checking nothing is left (`SLOT_EMPTIED <path>` on stdout).
 */
export const buildEmptySlotRemote = (args: EmptySlotArgs): string => {
    const { parts, notKept } = slotGuardParts(args)
    if (args.mode === 'helper') {
        parts.push(
            // The helper resolves <slot> through its root bridge and needs META.yaml at the root;
            // without META (e.g. a stream that failed before META arrived) the data was written
            // by pi and the plain removal below handles it — or fails loud if it cannot.
            `if [ -d ./instances ] && [ ! -L ./instances ] && [ -f ./META.yaml ] && [ ! -L ./META.yaml ]; then ` +
            `while IFS= read -r -d '' _si; do _sid=\${_si##*/}; ` +
            `if [[ ! "$_sid" =~ ${RE_INSTANCE_ID} ]]; then ${refuse('$_sp/instances/$_sid is not a valid instance id — refusing to rm instance data')}; fi; ` +
            `echo "SLOT_HELPER_DELETE $_sn $_sid"; ` +
            `sudo -n ${APP_DATA_HELPER} delete "$_sn" "$_sid" || ${refuse('sudo -n ' + APP_DATA_HELPER + ' delete $_sn $_sid failed')}; ` +
            `done < <(find ./instances -mindepth 1 -maxdepth 1 -type d -print0); ` +
            `fi`,
        )
    }
    parts.push(
        `find . -mindepth 1 -maxdepth 1 ${notKept} -exec rm -rf --one-file-system -- {} + || ` +
            `${refuse('could not remove every entry of $_sp (root-owned data outside instances/<id>?)')}`,
        `_sl=$(find . -mindepth 1 -maxdepth 1 ${notKept} -printf '%f ')`,
        `if [ -n "$_sl" ]; then ${refuse('$_sp still holds: $_sl')}; fi`,
        `cd / || true`,
        `echo "SLOT_EMPTIED $_sp"`,
    )
    return parts.join('; ')
}

/** Remote bash: refuse unless the slot exists, is a real dir, a direct child, and EMPTY (kept names aside). */
export const buildAssertEmptySlotRemote = (args: EmptySlotArgs): string => {
    const { parts, notKept } = slotGuardParts(args)
    parts.push(
        `_sl=$(find . -mindepth 1 -maxdepth 1 ${notKept} -printf '%f ')`,
        `if [ -n "$_sl" ]; then ${refuse('$_sp is not empty (holds: $_sl)')}; fi`,
        `cd / || true`,
        `echo "SLOT_IS_EMPTY $_sp"`,
    )
    return parts.join('; ')
}

/**
 * helper mode: where a moved-away slot's CONTENTS go — a sibling of the disks root (never inside
 * it: the disks root is root-owned and holds only Atlas's slots).
 */
export const movedAwayRoot = (disksRoot: string): string =>
    `${disksRoot.slice(0, disksRoot.lastIndexOf('/')) || ''}/duration-moved-away`

/**
 * helper mode, source side of a move: the disk has left this host. Move the slot's CONTENTS
 * (dotfiles included; lost+found kept) into `quarantine` — outside the disks root, same
 * filesystem (a rename: works as pi even over root-owned instance data, as the legacy slot
 * rename did) — and keep the slot dir itself, now empty. Refuses a symlink / missing /
 * non-child slot, a mount point, a quarantine inside the disks root or on another filesystem.
 */
export const buildQuarantineSlotContentsRemote = (args: { disksRoot: string; slot: string; quarantine: string }): string => {
    const { parts, notKept } = slotGuardParts({ disksRoot: args.disksRoot, slot: args.slot, mode: 'helper' })
    const q = args.quarantine
    if (!/^\/[A-Za-z0-9._/-]+$/.test(q) || q === args.disksRoot || q.startsWith(`${args.disksRoot}/`) || /(^|\/)\.\.?(\/|$)/.test(q)) {
        throw new Error(`slot safety: refuse quarantine '${q}' (must be an absolute path outside ${args.disksRoot})`)
    }
    const qparent = q.slice(0, q.lastIndexOf('/'))
    parts.push(
        `if mountpoint -q . 2>/dev/null; then ${refuse('$_sp is a mount point — refusing to move its contents away')}; fi`,
        `mkdir -p -- ${shq(qparent)} || ${refuse(`cannot create ${qparent}`)}`,
        `if [ "$(stat -c %d -- ${shq(qparent)})" != "$(stat -c %d -- .)" ]; then ${refuse(`${qparent} is on another filesystem than $_sp — a copy is not a rename; refusing`)}; fi`,
        `if [ -e ${shq(q)} ] || [ -L ${shq(q)} ]; then ${refuse(`${q} already exists`)}; fi`,
        `mkdir -- ${shq(q)} || ${refuse(`cannot create ${q}`)}`,
        `find . -mindepth 1 -maxdepth 1 ${notKept} -exec mv -t ${shq(q)} -- {} + || ${refuse(`could not move every entry of $_sp into ${q}`)}`,
        `_sl=$(find . -mindepth 1 -maxdepth 1 ${notKept} -printf '%f ')`,
        `if [ -n "$_sl" ]; then ${refuse('$_sp still holds: $_sl')}; fi`,
        `cd / || true`,
        `echo ${shq(`QUARANTINED ${q}`)}`,
    )
    return parts.join('; ')
}

// ── Helper detection + slot-layout preflight (read-only) ─────────────────────

/**
 * Read-only probe: does this Pi have the helper (and does `sudo -n … version` answer), the disks
 * root's owner/mode, each required slot's state, and the test-only root bridge entries.
 * `version` is only run when the helper file exists (legacy Pis get no sudo call at all).
 */
export const buildSlotLayoutProbeRemote = (disksRoot: string, slots: readonly string[]): string => {
    for (const s of slots) assertSlotPath(disksRoot, s)
    assertSlotPath(disksRoot, 'idea-test-1')
    const R = shq(disksRoot)
    const H = shq(APP_DATA_HELPER)
    const F = shq(APP_DATA_ROOTS_FILE)
    return [
        `if [ -e ${H} ] || [ -L ${H} ]; then echo "HELPER present"; ` +
            `if [ -x ${H} ]; then _v=$(sudo -n ${H} version 2>&1 </dev/null); _rc=$?; else _v="not executable"; _rc=126; fi; ` +
            `echo "HELPER_VERSION $_rc $(printf '%s' "$_v" | head -n 1 | tr -d '\\r')"; ` +
            `else echo "HELPER absent"; fi`,
        `if [ -L ${R} ]; then echo "ROOT symlink"; elif [ -d ${R} ]; then echo "ROOT dir $(stat -c '%u %g %a %U:%G' ${R})"; ` +
            `elif [ -e ${R} ]; then echo "ROOT notdir"; else echo "ROOT missing"; fi`,
        `for _s in ${slots.map(shq).join(' ')}; do _p=${R}/$_s; ` +
            `if [ -L "$_p" ]; then echo "SLOT $_s symlink"; ` +
            `elif [ -d "$_p" ]; then _w=no; if [ -w "$_p" ] && [ -x "$_p" ]; then _w=yes; fi; ` +
            `echo "SLOT $_s dir $(stat -c '%u %g %a %U:%G' "$_p") $_w"; ` +
            `elif [ -e "$_p" ]; then echo "SLOT $_s notdir"; else echo "SLOT $_s missing"; fi; done`,
        `if [ -L ${F} ]; then echo "BRIDGE symlink"; elif [ -f ${F} ]; then echo "BRIDGE file $(stat -c '%u %g %a' ${F})"; ` +
            `awk '{ sub(/#.*/, ""); gsub(/^[ \\t]+|[ \\t]+$/, ""); if ($0 != "") print "BRIDGE_LINE " $0 }' ${F} 2>/dev/null || echo "BRIDGE unreadable"; ` +
            `elif [ -e ${F} ]; then echo "BRIDGE notfile"; else echo "BRIDGE missing"; fi`,
        `true`,
    ].join('; ')
}

export type SlotProbeSlot =
    | { name: string; state: 'symlink' | 'notdir' | 'missing' }
    | { name: string; state: 'dir'; uid: number; gid: number; mode: string; owner: string; writable: boolean }

export type SlotLayoutProbe = {
    helper: 'present' | 'absent'
    versionRc: number | null
    versionOut: string
    root: { state: 'dir'; uid: number; gid: number; mode: string; owner: string } | { state: 'symlink' | 'notdir' | 'missing' }
    slots: SlotProbeSlot[]
    bridge: { state: 'file'; uid: number; gid: number; mode: string; lines: string[] } | { state: 'symlink' | 'notfile' | 'missing' | 'unreadable' }
}

export const parseSlotLayoutProbe = (out: string): SlotLayoutProbe => {
    const probe: SlotLayoutProbe = {
        helper: 'absent', versionRc: null, versionOut: '', root: { state: 'missing' }, slots: [], bridge: { state: 'missing' },
    }
    let sawHelper = false
    const bridgeLines: string[] = []
    for (const raw of out.split('\n')) {
        const line = raw.replace(/\r$/, '')
        let m: RegExpMatchArray | null
        if ((m = line.match(/^HELPER (present|absent)$/))) { probe.helper = m[1] as 'present' | 'absent'; sawHelper = true }
        else if ((m = line.match(/^HELPER_VERSION (\d+) ?(.*)$/))) { probe.versionRc = Number(m[1]); probe.versionOut = m[2]!.trim() }
        else if ((m = line.match(/^ROOT dir (\d+) (\d+) ([0-7]+) (\S+)$/))) {
            probe.root = { state: 'dir', uid: Number(m[1]), gid: Number(m[2]), mode: m[3]!, owner: m[4]! }
        } else if ((m = line.match(/^ROOT (symlink|notdir|missing)$/))) probe.root = { state: m[1] as 'symlink' }
        else if ((m = line.match(/^SLOT (\S+) dir (\d+) (\d+) ([0-7]+) (\S+) (yes|no)$/))) {
            probe.slots.push({ name: m[1]!, state: 'dir', uid: Number(m[2]), gid: Number(m[3]), mode: m[4]!, owner: m[5]!, writable: m[6] === 'yes' })
        } else if ((m = line.match(/^SLOT (\S+) (symlink|notdir|missing)$/))) probe.slots.push({ name: m[1]!, state: m[2] as 'missing' })
        else if ((m = line.match(/^BRIDGE file (\d+) (\d+) ([0-7]+)$/))) {
            probe.bridge = { state: 'file', uid: Number(m[1]), gid: Number(m[2]), mode: m[3]!, lines: bridgeLines }
        } else if ((m = line.match(/^BRIDGE (symlink|notfile|missing|unreadable)$/))) probe.bridge = { state: m[1] as 'missing' }
        else if ((m = line.match(/^BRIDGE_LINE (.+)$/))) bridgeLines.push(m[1]!)
    }
    if (!sawHelper) throw new Error(`slot layout probe: unparseable output (no HELPER line): ${out.slice(0, 300)}`)
    return probe
}

const groupOtherWritable = (mode: string): boolean => (parseInt(mode, 8) & 0o022) !== 0

export type SlotLayoutVerdict = {
    engine: string
    host: string
    mode: SlotLayoutMode
    ok: boolean
    helperVersion: string | null
    problems: string[]
    /** The one log line saying which mode is in force (and why). */
    message: string
}

/**
 * Decide the slot layout for one Pi. `legacy` (helper absent) always passes — the current pool
 * keeps working unchanged. `helper` is enforced: version answers, disks root root-owned and not
 * g/o-writable (and not a symlink), every required slot exists, is a real dir (not a symlink) and
 * pi-writable, and the helper's root bridge lists each slot (else `delete <slot> <id>` refuses).
 */
export const slotLayoutVerdict = (
    engine: string,
    host: string,
    disksRoot: string,
    probe: SlotLayoutProbe,
    slots: readonly string[] = requiredSlotNames(),
): SlotLayoutVerdict => {
    const where = `${engine} (${host})`
    if (probe.helper === 'absent') {
        return {
            engine, host, mode: 'legacy', ok: true, helperVersion: null, problems: [],
            message:
                `slot_layout_preflight: ${where}: mode=legacy — no ${APP_DATA_HELPER} on this Pi; the harness keeps ` +
                `its pre-helper slot handling unchanged (it creates/removes idea-test-N slot dirs under ${disksRoot}; ` +
                `no slot-layout checks enforced)`,
        }
    }
    const problems: string[] = []
    const vOk = probe.versionRc === 0 && /^idea-app-data [0-9]+$/.test(probe.versionOut)
    if (!vOk) {
        problems.push(
            `${APP_DATA_HELPER} exists but \`sudo -n ${APP_DATA_HELPER} version\` did not answer 'idea-app-data <N>' ` +
                `(exit ${probe.versionRc ?? '?'}: ${probe.versionOut || '(no output)'}) — check the sudoers line ` +
                `'pi ALL=(root) NOPASSWD: ${APP_DATA_HELPER}'`,
        )
    }
    const r = probe.root
    if (r.state !== 'dir') {
        problems.push(`disks root ${disksRoot} is ${r.state === 'symlink' ? 'a symlink' : r.state === 'notdir' ? 'not a directory' : 'missing'} — must be a real dir owned by root, mode 0755`)
    } else {
        if (r.uid !== 0) problems.push(`disks root ${disksRoot} is owned by ${r.owner} (uid ${r.uid}), not root — must be root:root 0755`)
        if (groupOtherWritable(r.mode)) problems.push(`disks root ${disksRoot} has mode 0${r.mode} (group/other-writable) — must be root:root 0755`)
    }
    for (const name of slots) {
        const s = probe.slots.find(x => x.name === name)
        const p = `${disksRoot}/${name}`
        if (!s || s.state === 'missing') problems.push(`slot ${p} does not exist — Atlas must pre-create it (the harness never creates a slot dir in helper mode)`)
        else if (s.state === 'symlink') problems.push(`slot ${p} is a symlink — must be a real dir`)
        else if (s.state === 'notdir') problems.push(`slot ${p} is not a directory`)
        else if (s.state === 'dir' && !s.writable) problems.push(`slot ${p} is not writable by pi (owner ${s.owner}, mode 0${s.mode}) — must be pi:pi 0755`)
    }
    const b = probe.bridge
    if (b.state !== 'file') {
        problems.push(`root bridge ${APP_DATA_ROOTS_FILE} is ${b.state} — idea-app-data delete <slot> <id> needs it (root:root 0644, one '${disksRoot}/idea-test-N' per line)`)
    } else {
        if (b.uid !== 0 || b.gid !== 0 || b.mode !== '644') {
            problems.push(`root bridge ${APP_DATA_ROOTS_FILE} is ${b.uid}:${b.gid} 0${b.mode} — the helper ignores it unless root:root 0644`)
        }
        const missing = slots.filter(n => !b.lines.includes(`${disksRoot}/${n}`))
        if (missing.length) {
            problems.push(`root bridge ${APP_DATA_ROOTS_FILE} does not list ${missing.map(n => `${disksRoot}/${n}`).join(', ')}`)
        }
    }
    const version = vOk ? probe.versionOut : null
    const slotRange = slots.length ? `${slots[0]}..${slots[slots.length - 1]!.replace('idea-test-', '')}` : '(none)'
    const message = problems.length
        ? `slot_layout_preflight: ${where}: mode=helper — FAIL: ${problems.join('; ')}`
        : `slot_layout_preflight: ${where}: mode=helper (${version}) — ${disksRoot} root-owned 0${(r as { mode: string }).mode}; ` +
          `slots ${slotRange} exist, pi-writable, no symlinks, listed in ${APP_DATA_ROOTS_FILE}; the harness never creates ` +
          `or removes a slot dir, it only empties slots (instances/<id> via sudo -n ${APP_DATA_HELPER} delete <slot> <id>)`
    return { engine, host, mode: 'helper', ok: problems.length === 0, helperVersion: version, problems, message }
}
