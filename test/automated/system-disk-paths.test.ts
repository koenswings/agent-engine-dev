/**
 * system-disk-paths.test.ts — absolute paths under a disk's mount root (idea#237).
 *
 * diskMountRoot / deviceMountRoot return '' for the system disk, which is right
 * for template strings (`${root}/instances` → /instances) but path.join('', …) is
 * RELATIVE. joinMountRoot / diskPath always give an absolute path.
 */
import { describe, it, afterEach, expect } from 'vitest'
import path from 'path'
import { Disk, diskMountRoot, diskPath, joinMountRoot, setRootDeviceForTests } from '../../src/data/Disk.js'
import { disksRoot } from '../../src/data/Config.js'

const disk = (device: string) => ({ id: `d-${device}`, device }) as unknown as Disk

describe('joinMountRoot / diskPath (idea#237)', () => {
    afterEach(() => setRootDeviceForTests(null))

    it('system disk: /instances/<id>, absolute; diskMountRoot itself stays ""', async () => {
        setRootDeviceForTests('nvme0n1p2')
        const sys = disk('nvme0n1p2')
        expect(await diskMountRoot(sys)).toBe('')                       // template-string callers rely on ''
        expect(path.join(await diskMountRoot(sys), 'instances', 'i1')).toBe('instances/i1')   // the bug
        const p = await diskPath(sys, 'instances', 'i1')
        expect(path.isAbsolute(p)).toBe(true)
        expect(p).toBe('/instances/i1')
        expect(await diskPath(sys, 'apps')).toBe('/apps')
        expect(await diskPath(sys, 'instances', 'i1', 'compose.yaml')).toBe('/instances/i1/compose.yaml')
        expect(joinMountRoot('', 'files')).toBe('/files')
        expect(joinMountRoot('', 'BACKUP.yaml')).toBe('/BACKUP.yaml')
    })

    it('regular disk: <disksRoot>/<device>/… unchanged', async () => {
        setRootDeviceForTests('nvme0n1p2')
        const app = disk('sdb1')
        expect(await diskMountRoot(app)).toBe(`${disksRoot()}/sdb1`)
        expect(await diskPath(app, 'instances', 'i1')).toBe(path.join(disksRoot(), 'sdb1', 'instances', 'i1'))
        expect(path.isAbsolute(await diskPath(app, 'apps'))).toBe(true)
        expect(joinMountRoot(`${disksRoot()}/sdb1`, 'files')).toBe(path.join(disksRoot(), 'sdb1', 'files'))
    })
})
