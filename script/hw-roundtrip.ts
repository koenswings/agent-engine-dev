#!/usr/bin/env -S npx tsx
/**
 * hw-roundtrip.ts — on-Pi hardware round-trip test for disk PRs (idea#152)
 *
 * Runs ON a Pi against a running Engine and checks, on real hardware:
 *   1. The Pi's system disk (the drive backing / and /boot/firmware) is never
 *      ejectable: its store record carries diskTypes 'system', so it fails the
 *      Console eject-button rule, and `ejectDisk` by id AND by name is refused
 *      (trace status 'error') while / and /boot/firmware stay mounted.
 *   2. For every partition of one USB test disk, per cycle:
 *        eject (`ejectDisk <diskId>` through the store command queue, the same
 *        path the Console uses) → store undocked, device null, no unmountError;
 *        no mount by source or target; /disks/<dev> gone
 *        → simulated unplug + re-plug of the USB device (sysfs)
 *        → the same udev remove/add events and Engine log lines as a real
 *          re-plug → every partition docked exactly once again, with the same
 *          disk id, META.yaml id kept, one mount by source and target.
 *
 * Usage (on the Pi, from any Engine checkout with node_modules):
 *   npx tsx script/hw-roundtrip.ts [options]
 *     --engine-dir <path>   Engine checkout the running Engine uses (store-identity/,
 *                           default: this checkout)
 *     --port <n>            Engine WebSocket port (default 4321)
 *     --engine-log <file>   Engine stdout log to check (default ~/.pm2/logs/engine-out.log)
 *     --device <sdX>        USB test disk (default: the only non-system USB disk)
 *     --cycles <n>          eject + re-plug cycles (default 2)
 *     --method <m>          unplug simulation: unbind (default) | authorized
 *     --timeout <s>         per-step timeout in seconds (default 60)
 *
 * Root: only the unplug simulation (a write to /sys/bus/usb/...) needs root.
 * It runs as `sudo -n tee <sysfs file>` with the tester's own sudo; it is NOT
 * in the Engine sudoers. Refuses to run on idea02 (golden) and refuses any USB
 * device that is, or sits above, the device of the system drive.
 *
 * Exit code 0 only when every check passes. Log: test/testresults/hw-roundtrip-<UTC yyyy-mm-dd-hhmmss>.log
 */

import { Repo, DocumentId } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { $, fs, sleep } from 'zx'
import os from 'os'
import path from 'path'
import { spawn, ChildProcess } from 'child_process'
import { fileURLToPath } from 'url'

$.verbose = false

// ── Options ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name: string, def: string): string => {
    const i = argv.indexOf(`--${name}`)
    return i !== -1 && argv[i + 1] ? argv[i + 1] : def
}
const ENGINE_DIR = path.resolve(opt('engine-dir', ROOT))
const PORT = opt('port', '4321')
const ENGINE_LOG = opt('engine-log', path.join(os.homedir(), '.pm2/logs/engine-out.log'))
const CYCLES = parseInt(opt('cycles', '2'), 10)
const METHOD = opt('method', 'unbind')
const TIMEOUT_MS = parseInt(opt('timeout', '60'), 10) * 1000
let DEVICE = opt('device', '')

// ── Log ─────────────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '')
const LOG_DIR = path.join(ROOT, 'test', 'testresults')
fs.mkdirpSync(LOG_DIR)
const LOG_FILE = path.join(LOG_DIR, `hw-roundtrip-${stamp}.log`)
const failures: string[] = []
let passes = 0
const write = (line: string) => {
    const l = `${new Date().toISOString()} ${line}`
    process.stdout.write(l + '\n')
    fs.appendFileSync(LOG_FILE, l + '\n')
}
const info = (m: string) => write(`      ${m}`)
const check = (ok: boolean, what: string, detail = ''): boolean => {
    if (ok) { passes++; write(`PASS  ${what}`) }
    else { failures.push(what + (detail ? ` — ${detail}` : '')); write(`FAIL  ${what}${detail ? ` — ${detail}` : ''}`) }
    return ok
}
const abort = (m: string): never => {
    write(`ABORT ${m}`)
    finish(2)
    throw new Error(m)
}

// ── Shell helpers ───────────────────────────────────────────────────────────

