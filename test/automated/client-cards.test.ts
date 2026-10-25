/**
 * client-cards.test.ts — idea#201 §10 client-card Engine API (contract v2, Console #157)
 *
 * Scanner (newDisks / cardReaders / clientCards), client images (SHA verify, current/previous),
 * flashCard / cancelFlash / initialiseDisk with a fake root helper (no device is ever written),
 * Operation.safeToRemove, NOT_EXT4, INTERRUPTED recovery, capabilities, helper argument checks.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import os from 'os'
import crypto from 'crypto'
import { execFileSync, spawnSync } from 'child_process'
import { fs, path } from 'zx'
import { DocHandle, Repo } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { createOrUpdateEngine, localEngineId, engineCapabilities, ENGINE_CAPABILITIES } from '../../src/data/Engine.js'
import { EngineID, DiskID } from '../../src/data/CommonTypes.js'
import {
    scanClientCards, setClientCardOpsForTests, clearClientCardStateForTests, refreshClientCards,
    resetClientCardWriteCacheForTests, classifyContents, usbPathOf, CardLsblkDevice, setClientCardProbes,
} from '../../src/data/ClientCards.js'
import { scanClientImages, setClientImageOpsForTests, resolveImage, parseShaLine } from '../../src/data/ClientImages.js'
import {
    flashCard, cancelFlash, initialiseDisk, setFlashCardOpsForTests, clearFlashStateForTests, parseHelperError, CardError,
} from '../../src/data/FlashCard.js'
import { recoverInterruptedOperations, createOperation, updateOperation } from '../../src/data/Operations.js'
import { setUnformattedOpsForTests, scanUnformattedDisks, clearGeneratedUnformattedIdsForTests, clearCardReaderMemoryForTests, candidateIdFor } from '../../src/data/UnformattedDisks.js'

const LOCAL = localEngineId as EngineID
const newStore = async (): Promise<DocHandle<Store>> => {
    const h = new Repo({ network: [], storage: undefined }).create<Store>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    } as any)
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    return h
}

const GB = 1_000_000_000
const SYS: CardLsblkDevice = { name: 'sda', type: 'disk', size: 500 * GB, rm: false, tran: 'usb', model: 'SSD', serial: 'SYS1',
    children: [{ name: 'sda1', type: 'part', fstype: 'vfat', label: 'bootfs', size: 512e6, mountpoint: '/boot/firmware' },
               { name: 'sda2', type: 'part', fstype: 'ext4', label: 'rootfs', size: 499 * GB, mountpoint: '/' }] }
const RPI_CARD: CardLsblkDevice = { name: 'sdb', type: 'disk', size: 32 * GB, rm: true, tran: 'usb', model: 'STORAGE DEVICE', vendor: 'Generic',
    serial: '000000001206', ptuuid: 'abcd1234',
    children: [{ name: 'sdb1', type: 'part', fstype: 'vfat', label: 'bootfs', size: 512e6 },
               { name: 'sdb2', type: 'part', fstype: 'ext4', label: 'rootfs', size: 31 * GB }] }
const EMPTY_READER: CardLsblkDevice = { name: 'sdc', type: 'disk', size: 0, rm: true, tran: 'usb', model: 'SD Reader', vendor: 'Realtek', serial: 'RDR2' }
const FOREIGN_SSD: CardLsblkDevice = { name: 'sdd', type: 'disk', size: 240 * GB, rm: false, tran: 'usb', model: 'Foreign SSD', serial: 'SSD9',
    children: [{ name: 'sdd1', type: 'part', fstype: 'ext4', label: 'data', size: 240 * GB }] }
const EXFAT_SSD: CardLsblkDevice = { name: 'sde', type: 'disk', size: 120 * GB, rm: false, tran: 'usb', model: 'ExFAT SSD', serial: 'EX1',
    children: [{ name: 'sde1', type: 'part', fstype: 'exfat', label: 'BIG', size: 120 * GB }] }
const IDEA_SSD: CardLsblkDevice = { name: 'sdf', type: 'disk', size: 240 * GB, rm: false, tran: 'usb', model: 'IDEA SSD', serial: 'IDEA1',
    children: [{ name: 'sdf1', type: 'part', fstype: 'ext4', label: 'IDEA Disk', size: 240 * GB, mountpoint: '/disks/sdf1' }] }

let lsblk: CardLsblkDevice[] = []
let lsblkHook: (() => Promise<void>) | null = null
const useDevices = (devs: CardLsblkDevice[], docked: string[] = ['sdf1'], sys: (d: string) => boolean = (d) => d.startsWith('sda')) => {
    lsblk = devs
    lsblkHook = null
    setClientCardOpsForTests({
        lsblkJson: async () => { if (lsblkHook) await lsblkHook(); return JSON.parse(JSON.stringify(lsblk)) },
        byIdLinks: async () => lsblk.filter(d => d.name !== 'sda').map(d => ({ link: `/dev/disk/by-id/usb-${(d.model ?? 'X').replace(/ /g, '_')}_${d.serial}-0:0`, device: d.name })),
        sysfsPath: async (d) => `/sys/devices/platform/scb/fd500000.pcie/pci0000:00/0000:01:00.0/usb1/1-1/1-1.${d.charCodeAt(2) - 96}/1-1.${d.charCodeAt(2) - 96}:1.0/host0/target0:0:0/0:0:0:0/block/${d}`,
        isSystemDevice: async (d) => sys(d),
        dockedDevices: () => new Set(docked),
    })
    setUnformattedOpsForTests({
        lsblkJson: async () => JSON.parse(JSON.stringify(lsblk)) as any,
        hardwareId: async () => undefined,
    })
}

describe('client cards scanner (idea#201 §10)', () => {
    beforeEach(() => { clearClientCardStateForTests(); clearGeneratedUnformattedIdsForTests(); resetClientCardWriteCacheForTests() })
    afterEach(() => { setClientCardOpsForTests(null); setUnformattedOpsForTests(null) })

    it('lists a removable card as a clientCard with its reader; never the system disk or an IDEA disk', async () => {
        useDevices([SYS, RPI_CARD, EMPTY_READER, IDEA_SSD])
        const r = await scanClientCards(undefined, String(LOCAL))
        expect(r.clientCards.map(c => c.device)).toEqual(['sdb'])
        const card = r.clientCards[0]
        expect(card.contents).toEqual({ kind: 'raspios' })
        expect(card.flashable).toBe(true)
        expect(card.refusal).toBeNull()
        expect(card.candidateId).toMatch(/^card-[0-9a-f]{16}$/)
        expect(r.cardReaders).toHaveLength(2)
        const withCard = r.cardReaders.find(x => x.hasMedium)!
        expect(withCard).toMatchObject({ name: 'Generic STORAGE DEVICE', usbPath: '1-1.2', candidateId: card.candidateId })
        expect(card.readerId).toBe(withCard.id)
        expect(r.cardReaders.find(x => !x.hasMedium)).toMatchObject({ candidateId: null, name: 'Realtek SD Reader' })
        expect(r.newDisks).toEqual([])  // decision 6: cards never in newDisks
        expect([...r.clientCards, ...r.newDisks].some((d: any) => d.device === 'sda' || d.device === 'sdf')).toBe(false)
    })

    it('a non-removable disk without META is a newDisk with the unformattedDisks candidateId (one id space)', async () => {
        useDevices([SYS, FOREIGN_SSD, EXFAT_SSD])
        const r = await scanClientCards(undefined, String(LOCAL))
        const unf = await scanUnformattedDisks()
        expect(r.newDisks.map(d => d.device).sort()).toEqual(['sdd', 'sde'])
        const ex = r.newDisks.find(d => d.device === 'sde')!
        expect(unf.find(u => u.device === 'sde')!.candidateId).toBe(ex.candidateId)
        expect(ex).toMatchObject({ removable: false, readerId: null, serial: 'EX1', byId: expect.stringContaining('/dev/disk/by-id/usb-') })
        expect(r.newDisks.find(d => d.device === 'sdd')!.partitions).toEqual([{ label: 'data', fsType: 'ext4', sizeBytes: 240 * GB }])
    })

    it('a mounted card (teacher stick) carries refusal MOUNTED; busy Engine → BUSY; no helper → HELPER_MISSING', async () => {
        const stick: CardLsblkDevice = { ...RPI_CARD, children: [{ name: 'sdb1', type: 'part', fstype: 'vfat', label: 'TEACHER', size: 8 * GB, mountpoint: '/run/idea-usb/sdb1' }] }
        useDevices([stick])
        expect((await scanClientCards(undefined, String(LOCAL))).clientCards[0]).toMatchObject({ flashable: false, refusal: 'MOUNTED' })
        useDevices([RPI_CARD])
        expect((await scanClientCards(undefined, String(LOCAL), { busy: true })).clientCards[0].refusal).toBe('BUSY')
        expect((await scanClientCards(undefined, String(LOCAL), { helperInstalled: false })).clientCards[0].refusal).toBe('HELPER_MISSING')
    })

    it('card id changes when the medium is swapped (same reader serial, other PTUUID)', async () => {
        useDevices([RPI_CARD])
        const a = (await scanClientCards(undefined, String(LOCAL))).clientCards[0].candidateId
        useDevices([{ ...RPI_CARD, ptuuid: 'ffff0000' }])
        const b = (await scanClientCards(undefined, String(LOCAL))).clientCards[0].candidateId
        expect(a).not.toBe(b)
    })

    it('classifies contents read-only from labels', () => {
        expect(classifyContents([], null)).toEqual({ kind: 'empty' })
        expect(classifyContents([{ label: 'system-boot', fsType: 'vfat', sizeBytes: 1 }, { label: 'writable', fsType: 'ext4', sizeBytes: 1 }], null)).toEqual({ kind: 'ubuntu' })
        expect(classifyContents([{ label: 'IDEA-CLIENT-26.04-20261016-f00748e', fsType: 'vfat', sizeBytes: 1 }], null))
            .toEqual({ kind: 'idea-client', imageName: 'IDEA-CLIENT-26.04-20261016-f00748e', version: '26.04-20261016-f00748e' })
        expect(classifyContents([{ label: 'SANDISK', fsType: 'exfat', sizeBytes: 1 }], null)).toEqual({ kind: 'other', summary: "exfat 'SANDISK'" })
        expect(classifyContents([{ label: null, fsType: null, sizeBytes: 1 }], null)).toEqual({ kind: 'unknown' })
        expect(usbPathOf('/sys/devices/x/usb2/2-1/2-1:1.0/host1/block/sdb')).toBe('2-1')
    })

    it('refreshClientCards publishes the contract shapes on the Engine (no device/byId on ClientCard)', async () => {
        const h = await newStore()
        useDevices([SYS, RPI_CARD, EMPTY_READER, FOREIGN_SSD])
        await refreshClientCards(h, LOCAL)
        const e: any = h.doc()!.engineDB[LOCAL]
        expect(Object.keys(e.clientCards[0]).sort()).toEqual(['candidateId', 'contents', 'flashable', 'model', 'readerId', 'refusal', 'sizeBytes'])
        expect(e.cardReaders).toHaveLength(2)
        expect(e.newDisks.map((d: any) => d.device)).toEqual(['sdd'])
        expect(Object.keys(e.newDisks[0]).sort()).toEqual(['byId', 'candidateId', 'contents', 'device', 'firstSeen', 'model', 'mountedReadOnly', 'partitions', 'readerId', 'removable', 'serial', 'sizeBytes'])
    })

    it('no stale BUSY: a slow scan started while busy cannot overwrite the refresh that follows the flash', async () => {
        const h = await newStore()
        useDevices([SYS, RPI_CARD])
        let busy = true
        setClientCardProbes({ busy: () => busy, helperInstalled: () => true })
        try {
            // first (poll) scan is slow and starts while the flash runs
            let release!: () => void
            const gate = new Promise<void>(r => { release = r })
            let first = true
            lsblkHook = async () => { if (first) { first = false; await gate } }
            const poll = refreshClientCards(h, LOCAL)
            await new Promise(r => setTimeout(r, 10))     // the poll has read busy=true and waits in lsblk
            busy = false                                   // flash finished
            const after = refreshClientCards(h, LOCAL)     // end-of-flash refresh
            release()
            await Promise.all([poll, after])
            const card: any = (h.doc()!.engineDB[LOCAL] as any).clientCards[0]
            expect(card.refusal).toBeNull()
            expect(card.flashable).toBe(true)
        } finally {
            setClientCardProbes({ busy: () => false })
        }
    })
})

// ── client images ───────────────────────────────────────────────────────────
const V1 = '26.04-20261015-ab12cd3', V2 = '26.04-20261016-f00748e', V3 = '26.04-20261014-0000001'
let imgRoot = ''
const putImage = async (v: string, content: string, opts: { badSha?: boolean; noSha?: boolean; wrongName?: boolean } = {}) => {
    const dir = path.join(imgRoot, v); await fs.ensureDir(dir)
    const f = path.join(dir, `idea-client-${v}.img.xz`); await fs.writeFile(f, content)
    const sha = crypto.createHash('sha256').update(opts.badSha ? 'other' : content).digest('hex')
    if (!opts.noSha) await fs.writeFile(`${f}.sha256`, `${sha}  ${opts.wrongName ? 'x.img.xz' : `idea-client-${v}.img.xz`}\n`)
    return sha
}

describe('client images (idea#201 §10, idea#202)', () => {
    let hashes = 0
    beforeEach(async () => {
        imgRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cimg-'))
        process.env.IDEA_CLIENT_IMAGES_DIR = imgRoot
        hashes = 0
        setClientImageOpsForTests({
            cacheFile: () => path.join(imgRoot, '.cache.json'),
            uncompressedSize: async () => 4 * GB,
            sha256File: async (f) => { hashes++; return crypto.createHash('sha256').update(await fs.readFile(f)).digest('hex') },
        })
    })
    afterEach(async () => { delete process.env.IDEA_CLIENT_IMAGES_DIR; setClientImageOpsForTests(null); await fs.remove(imgRoot) })

    it('verifies SHA; current = newest verified, previous = next; bad/arriving never offered and never deleted', async () => {
        await putImage(V1, 'one'); await putImage(V2, 'two'); await putImage(V3, 'three', { badSha: true })
        await putImage('26.04-20261017-1111111', 'arriving', { noSha: true })
        await putImage('26.04-20261013-2222222', 'named', { wrongName: true })
        const st = await scanClientImages()
        expect(st.current).toBe(V2)
        expect(st.previous).toBe(V1)
        const by = Object.fromEntries(st.images.map(i => [i.version, i.state]))
        expect(by).toMatchObject({ [V1]: 'verified', [V2]: 'verified', [V3]: 'bad-sha', '26.04-20261017-1111111': 'arriving', '26.04-20261013-2222222': 'bad-sha' })
        expect(fs.existsSync(path.join(imgRoot, V3, `idea-client-${V3}.img.xz`))).toBe(true)
        expect(st.images.find(i => i.version === V2)).toMatchObject({ fileName: `idea-client-${V2}.img.xz`, imageSizeBytes: 4 * GB, source: { type: 'local' } })
        expect(resolveImage(st, 'current')).toMatchObject({ ok: true, image: { version: V2 } })
        expect(resolveImage(st, V3)).toMatchObject({ ok: false, code: 'IMAGE_BAD_SHA' })
        expect(resolveImage(st, '26.04-20990101-abcdef0')).toMatchObject({ ok: false, code: 'IMAGE_NOT_FOUND' })
    })

    it('hashes an image once (cache by size+mtime), again when the file changes', async () => {
        await putImage(V1, 'one')
        await scanClientImages(); await scanClientImages()
        expect(hashes).toBe(1)
        await putImage(V1, 'one-changed')
        const st = await scanClientImages()
        expect(hashes).toBe(2)
        expect(st.current).toBe(V1)
    })

    it('parses sha256sum lines', () => {
        expect(parseShaLine(`${'a'.repeat(64)}  idea-client-x.img.xz\n`)).toEqual({ sha256: 'a'.repeat(64), name: 'idea-client-x.img.xz' })
        expect(parseShaLine('nope')).toBeNull()
    })
})

// ── flashCard / cancelFlash ─────────────────────────────────────────────────
class FakeProc extends EventEmitter {
    stdout = new PassThrough(); stderr = new PassThrough(); killed: string | null = null
    kill(sig: string) { this.killed = sig; return true }
    line(o: unknown) { this.stdout.write(JSON.stringify(o) + '\n') }
    end(code: number, err = '') { if (err) this.stderr.write(err); setTimeout(() => this.emit('close', code), 5) }
}
const IMG = { version: V2, fileName: `idea-client-${V2}.img.xz`, sizeBytes: 4.5 * GB, imageSizeBytes: 9 * GB, sha256: 'b'.repeat(64), state: 'verified' as const, source: { type: 'local' as const }, addedAt: 1 as any }

describe('flashCard / cancelFlash (idea#201 §10)', () => {
    let h: DocHandle<Store>, proc: FakeProc, spawned: any[], logLines: string[], cardId = ''
    beforeEach(async () => {
        clearClientCardStateForTests(); resetClientCardWriteCacheForTests(); clearFlashStateForTests()
        h = await newStore()
        useDevices([SYS, RPI_CARD, FOREIGN_SSD, IDEA_SSD])
        cardId = (await scanClientCards(undefined, String(LOCAL))).clientCards[0].candidateId
        spawned = []; logLines = []
        setFlashCardOpsForTests({
            helperInstalled: () => true,
            spawnHelper: (a) => { spawned.push(a); proc = new FakeProc(); return proc as any },
            images: async () => ({ current: V2, previous: null, images: [IMG] }),
            appendFlashLog: async (l) => { logLines.push(l) },
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async () => ({ ok: true, hasMeta: false, alreadyMounted: false, ignored: false }),
        })
    })
    afterEach(() => { setFlashCardOpsForTests(null); setClientCardOpsForTests(null); setUnformattedOpsForTests(null); clearFlashStateForTests() })

    const op = (id: string) => h.doc()!.operationDB[id] as any
    const code = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e) { return (e as CardError).code ?? String(e) } }

    it('refuses with contract codes before any Operation exists', async () => {
        const size = String(32 * GB)
        expect(await code(flashCard(h, 'card-nope', 'current', size))).toBe('NOT_FOUND')
        // idea#303: a USB SSD is a flash target now; a non-USB disk is not
        lsblk = [...lsblk, { ...FOREIGN_SSD, name: 'sdg', serial: 'SATA1', tran: 'sata' }]
        const sata = (await scanClientCards(undefined, String(LOCAL))).newDisks.find(d => d.device === 'sdg')!.candidateId
        expect(await code(flashCard(h, sata, 'current', size))).toBe('NOT_REMOVABLE')
        expect(await code(flashCard(h, cardId, 'current', String(16 * GB)))).toBe('SIZE_CHANGED')
        expect(await code(flashCard(h, cardId, '26.04-20990101-abcdef0', size))).toBe('IMAGE_NOT_FOUND')
        expect(await code(flashCard(h, cardId, 'current', 'abc'))).toBe('BAD_ARGS')
        setFlashCardOpsForTests({ helperInstalled: () => false, images: async () => ({ current: V2, previous: null, images: [IMG] }) })
        expect(await code(flashCard(h, cardId, 'current', size))).toBe('HELPER_MISSING')
        setFlashCardOpsForTests({ helperInstalled: () => true, images: async () => ({ current: V2, previous: null, images: [{ ...IMG, imageSizeBytes: 64 * GB }] }) })
        expect(await code(flashCard(h, cardId, 'current', size))).toBe('IMAGE_TOO_LARGE')
        expect(Object.keys(h.doc()!.operationDB)).toHaveLength(0)
        expect(spawned).toHaveLength(0)
    })

    it('never flashes the system disk even if it were listed as a card', async () => {
        useDevices([{ ...SYS, rm: true, model: 'SD Card Reader' }, RPI_CARD], ['sdf1'], () => false)  // scanner fooled
        const sysCard = (await scanClientCards(undefined, String(LOCAL))).clientCards.find(c => c.device === 'sda')
        expect(sysCard).toBeDefined()
        expect(await code(flashCard(h, sysCard!.candidateId, 'current', String(500 * GB)))).toMatch(/SYSTEM_DISK|MOUNTED/)
        expect(spawned).toHaveLength(0)
    })

    it('runs the helper with the re-resolvable by-id, steps → Operation, Done with safeToRemove true; log line', async () => {
        const { operationId, done } = await flashCard(h, cardId, 'current', String(32 * GB))
        expect(spawned[0]).toEqual({ byId: '/dev/disk/by-id/usb-STORAGE_DEVICE_000000001206-0:0', device: 'sdb', sizeBytes: 32 * GB,
            image: path.join(process.env.IDEA_CLIENT_IMAGES_DIR || '/var/lib/idea/client-images', V2, `idea-client-${V2}.img.xz`), sha256: IMG.sha256, osRootfsPartitions: [] })
        expect(op(operationId)).toMatchObject({ kind: 'flashCard', status: 'Running', subject: { type: 'disk', id: cardId },
            args: { candidateId: cardId, version: V2, confirmSizeBytes: String(32 * GB) }, cause: 'console-command' })
        expect((h.doc()!.engineDB[LOCAL] as any).flashInProgress).toMatchObject({ operationId, candidateId: cardId, version: V2 })
        proc.line({ step: 'writing', bytes: 0, total: 100 })
        await new Promise(r => setTimeout(r, 5))
        expect(op(operationId)).toMatchObject({ stepLabel: 'writing', currentStep: 2, totalSteps: 6 })
        proc.line({ step: 'writing', bytes: 2, total: 100 }); proc.line({ step: 'writing', bytes: 12, total: 100 })
        await new Promise(r => setTimeout(r, 5))
        expect(op(operationId).progressPercent).toBe(12)  // stored in 5 % steps (not a progress-only patch)
        proc.line({ result: 'ok', bytesWritten: 9 * GB, sha256: 'c'.repeat(64), readBackSha256: 'c'.repeat(64), safeToRemove: true })
        proc.end(0)
        const res = await done
        expect(res).toMatchObject({ candidateId: cardId, version: V2, bytesWritten: 9 * GB, safeToRemove: true })
        expect(op(operationId)).toMatchObject({ status: 'Done', safeToRemove: true, error: null })
        expect((h.doc()!.engineDB[LOCAL] as any).flashInProgress).toBeNull()
        expect(JSON.parse(logLines[0])).toMatchObject({ result: 'ok', version: V2, device: 'sdb' })
    })

    it('power-off failure: Done, safeToRemove false, POWER_OFF_FAILED in the message', async () => {
        const { operationId, done } = await flashCard(h, cardId, V2, String(32 * GB))
        proc.line({ result: 'ok', bytesWritten: 1, sha256: 'c'.repeat(64), readBackSha256: 'c'.repeat(64), safeToRemove: false }); proc.end(0)
        await done
        expect(op(operationId)).toMatchObject({ status: 'Done', safeToRemove: false })
        expect(op(operationId).error).toMatch(/^POWER_OFF_FAILED: /)
    })

    it('helper refusal / failure → Failed "CODE: text"', async () => {
        const { operationId, done } = await flashCard(h, cardId, V2, String(32 * GB))
        proc.end(2, 'refused: MEDIUM_SWAPPED: /dev/disk/by-id/usb-x no longer resolves to /dev/sdb\n')
        expect(await done).toBeNull()
        expect(op(operationId)).toMatchObject({ status: 'Failed', safeToRemove: false })
        expect(op(operationId).error).toMatch(/^MEDIUM_SWAPPED: /)
        expect(parseHelperError('x\nfailed: VERIFY_FAILED: read-back differs')).toEqual({ code: 'VERIFY_FAILED', text: 'read-back differs' })
        expect(parseHelperError('garbage').code).toBe('WRITE_FAILED')
    })

    it('one flash at a time: a second flashCard while one runs is BUSY', async () => {
        const { done } = await flashCard(h, cardId, V2, String(32 * GB))
        expect(await code(flashCard(h, cardId, V2, String(32 * GB)))).toBe('BUSY')
        proc.end(3, 'failed: WRITE_FAILED: io'); await done
    })

    it('cancelFlash during writing → SIGTERM, Failed "CANCELLED: ..." (no Cancelled status)', async () => {
        const { operationId, done } = await flashCard(h, cardId, V2, String(32 * GB))
        proc.line({ step: 'writing', bytes: 10, total: 100 }); await new Promise(r => setTimeout(r, 5))
        cancelFlash(h, operationId)
        expect(proc.killed).toBe('SIGTERM')
        proc.end(3, 'failed: CANCELLED: flash cancelled\n')
        await done
        expect(op(operationId).status).toBe('Failed')
        expect(op(operationId).error).toMatch(/^CANCELLED: /)
    })

    it('cancelFlash is refused once the write is done (reading-back) and for unknown ids', async () => {
        const { operationId, done } = await flashCard(h, cardId, V2, String(32 * GB))
        proc.line({ step: 'reading-back', bytes: 0, total: 100 }); await new Promise(r => setTimeout(r, 5))
        expect(() => cancelFlash(h, operationId)).toThrow(/^BUSY: /)
        expect(() => cancelFlash(h, 'nope')).toThrow(/^NOT_FOUND: /)
        expect(proc.killed).toBeNull()
        proc.end(3, 'failed: VERIFY_FAILED: x'); await done
    })

    it('an interrupted flash is failed INTERRUPTED with safeToRemove false at startup (never retried)', async () => {
        const id = createOperation(h, 'flashCard', { candidateId: cardId, version: V2, confirmSizeBytes: '1' }, 'console-command', { type: 'disk', id: cardId })
        updateOperation(h, id, { status: 'Running' })
        await recoverInterruptedOperations(h, {})
        expect(op(id)).toMatchObject({ status: 'Failed', safeToRemove: false })
        expect(op(id).error).toMatch(/^INTERRUPTED: /)
    })
})

// ── initialiseDisk ──────────────────────────────────────────────────────────
describe('initialiseDisk (idea#201 §10, NOT_EXT4)', () => {
    let h: DocHandle<Store>, written: { part: string; yaml: string }[], added: string[], mounted: string[], hasMeta = false
    beforeEach(async () => {
        clearClientCardStateForTests(); resetClientCardWriteCacheForTests(); clearFlashStateForTests(); clearGeneratedUnformattedIdsForTests()
        h = await newStore()
        useDevices([SYS, RPI_CARD, FOREIGN_SSD, EXFAT_SSD])
        written = []; added = []; mounted = []; hasMeta = false
        setFlashCardOpsForTests({
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async () => ({ ok: true, hasMeta, alreadyMounted: false }),
            mountRw: async (p) => { mounted.push(p); return { ok: true, alreadyMounted: false, fsUuid: null } },
            writeMeta: async (part, yaml) => { written.push({ part, yaml }) },
            addDevice: async (p) => {
                added.push(p)
                const id = /diskId: (\S+)/.exec(written[written.length - 1].yaml)![1]
                h.change(d => { (d.diskDB as any)[id] = { id, name: 'IDEA Disk', device: p, dockedTo: LOCAL, diskTypes: [] } })
            },
            createFilesDisk: async () => undefined,
            createBackupDisk: async () => undefined,
        })
    })
    afterEach(() => { setFlashCardOpsForTests(null); setClientCardOpsForTests(null); setUnformattedOpsForTests(null) })
    const idOf = async (dev: string) => (await scanClientCards(undefined, String(LOCAL))).newDisks.find(d => d.device === dev)!.candidateId
    const code = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e) { return (e as CardError).code ?? String(e) } }

    it('ro look, rw mount and META.yaml only then; registers the disk; Operation Done', async () => {
        const id = await idOf('sdd')
        const r = await initialiseDisk(h, id, 'empty')
        expect(mounted).toEqual(['sdd1'])
        expect(written[0].part).toBe('sdd1')
        expect(written[0].yaml).toMatch(/diskName: IDEA Disk/)
        expect(added).toEqual(['sdd1'])
        expect(h.doc()!.diskDB[r.diskId as DiskID]).toBeDefined()
        expect(h.doc()!.operationDB[r.operationId]).toMatchObject({ kind: 'initialiseDisk', status: 'Done', args: { candidateId: id, role: 'empty' }, subject: { type: 'disk', id } })
    })

    it('NOT_EXT4 for a non-ext4 new disk (also listed in unformattedDisks with the same id); nothing mounted or written', async () => {
        const { refreshUnformattedDisks } = await import('../../src/data/UnformattedDisks.js')
        await refreshUnformattedDisks(h, LOCAL)
        const id = await idOf('sde')
        expect((h.doc()!.engineDB[LOCAL] as any).unformattedDisks.map((u: any) => u.candidateId)).toContain(id)
        expect(await code(initialiseDisk(h, id))).toBe('NOT_EXT4')
        expect(mounted).toEqual([]); expect(written).toEqual([])
    })

    it('ALREADY_IDEA when the ro look finds META.yaml: never mounted rw, nothing written', async () => {
        hasMeta = true
        expect(await code(initialiseDisk(h, await idOf('sdd')))).toBe('ALREADY_IDEA')
        expect(mounted).toEqual([]); expect(written).toEqual([])
    })

    it('refuses cards, unknown ids and bad roles', async () => {
        const card = (await scanClientCards(undefined, String(LOCAL))).clientCards[0].candidateId
        expect(await code(initialiseDisk(h, card))).toBe('NOT_FOUND')
        expect(await code(initialiseDisk(h, 'nope'))).toBe('NOT_FOUND')
        expect(await code(initialiseDisk(h, await idOf('sdd'), 'weird'))).toBe('BAD_ARGS')
        expect(written).toEqual([])
    })
})

describe('capabilities + helper script (idea#201 §10)', () => {
    it('clientCards and clientImages always; flashCard only with the helper installed', () => {
        expect(ENGINE_CAPABILITIES).toContain('clientCards')
        expect(ENGINE_CAPABILITIES).toContain('clientImages')
        expect(ENGINE_CAPABILITIES).toContain('unknownDiskReadOnly')
        expect(engineCapabilities(true)).toContain('flashCard')
        expect(engineCapabilities(false)).not.toContain('flashCard')
    })

    const HELPER = path.resolve(process.cwd(), 'script/build_image_assets/idea-flash-card')
    const run = (args: string[]) => spawnSync('bash', [HELPER, ...args], { encoding: 'utf8' })

    it('helper parses (bash -n) and reports its version', () => {
        execFileSync('bash', ['-n', HELPER])
        expect(run(['--version']).stdout.trim()).toBe('idea-flash-card 2')
    })

    it('helper refuses bad arguments before touching any device (exit 2, BAD_ARGS)', () => {
        const ok = ['--by-id', '/dev/disk/by-id/usb-Generic_X-0:0', '--expect-device', 'sdz', '--expect-size', '100',
            '--image', `/var/lib/idea/client-images/${V2}/idea-client-${V2}.img.xz`, '--sha256', 'a'.repeat(64)]
        const withArg = (k: string, v: string) => { const a = [...ok]; a[a.indexOf(k) + 1] = v; return a }
        for (const a of [withArg('--by-id', '/dev/sdb'), withArg('--by-id', '/dev/disk/by-id/usb-X-0:0-part1'), withArg('--expect-device', 'mmcblk0'),
                         withArg('--expect-size', '0'), withArg('--sha256', 'xyz'), withArg('--image', '/tmp/evil.img.xz'),
                         withArg('--image', `/var/lib/idea/client-images/${V1}/idea-client-${V2}.img.xz`)]) {
            const r = run(a)
            expect(r.status).toBe(2)
            expect(r.stderr).toMatch(/^refused: BAD_ARGS: /)
        }
        // valid args but no such by-id link → NOT_FOUND, still before any write
        const r = run(ok)
        expect(r.status).toBe(2)
        expect(r.stderr).toMatch(/^refused: NOT_FOUND: /)
    })

    it('sudoers allows the helper (validated by itself)', async () => {
        const s = await fs.readFile(path.resolve(process.cwd(), 'script/build_image_assets/11-engine-files.sudoers'), 'utf8')
        expect(s).toMatch(/^pi ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/idea-flash-card$/m)
    })
})

// ── idea#303: disk roles (one candidate per physical disk, allowed actions) ─
describe('disk roles: USB disks get both roles, SD cards flash only (idea#303)', () => {
    const STICK: CardLsblkDevice = { name: 'sdh', type: 'disk', size: 64 * GB, rm: true, tran: 'usb', model: 'Flash Drive FIT', vendor: 'Samsung', serial: 'FIT303',
        children: [{ name: 'sdh1', type: 'part', fstype: 'exfat', label: 'SAMSUNG', size: 64 * GB }] }
    const EXT4_STICK: CardLsblkDevice = { ...STICK, name: 'sdi', serial: 'FIT304', children: [{ name: 'sdi1', type: 'part', fstype: 'ext4', label: 'old', size: 64 * GB }] }
    let h: DocHandle<Store>, spawned: any[]
    beforeEach(async () => {
        clearClientCardStateForTests(); clearGeneratedUnformattedIdsForTests(); resetClientCardWriteCacheForTests(); clearFlashStateForTests(); clearCardReaderMemoryForTests()
        h = await newStore()
        spawned = []
        setFlashCardOpsForTests({
            helperInstalled: () => true,
            spawnHelper: (a) => { spawned.push(a); return new FakeProc() as any },
            images: async () => ({ current: V2, previous: null, images: [IMG] }),
            appendFlashLog: async () => {},
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async () => ({ ok: true, hasMeta: false, alreadyMounted: false, ignored: false }),
        })
    })
    afterEach(() => { setFlashCardOpsForTests(null); setClientCardOpsForTests(null); setUnformattedOpsForTests(null); clearFlashStateForTests() })
    const code = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e) { return (e as CardError).code ?? String(e) } }

    it('one candidate per physical disk with its actions; same candidateId across the legacy lists', async () => {
        useDevices([SYS, RPI_CARD, STICK, EXT4_STICK, FOREIGN_SSD, EXFAT_SSD, IDEA_SSD])
        const r = await scanClientCards(undefined, String(LOCAL))
        const by = (dev: string) => r.diskCandidates!.find(c => c.device === dev)
        expect(r.diskCandidates!.map(c => c.device).sort()).toEqual(['sdb', 'sdd', 'sde', 'sdh', 'sdi'])   // never sda (system) or sdf (docked IDEA)
        expect(by('sdb')).toMatchObject({ kind: 'sdCard', actions: ['flash'], removable: true })
        expect(by('sdh')).toMatchObject({ kind: 'usbDisk', actions: ['erase', 'flash'], removable: true, readerId: null, flashRefusal: null })
        expect(by('sdi')).toMatchObject({ kind: 'usbDisk', actions: ['initialise', 'flash'] })
        expect(by('sdd')).toMatchObject({ kind: 'usbDisk', actions: ['initialise', 'flash'], removable: false })
        expect(by('sde')).toMatchObject({ kind: 'usbDisk', actions: ['erase', 'flash'] })
        // legacy lists: SD card only in clientCards; USB disks in newDisks AND clientCards with one id
        expect(r.newDisks.map(d => d.device).sort()).toEqual(['sdd', 'sde', 'sdh', 'sdi'])
        expect(r.clientCards.map(c => c.device).sort()).toEqual(['sdb', 'sdd', 'sde', 'sdh', 'sdi'])
        for (const dev of ['sdd', 'sde', 'sdh', 'sdi']) {
            expect(r.clientCards.find(c => c.device === dev)!.candidateId).toBe(r.newDisks.find(d => d.device === dev)!.candidateId)
            expect(by(dev)!.candidateId).toBe(r.newDisks.find(d => d.device === dev)!.candidateId)
        }
        expect(r.cardReaders.map(x => x.candidateId)).toEqual([by('sdb')!.candidateId])   // a stick is not a card reader
        const unf = await scanUnformattedDisks()
        expect(unf.map(u => u.device).sort()).toEqual(['sde', 'sdh'])                  // sticks without ext4 get Erase too; never the SD card
        expect(unf.find(u => u.device === 'sdh')!.candidateId).toBe(by('sdh')!.candidateId)
    })

    it('card reader vs stick: reader-like model, or seen without a medium, stays an SD card', async () => {
        const generic: CardLsblkDevice = { ...STICK, name: 'sdj', serial: 'GEN1', model: 'USB DISK 3.0', vendor: 'Generic', size: 0, children: [] }
        useDevices([generic])
        expect((await scanClientCards(undefined, String(LOCAL))).diskCandidates).toEqual([])   // empty reader
        lsblk = [{ ...generic, size: 32 * GB, children: [{ name: 'sdj1', type: 'part', fstype: 'vfat', label: 'bootfs', size: 1 * GB }] }]
        expect((await scanClientCards(undefined, String(LOCAL))).diskCandidates!.map(c => [c.kind, c.actions])).toEqual([['sdCard', ['flash']]])
        clearCardReaderMemoryForTests()
        expect((await scanClientCards(undefined, String(LOCAL))).diskCandidates!.map(c => c.kind)).toEqual(['usbDisk'])
    })

    it('SSD flash target: the helper gets the SSD by-id (usb-*), size and image', async () => {
        useDevices([SYS, FOREIGN_SSD])
        const ssd = (await scanClientCards(undefined, String(LOCAL))).diskCandidates!.find(c => c.device === 'sdd')!
        const { done } = await flashCard(h, ssd.candidateId, 'current', String(240 * GB))
        expect(spawned).toHaveLength(1)
        expect(spawned[0]).toMatchObject({ byId: expect.stringMatching(/^\/dev\/disk\/by-id\/usb-/), device: 'sdd', sizeBytes: 240 * GB, sha256: IMG.sha256 })
        void done
    })

    it('refuses a docked IDEA SSD, a mounted USB disk and the system disk; nothing is spawned', async () => {
        useDevices([SYS, IDEA_SSD, { ...STICK, children: [{ name: 'sdh1', type: 'part', fstype: 'exfat', label: 'T', size: 64 * GB, mountpoint: '/run/idea-usb/sdh1' }] }])
        const r = await scanClientCards(undefined, String(LOCAL))
        expect(r.diskCandidates!.some(c => c.device === 'sdf' || c.device === 'sda')).toBe(false)
        expect(r.clientCards.some(c => c.device === 'sdf' || c.device === 'sda')).toBe(false)
        const idea = await candidateIdFor('sdf', 'IDEA1')
        expect(await code(flashCard(h, idea.candidateId, 'current', String(240 * GB)))).toBe('NOT_FOUND')
        const stick = r.diskCandidates!.find(c => c.device === 'sdh')!
        expect(stick.flashRefusal).toBe('MOUNTED')
        expect(await code(flashCard(h, stick.candidateId, 'current', String(64 * GB)))).toBe('MOUNTED')
        expect(spawned).toHaveLength(0)
    })

    it('reader first seen WITH a card in it: a reader-like model is an SD card at once (flash only)', async () => {
        const reader: CardLsblkDevice = { name: 'sdm', type: 'disk', size: 16 * GB, rm: true, tran: 'usb', model: 'SD/MMC', vendor: 'Generic', serial: 'RDR9',
            children: [{ name: 'sdm1', type: 'part', fstype: 'vfat', label: 'bootfs', size: 1 * GB }] }
        useDevices([reader])
        const r = await scanClientCards(undefined, String(LOCAL))
        expect(r.diskCandidates!.map(c => [c.kind, c.actions])).toEqual([['sdCard', ['flash']]])
        expect(r.newDisks).toEqual([])
        expect(await scanUnformattedDisks()).toEqual([])
    })

    it('empty reader that gets a card later: remembered from size 0, the card is an SD card (flash only)', async () => {
        const empty: CardLsblkDevice = { name: 'sdn', type: 'disk', size: 0, rm: true, tran: 'usb', model: 'USB3.0 CRW', vendor: 'Generic', serial: 'CRW1' }
        useDevices([empty])
        const r0 = await scanClientCards(undefined, String(LOCAL))
        expect(r0.diskCandidates).toEqual([])
        expect(r0.cardReaders.map(x => x.hasMedium)).toEqual([false])
        lsblk = [{ ...empty, size: 32 * GB, children: [{ name: 'sdn1', type: 'part', fstype: 'exfat', label: 'X', size: 32 * GB }] }]
        const r1 = await scanClientCards(undefined, String(LOCAL))
        expect(r1.diskCandidates!.map(c => [c.kind, c.actions])).toEqual([['sdCard', ['flash']]])
        expect((await scanUnformattedDisks()).map(u => u.device)).toEqual([])   // no Erase for an SD card
    })

    it('old Engine stick (OS rootfs + META.yaml, the "anna" case) is flashable: not HAS_IDEA_META, helper told --os-rootfs', async () => {
        const anna: CardLsblkDevice = { name: 'sdk', type: 'disk', size: 64 * GB, rm: true, tran: 'usb', model: 'Flash Drive', vendor: 'Samsung', serial: 'ANNA1',
            children: [{ name: 'sdk1', type: 'part', fstype: 'vfat', label: 'bootfs', size: 512e6 },
                       { name: 'sdk2', type: 'part', fstype: 'ext4', label: 'rootfs', size: 63 * GB }] }
        useDevices([SYS, anna])
        const looked: string[] = []
        setFlashCardOpsForTests({
            helperInstalled: () => true,
            spawnHelper: (a) => { spawned.push(a); return new FakeProc() as any },
            images: async () => ({ current: V2, previous: null, images: [IMG] }),
            appendFlashLog: async () => {},
            isSystemDevice: async (d) => d.startsWith('sda'),
            // what lookForIdeaMeta returns for an OS rootfs (hasOsRootfsLayout matched; META.yaml not counted)
            lookForMeta: async (p) => { looked.push(p); return p === 'sdk2' ? { ok: true, hasMeta: false, alreadyMounted: false, ignored: false, osRootfs: true } : { ok: true, hasMeta: false, alreadyMounted: false, ignored: false } },
        })
        const c = (await scanClientCards(undefined, String(LOCAL))).diskCandidates!.find(x => x.device === 'sdk')!
        expect(c).toMatchObject({ kind: 'usbDisk', flashRefusal: null })
        expect(c.actions).toContain('flash')
        expect(await code(flashCard(h, c.candidateId, 'current', String(64 * GB)))).toBe('OK')
        expect(looked).toEqual(['sdk2'])                      // only ext4 partitions 1/2 are looked at
        expect(spawned[0].osRootfsPartitions).toEqual(['sdk2'])
    })

    it('a real App/Files/Backup disk (META.yaml, no OS rootfs) that is not docked: helper gets no --os-rootfs, so it refuses HAS_IDEA_META', async () => {
        const app: CardLsblkDevice = { name: 'sdl', type: 'disk', size: 240 * GB, rm: false, tran: 'usb', model: 'App SSD', serial: 'APP1',
            children: [{ name: 'sdl1', type: 'part', fstype: 'ext4', label: 'IDEA Disk', size: 240 * GB }] }
        useDevices([SYS, app], [])
        setFlashCardOpsForTests({
            helperInstalled: () => true,
            spawnHelper: (a) => { spawned.push(a); return new FakeProc() as any },
            images: async () => ({ current: V2, previous: null, images: [IMG] }),
            appendFlashLog: async () => {},
            isSystemDevice: async (d) => d.startsWith('sda'),
            lookForMeta: async () => ({ ok: true, hasMeta: true, alreadyMounted: false, ignored: false }),
        })
        const c = (await scanClientCards(undefined, String(LOCAL))).diskCandidates!.find(x => x.device === 'sdl')!
        await code(flashCard(h, c.candidateId, 'current', String(240 * GB)))
        expect(spawned[0].osRootfsPartitions).toEqual([])
        expect(spawned[0].byId).toMatch(/^\/dev\/disk\/by-id\/usb-/)
    })

    it('helper META check (the real bash block): META.yaml refused unless that partition is named --os-rootfs', () => {
        const helper = fs.readFileSync(path.join(process.cwd(), 'script/build_image_assets/idea-flash-card'), 'utf8')
        const block = helper.slice(helper.indexOf('# >>> meta-check'), helper.indexOf('# <<< meta-check'))
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-check-'))
        fs.writeFileSync(path.join(dir, 'lsblk'), '#!/bin/bash\nprintf "sdz\\nsdz1 vfat\\nsdz2 ext4\\nsdz3 ext4\\n"\n', { mode: 0o755 })
        // debugfs stub: META.yaml exists on the partitions listed in $META_ON
        fs.writeFileSync(path.join(dir, 'debugfs'), '#!/bin/bash\nfor m in $META_ON; do [[ "${@: -1}" == "/dev/$m" ]] && echo "Inode: 12"; done; exit 0\n', { mode: 0o755 })
        const run = (metaOn: string, rootfs: string[]) => spawnSync('bash', ['-c',
            `refuse() { echo "refused: $1: $2" >&2; exit 2; }; DEVPATH=/dev/sdz; OSROOTFS=(${rootfs.join(' ')})\n${block}\necho PASSED`],
            { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, META_ON: metaOn } })
        expect(run('', []).stdout).toContain('PASSED')                                     // no META anywhere
        expect(run('sdz2', []).stderr).toMatch(/^refused: HAS_IDEA_META: \/dev\/sdz2/)   // App/Files/Backup disk
        expect(run('sdz2', ['sdz2']).stdout).toContain('PASSED')                         // anna: OS rootfs + META
        expect(run('sdz3', ['sdz2']).stderr).toMatch(/^refused: HAS_IDEA_META: \/dev\/sdz3/)   // META elsewhere still refused
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('helper: --os-rootfs must be partition 1 or 2 of the target device', () => {
        const HELPER = path.resolve(process.cwd(), 'script/build_image_assets/idea-flash-card')
        const base = ['--by-id', '/dev/disk/by-id/usb-Generic_X-0:0', '--expect-device', 'sdz', '--expect-size', '100',
            '--image', `/var/lib/idea/client-images/${V2}/idea-client-${V2}.img.xz`, '--sha256', 'a'.repeat(64)]
        for (const bad of ['sdy2', 'sdz3', 'sdz', '../x']) {
            const r = spawnSync('bash', [HELPER, ...base, '--os-rootfs', bad], { encoding: 'utf8' })
            expect(r.status).toBe(2)
            expect(r.stderr).toMatch(/^refused: BAD_ARGS: os-rootfs/)
        }
    })

    it('helper: accepts removable=1 or tran=usb, everything else unchanged', () => {
        const helper = fs.readFileSync(path.join(process.cwd(), 'script/build_image_assets/idea-flash-card'), 'utf8')
        expect(helper).toContain('[[ "$rm_flag" == "1" || "$tran" == "usb" ]] || refuse NOT_REMOVABLE')
        expect(helper).toContain('by-id must be /dev/disk/by-id/usb-...')
        expect(helper).toContain('refuse SYSTEM_DISK')
        expect(helper).toContain('refuse HAS_IDEA_META')
    })
})
