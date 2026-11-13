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
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ENGINE_IMAGE_PLATFORM, buildImageSteps, saveFailedMessage, checkLoadedDigest, checkServiceTarPin, digestInspectRef, legacyServiceImageTarName, parseImageRef, planExistingTarOnInstall, planPinnedServiceImageLoad, saveName, serviceImageTarName, serviceTarQuarantineName } from '../../src/data/ImageRef.js'
import { inspectServiceTar, quarantineServiceTar, readTarEntry, serviceImageTarPath, verifyServiceImageDigest } from '../../src/data/Instance.js'

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
        const web = 'ghcr.io/koenswings/usage-dashboard-web:1.0@sha256:' + '9'.repeat(64)
        expect(serviceImageTarName(web)).toBe('ghcr.io_koenswings_usage-dashboard-web:1.0.tar')
        expect(legacyServiceImageTarName(web)).toContain('@sha256:')
        expect(serviceImageTarName(web)).not.toBe(legacyServiceImageTarName(web))
    })
})

describe('buildImageSteps (persist path)', () => {
    it('tag-only: pull + save, exactly as before', () => {
        expect(buildImageSteps(TAG)).toEqual([['docker', 'image', 'pull', '--platform', 'linux/arm64', TAG], ['docker', 'save', TAG]])
    })
    it('pinned: pull by the full ref, tag as repo:tag, save by repo:tag (never save by digest)', () => {
        const s = buildImageSteps(PINNED)
        expect(s).toEqual([['docker', 'image', 'pull', '--platform', 'linux/arm64', PINNED], ['docker', 'image', 'tag', PINNED, TAG], ['docker', 'save', TAG]])
        expect(s.some(x => x[1] === 'save' && x.join(' ').includes('@'))).toBe(false)
        expect(ENGINE_IMAGE_PLATFORM).toBe('linux/arm64')
    })
})

