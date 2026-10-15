#!/usr/bin/env -S npx tsx
/**
 * hw-usb-sticks.ts: on-Pi hardware test for teacher USB sticks (idea#193 §14, Engine step 1)
 *
 * Runs ON a claimed test Pi against its running Engine (never idea02, wizardly-hugle
 * or a Milkwise Pi), in the style of hw-roundtrip.ts. For every recorded test stick
 * (script/hw-usb-sticks.json, matched by filesystem UUID, disk serial and USB serial,
 * never by device name; hw-roundtrip-guard.ts refuses the system drive and the root
 * SSD serial):
 *    1. sha256 of the whole stick partition BEFORE (sudo -n sha256sum /dev/<dev>)
 *    2. simulated unplug + re-plug (sysfs unbind/bind) → Engine.usbSticks has
 *       usb-<uuid> on /dev/<dev>, displayName 'USB: …', readOnly, fsType, hasKolibriFolder
 *    3. findmnt: /run/idea-usb/<dev>, fstype, options ro,nosuid,nodev,noexec, uid=1000
 *       (kernel exfat driver present: /proc/filesystems lists exfat)
 *    4. recorded files: sha256 matches through the mount; a write as pi fails
 *    5. /run/idea-usb/.idea-usb.json lists the stick ({"sticks":[{device,displayName,label,…}]})
 *    6. never a diskDB entry; the drive is in Engine.unformattedDisks (erase offered),
 *       or, when the drive also carries an ext4 partition (App Disk), NOT in it
 *    7. a Running Nextcloud with x-app.usbMount on this Engine sees /mnt/idea-usb/<dev>
 *       (docker exec ls) and the Engine log shows the usb-sync.sh call
 *    8. channel builder (§8.2a, only with --builder): a kolibri stick with the builder
 *       Docked → Engine log 'auto-start: usb stick', builder Running, builderAutoStart
 *       'started'; then Console-path stopInstance, re-plug → stays Stopped,
 *       builderAutoStart 'operatorStopped'
 *    9. unplug → gone from usbSticks and the JSON, no mount by source or target,
 *       /run/idea-usb/<dev> removed; re-plug and sha256 AFTER == BEFORE (bit-identical)
 *
 * Usage (on the test Pi, from an Engine checkout with node_modules):
 *   npx tsx script/hw-usb-sticks.ts [--engine-dir <path>] [--port 4321]
 *       [--engine-log ~/.pm2/logs/engine-out.log] [--config script/hw-usb-sticks.json]
 *       [--method unbind|authorized|partition-uevent] [--timeout 60] [--builder]
 * --method partition-uevent simulates unplug/plug of the stick PARTITION only
 * (udevadm trigger --action=remove|add /sys/class/block/<part>): use it when the
 * stick partition shares a USB device with another disk that must stay up.
 * Root: only the unplug simulation and the read-only sha256 of the block device use
 * the tester's own sudo (not the Engine sudoers). Exit 0 only when every check passes.
 * Log: test/testresults/hw-usb-sticks-<UTC yyyy-mm-dd-hhmmss>.log
 */
import { Repo, DocumentId } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { $, fs, sleep } from 'zx'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { collectBlockFacts, resolveStick, StickExpectation, diskHasExt4, unformattedExpectation } from './hw-roundtrip-guard.js'

$.verbose = false
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i !== -1 && argv[i + 1] ? argv[i + 1] : d }
const ENGINE_DIR = path.resolve(opt('engine-dir', ROOT))
const PORT = opt('port', '4321')
const ENGINE_LOG = opt('engine-log', path.join(os.homedir(), '.pm2/logs/engine-out.log'))
const CONFIG = path.resolve(opt('config', path.join(ROOT, 'script', 'hw-usb-sticks.json')))
const METHOD = opt('method', 'unbind')
const TIMEOUT_MS = parseInt(opt('timeout', '60'), 10) * 1000
const BUILDER = argv.includes('--builder')
const USB_ROOT = '/run/idea-usb'