const sh = async (cmd: string): Promise<string> => {
    const r = await $`bash -c ${cmd}`.nothrow()
    return r.stdout.trim()
}
const mountsBySource = async (dev: string) => (await sh(`findmnt -rn -S /dev/${dev} -o TARGET`)).split('\n').filter(Boolean)
const mountsByTarget = async (target: string) => (await sh(`findmnt -rn -M ${target} -o SOURCE`)).split('\n').filter(Boolean)
const sourceOf = async (target: string) => sh(`findmnt -n -o SOURCE ${target}`)
const parentOf = async (dev: string) => sh(`lsblk -no PKNAME /dev/${dev.replace('/dev/', '')} | head -1`)
const partitionsOf = async (disk: string) =>
    (await sh(`lsblk -rno NAME,TYPE /dev/${disk}`)).split('\n').map(l => l.split(' ')).filter(p => p[1] === 'part').map(p => p[0])
const uuidOf = async (dev: string) => sh(`lsblk -no UUID /dev/${dev}`)
const deviceByUuid = async (uuid: string) =>
    (await sh(`lsblk -rno NAME,UUID`)).split('\n').map(l => l.split(' ')).find(p => p[1] === uuid)?.[0] ?? null

/** sysfs path of a block device's USB device, e.g. /sys/devices/.../usb4/4-1; null if not USB */
const usbDevicePath = async (disk: string): Promise<string | null> => {
    const real = await sh(`readlink -f /sys/block/${disk}`)
    const parts = real.split('/')
    let last = -1
    parts.forEach((p, i) => { if (/^\d+-[\d.]+$/.test(p)) last = i })
    return last === -1 ? null : parts.slice(0, last + 1).join('/')
}

const waitFor = async (what: string, fn: () => Promise<boolean>, timeout = TIMEOUT_MS): Promise<boolean> => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
        if (await fn()) return true
        await sleep(500)
    }
    info(`timed out after ${timeout / 1000}s waiting for: ${what}`)
    return false
}

// ── Guards ──────────────────────────────────────────────────────────────────

if (os.hostname() === 'idea02') abort('refusing to run on idea02 (golden Pi)')
if (!['unbind', 'authorized'].includes(METHOD)) abort(`unknown --method ${METHOD}`)

const rootSource = await sourceOf('/')
const bootSource = await sourceOf('/boot/firmware')
const systemDisks = new Set<string>()
for (const src of [rootSource, bootSource].filter(s => s.startsWith('/dev/'))) {
    const p = await parentOf(src)
    systemDisks.add(p || src.replace('/dev/', ''))
}
const systemUsb = new Set<string>()
for (const d of systemDisks) { const u = await usbDevicePath(d); if (u) systemUsb.add(u) }

write(`hw-roundtrip on ${os.hostname()}: engine-dir=${ENGINE_DIR} port=${PORT} log=${ENGINE_LOG} cycles=${CYCLES} method=${METHOD}`)
info(`system drive: root=${rootSource} boot=${bootSource || '(none)'} disks=${[...systemDisks].join(',')} usb=${[...systemUsb].join(',') || '(not USB)'}`)

if (!DEVICE) {
    const disks = (await sh(`lsblk -dno NAME,TRAN`)).split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[1] === 'usb' && !systemDisks.has(p[0])).map(p => p[0])
    if (disks.length !== 1) abort(`need exactly one non-system USB disk, found: ${disks.join(',') || 'none'} (pass --device)`)
    DEVICE = disks[0]
}
if (systemDisks.has(DEVICE)) abort(`${DEVICE} is the system drive`)
const usbPath = await usbDevicePath(DEVICE)
if (!usbPath) abort(`${DEVICE} is not a USB device`)
for (const s of systemUsb) {
    if (s === usbPath || s.startsWith(usbPath + '/')) abort(`${DEVICE}'s USB device ${usbPath} is (or is above) the system drive's USB device ${s}`)
}
const usbId = path.basename(usbPath!)
info(`test disk ${DEVICE} on USB device ${usbId} (${usbPath})`)

// ── Store ───────────────────────────────────────────────────────────────────

const storeUrl = fs.readFileSync(path.join(ENGINE_DIR, 'store-identity', 'store-url.txt'), 'utf8').trim()
const logUrl = fs.readFileSync(path.join(ENGINE_DIR, 'store-identity', 'command-log-url.txt'), 'utf8').trim()
const repo = new Repo({ network: [new WebSocketClientAdapter(`ws://127.0.0.1:${PORT}`)] })
const storeHandle = await repo.find<any>(storeUrl.replace('automerge:', '') as DocumentId)
await storeHandle.whenReady()
const logHandle = await repo.find<any>(logUrl.replace('automerge:', '') as DocumentId)
await logHandle.whenReady()
await sleep(1500)
const store = () => storeHandle.doc() as any
const localEngine = Object.values(store().engineDB ?? {}).find((e: any) => e.hostname === os.hostname()) as any
if (!localEngine) abort(`no engine with hostname ${os.hostname()} in store ${storeUrl}`)
const ENGINE_ID = localEngine.id as string
info(`store ${storeUrl}, engine ${ENGINE_ID}`)

