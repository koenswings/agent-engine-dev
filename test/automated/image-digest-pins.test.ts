/**
 * image-digest-pins.test.ts (koenswings/idea#322)
 *
 * Load-then-start with digest-pinned service images: pull by the full ref, save by repo:tag,
 * verify the pinned digest after `docker image load`. Digests are the real ones measured on
 * idea04 (koenswings/kolibri:1.1-0.19.5: index a5ae1caf…, linux/arm64 manifest 2b1cb1ed…).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fs, path } from 'zx'
import os from 'os'
import { buildImageSteps, checkLoadedDigest, legacyServiceImageTarName, parseImageRef, saveName, serviceImageTarName } from '../../src/data/ImageRef.js'
import { serviceImageTarPath, verifyServiceImageDigest } from '../../src/data/Instance.js'

const INDEX = 'sha256:a5ae1caf3e31b5bb9f2df9c94d45c4cf6fdb8ce3cfe8730364bd6648cdbadc31'
const PLATFORM = 'sha256:2b1cb1ed1dda1d626ac7dc0b4c23c04d575eeac6fc208d848a10282ba2f64079'
const TAG = 'koenswings/kolibri:1.1-0.19.5'
const PINNED = `${TAG}@${INDEX}`

describe('parseImageRef / saveName / tar names', () => {
    it('parses tag-only, pinned, registry-with-port and digest-only refs', () => {
        expect(parseImageRef(TAG)).toEqual({ ref: TAG, repo: 'koenswings/kolibri', tag: '1.1-0.19.5', digest: null })
        expect(parseImageRef(PINNED)).toMatchObject({ repo: 'koenswings/kolibri', tag: '1.1-0.19.5', digest: INDEX })
        expect(parseImageRef('localhost:5000/a/b:1@' + INDEX)).toMatchObject({ repo: 'localhost:5000/a/b', tag: '1', digest: INDEX })
        expect(parseImageRef('localhost:5000/a/b')).toMatchObject({ repo: 'localhost:5000/a/b', tag: null, digest: null })
        expect(parseImageRef('busybox@' + INDEX)).toMatchObject({ repo: 'busybox', tag: null, digest: INDEX })
        expect(() => parseImageRef('busybox@sha256:xyz')).toThrow(/not a sha256 digest/)
    })
    it('saves a pinned ref by repo:tag; digest-only refs are refused clearly', () => {
        expect(saveName(PINNED)).toBe(TAG)
        expect(saveName(TAG)).toBe(TAG)
        expect(() => saveName('busybox@' + INDEX)).toThrow(/without a tag/)
    })
    it('tar name: tag-only unchanged from before, pinned maps to the tag file', () => {
        expect(serviceImageTarName('traefik/whoami:v1')).toBe('traefik_whoami:v1.tar')
        expect(serviceImageTarName(PINNED)).toBe('koenswings_kolibri:1.1-0.19.5.tar')
        expect(serviceImageTarPath('/disks/sdb1', PINNED)).toBe('/disks/sdb1/services/koenswings_kolibri:1.1-0.19.5.tar')
        expect(serviceImageTarPath('/disks/sdb1', 'ghcr.io/kiwix/kiwix-serve:3.8.2')).toBe('/disks/sdb1/services/ghcr.io_kiwix_kiwix-serve:3.8.2.tar')
        expect(legacyServiceImageTarName(PINNED)).toBe(`koenswings_kolibri:1.1-0.19.5@${INDEX}.tar`)
    })
})

describe('buildImageSteps (persist path)', () => {
    it('tag-only: pull + save, exactly as before', () => {
        expect(buildImageSteps(TAG)).toEqual([['docker', 'image', 'pull', TAG], ['docker', 'save', TAG]])
    })
    it('pinned: pull by the full ref, tag as repo:tag, save by repo:tag (never save by digest)', () => {
        const s = buildImageSteps(PINNED)
        expect(s).toEqual([['docker', 'image', 'pull', PINNED], ['docker', 'image', 'tag', PINNED, TAG], ['docker', 'save', TAG]])
        expect(s.some(x => x[1] === 'save' && x.join(' ').includes('@'))).toBe(false)
    })
})

describe('checkLoadedDigest (after docker image load)', () => {
    it('tag-only refs are never checked', () => {
        expect(checkLoadedDigest(TAG, null, null)).toEqual({ ok: true })
    })
    it('index pin + tag-saved tar (idea04 case 4): ok via RepoDigests, docker.io prefix tolerated', () => {
        expect(checkLoadedDigest(PINNED, [`koenswings/kolibri@${INDEX}`], INDEX)).toEqual({ ok: true })
        expect(checkLoadedDigest(PINNED, [`docker.io/koenswings/kolibri@${INDEX}`], null)).toEqual({ ok: true })
        expect(checkLoadedDigest('busybox:1.36@' + INDEX, [`docker.io/library/busybox@${INDEX}`], null)).toEqual({ ok: true })
    })
    it('ok via the image Id on the containerd store', () => {
        expect(checkLoadedDigest(PINNED, [], INDEX)).toEqual({ ok: true })
    })
    it('platform-manifest pin (app-kolibri main, idea04 case 2): clear error naming the index digest fix', () => {
        const c = checkLoadedDigest(`${TAG}@${PLATFORM}`, [`koenswings/kolibri@${INDEX}`], INDEX)
        expect(c.ok).toBe(false)
        if (!c.ok) {
            expect(c.reason).toContain(PLATFORM)
            expect(c.reason).toMatch(/per-platform manifest digest/)
            expect(c.reason).toMatch(/imagetools inspect koenswings\/kolibri:1\.1-0\.19\.5/)
        }
    })
    it('mismatch: a different build under the same tag fails', () => {
        expect(checkLoadedDigest(PINNED, [`koenswings/kolibri@${PLATFORM}`], PLATFORM).ok).toBe(false)
    })
    it('same digest under another repo does not count', () => {
        expect(checkLoadedDigest(PINNED, [`other/kolibri@${INDEX}`], null).ok).toBe(false)
    })
    it('image absent after load (tar saved by digest → untagged, idea04 cases 1/5): clear error', () => {
        const c = checkLoadedDigest(PINNED, null, null)
        expect(c.ok).toBe(false)
        if (!c.ok) expect(c.reason).toMatch(/not present after loading/)
    })
})

// verifyServiceImageDigest against a fake `docker` on PATH (no real Docker needed)
describe('verifyServiceImageDigest (fake docker inspect)', () => {
    let dir = ''
    let oldPath = ''
    const setInspect = (out: string | null) => {
        fs.writeFileSync(path.join(dir, 'inspect.out'), out ?? '')
        fs.writeFileSync(path.join(dir, 'inspect.rc'), out === null ? '1' : '0')
    }
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-322-'))
        fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\nD=$(dirname "$0")\n[ "$1 $2" = "image inspect" ] || exit 2\ncat "$D/inspect.out"\nexit $(cat "$D/inspect.rc")\n`, { mode: 0o755 })
        oldPath = process.env.PATH ?? ''
        process.env.PATH = `${dir}:${oldPath}`
    })
    afterAll(() => { process.env.PATH = oldPath; fs.removeSync(dir) })

    it('tag-only: no inspect at all', async () => {
        setInspect(null)
        await expect(verifyServiceImageDigest(TAG)).resolves.toBeUndefined()
    })
    it('pinned index digest present: ok', async () => {
        setInspect(`["koenswings/kolibri@${INDEX}"]|${INDEX}`)
        await expect(verifyServiceImageDigest(PINNED)).resolves.toBeUndefined()
    })
    it('pinned platform digest: throws the clear error', async () => {
        setInspect(`["koenswings/kolibri@${INDEX}"]|${INDEX}`)
        await expect(verifyServiceImageDigest(`${TAG}@${PLATFORM}`)).rejects.toThrow(/per-platform manifest digest/)
    })
    it('absent: build path (requirePresent) throws, start path leaves it to compose', async () => {
        setInspect(null)
        await expect(verifyServiceImageDigest(PINNED)).rejects.toThrow(/not present/)
        await expect(verifyServiceImageDigest(PINNED, { requirePresent: false })).resolves.toBeUndefined()
    })
})
