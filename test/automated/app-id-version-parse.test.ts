/**
 * app-id-version-parse.test.ts
 *
 * wizardly-hugle (main 033f976): `installApp nextcloud-1.0-31.0.1 <disk>` split the
 * app id at the LAST '-', so it cloned app 'nextcloud-1.0' at tag '31.0.1'. Any
 * version containing '-' broke. The catalog is koenswings/app-<name>, tag = <version>
 * (app-nextcloud has tag 1.0-31.0.1).
 * Second bug: createInstance looked its disk up by name only, so neither the disk id
 * nor 'System Disk' (space) could be passed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DocHandle, Repo } from '@automerge/automerge-repo'

const builds: Array<{ appName: string, version: string, device: string }> = []
vi.mock('../../src/data/Instance.js', async (orig) => {
    const real: any = await orig()
    return {
        ...real,
        buildInstance: vi.fn(async (_n: string, appName: string, _g: string, version: string, device: string) => {
            builds.push({ appName, version, device })
        }),
    }
})

const { extractAppName, extractAppVersion } = await import('../../src/data/App.js')
const StoreMod = await import('../../src/data/Store.js')
const { createOrUpdateEngine, localEngineId } = await import('../../src/data/Engine.js')
const { commands } = await import('../../src/data/Commands.js')
const { handleCommand } = await import('../../src/utils/commandUtils.js')

const CASES: Array<[string, string, string]> = [
    ['nextcloud-1.0-31.0.1', 'nextcloud', '1.0-31.0.1'],
    ['kolibri-1.0', 'kolibri', '1.0'],
    ['kiwix-1.0', 'kiwix', '1.0'],
    ['kolibri-1.0-duration', 'kolibri', '1.0-duration'],
    ['kolibri-channel-builder-1.0', 'kolibri-channel-builder', '1.0'],
    ['kolibri-channel-builder-2.1-rc.1', 'kolibri-channel-builder', '2.1-rc.1'],
    ['app-2fa-1.0', 'app-2fa', '1.0'],
    ['kolibri-latest', 'kolibri', 'latest'],
]

describe('app id <name>-<version> parsing', () => {
    for (const [id, name, version] of CASES) {
        it(`${id} -> ${name} / ${version}`, () => {
            expect(extractAppName(id as any)).toBe(name)
            expect(extractAppVersion(id as any)).toBe(version)
            expect(StoreMod.extractAppName(id as any)).toBe(name)
        })
    }
})

const LOCAL = localEngineId as any
const newStore = async (): Promise<DocHandle<any>> => {
    const h = new Repo({ network: [], storage: undefined }).create<any>({
        engineDB: {}, diskDB: {}, appDB: {}, instanceDB: {}, userDB: {}, operationDB: {},
    })
    await h.whenReady()
    await createOrUpdateEngine(h, LOCAL)
    h.change((doc: any) => {
        doc.diskDB['sysdisk01'] = { id: 'sysdisk01', name: 'System Disk', device: 'sda2', dockedTo: LOCAL,
            created: 1, lastDocked: 1, diskTypes: ['system'], backupConfig: null }
    })
    return h
}
const run = async (h: DocHandle<any>, cmd: string) => {
    const log = new Repo({ network: [], storage: undefined }).create<any>({ traces: {}, recentTraceIds: [] })
    await handleCommand(commands, h, 'engine', cmd, log)
}

describe('installApp GitHub route clones app-<name> at tag <version>', () => {
    let h: DocHandle<any>
    beforeEach(async () => { builds.length = 0; process.env.IDEA_INSTALL_FORCE_ONLINE = 'true'; h = await newStore() })
    afterEach(() => { delete process.env.IDEA_INSTALL_FORCE_ONLINE })

    for (const [id, name, version] of CASES.filter(c => c[0] !== 'kolibri-latest')) {
        it(`installApp ${id} sysdisk01 -> buildInstance(${name}, ${version})`, async () => {
            await run(h, `installApp ${id} sysdisk01`)
            expect(builds).toEqual([{ appName: name, version, device: 'sda2' }])
        })
    }
})

describe('createInstance disk argument', () => {
    let h: DocHandle<any>
    let warn: any
    beforeEach(async () => { builds.length = 0; h = await newStore(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
    afterEach(() => warn.mockRestore())

    it('accepts the disk id', async () => {
        await run(h, 'createInstance nextcloud nextcloud koenswings 1.0-31.0.1 sysdisk01')
        expect(builds).toEqual([{ appName: 'nextcloud', version: '1.0-31.0.1', device: 'sda2' }])
    })
    it('accepts the quoted system disk name with a space', async () => {
        await run(h, 'createInstance nextcloud nextcloud koenswings 1.0-31.0.1 "System Disk"')
        expect(builds).toEqual([{ appName: 'nextcloud', version: '1.0-31.0.1', device: 'sda2' }])
    })
})
