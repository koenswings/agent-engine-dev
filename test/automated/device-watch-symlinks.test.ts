/**
 * device-watch-symlinks.test.ts
 *
 * Verifies idea#110: the udev watch folder (/dev/engine) watcher does not follow
 * the device symlinks.
 *
 * udev creates /dev/engine/<device> as a symlink to /dev/<device>, which is
 * root:disk 0660. The Engine runs as pi (not in the disk group), so a watcher that
 * follows the links puts an inotify watch on the block device and fails with EACCES.
 *
 *   1. A link to an unreadable target still produces 'add' and 'unlink' events,
 *      without any watcher error
 *   2. Control: following the links does produce the EACCES error (skipped as root,
 *      where file permissions do not apply)
 *   3. enableUsbDeviceMonitor uses watchDeviceFolder (followSymlinks off)
 *
 * Everything runs in a private temp folder: nothing touches /dev/engine or /dev/sd*.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { fs } from 'zx'
import { DEVICE_WATCH_OPTIONS, watchDeviceFolder } from '../../src/monitors/usbDeviceMonitor.js'

const ROOT = process.cwd()
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

/** Collects watcher events until `predicate` holds (or the timeout passes). */
const collect = (watcher: FSWatcher) => {
    const events: { event: string, path: string }[] = []
    const errors: string[] = []
    watcher.on('add', p => events.push({ event: 'add', path: p }))
    watcher.on('unlink', p => events.push({ event: 'unlink', path: p }))
    watcher.on('error', e => errors.push(String((e as Error)?.message ?? e)))
    const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
        const start = Date.now()
        while (!predicate() && Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 50))
        }
    }
    const ready = new Promise<void>(resolve => watcher.on('ready', () => resolve()))
    return { events, errors, waitFor, ready }
}

let tmp: string
let watchDir: string
let target: string
let watcher: FSWatcher | undefined

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-devwatch-'))
    watchDir = path.join(tmp, 'dev-engine')
    await fs.ensureDir(watchDir)
    // Stand-in for /dev/sdX: a file the Engine user cannot read.
    target = path.join(tmp, 'idea-test-1-blockdev')
    await fs.writeFile(target, '')
    await fs.chmod(target, 0o000)
})

afterEach(async () => {
    await watcher?.close()
    watcher = undefined
    await fs.chmod(target, 0o600).catch(() => {})
    await fs.remove(tmp)
})

describe('udev watch folder watcher (idea#110)', () => {
    it('does not follow symlinks', () => {
        expect(DEVICE_WATCH_OPTIONS.followSymlinks).toBe(false)
    })

    it('reports add and unlink of a link to an unreadable target without errors', async () => {
        watcher = watchDeviceFolder(watchDir)
        const c = collect(watcher)
        await c.ready

        const link = path.join(watchDir, 'idea-test-1')
        await fs.symlink(target, link)
        await c.waitFor(() => c.events.some(e => e.event === 'add' && e.path === link))
        expect(c.events).toContainEqual({ event: 'add', path: link })

        await fs.remove(link)
        await c.waitFor(() => c.events.some(e => e.event === 'unlink' && e.path === link))
        expect(c.events).toContainEqual({ event: 'unlink', path: link })

        expect(c.errors).toEqual([])
    })

    it('reports a link that already exists when the watcher starts, without errors', async () => {
        const link = path.join(watchDir, 'idea-test-2')
        await fs.symlink(target, link)

        watcher = watchDeviceFolder(watchDir)
        const c = collect(watcher)
        await c.ready
        await c.waitFor(() => c.events.some(e => e.event === 'add' && e.path === link))
        expect(c.events).toContainEqual({ event: 'add', path: link })
        expect(c.errors).toEqual([])
    })

    it.skipIf(isRoot)('control: following the links hits EACCES on the unreadable target', async () => {
        const link = path.join(watchDir, 'idea-test-3')
        await fs.symlink(target, link)

        watcher = chokidar.watch(watchDir, { persistent: true, followSymlinks: true })
        const c = collect(watcher)
        await c.waitFor(() => c.errors.length > 0)
        expect(c.errors.join('\n')).toMatch(/EACCES/)
    })

    it('enableUsbDeviceMonitor watches the folder with watchDeviceFolder', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/monitors/usbDeviceMonitor.ts'), 'utf8')
        expect(src).toMatch(/const watcher = watchDeviceFolder\(watchDir\)/)
        expect(src.match(/chokidar\.watch\(/g) ?? []).toHaveLength(1)
    })
})
