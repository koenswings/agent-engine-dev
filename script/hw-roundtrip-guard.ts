/**
 * hw-roundtrip-guard.ts: which disk script/hw-roundtrip.ts may touch (idea#152).
 *
 * The hardware test ejects and unplugs (sysfs unbind) a real USB disk, so it
 * only ever touches the recorded test disk, matched by its IDs and never by a
 * device name such as sdb:
 *   - every expected filesystem UUID is found, all on one disk, and that disk
 *     has no other partitions;
 *   - the disk serial (lsblk SERIAL = udev ID_SERIAL_SHORT) and the USB serial
 *     (sysfs `serial` of its USB device = ID_USB_SERIAL_SHORT) match;
 *   - never a refused serial (e.g. idea03's root SSD), never the drive backing
 *     / or /boot/firmware, never a USB device that is or sits above theirs.
 *
 * resolveStick() is pure (unit-tested with fake facts); collectBlockFacts()
 * reads lsblk and sysfs on the Pi.
 */

import { $, fs } from 'zx'
import path from 'path'

export interface StickExpectation {
    usbSerial: string          // ID_USB_SERIAL_SHORT of the USB bridge
    diskSerial: string         // ID_SERIAL_SHORT of the disk (lsblk SERIAL)
    uuids: string[]            // filesystem UUIDs of all its partitions
    refuseSerials: string[]    // disk serials that are never a target (root SSD)
}

export interface DiskFacts {
    serial: string             // lsblk SERIAL ('' if none)
    usbPath: string | null     // sysfs path of its USB device, null if not USB
    usbSerial: string | null   // sysfs `serial` of that USB device
}

export interface BlockFacts {
    partitions: { name: string, uuid: string, disk: string }[]
    disks: Record<string, DiskFacts>
    systemDisks: string[]      // drives backing / and /boot/firmware
}

export type StickResolution =
    | { ok: true, disk: string, usbPath: string, usbId: string, partitions: string[] }
    | { ok: false, reason: string }

const refuse = (reason: string): StickResolution => ({ ok: false, reason })

export const resolveStick = (exp: StickExpectation, facts: BlockFacts): StickResolution => {
    if (!exp.usbSerial) return refuse('no expected USB serial (--stick-usb-serial or the stick config)')
    if (!exp.diskSerial) return refuse('no expected disk serial (--disk-serial or the stick config)')
    if (exp.uuids.length === 0) return refuse('no expected filesystem UUIDs (--uuid or the stick config)')
    if (exp.refuseSerials.includes(exp.diskSerial)) return refuse(`the expected disk serial ${exp.diskSerial} is a refused serial (root SSD)`)

    // Refused serials and the system drive: never a target, whatever else matches
    for (const d of facts.systemDisks) {
        const f = facts.disks[d]
        if (f?.serial && f.serial === exp.diskSerial) return refuse(`disk serial ${exp.diskSerial} is the system drive ${d}`)
        if (f?.usbSerial && f.usbSerial === exp.usbSerial) return refuse(`USB serial ${exp.usbSerial} is the system drive ${d}'s USB device`)
    }

    const found = exp.uuids.map(u => ({ uuid: u, parts: facts.partitions.filter(p => p.uuid === u) }))
    const missing = found.filter(f => f.parts.length === 0).map(f => f.uuid)
    if (missing.length) return refuse(`filesystem UUID(s) not found: ${missing.join(', ')}`)
    const dup = found.filter(f => f.parts.length > 1)
    if (dup.length) return refuse(`filesystem UUID(s) on more than one partition: ${dup.map(f => `${f.uuid} (${f.parts.map(p => p.name).join(', ')})`).join('; ')}`)
    const disks = [...new Set(found.map(f => f.parts[0].disk))]
    if (disks.length !== 1) return refuse(`the expected UUIDs are on different disks: ${disks.join(', ')}`)
    const disk = disks[0]
    const d = facts.disks[disk]
    if (!d) return refuse(`no facts for disk ${disk}`)

    if (exp.refuseSerials.includes(d.serial)) return refuse(`disk ${disk} has refused serial ${d.serial} (root SSD)`)
    if (facts.systemDisks.includes(disk)) return refuse(`disk ${disk} backs / or /boot/firmware`)
    if (!d.serial) return refuse(`disk ${disk} reports no serial; expected ${exp.diskSerial}`)
    if (d.serial !== exp.diskSerial) return refuse(`disk ${disk} serial ${d.serial} is not the expected ${exp.diskSerial}`)
    if (!d.usbPath) return refuse(`disk ${disk} is not on USB`)
    if (!d.usbSerial) return refuse(`USB device of ${disk} reports no serial; expected ${exp.usbSerial}`)
    if (d.usbSerial !== exp.usbSerial) return refuse(`USB device of ${disk} has serial ${d.usbSerial}, not the expected ${exp.usbSerial}`)
    for (const s of facts.systemDisks) {
        const u = facts.disks[s]?.usbPath
        if (u && (u === d.usbPath || u.startsWith(d.usbPath + '/'))) return refuse(`USB device ${d.usbPath} is (or is above) the system drive ${s}'s USB device`)
    }

    const partitions = facts.partitions.filter(p => p.disk === disk)
    const extra = partitions.filter(p => !exp.uuids.includes(p.uuid))
    if (extra.length) return refuse(`disk ${disk} has partitions that are not expected: ${extra.map(p => `${p.name} (${p.uuid || 'no UUID'})`).join(', ')}`)
    return { ok: true, disk, usbPath: d.usbPath, usbId: path.basename(d.usbPath), partitions: partitions.map(p => p.name) }
}