const disks = (): any[] => Object.values(store().diskDB ?? {})
const dockedOn = (dev: string) => disks().filter(d => d.device === dev && d.dockedTo === ENGINE_ID)

/** Same path as the Console: append a command string to engineDB[<engine>].commands */
const sendEject = (arg: string): number => {
    const t0 = Date.now()
    storeHandle.change((doc: any) => { doc.engineDB[ENGINE_ID].commands.push(`ejectDisk ${arg}`) })
    return t0
}
const waitTrace = async (arg: string, t0: number): Promise<any | null> => {
    let found: any = null
    await waitFor(`ejectDisk ${arg} trace`, async () => {
        const traces = Object.values((logHandle.doc() as any)?.traces ?? {}) as any[]
        found = traces.find(t => t.command === 'ejectDisk' && t.startedAt >= t0 - 2000
            && (() => { try { return JSON.parse(t.args).diskId === arg } catch { return false } })()
            && t.status !== 'running' && t.completedAt) ?? null
        return !!found
    }, 30000)
    return found
}

/**
 * The Console's eject-button rule this test assumes: Console #124 (ed2a823)
 * `device !== null && !diskTypes.includes('backup')` plus the system-disk gate
 * `!diskTypes.includes('system')` (idea#152). Checked against the marker the
 * Engine writes.
 */
const consoleCanEject = (d: any): boolean =>
    d.device !== null && !(d.diskTypes ?? []).includes('backup') && !(d.diskTypes ?? []).includes('system')
const console124CanEject = (d: any): boolean => d.device !== null && !(d.diskTypes ?? []).includes('backup')

// ── Engine log + udev capture ───────────────────────────────────────────────

const logOffset = (): number => { try { return fs.statSync(ENGINE_LOG).size } catch { return -1 } }
const logSince = (off: number): string => {
    if (off < 0) return ''
    const fd = fs.openSync(ENGINE_LOG, 'r')
    const size = fs.fstatSync(fd).size
    const buf = Buffer.alloc(Math.max(0, size - off))
    fs.readSync(fd, buf, 0, buf.length, off)
    fs.closeSync(fd)
    return buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '')
}
let udevLines: string[] = []
let udev: ChildProcess | null = null
const startUdev = () => {
    udevLines = []
    udev = spawn('stdbuf', ['-oL', 'udevadm', 'monitor', '--udev', '--subsystem-match=block'])
    udev.stdout?.on('data', (b: Buffer) => udevLines.push(...b.toString().split('\n').filter(Boolean)))
}
const stopUdev = () => { udev?.kill(); udev = null }
const udevSaw = (action: 'add' | 'remove', dev: string) =>
    udevLines.some(l => l.includes(` ${action} `) && l.endsWith(`/block/${DEVICE}/${dev} (block)`) || l.includes(` ${action} `) && dev === DEVICE && l.endsWith(`/block/${dev} (block)`))

// ── Unplug simulation ───────────────────────────────────────────────────────

let unplugged = false
const sysWrite = async (file: string, value: string) => {
    const r = await $`echo ${value} | sudo -n tee ${file}`.nothrow()
    if (r.exitCode !== 0) throw new Error(`sudo tee ${file} failed: ${r.stderr.trim()}`)
}
const unplug = async () => {
    unplugged = true
    if (METHOD === 'unbind') await sysWrite('/sys/bus/usb/drivers/usb/unbind', usbId)
    else await sysWrite(`/sys/bus/usb/devices/${usbId}/authorized`, '0')
}
const plug = async () => {
    if (METHOD === 'unbind') await sysWrite('/sys/bus/usb/drivers/usb/bind', usbId)
    else await sysWrite(`/sys/bus/usb/devices/${usbId}/authorized`, '1')
    unplugged = false
}

let finished = false
function finish(code?: number) {
    if (finished) return
    finished = true
    stopUdev()
    const result = code ?? (failures.length ? 1 : 0)
    write(`RESULT ${result === 0 ? 'PASS' : 'FAIL'}: ${passes} passed, ${failures.length} failed`)
    failures.forEach(f => write(`  failed: ${f}`))
    write(`log: ${LOG_FILE}`)
    process.exitCode = result
}

// ── 1. System disk ──────────────────────────────────────────────────────────