const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '')
const LOG_FILE = path.join(ROOT, 'test', 'testresults', `hw-usb-sticks-${stamp}.log`)
fs.mkdirpSync(path.dirname(LOG_FILE))
const failures: string[] = []
let passes = 0
const write = (l: string) => { const s = `${new Date().toISOString()} ${l}`; process.stdout.write(s + '\n'); fs.appendFileSync(LOG_FILE, s + '\n') }
const info = (m: string) => write(`      ${m}`)
const check = (ok: boolean, what: string, detail = '') => {
    if (ok) { passes++; write(`PASS  ${what}`) } else { failures.push(`${what}${detail ? ` — ${detail}` : ''}`); write(`FAIL  ${what}${detail ? ` — ${detail}` : ''}`) }
    return ok
}
const finish = (code?: number) => {
    const r = code ?? (failures.length ? 1 : 0)
    write(`RESULT ${r === 0 ? 'PASS' : r === 2 ? 'ABORT' : 'FAIL'}: ${passes} passed, ${failures.length} failed`)
    failures.forEach(f => write(`  failed: ${f}`)); write(`log: ${LOG_FILE}`)
    process.exit(r)
}
const abort = (m: string): never => { write(`ABORT ${m}`); return finish(2) as never }
const sh = async (cmd: string) => (await $`bash -c ${cmd}`.nothrow()).stdout.trim()
const waitFor = async (what: string, fn: () => Promise<boolean> | boolean, timeout = TIMEOUT_MS) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await fn()) return true; await sleep(500) }
    info(`timed out after ${timeout / 1000}s waiting for: ${what}`); return false
}

// ── Guards ──
const host = os.hostname()
if (['idea02', 'wizardly-hugle'].includes(host) || /milkwise/i.test(host)) abort(`refusing to run on ${host}`)
if (!['unbind', 'authorized', 'partition-uevent'].includes(METHOD)) abort(`unknown --method ${METHOD}`)
const cfg = (JSON.parse(fs.readFileSync(CONFIG, 'utf8')) as any)[host]
if (!cfg?.sticks?.length) abort(`no test sticks recorded for ${host} in ${CONFIG}`)
type StickCfg = { name: string, fsType: 'vfat' | 'exfat', usbSerial: string, diskSerial: string, uuids: string[], kolibri: boolean, files: Record<string, string> }
const sticks: StickCfg[] = cfg.sticks

// ── Store ──
const storeUrl = fs.readFileSync(path.join(ENGINE_DIR, 'store-identity', 'store-url.txt'), 'utf8').trim()
const repo = new Repo({ network: [new WebSocketClientAdapter(`ws://127.0.0.1:${PORT}`)] })
const h = await repo.find<any>(storeUrl.replace('automerge:', '') as DocumentId)
await h.whenReady(); await sleep(1500)
const store = () => h.doc() as any
const engine = Object.values(store().engineDB ?? {}).find((e: any) => e.hostname === host) as any
if (!engine) abort(`no engine with hostname ${host} in ${storeUrl}`)
const ENGINE_ID = engine.id
const usbSticks = (): any[] => store().engineDB[ENGINE_ID]?.usbSticks ?? []
const logOffset = () => { try { return fs.statSync(ENGINE_LOG).size } catch { return -1 } }
const logSince = (off: number) => {
    if (off < 0) return ''
    const fd = fs.openSync(ENGINE_LOG, 'r'); const size = fs.fstatSync(fd).size
    const buf = Buffer.alloc(Math.max(0, size - off)); fs.readSync(fd, buf, 0, buf.length, off); fs.closeSync(fd)
    return buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '')
}
const sysWrite = async (file: string, v: string) => {
    const r = await $`echo ${v} | sudo -n tee ${file}`.nothrow()
    if (r.exitCode !== 0) throw new Error(`sudo tee ${file} failed: ${r.stderr.trim()}`)
}
const uevent = async (action: 'add' | 'remove', part: string) => {
    if (!/^[a-z]+[0-9]+$/.test(part)) throw new Error(`partition-uevent needs a partition, got '${part}'`)
    const r = await $`sudo -n udevadm trigger --action=${action} ${`/sys/class/block/${part}`}`.nothrow()
    if (r.exitCode !== 0) throw new Error(`udevadm trigger ${action} ${part} failed: ${r.stderr.trim()}`)
}
// usbId: the USB device (unbind/authorized); part: the stick partition (partition-uevent)
const unplug = (usbId: string, part: string) => METHOD === 'partition-uevent' ? uevent('remove', part) : METHOD === 'unbind' ? sysWrite('/sys/bus/usb/drivers/usb/unbind', usbId) : sysWrite(`/sys/bus/usb/devices/${usbId}/authorized`, '0')
const plug = (usbId: string, part: string) => METHOD === 'partition-uevent' ? uevent('add', part) : METHOD === 'unbind' ? sysWrite('/sys/bus/usb/drivers/usb/bind', usbId) : sysWrite(`/sys/bus/usb/devices/${usbId}/authorized`, '1')
const deviceOfUuid = async (uuid: string) => (await sh('lsblk -rno NAME,UUID')).split('\n').map(l => l.split(' ')).find(p => p[1] === uuid)?.[0] ?? ''
const builder = () => Object.values(store().instanceDB ?? {}).find((i: any) =>
    String(i.instanceOf).startsWith('kolibri-channel-builder-') && store().diskDB[i.storedOn]?.dockedTo === ENGINE_ID) as any