// ── Reading the facts on the Pi ─────────────────────────────────────────────

/** sysfs path of a block device's USB device, e.g. /sys/devices/.../usb4/4-1; null if not USB */
export const usbPathFromSysPath = (real: string): string | null => {
    const parts = real.split('/')
    let last = -1
    parts.forEach((p, i) => { if (/^\d+-[\d.]+$/.test(p)) last = i })
    return last === -1 ? null : parts.slice(0, last + 1).join('/')
}

const out = async (cmd: string): Promise<string> => (await $`bash -c ${cmd}`.nothrow()).stdout.trim()

export const collectBlockFacts = async (): Promise<BlockFacts> => {
    type Node = { name: string, uuid?: string | null, serial?: string | null, type?: string, children?: Node[] }
    const json = JSON.parse(await out('lsblk -J -o NAME,UUID,SERIAL,TYPE') || '{"blockdevices":[]}') as { blockdevices: Node[] }
    const partitions: BlockFacts['partitions'] = []
    const disks: Record<string, DiskFacts> = {}
    for (const n of json.blockdevices) {
        if (n.type !== 'disk') continue
        const usbPath = usbPathFromSysPath(await out(`readlink -f /sys/block/${n.name}`))
        let usbSerial: string | null = null
        if (usbPath) { try { usbSerial = fs.readFileSync(`${usbPath}/serial`, 'utf8').trim() || null } catch { usbSerial = null } }
        disks[n.name] = { serial: (n.serial ?? '').trim(), usbPath, usbSerial }
        for (const c of n.children ?? []) if (c.type === 'part') partitions.push({ name: c.name, uuid: c.uuid ?? '', disk: n.name })
    }
    const systemDisks = new Set<string>()
    for (const target of ['/', '/boot/firmware']) {
        const src = await out(`findmnt -n -o SOURCE ${target}`)
        if (!src.startsWith('/dev/')) continue
        const parent = await out(`lsblk -no PKNAME ${src} | head -1`)
        systemDisks.add(parent || src.replace('/dev/', ''))
    }
    return { partitions, disks, systemDisks: [...systemDisks] }
}

// ── Expected IDs: stick config + CLI flags ──────────────────────────────────

/**
 * The recorded test disk of a host from script/hw-roundtrip-disks.json (keyed
 * by hostname), overridden by --stick-usb-serial, --disk-serial, --uuid
 * (repeatable; replaces the list) and --refuse-serial (repeatable; added).
 */
export const loadExpectation = (argv: string[], configFile: string, hostname: string): StickExpectation => {
    const all = (name: string) => argv.flatMap((a, i) => a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : [])
    const one = (name: string) => all(name)[0]
    let base: Partial<StickExpectation> = {}
    if (fs.existsSync(configFile)) {
        const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, Partial<StickExpectation>>
        base = cfg[hostname] ?? {}
    }
    return {
        usbSerial: one('stick-usb-serial') ?? base.usbSerial ?? '',
        diskSerial: one('disk-serial') ?? base.diskSerial ?? '',
        uuids: all('uuid').length ? all('uuid') : (base.uuids ?? []),
        refuseSerials: [...(base.refuseSerials ?? []), ...all('refuse-serial')],
    }
}
