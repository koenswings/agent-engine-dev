/**
 * restore-app-files.test.ts (#189): restore onto another disk also puts the app
 * master and the service image tars on the target, from the previous disk first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('../../src/utils/rsync.js', async (orig) => ({ ...(await orig<any>()), rsyncDirectory: vi.fn(async (a: string, b: string) => { const { fs } = await import('zx'); await fs.copy(a, b) }) }))
import { fs } from 'zx'
import { disksRoot } from '../../src/data/Config.js'
import { setRootDeviceForTests } from '../../src/data/Disk.js'
import { ensureAppFilesOnTarget, serviceTarName } from '../../src/data/RestoreAppFiles.js'

const disk = (id: string, device: string) => ({ id, name: id, device, dockedTo: 'E', diskTypes: ['app'] }) as any
const PREV = disk('DISK_prev', 'idea-test-81'), OTHER = disk('DISK_other', 'idea-test-82'), TGT = disk('DISK_tgt', 'idea-test-83')
const root = (d: any) => `${disksRoot()}/${d.device}`
const IMG = 'koenswings/kolibri:1.0-0.15.5-dev'

describe('ensureAppFilesOnTarget (#189)', () => {
    beforeEach(async () => {
        setRootDeviceForTests('mmcblk-not-a-test-disk')
        for (const d of [PREV, OTHER, TGT]) { await fs.remove(root(d)); await fs.ensureDir(root(d)) }
    })
    afterEach(async () => { setRootDeviceForTests(null); for (const d of [PREV, OTHER, TGT]) await fs.remove(root(d)) })

    it('copies apps/<appId> and the service tar from the previous disk', async () => {
        await fs.outputFile(`${root(PREV)}/apps/kolibri-1.0/compose.yaml`, 'prev')
        await fs.outputFile(`${root(PREV)}/services/${serviceTarName(IMG)}`, 'tar')
        const r = await ensureAppFilesOnTarget('kolibri-1.0', [IMG], TGT, [PREV, OTHER])
        expect(await fs.readFile(`${root(TGT)}/apps/kolibri-1.0/compose.yaml`, 'utf8')).toBe('prev')
        expect(await fs.readFile(`${root(TGT)}/services/koenswings_kolibri:1.0-0.15.5-dev.tar`, 'utf8')).toBe('tar')
        expect(r.servicesCopied).toEqual(['koenswings_kolibri:1.0-0.15.5-dev.tar'])
    })

    it('falls back to another docked disk; prefers the previous one', async () => {
        await fs.outputFile(`${root(OTHER)}/apps/kolibri-1.0/compose.yaml`, 'other')
        await fs.outputFile(`${root(OTHER)}/services/${serviceTarName(IMG)}`, 'o')
        expect((await ensureAppFilesOnTarget('kolibri-1.0', [IMG], TGT, [PREV, OTHER])).appMasterFrom).toContain('idea-test-82')
    })

    it('leaves files already on the target alone and reports missing pieces without throwing', async () => {
        await fs.outputFile(`${root(TGT)}/apps/kolibri-1.0/compose.yaml`, 'mine')
        await fs.outputFile(`${root(PREV)}/apps/kolibri-1.0/compose.yaml`, 'prev')
        const r = await ensureAppFilesOnTarget('kolibri-1.0', [IMG], TGT, [PREV])
        expect(await fs.readFile(`${root(TGT)}/apps/kolibri-1.0/compose.yaml`, 'utf8')).toBe('mine')
        expect(r.servicesMissing).toEqual(['koenswings_kolibri:1.0-0.15.5-dev.tar'])
    })

    it('restore onto the same disk it came from: nothing to copy', async () => {
        const r = await ensureAppFilesOnTarget('kolibri-1.0', [], TGT, [TGT])
        expect(r).toEqual({ appMasterFrom: null, servicesCopied: [], servicesMissing: [] })
    })
})
