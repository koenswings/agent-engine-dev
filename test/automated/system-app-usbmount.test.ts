/**
 * processSystemApp (system-disk apps under /apps/<appId>) must read the same x-app
 * fields as createOrUpdateApp, in particular x-app.usbMount (idea#193 §4), on both
 * create and update. Before the fix only filesMount was read, so system-disk apps
 * (wh's Nextcloud and channel builder) never got the /run/idea-usb bind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import { fs, path, YAML } from 'zx'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { processSystemApp } from '../../src/data/Disk.js'
import { buildOverride, NEXTCLOUD_USB_SYNC } from '../../src/data/FilesMount.js'
import { createTestStore } from '../harness/diskSim.js'

const APP = 'nextcloud-1.0-31.0.1'
const USB_BIND = { type: 'bind', source: '/run/idea-usb', target: '/mnt/idea-usb', read_only: true, bind: { create_host_path: false, propagation: 'rslave' } }

const writeCompose = async (root: string, xapp: any) => {
    await fs.mkdirp(path.join(root, APP))
    await fs.writeFile(path.join(root, APP, 'compose.yaml'), YAML.stringify({ services: { 'nextcloud-app': { image: 'nextcloud:31' } }, 'x-app': xapp }))
}
const baseXapp = { title: 'Nextcloud', description: 'Files', url: 'https://nextcloud.com', category: 'productivity', icon: 'nc.png', author: 'Kid', filesMount: { path: '/mnt/idea-files', services: ['nextcloud-app'] } }
const usbXapp = { ...baseXapp, usbMount: { path: '/mnt/idea-usb', services: ['nextcloud-app'] } }
const disk = { id: 'sysdisk' } as any

const overrideVolumes = (h: DocHandle<Store>) => {
    const app: any = h.doc().appDB[APP as any]
    expect(app.usbMount).toBeTruthy()
    const { yaml } = buildOverride(app.filesMount, [], '', { usbMount: app.usbMount, hostRoot: '/run/idea-usb' })
    return YAML.parse(yaml).services['nextcloud-app'].volumes
}

describe('processSystemApp reads x-app like createOrUpdateApp', () => {
    let h: DocHandle<Store>
    let root: string
    beforeEach(async () => {
        h = (await createTestStore()).storeHandle
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'sysapps-'))
    })
    afterEach(async () => { await fs.remove(root) })

    it('create: x-app.usbMount is stored and produces the ro rslave bind at /mnt/idea-usb', async () => {
        await writeCompose(root, usbXapp)
        const app = await processSystemApp(h, disk, APP as any, root)
        expect(app?.usbMount).toEqual({ path: '/mnt/idea-usb', services: ['nextcloud-app'], sync: { ...NEXTCLOUD_USB_SYNC } })
        expect(overrideVolumes(h)).toContainEqual(USB_BIND)
    })

    it('update: an existing record without usbMount gets it from the compose and produces the bind', async () => {
        await writeCompose(root, baseXapp)
        await processSystemApp(h, disk, APP as any, root)
        expect(h.doc().appDB[APP as any].usbMount ?? null).toBe(null)
        await writeCompose(root, usbXapp)
        await processSystemApp(h, disk, APP as any, root)
        expect(overrideVolumes(h)).toContainEqual(USB_BIND)
    })

    it('update: usbMount removed from the compose clears it; other x-app fields refresh too', async () => {
        await writeCompose(root, usbXapp)
        await processSystemApp(h, disk, APP as any, root)
        await writeCompose(root, { ...baseXapp, title: 'Nextcloud 2', description: null, icon: 'nc2.png', category: 'files', author: null, url: null })
        await processSystemApp(h, disk, APP as any, root)
        const app: any = h.doc().appDB[APP as any]
        expect(app.usbMount).toBe(null)
        expect(app.title).toBe('Nextcloud 2')
        expect(app.icon).toBe('nc2.png')
        expect(app.category).toBe('files')
        expect(app.description).toBe(null)
        expect(app.url).toBe(null)
        expect(app.author).toBe(null)
    })
})
