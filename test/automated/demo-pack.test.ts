/**
 * demo-pack.test.ts — pack.json validation, sha verify, source selection (engine#369).
 * Network downloads are not exercised (IDEA_NETWORK_TESTS is off; tests mock download).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { fs, path, os } from 'zx'
import {
    parsePackJson, PackVerifyError, verifyExtractedPack, verifyTarSha256, extractPackTar,
    sha256File, pickBestLocalPack, scanIdeaDemoDir, ideaDemoTarName, readAppDemoSpec, spaceNeededBytes,
} from '../../src/data/DemoPack.js'
import { stepPlan } from '../../src/data/DemoApps.js'

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

let tmp: string
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-pack-')) })
afterEach(async () => { await fs.remove(tmp) })

const packDoc = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    packVersion: 4,
    app: 'kolibri',
    minAppVersion: '1.2',
    bytes: 10,
    credits: 'CREDITS.txt',
    hooks: [{ id: 'seed', needs: 'stopped' }, { id: 'classwork', needs: 'running' }],
    files: [{ path: 'CREDITS.txt', sha256: sha('thanks\n'), bytes: Buffer.byteLength('thanks\n') }],
    ...over,
})

describe('parsePackJson', () => {
    it('accepts a schema v1 pack and rejects a bad document as INVALID_PACK', () => {
        const p = parsePackJson(JSON.stringify(packDoc()), 'kolibri')
        expect(p.packVersion).toBe(4)
        expect(p.app).toBe('kolibri')
        expect(p.credits).toBe('CREDITS.txt')
        const bad = (raw: string, re: RegExp) => {
            try { parsePackJson(raw); throw new Error('expected throw') } catch (e) {
                expect(e).toBeInstanceOf(PackVerifyError)
                expect((e as PackVerifyError).code).toBe('INVALID_PACK')
                expect((e as Error).message).toMatch(re)
            }
        }
        bad('{', /INVALID_PACK/)
        bad(JSON.stringify(packDoc({ schemaVersion: 2 })), /schemaVersion/)
        bad(JSON.stringify(packDoc({ app: 'kiwix' })), /kolibri/)
        bad(JSON.stringify(packDoc({ files: [{ path: 'pack.json', sha256: sha('x'), bytes: 1 }] })), /must not list itself/)
        bad(JSON.stringify(packDoc({ credits: '../etc/passwd' })), /safe relative path/)
    })
})

describe('verifyExtractedPack', () => {
    it('requires CREDITS.txt, verifies sha256, and ignores extra files', async () => {
        const root = path.join(tmp, 'x')
        await fs.outputFile(path.join(root, 'CREDITS.txt'), 'thanks\n')
        await fs.outputFile(path.join(root, 'extra.txt'), 'ignored\n')
        await fs.outputFile(path.join(root, 'pack.json'), JSON.stringify(packDoc(), null, 2))
        const p = await verifyExtractedPack(root, 'kolibri', { minVersion: 3 })
        expect(p.packVersion).toBe(4)
    })

    it('CHECKSUM_MISMATCH when a listed file hash is wrong, PACK_OUTDATED when packVersion is low', async () => {
        const root = path.join(tmp, 'bad')
        await fs.outputFile(path.join(root, 'CREDITS.txt'), 'thanks\n')
        const bad = packDoc({ files: [{ path: 'CREDITS.txt', sha256: sha('nope'), bytes: Buffer.byteLength('thanks\n') }] })
        await fs.outputFile(path.join(root, 'pack.json'), JSON.stringify(bad))
        await expect(verifyExtractedPack(root, 'kolibri')).rejects.toThrow(/CHECKSUM_MISMATCH/)

        const oldRoot = path.join(tmp, 'old')
        await fs.outputFile(path.join(oldRoot, 'CREDITS.txt'), 'thanks\n')
        await fs.outputFile(path.join(oldRoot, 'pack.json'), JSON.stringify(packDoc({ packVersion: 1 }), null, 2))
        await expect(verifyExtractedPack(oldRoot, 'kolibri', { minVersion: 3 })).rejects.toThrow(/PACK_OUTDATED/)
    })

    it('INVALID_PACK when the credits file is empty', async () => {
        const root = path.join(tmp, 'empty-credits')
        await fs.outputFile(path.join(root, 'CREDITS.txt'), '   \n')
        const files = [{ path: 'CREDITS.txt', sha256: sha('   \n'), bytes: Buffer.byteLength('   \n') }]
        await fs.outputFile(path.join(root, 'pack.json'), JSON.stringify(packDoc({ files, bytes: Buffer.byteLength('   \n') })))
        await expect(verifyExtractedPack(root, 'kolibri')).rejects.toMatchObject({ code: 'INVALID_PACK', message: expect.stringMatching(/^INVALID_PACK: .*credits file/) })
    })
})

describe('verifyTarSha256 and extractPackTar', () => {
    it('accepts a matching tar and refuses a wrong sha or a .. member', async () => {
        const root = path.join(tmp, 'pkg')
        await fs.outputFile(path.join(root, 'CREDITS.txt'), 'thanks\n')
        await fs.outputFile(path.join(root, 'pack.json'), JSON.stringify(packDoc(), null, 2))
        const tar = path.join(tmp, 'idea-demo-kolibri-v4.tar')
        const { $ } = await import('zx')
        await $`tar -cf ${tar} -C ${root} pack.json CREDITS.txt`
        const digest = await sha256File(tar)
        await verifyTarSha256(tar, digest)
        await expect(verifyTarSha256(tar, '0'.repeat(64))).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' })
        const dest = path.join(tmp, 'extracted')
        await extractPackTar(tar, dest)
        expect(await fs.pathExists(path.join(dest, 'pack.json'))).toBe(true)
    })

    it('INVALID_PACK when a tar member has an unsafe path', async () => {
        const unsafe = path.join(tmp, 'unsafe.tar')
        const py = path.join(tmp, 'mk-unsafe-tar.py')
        await fs.outputFile(py, `import tarfile\nt = tarfile.open(${JSON.stringify(unsafe)}, "w")\ni = tarfile.TarInfo("../evil")\ni.size = 0\nt.addfile(i)\nt.close()\n`)
        const { $ } = await import('zx')
        await $`python3 ${py}`
        await expect(extractPackTar(unsafe, path.join(tmp, 'unsafe-out'))).rejects.toMatchObject({
            code: 'INVALID_PACK',
            message: expect.stringMatching(/^INVALID_PACK: .*unsafe path/),
        })
    })
})

describe('source selection', () => {
    it('scan + pickBestLocalPack: highest packVersion, tie prefers the sha256-pinned tar', async () => {
        const idea = path.join(tmp, 'IDEA-DEMO')
        const dir = path.join(idea, 'kolibri')
        await fs.outputFile(path.join(dir, 'CREDITS.txt'), 'thanks\n')
        await fs.outputFile(path.join(dir, 'pack.json'), JSON.stringify(packDoc({ packVersion: 3 }), null, 2))

        const v4 = path.join(tmp, 'v4root')
        await fs.outputFile(path.join(v4, 'CREDITS.txt'), 'thanks\n')
        await fs.outputFile(path.join(v4, 'pack.json'), JSON.stringify(packDoc({ packVersion: 4 }), null, 2))
        const { $ } = await import('zx')
        const tar = path.join(idea, 'idea-demo-kolibri-v4.tar')
        await $`tar -cf ${tar} -C ${v4} pack.json CREDITS.txt`
        const digest = await sha256File(tar)
        const pin = { file: 'idea-demo-kolibri-v4.tar', url: 'https://example.invalid/idea-demo-kolibri-v4.tar', sha256: digest, bytes: (await fs.stat(tar)).size, minVersion: 3 }
        const found = await scanIdeaDemoDir(idea, 'kolibri', 3, pin)
        expect(found.length).toBeGreaterThanOrEqual(2)
        const best = pickBestLocalPack(found, pin)
        expect(best?.packVersion).toBe(4)
        expect(best?.kind).toBe('tar')
        expect(best?.tarSha256).toBe(digest)
    })

    it('an old FAT32 tree without pack.json is not a usable pack', async () => {
        const idea = path.join(tmp, 'IDEA-DEMO')
        await fs.outputFile(path.join(idea, 'kolibri', 'content.txt'), 'legacy\n')
        const found = await scanIdeaDemoDir(idea, 'kolibri', 0, null)
        expect(found).toEqual([])
        expect(pickBestLocalPack(found, null)).toBeNull()
    })

    it('a nextcloud-only stick is not offered to kolibri; each app picks only its own tar when both are present', async () => {
        expect(ideaDemoTarName('kolibri', 'idea-demo-kolibri-v4.tar')).toBe(4)
        expect(ideaDemoTarName('kolibri', 'idea-demo-nextcloud-v1.tar')).toBeNull()
        expect(ideaDemoTarName('nextcloud', 'idea-demo-nextcloud-v1.tar')).toBe(1)

        const idea = path.join(tmp, 'IDEA-DEMO')
        await fs.ensureDir(idea)
        const { $ } = await import('zx')
        const makeTar = async (app: 'kolibri' | 'nextcloud', ver: number, file: string) => {
            const root = path.join(tmp, `${app}-v${ver}`)
            await fs.outputFile(path.join(root, 'CREDITS.txt'), 'thanks\n')
            await fs.outputFile(path.join(root, 'pack.json'), JSON.stringify(packDoc({ app, packVersion: ver }), null, 2))
            const tar = path.join(idea, file)
            await $`tar -cf ${tar} -C ${root} pack.json CREDITS.txt`
            return tar
        }
        const ncOnly = path.join(idea, 'idea-demo-nextcloud-v1.tar')
        await makeTar('nextcloud', 1, 'idea-demo-nextcloud-v1.tar')
        const kolibriOnNcStick = await scanIdeaDemoDir(idea, 'kolibri', 0, null)
        expect(kolibriOnNcStick).toEqual([])
        expect(pickBestLocalPack(kolibriOnNcStick, null)).toBeNull()
        const nextcloudOnNcStick = await scanIdeaDemoDir(idea, 'nextcloud', 0, null)
        expect(nextcloudOnNcStick).toHaveLength(1)
        expect(nextcloudOnNcStick[0].path).toBe(ncOnly)
        expect(nextcloudOnNcStick[0].packVersion).toBe(1)

        const kTar = await makeTar('kolibri', 4, 'idea-demo-kolibri-v4.tar')
        const kFound = await scanIdeaDemoDir(idea, 'kolibri', 0, null)
        const nFound = await scanIdeaDemoDir(idea, 'nextcloud', 0, null)
        expect(kFound.map(f => path.basename(f.path))).toEqual(['idea-demo-kolibri-v4.tar'])
        expect(nFound.map(f => path.basename(f.path))).toEqual(['idea-demo-nextcloud-v1.tar'])
        expect(pickBestLocalPack(kFound, null)?.path).toBe(kTar)
        expect(pickBestLocalPack(nFound, null)?.path).toBe(ncOnly)
        expect(pickBestLocalPack(kFound, null)?.packVersion).toBe(4)
        expect(pickBestLocalPack(nFound, null)?.packVersion).toBe(1)
    })
})

describe('readAppDemoSpec (Kid app.yaml demo block)', () => {
    it('reads the pin and hook steps from app.yaml', async () => {
        const sha256 = 'e'.repeat(64)
        const yaml = `name: kolibri\nversion: 1.2-0.19.5\ndemo:\n  name: "Kolibri Demo"\n  minEngine: "1.0"\n  pack:\n    file: idea-demo-kolibri-v4.tar\n    url: https://github.com/koenswings/app-kolibri/releases/download/idea-demo-kolibri-v4/idea-demo-kolibri-v4.tar\n    sha256: "${sha256}"\n    bytes: 192430080\n    minVersion: 3\n  reserveBytes: 300000000\n  steps:\n    - { id: seed,      run: demo/hook.sh seed,      needs: stopped, timeoutSec: 1800 }\n    - { id: classwork, run: demo/hook.sh classwork, needs: running, timeoutSec: 600 }\n`
        const dir = path.join(tmp, 'apps', 'kolibri-1.2-0.19.5')
        await fs.outputFile(path.join(dir, 'app.yaml'), yaml)
        const spec = await readAppDemoSpec(dir)
        expect(spec?.name).toBe('Kolibri Demo')
        expect(spec?.minEngine).toBe('1.0')
        expect(spec?.pack?.file).toBe('idea-demo-kolibri-v4.tar')
        expect(spec?.pack?.minVersion).toBe(3)
        expect(spec?.steps.map(s => s.id)).toEqual(['seed', 'classwork'])
        expect(stepPlan(spec)).toEqual(['install', 'download', 'verify', 'seed', 'start', 'ready', 'classwork'])
        expect(stepPlan({
            name: 'Nextcloud Demo', pack: null, reserveBytes: 0,
            steps: [{ id: 'seed', run: 'demo/hook.sh seed', needs: 'running', timeoutSec: 600 }],
        })).toEqual(['install', 'download', 'verify', 'start', 'ready', 'seed'])
    })
})

describe('spaceNeededBytes', () => {
    it('is 2× pack + reserve + 1 GiB', () => {
        expect(spaceNeededBytes([{ packBytes: 100, reserveBytes: 50 }])).toBe(2 * 100 + 50 + 1024 ** 3)
    })
})