const systemChecks = async (when: string) => {
    write(`== system disk checks (${when})`)
    const sysDevs = new Set<string>()
    for (const d of systemDisks) (await partitionsOf(d)).forEach(p => sysDevs.add(p))
    const sysRecords = disks().filter(d => d.dockedTo === ENGINE_ID && d.device && sysDevs.has(d.device))
    info(`system drive records docked here: ${sysRecords.map(d => `${d.id} '${d.name}' ${d.device} [${(d.diskTypes ?? []).join(',')}]`).join('; ') || 'none'}`)
    for (const d of sysRecords) {
        check((d.diskTypes ?? []).includes('system'), `system record ${d.id} (${d.device}) carries diskTypes 'system'`, `diskTypes=${JSON.stringify(d.diskTypes)}`)
        check(!consoleCanEject(d), `system record ${d.id} fails the Console eject rule (Console #124 rule + 'system' gate)`)
        if (console124CanEject(d)) info(`note: the unchanged Console #124 rule would still show eject for ${d.id}; the Console needs the 'system' gate`)
    }
    const rootRec = sysRecords.find(d => `/dev/${d.device}` === rootSource)
    if (!rootRec) { info('no docked system disk record (IDEA_SYSTEM_DISK_SKIP?) — eject refusal checks skipped'); return }
    // By name first, then by id: each attempt must find the record docked and be
    // refused as the system disk (not as "not docked" after an earlier eject)
    for (const arg of [rootRec.name, rootRec.id]) {
        const before = store().diskDB[rootRec.id]
        check(before?.dockedTo === ENGINE_ID && before?.device === rootRec.device, `system record ${rootRec.id} docked before ejectDisk ${arg}`)
        const t0 = sendEject(arg)
        const trace = await waitTrace(arg, t0)
        check(!!trace && trace.status === 'error' && /system disk/.test(trace.errorMessage ?? ''),
            `ejectDisk ${arg} (system disk) is refused as the system disk, trace status 'error'`,
            trace ? `status=${trace.status} error=${trace.errorMessage} logs=${JSON.stringify(trace.logs?.map((l: any) => l.message))}` : 'no trace')
        await sleep(1000)
        check(await sourceOf('/') === rootSource, `/ still mounted from ${rootSource} after ejectDisk ${arg}`)
        if (bootSource) check(await sourceOf('/boot/firmware') === bootSource, `/boot/firmware still mounted from ${bootSource} after ejectDisk ${arg}`)
        const now = store().diskDB[rootRec.id]
        check(now?.dockedTo === ENGINE_ID && now?.device === rootRec.device, `system record ${rootRec.id} still docked on ${rootRec.device} after ejectDisk ${arg}`,
            `dockedTo=${now?.dockedTo} device=${now?.device}`)
    }
}

// ── 2. Round trip ───────────────────────────────────────────────────────────

interface Part { dev: string, uuid: string, diskId: string, name: string, metaId: string }

