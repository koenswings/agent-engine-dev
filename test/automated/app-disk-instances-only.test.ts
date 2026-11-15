/**
 * app-disk-instances-only.test.ts
 *
 * engine#427: a disk with `instances/<id>` but no `apps/` (a restore target, or a
 * Backup Disk that also hosts an instance) is an App Disk, so the dock pass
 * processes its instances and a restarted Engine does not leave them Starting.
 *
 * Runs in private test-device folders under the harness disks root.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { fs } from 'zx'
import { isAppDisk, hasInstanceFolders, Disk } from '../../src/data/Disk.js'
import { uniqueTestDevice, diskPath, cleanupDisk } from '../harness/diskSim.js'

const diskOn = (device: string): Disk => ({ id: `d-${device}`, device } as unknown as Disk)

describe('isAppDisk counts instances without apps/ (engine#427)', () => {
    const used: string[] = []
    const fresh = async (): Promise<string> => {
        const device = uniqueTestDevice()
        used.push(device)
        await fs.ensureDir(diskPath(device))
        return device
    }
    afterEach(async () => {
        while (used.length) await cleanupDisk(used.pop())
    })

    it('an apps/ folder still makes an App Disk', async () => {
        const device = await fresh()
        await fs.ensureDir(`${diskPath(device)}/apps`)
        expect(await isAppDisk(diskOn(device))).toBe(true)
    })

    it('instances/<id> without apps/ is an App Disk (the restore-target case)', async () => {
        const device = await fresh()
        await fs.ensureDir(`${diskPath(device)}/instances/nextcloud-abc`)
        await fs.writeFile(`${diskPath(device)}/BACKUP.yaml`, 'mode: on-demand\nlinks: []\n')
        expect(await isAppDisk(diskOn(device))).toBe(true)
    })

    it('an empty instances/, hidden entries only, or a plain file is not', async () => {
        const device = await fresh()
        await fs.ensureDir(`${diskPath(device)}/instances/.quarantine`)
        await fs.writeFile(`${diskPath(device)}/instances/README`, 'x')
        expect(await hasInstanceFolders(`${diskPath(device)}/instances`)).toBe(false)
        expect(await isAppDisk(diskOn(device))).toBe(false)
    })

    it('a disk with only a backups/ folder, or a blank disk, is not', async () => {
        const device = await fresh()
        await fs.ensureDir(`${diskPath(device)}/backups/x`)
        expect(await isAppDisk(diskOn(device))).toBe(false)
    })

    it('an apps file (not a folder) does not count', async () => {
        const device = await fresh()
        await fs.writeFile(`${diskPath(device)}/apps`, '')
        expect(await isAppDisk(diskOn(device))).toBe(false)
    })
})