describe('idea03 real inspect shapes (Docker 29.4.0, PR #296 comment 6520480056)', () => {
    const K_INDEX = 'sha256:a5ae1caf3e31b5bb9f2df9c94d45c4cf6fdb8ce3cfe8730364bd6648cdbadc31'
    const K_ARM64 = 'sha256:2b1cb1ed1dda1d626ac7dc0b4c23c04d575eeac6fc208d848a10282ba2f64079'
    const K_TAG = 'koenswings/kolibri:1.1-0.19.5'
    it('never saves with --platform; pulls with it', () => {
        const s = buildImageSteps(`${K_TAG}@${K_INDEX}`)
        expect(s.find(x => x[1] === 'save')).toEqual(['docker', 'save', K_TAG])
        expect(s[0]).toEqual(['docker', 'image', 'pull', '--platform', ENGINE_IMAGE_PLATFORM, `${K_TAG}@${K_INDEX}`])
    })
    it('--platform-saved image (arm64-only RepoDigest, .Id arm64) fails the index pin', () => {
        expect(checkLoadedDigest(`${K_TAG}@${K_INDEX}`, [`koenswings/kolibri@${K_ARM64}`], K_ARM64).ok).toBe(false)
    })
    it('plain-saved image (index RepoDigest, .Id index) passes the index pin', () => {
        expect(checkLoadedDigest(`${K_TAG}@${K_INDEX}`, [`koenswings/kolibri@${K_INDEX}`], K_INDEX)).toEqual({ ok: true })
    })
    it('wrong arm64 pin fails in the plain-save shape', () => {
        expect(checkLoadedDigest(`${K_TAG}@${K_ARM64}`, [`koenswings/kolibri@${K_INDEX}`], K_INDEX).ok).toBe(false)
    })
    it('save failure message names the image and Docker version, and rules out a --platform fallback', () => {
        const m = saveFailedMessage(`${K_TAG}@${K_INDEX}`, '29.8.1', 'content digest sha256:x: not found')
        expect(m).toContain(K_TAG)
        expect(m).toContain('Docker 29.8.1')
        expect(m).toMatch(/not found/)
        expect(m).toMatch(/--platform save is not used as a fallback/)
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
    it('platform pin + --platform save whose .Id is the arm64 manifest digest: still fails (RepoDigests show the index)', () => {
        expect(checkLoadedDigest(`${TAG}@${PLATFORM}`, [`koenswings/kolibri@${INDEX}`], PLATFORM).ok).toBe(false)
    })
    it('single-platform image (no index, e.g. nextcloud): a top-level manifest pin passes', () => {
        const M = 'sha256:' + 'c'.repeat(64)
        expect(checkLoadedDigest(`nextcloud:31@${M}`, [`docker.io/library/nextcloud@${M}`], M)).toEqual({ ok: true })
        expect(checkLoadedDigest(`koenswings/nextcloud-mariadb:1@${M}`, [`koenswings/nextcloud-mariadb@${M}`], null)).toEqual({ ok: true })
        expect(checkLoadedDigest(`koenswings/nextcloud-code:1@${M}`, [], M)).toEqual({ ok: true })
    })
    it('platform digest inside an index (kolibri 2b1cb1ed… under a5ae1caf…) still fails', () => {
        expect(checkLoadedDigest(`${TAG}@${PLATFORM}`, [`koenswings/kolibri@${INDEX}`], INDEX).ok).toBe(false)
        expect(checkLoadedDigest(`${TAG}@${PLATFORM}`, [`koenswings/kolibri@${INDEX}`], PLATFORM).ok).toBe(false)
    })
    it('index pin passes', () => {
        expect(checkLoadedDigest(PINNED, [`koenswings/kolibri@${INDEX}`], PLATFORM)).toEqual({ ok: true })
    })
    it('error text asks for the top-level digest', () => {
        const c = checkLoadedDigest(`${TAG}@${PLATFORM}`, [`koenswings/kolibri@${INDEX}`], INDEX)
        if (!c.ok) expect(c.reason).toMatch(/top-level digest: the index digest if the image has one, otherwise its single manifest digest/)
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

// idea#445: verify inspects repo@digest, so a wrong :tag does not fail when the pin is present
describe('verifyServiceImageDigest inspects repo@digest (idea#445)', () => {
    let dir = ''
    let oldPath = ''
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-445-'))
        fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\n' +
            'D=$(dirname "$0")\n' +
            '[ "$1 $2" = "image inspect" ] || exit 2\n' +
            'echo "$3" >> "$D/seen"\n' +
            'img="$3"\n' +
            'if echo "$img" | grep -q "@sha256:"; then\n' +
            '  cat "$D/digest.out"\n' +
            '  exit $(cat "$D/digest.rc")\n' +
            'fi\n' +
            'cat "$D/tag.out"\n' +
            'exit $(cat "$D/tag.rc")\n', { mode: 0o755 })
        fs.writeFileSync(path.join(dir, 'digest.out'), `["koenswings/kolibri@${INDEX}"]|${INDEX}`)
        fs.writeFileSync(path.join(dir, 'digest.rc'), '0')
        fs.writeFileSync(path.join(dir, 'tag.out'), `["koenswings/kolibri@${PLATFORM}"]|${PLATFORM}`)
        fs.writeFileSync(path.join(dir, 'tag.rc'), '0')
        oldPath = process.env.PATH ?? ''
        process.env.PATH = `${dir}:${oldPath}`
    })
    afterAll(() => { process.env.PATH = oldPath; fs.removeSync(dir) })

    it('passes when repo@digest has the pin even if repo:tag points at another build', async () => {
        await expect(verifyServiceImageDigest(PINNED)).resolves.toBeUndefined()
        const seen = fs.readFileSync(path.join(dir, 'seen'), 'utf8')
        expect(seen).toContain(`koenswings/kolibri@${INDEX}`)
        expect(seen).not.toContain('koenswings/kolibri:1.1-0.19.5')
    })
})


const WEB_PIN = 'sha256:9b5501f0690f02146217595f177496612d107aefd2bd56c181f84c7f1c678139'
const WEB_OLD = 'sha256:ef48f1faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const WEB = `ghcr.io/koenswings/usage-dashboard-web:1.0@${WEB_PIN}`

const sha = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const hex = (digest: string) => digest.slice('sha256:'.length)
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json'
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
const WEB_NAME = 'ghcr.io/koenswings/usage-dashboard-web:1.0'
const buf = (v: unknown): Buffer => Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8')
const membersOf = (files: Record<string, unknown>): Map<string, Buffer> => {
    const m = new Map<string, Buffer>()
    for (const [k, v] of Object.entries(files)) m.set(k, buf(v))
    return m
}
const indexWrapper = (name: string, digest: string, media: string, size: number) => ({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [{ mediaType: media, digest, size, annotations: { 'io.containerd.image.name': name } }],
})
const repoTags = (name: string) => [{ RepoTags: [name], Config: 'cfg', Layers: [] }]
const withBlob = (name: string, media: string, blob: Buffer): Record<string, unknown> => {
    const digest = sha(blob)
    return {
        'index.json': indexWrapper(name, digest, media, blob.length),
        'manifest.json': repoTags(name),
        [`blobs/sha256/${hex(digest)}`]: blob,
    }
}
const packMembersTar = (tarPath: string, files: Record<string, unknown>): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-445-tar-'))
    for (const [rel, v] of Object.entries(files)) {
        const dest = path.join(dir, rel)
        fs.ensureDirSync(path.dirname(dest))
        fs.writeFileSync(dest, buf(v))
    }
    const args = ['-C', dir, '-cf', tarPath, ...Object.keys(files)]
    execFileSync('tar', args)
    fs.removeSync(dir)
}

describe('digestInspectRef (idea#445)', () => {
    it('addresses a pin as repo@digest, not repo:tag', () => {
        expect(digestInspectRef(PINNED)).toBe(`koenswings/kolibri@${INDEX}`)
        expect(digestInspectRef(WEB)).toBe(`ghcr.io/koenswings/usage-dashboard-web@${WEB_PIN}`)
        expect(digestInspectRef(TAG)).toBeNull()
    })
})

describe('planPinnedServiceImageLoad (idea#445, idea03 repro)', () => {
    const base = { ref: WEB, pin: WEB_PIN, tarPath: '/services/ghcr.io_koenswings_usage-dashboard-web:1.0.tar' }
    it('pin already local + stale tar: skip load, quarantine, do not fail (idea03)', () => {
        const p = planPinnedServiceImageLoad({ ...base, pinPresent: true, tarState: 'mismatch', tarDigest: WEB_OLD })
        expect(p.action).toBe('skip-retag')
        expect(p.quarantine).toBe(true)
        expect(p.warning).toMatch(/stale service tar/)
        expect(p.warning).toMatch(/ef48f1fa/)
        expect(p.warning).toMatch(/already local/)
        expect(p.error).toBeUndefined()
    })
    it('pin already local + matching or missing tar: skip load, no quarantine', () => {
        expect(planPinnedServiceImageLoad({ ...base, pinPresent: true, tarState: 'matches', tarDigest: WEB_PIN })).toEqual({ action: 'skip-retag', quarantine: false })
        expect(planPinnedServiceImageLoad({ ...base, pinPresent: true, tarState: 'missing' })).toEqual({ action: 'skip-retag', quarantine: false })
    })
    it('pin absent + matching tar: load it', () => {
        expect(planPinnedServiceImageLoad({ ...base, pinPresent: false, tarState: 'matches', tarDigest: WEB_PIN })).toEqual({ action: 'load', quarantine: false })
    })
    it('pin absent + stale tar: quarantine and fail, never load', () => {
        const p = planPinnedServiceImageLoad({ ...base, pinPresent: false, tarState: 'mismatch', tarDigest: WEB_OLD })
        expect(p.action).toBe('stale-fail')
        expect(p.quarantine).toBe(true)
        expect(p.error).toMatch(/stale service tar/)
        expect(p.error).toMatch(/not loaded/)
        expect(p.error).toContain(WEB_OLD)
        expect(p.error).toContain(WEB_PIN)
    })
    it('pin absent + unreadable tar: fail without loading or quarantining', () => {
        const p = planPinnedServiceImageLoad({ ...base, pinPresent: false, tarState: 'unreadable', tarReason: 'no index.json' })
        expect(p.action).toBe('stale-fail')
        expect(p.quarantine).toBe(false)
        expect(p.error).toMatch(/cannot read a digest/)
        expect(p.error).toMatch(/no index.json/)
    })
    it('pin absent + missing tar: idea#109 missing warning path', () => {
        expect(planPinnedServiceImageLoad({ ...base, pinPresent: false, tarState: 'missing' })).toEqual({ action: 'missing', quarantine: false })
    })
})

describe('planExistingTarOnInstall (idea#445)', () => {
    it('unpinned existing tar is still reused', () => {
        expect(planExistingTarOnInstall(false, 'matches')).toBe('use')
        expect(planExistingTarOnInstall(false, 'absent')).toBe('create')
    })
    it('pinned: reuse only a matching tar; stale or unreadable is quarantined and replaced', () => {
        expect(planExistingTarOnInstall(true, 'matches')).toBe('use')
        expect(planExistingTarOnInstall(true, 'mismatch')).toBe('quarantine-and-create')
        expect(planExistingTarOnInstall(true, 'unreadable')).toBe('quarantine-and-create')
        expect(planExistingTarOnInstall(true, 'absent')).toBe('create')
        expect(planExistingTarOnInstall(true, 'missing')).toBe('create')
    })
})

describe('checkServiceTarPin (idea#445, aligned with Kid PR #15)', () => {
    it('(a) named index-wrapper digest equal to the pin passes', () => {
        const blob = buf({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [{ mediaType: OCI_MANIFEST, digest: PLATFORM, platform: { os: 'linux', architecture: 'arm64' } }] })
        const pin = sha(blob)
        const files = withBlob(WEB_NAME, OCI_INDEX, blob)
        expect(checkServiceTarPin(`${WEB_NAME}@${pin}`, membersOf(files))).toEqual({ state: 'matches', digest: pin, layout: 'index' })
        expect(checkServiceTarPin(`${WEB_NAME}@${WEB_OLD}`, membersOf(files))).toMatchObject({ state: 'mismatch', digest: pin, layout: 'index' })
        expect(pin).not.toBe(sha(buf(files['index.json'])))
    })
    it('(b) single manifest digest equal to the pin passes (ef48-style, no index)', () => {
        const blob = buf({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { digest: 'sha256:' + 'c'.repeat(64) }, layers: [] })
        const pin = sha(blob)
        const files = withBlob(WEB_NAME, OCI_MANIFEST, blob)
        expect(checkServiceTarPin(`${WEB_NAME}@${pin}`, membersOf(files))).toEqual({ state: 'matches', digest: pin, layout: 'manifest' })
    })
    it('(c) platform-manifest only while the pin is an index: mismatch, refused (no --platform-digest hatch)', () => {
        const blob = buf({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { digest: 'sha256:' + 'c'.repeat(64) }, layers: [], platform: { os: 'linux', architecture: 'arm64' } })
        const files = withBlob(TAG, OCI_MANIFEST, blob)
        const top = sha(blob)
        const r = checkServiceTarPin(`${TAG}@${INDEX}`, membersOf(files))
        expect(r.state).toBe('mismatch')
        expect(r.layout).toBe('manifest')
        expect(r.digest).toBe(top)
        expect(r.reason).toMatch(/platform-manifest only/)
        expect(r.reason).toContain(INDEX)
        // The same tar matches if the pin is that manifest digest (b), not an index pin.
        expect(checkServiceTarPin(`${TAG}@${top}`, membersOf(files)).state).toBe('matches')
    })
    it('(d) no index.json, no manifest.json, missing blob, corrupt blob, or duplicate names fail as unreadable', () => {
        const blob = buf({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [] })
        const pin = sha(blob)
        const ref = `${WEB_NAME}@${pin}`
        expect(checkServiceTarPin(ref, membersOf({ 'manifest.json': repoTags(WEB_NAME) }))).toMatchObject({ state: 'unreadable', reason: 'no index.json' })
        expect(checkServiceTarPin(ref, membersOf({ 'index.json': indexWrapper(WEB_NAME, pin, OCI_INDEX, blob.length) }))).toMatchObject({ state: 'unreadable', reason: 'no manifest.json' })
        expect(checkServiceTarPin(ref, membersOf({
            'index.json': indexWrapper(WEB_NAME, pin, OCI_INDEX, blob.length),
            'manifest.json': repoTags(WEB_NAME),
        }))).toMatchObject({ state: 'unreadable', reason: /top-level blob .* is not in the tar/ })
        const other = buf('not-the-index')
        expect(checkServiceTarPin(ref, membersOf({
            'index.json': indexWrapper(WEB_NAME, pin, OCI_INDEX, blob.length),
            'manifest.json': repoTags(WEB_NAME),
            [`blobs/sha256/${hex(pin)}`]: other,
        }))).toMatchObject({ state: 'unreadable', reason: /hashes to/ })
        const d1 = 'sha256:' + '1'.repeat(64)
        const d2 = 'sha256:' + '2'.repeat(64)
        const dup = {
            schemaVersion: 2,
            manifests: [
                { mediaType: OCI_INDEX, digest: d1, size: 1, annotations: { 'io.containerd.image.name': WEB_NAME } },
                { mediaType: OCI_INDEX, digest: d2, size: 1, annotations: { 'io.containerd.image.name': WEB_NAME } },
            ],
        }
        expect(checkServiceTarPin(`${WEB_NAME}@${d1}`, membersOf({ 'index.json': dup, 'manifest.json': repoTags(WEB_NAME) }))).toMatchObject({ state: 'unreadable', reason: /duplicate name/ })
    })
    it('manifest.json RepoTags must name repo:tag', () => {
        const blob = buf({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [] })
        const pin = sha(blob)
        const r = checkServiceTarPin(`${WEB_NAME}@${pin}`, membersOf({
            'index.json': indexWrapper(WEB_NAME, pin, OCI_INDEX, blob.length),
            'manifest.json': repoTags('other/image:1.0'),
            [`blobs/sha256/${hex(pin)}`]: blob,
        }))
        expect(r.state).toBe('unreadable')
        expect(r.reason).toMatch(/RepoTags/)
    })
    it('(a) extra: a bare image-index index.json whose file digest equals the pin matches, a nested platform digest does not', () => {
        const index = {
            schemaVersion: 2,
            mediaType: OCI_INDEX,
            manifests: [
                { mediaType: OCI_MANIFEST, digest: 'sha256:' + 'a'.repeat(64), platform: { architecture: 'amd64', os: 'linux' } },
                { mediaType: OCI_MANIFEST, digest: PLATFORM, platform: { architecture: 'arm64', os: 'linux' } },
            ],
        }
        const bytes = buf(index)
        const pin = sha(bytes)
        const files = { 'index.json': bytes, 'manifest.json': repoTags(WEB_NAME) }
        expect(checkServiceTarPin(`${WEB_NAME}@${pin}`, membersOf(files))).toEqual({ state: 'matches', digest: pin, layout: 'index' })
        expect(checkServiceTarPin(`${WEB_NAME}@${PLATFORM}`, membersOf(files)).state).toBe('unreadable')
    })
})

describe('service tar IO: inspectServiceTar and quarantine (idea#445)', () => {
    let dir = ''
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-445-io-')) })
    afterAll(() => { fs.removeSync(dir) })

    it('inspectServiceTar reads the wrapper index digest without docker load', async () => {
        const blob = buf({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [] })
        const pin = sha(blob)
        const tar = path.join(dir, 'web:1.0.tar')
        packMembersTar(tar, withBlob(WEB_NAME, OCI_INDEX, blob))
        const bytes = await readTarEntry(tar, 'index.json')
        expect(bytes).not.toBeNull()
        expect(JSON.parse(bytes!.toString('utf8')).manifests[0].digest).toBe(pin)
        await expect(inspectServiceTar(tar, `${WEB_NAME}@${pin}`)).resolves.toMatchObject({ state: 'matches', digest: pin, layout: 'index' })
        await expect(inspectServiceTar(tar, `${WEB_NAME}@${WEB_OLD}`)).resolves.toMatchObject({ state: 'mismatch', digest: pin, layout: 'index' })
    })
    it('quarantine renames aside and never deletes; collision gets a suffix', async () => {
        const tar = path.join(dir, 'stale:1.0.tar')
        fs.writeFileSync(tar, 'old')
        const now = Date.parse('2026-11-11T21:51:00.000Z')
        expect(serviceTarQuarantineName(tar, now)).toBe(`${tar}.quarantine-20261111T215100Z`)
        const q = await quarantineServiceTar(tar, now)
        expect(q).toBe(`${tar}.quarantine-20261111T215100Z`)
        expect(fs.existsSync(tar)).toBe(false)
        expect(fs.readFileSync(q, 'utf8')).toBe('old')
        fs.writeFileSync(tar, 'old2')
        const q2 = await quarantineServiceTar(tar, now)
        expect(q2).toBe(`${tar}.quarantine-20261111T215100Z-2`)
        expect(fs.readFileSync(q, 'utf8')).toBe('old')
        expect(fs.readFileSync(q2, 'utf8')).toBe('old2')
    })
    it('a tar without index.json is unreadable, not a match', async () => {
        const tar = path.join(dir, 'classic.tar')
        const empty = path.join(dir, 'empty-dir')
        fs.ensureDirSync(empty)
        fs.writeFileSync(path.join(empty, 'manifest.json'), '[]')
        execFileSync('tar', ['-C', empty, '-cf', tar, 'manifest.json'])
        await expect(inspectServiceTar(tar, WEB)).resolves.toMatchObject({ state: 'unreadable', reason: 'no index.json' })
        await expect(inspectServiceTar(path.join(dir, 'missing.tar'), WEB)).resolves.toMatchObject({ state: 'missing', digest: null })
    })
})