const nextcloud = () => Object.values(store().instanceDB ?? {}).find((i: any) =>
    store().appDB[i.instanceOf]?.usbMount && String(i.instanceOf).startsWith('nextcloud-') && i.status === 'Running' && store().diskDB[i.storedOn]?.dockedTo === ENGINE_ID) as any

write(`hw-usb-sticks on ${host}: engine ${ENGINE_ID} store ${storeUrl} method=${METHOD} builder=${BUILDER}`)
check((await sh('cat /proc/filesystems')).split('\n').some(l => l.trim().endsWith('exfat')) || !!(await sh('/usr/sbin/modinfo -n exfat 2>/dev/null || ls /lib/modules/$(uname -r)/kernel/fs/exfat 2>/dev/null')), 'kernel exfat driver available (no exfat-fuse)')
check((await sh(`stat -c '%U:%G %a' ${USB_ROOT}`)) === 'pi:pi 755', `${USB_ROOT} is pi:pi 0755 (tmpfiles.d idea-usb.conf)`)

for (const s of sticks) {
    write(`== ${s.name} (${s.fsType})`)
    const exp: StickExpectation = { usbSerial: s.usbSerial, diskSerial: s.diskSerial, uuids: s.uuids, refuseSerials: cfg.refuseSerials ?? [] }
    const r = resolveStick(exp, await collectBlockFacts())
    if (!r.ok) { check(false, `${s.name}: stick identified`, (r as any).reason); continue }
    write(`PASS  ${s.name}: stick ${r.disk} on USB ${r.usbId}`)
    // uuids[1..] are other partitions on the same disk that must stay up (e.g. an Engine
    // disk next to the stick partition): only a partition-level uevent may then be used
    if (s.uuids.length > 1 && METHOD !== 'partition-uevent') { check(false, `${s.name}: shares its disk with ${s.uuids.slice(1).join(', ')}`, 'only --method partition-uevent may be used'); continue }
    const uuid = s.uuids[0]
    let dev = await deviceOfUuid(uuid)
    const stickId = `usb-${uuid}`
    const before = (await sh(`sudo -n sha256sum /dev/${dev} | cut -d' ' -f1`))
    check(/^[0-9a-f]{64}$/.test(before), `${s.name}: image checksum before`, before)

    let off = logOffset()
    await unplug(r.usbId, dev); await waitFor('stick gone', () => !usbSticks().some(x => x.stickId === stickId)); await sleep(2000)
    await plug(r.usbId, dev)
    const seen = await waitFor('Engine.usbSticks entry', () => usbSticks().some(x => x.stickId === stickId))
    check(seen, `${s.name}: in Engine.usbSticks after plug`)
    dev = await deviceOfUuid(uuid)
    const e = usbSticks().find(x => x.stickId === stickId) ?? {}
    check(e.device === dev && e.fsType === s.fsType && e.readOnly === true && String(e.displayName).startsWith('USB: '), `${s.name}: entry fields`, JSON.stringify(e))
    check(e.hasKolibriFolder === s.kolibri, `${s.name}: hasKolibriFolder ${s.kolibri}`)
    const mp = `${USB_ROOT}/${dev}`
    const opts = await sh(`findmnt -n -o FSTYPE,OPTIONS -M ${mp}`)
    check(opts.startsWith(s.fsType) && ['ro', 'nosuid', 'nodev', 'noexec', 'uid=1000'].every(o => opts.split(/[ ,]/).includes(o)), `${s.name}: findmnt ${mp} ro,nosuid,nodev,noexec`, opts)
    for (const [rel, sum] of Object.entries(s.files)) {
        check((await sh(`sha256sum ${JSON.stringify(path.join(mp, rel))} | cut -d' ' -f1`)) === sum, `${s.name}: ${rel} checksum`)
    }
    const w = await $`touch ${mp}/idea-write-test`.nothrow()
    check(w.exitCode !== 0 && /Read-only/i.test(w.stderr), `${s.name}: write as pi refused (read-only)`, w.stderr.trim())
    const json = (() => { try { return JSON.parse(fs.readFileSync(`${USB_ROOT}/.idea-usb.json`, 'utf8')) } catch { return null } })()
    check(!!json?.sticks?.some((x: any) => x.device === dev && x.displayName === e.displayName && x.label === e.label), `${s.name}: .idea-usb.json lists it`)
    check(!Object.values(store().diskDB ?? {}).some((d: any) => d.device === dev && d.dockedTo === ENGINE_ID), `${s.name}: no diskDB entry`)
    {
        const listed = (store().engineDB[ENGINE_ID].unformattedDisks ?? []).some((u: any) => u.device === r.disk)
        const hasExt4 = diskHasExt4(await sh(`lsblk -J -o NAME,FSTYPE /dev/${r.disk}`), r.disk)
        const u = unformattedExpectation(hasExt4, listed)
        check(u.ok, `${s.name}: ${u.label}`, `listed=${listed} ext4=${hasExt4}`)
    }
    const nc = nextcloud()
    if (nc) {
        const ls = await sh(`docker exec ${nc.id}-nextcloud-app-1 ls /mnt/idea-usb/${dev}`)
        check(ls.length > 0, `${s.name}: visible in Nextcloud container at /mnt/idea-usb/${dev}`)
        await waitFor('usb-sync log line', () => /usb-sync\.sh in .* \(plug\) ok/.test(logSince(off)), 30000)
        check(/usb-sync\.sh in .* \(plug\) ok/.test(logSince(off)), `${s.name}: Engine ran usb-sync.sh (plug)`)
    } else info('no Running Nextcloud with x-app.usbMount on this Engine: Nextcloud checks skipped')

    if (BUILDER && s.kolibri) {
        const b = builder()
        if (!b) check(false, `${s.name}: --builder given but no channel builder docked on ${host}`)
        else {
            if (b.status === 'Docked') {
                check(/auto-start: usb stick .* starting channel builder/.test(logSince(off)) || await waitFor('builder Running', () => builder()?.status === 'Running', 180000), `${s.name}: Engine auto-started the Docked builder`)
                await waitFor('builder Running', () => builder()?.status === 'Running', 180000)
                check(builder()?.status === 'Running', `${s.name}: builder Running`)
                check(usbSticks().find(x => x.stickId === stickId)?.builderAutoStart === 'started', `${s.name}: builderAutoStart started`)
            } else info(`builder ${b.id} is ${b.status}, not Docked: auto-start-from-Docked check needs a fresh dock of the builder disk`)
            h.change((doc: any) => { doc.engineDB[ENGINE_ID].commands.push(`stopInstance ${builder().name} ${builder().storedOn}`) })
            await waitFor('builder Stopped', () => builder()?.status === 'Stopped', 120000)
            await unplug(r.usbId, dev); await waitFor('gone', () => !usbSticks().some(x => x.stickId === stickId)); await sleep(2000); await plug(r.usbId, dev)
            await waitFor('back', () => usbSticks().some(x => x.stickId === stickId)); await sleep(5000)
            check(builder()?.status === 'Stopped', `${s.name}: operator-stopped builder stays Stopped on plug`)
            check(usbSticks().find(x => x.stickId === stickId)?.builderAutoStart === 'operatorStopped', `${s.name}: builderAutoStart operatorStopped`)
            dev = await deviceOfUuid(uuid)
        }
    }

    off = logOffset()
    const mp2 = `${USB_ROOT}/${dev}`
    await unplug(r.usbId, dev)
    check(await waitFor('removed from store', () => !usbSticks().some(x => x.stickId === stickId)), `${s.name}: removed from Engine.usbSticks on unplug`)
    await waitFor('mount gone', async () => !(await sh(`findmnt -rn -M ${mp2}`)))
    check(!(await sh(`findmnt -rn -M ${mp2}`)) && !(await sh(`findmnt -rn -S /dev/${dev}`)), `${s.name}: no mount by target or source`)
    check(!fs.existsSync(mp2), `${s.name}: ${mp2} removed`)
    const json2 = (() => { try { return JSON.parse(fs.readFileSync(`${USB_ROOT}/.idea-usb.json`, 'utf8')) } catch { return null } })()
    check(!!json2 && !json2.sticks.some((x: any) => x.device === dev), `${s.name}: gone from .idea-usb.json`)
    await plug(r.usbId, dev)
    await waitFor('re-plugged', async () => !!(await deviceOfUuid(uuid)))
    dev = await deviceOfUuid(uuid)
    await waitFor('mounted again', () => usbSticks().some(x => x.stickId === stickId))
    const after = await sh(`sudo -n sha256sum /dev/${dev} | cut -d' ' -f1`)
    check(after === before, `${s.name}: stick image bit-identical before/after`, `${before} vs ${after}`)
}
finish()