const metaIdOf = async (dev: string) => (await sh(`grep -E '^diskId:' /disks/${dev}/META.yaml | head -1 | sed 's/^diskId:[[:space:]]*//'`)).replace(/['"]/g, '')

const checkDocked = async (parts: Part[], when: string) => {
    for (const p of parts) {
        const recs = dockedOn(p.dev)
        check(recs.length === 1, `${when}: exactly one docked store record on ${p.dev}`, `found ${recs.map(r => r.id).join(',') || 'none'}`)
        check(recs[0]?.id === p.diskId, `${when}: ${p.dev} docked with the same disk id ${p.diskId}`, `got ${recs[0]?.id}`)
        check(!recs[0]?.unmountError, `${when}: ${p.dev} has no unmountError`)
        const bySrc = await mountsBySource(p.dev)
        const byTgt = await mountsByTarget(`/disks/${p.dev}`)
        check(bySrc.length === 1 && bySrc[0] === `/disks/${p.dev}`, `${when}: one mount of /dev/${p.dev} (by source)`, `got ${JSON.stringify(bySrc)}`)
        check(byTgt.length === 1 && byTgt[0] === `/dev/${p.dev}`, `${when}: one mount on /disks/${p.dev} (by target)`, `got ${JSON.stringify(byTgt)}`)
        check(await metaIdOf(p.dev) === p.metaId, `${when}: META.yaml id on ${p.dev} kept (${p.metaId})`)
    }
}

const roundTrip = async () => {
    const devs = await partitionsOf(DEVICE)
    const parts: Part[] = []
    for (const dev of devs) {
        const recs = dockedOn(dev)
        if (recs.length !== 1) { check(false, `start: exactly one docked record on ${dev}`, `found ${recs.length}`); continue }
        parts.push({ dev, uuid: await uuidOf(dev), diskId: recs[0].id, name: recs[0].name, metaId: await metaIdOf(dev) })
    }
    if (parts.length === 0) abort(`no docked partitions on ${DEVICE}; dock the test disk first`)
    info(`partitions: ${parts.map(p => `${p.dev} '${p.name}' ${p.diskId} uuid=${p.uuid} meta=${p.metaId}`).join('; ')}`)
    await checkDocked(parts, 'start')

    for (let c = 1; c <= CYCLES; c++) {
        write(`== cycle ${c}/${CYCLES}`)
        for (const p of parts) {
            const t0 = sendEject(p.diskId)
            const trace = await waitTrace(p.diskId, t0)
            check(!!trace && trace.status === 'ok', `cycle ${c}: ejectDisk ${p.diskId} (${p.name}) trace ok`, trace ? `status=${trace.status} ${trace.errorMessage ?? ''}` : 'no trace')
            const rec = store().diskDB[p.diskId]
            check(rec?.dockedTo === null && rec?.device === null, `cycle ${c}: ${p.diskId} undocked in the store (dockedTo, device null)`, `dockedTo=${rec?.dockedTo} device=${rec?.device}`)
            check(!rec?.unmountError, `cycle ${c}: ${p.diskId} has no unmountError`, JSON.stringify(rec?.unmountError))
            check((await mountsBySource(p.dev)).length === 0, `cycle ${c}: no mount of /dev/${p.dev} after eject`)
            check((await mountsByTarget(`/disks/${p.dev}`)).length === 0, `cycle ${c}: nothing mounted on /disks/${p.dev} after eject`)
            check(!fs.existsSync(`/disks/${p.dev}`), `cycle ${c}: /disks/${p.dev} removed after eject`)
        }

        let off = logOffset()
        startUdev()
        await sleep(500)
        info(`unplug: ${METHOD === 'unbind' ? 'unbind' : 'authorized=0'} ${usbId}`)
        await unplug()
        check(await waitFor(`/dev/${DEVICE} gone`, async () => !fs.existsSync(`/dev/${DEVICE}`)), `cycle ${c}: /dev/${DEVICE} gone after unplug`)
        await sleep(3000)
        const removedLog = logSince(off)
        for (const d of [...parts.map(p => p.dev), DEVICE]) {
            check(udevSaw('remove', d), `cycle ${c}: udev 'remove' for ${d}`)
            if (off >= 0) check(removedLog.includes(`Processing the removal of USB device ${d}`), `cycle ${c}: Engine logged the removal of ${d}`)
        }
        off = logOffset()
        udevLines = []
        info(`re-plug: ${METHOD === 'unbind' ? 'bind' : 'authorized=1'} ${usbId}`)
        await plug()
        const back = await waitFor('all partitions back and docked', async () => {
            for (const p of parts) {
                const dev = await deviceByUuid(p.uuid)
                if (!dev) return false
                p.dev = dev
                if (dockedOn(dev).length === 0 || (await mountsBySource(dev)).length === 0) return false
            }
            return true
        })
        check(back, `cycle ${c}: every partition re-docked after re-plug`, parts.map(p => `${p.name}: ${dockedOn(p.dev).map(r => r.id).join(',') || 'not docked'}`).join('; '))
        await sleep(3000)   // let any late dock-time dedupe or undock happen before checking
        stopUdev()
        const addedLog = logSince(off)
        for (const d of [...parts.map(p => p.dev)]) {
            check(udevSaw('add', d), `cycle ${c}: udev 'add' for ${d}`)
            if (off >= 0) check(addedLog.includes(`A disk on device /dev/engine/${d} has been added`), `cycle ${c}: Engine logged the add of ${d}`)
        }
        await checkDocked(parts, `cycle ${c} after re-plug`)
        const u = udevLines.length ? '' : ' (no udev lines captured)'
        info(`udev events captured this cycle${u}`)
    }
}

try {
    await systemChecks('before')
    await roundTrip()
    await systemChecks('after')
} catch (e) {
    if (!finished) { failures.push(`exception: ${e instanceof Error ? e.message : String(e)}`); write(`ERROR ${e}`) }
} finally {
    if (unplugged) {
        write(`re-plugging ${usbId} after an error`)
        await plug().catch(e => write(`could not re-plug ${usbId}: ${e}`))
    }
    finish()
    await sleep(500)
    process.exit(process.exitCode ?? 0)
}
