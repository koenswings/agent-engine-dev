/**
 * Service image references with digest pins (koenswings/idea#322).
 *
 * Composes pin `repo:tag@sha256:<INDEX digest>` and use `pull_policy: never`, so the image must
 * resolve locally after `docker image load` of the App Disk's services/<name>.tar. Measured on
 * idea04 (Docker 29.8, containerd image store, idea#322 comment 6518421648):
 *  - `docker save repo:tag@sha256:…` writes a tar WITHOUT a name: after load the image is untagged
 *    and neither the digest ref nor the tag resolves ("No such image").
 *  - `docker save repo:tag` keeps the name; after load the image carries RepoDigest repo@<index
 *    digest>, and `repo:tag@<index digest>` resolves. A per-platform manifest digest does not.
 * So: pull by the full ref, tag it as repo:tag, save by repo:tag, and after load verify that the
 * pinned digest is present as `repo@digest` (idea#445; a mutable repo:tag may point at an older
 * build). Tag-only refs behave exactly as before. A stale services/ tar is never loaded: if the
 * pin is already local, start skips the load and retags repo:tag; otherwise the tar is checked
 * against the pin first and a mismatch is quarantined (never deleted).
 *
 * Accepted pins: the TOP-LEVEL digest of the image, i.e. the index digest for a multi-platform
 * image, or the manifest digest for a single-platform image with no index above it (e.g. the
 * nextcloud images). Both show up in RepoDigests after a repo:tag load.
 * Rejected: a per-platform manifest digest that sits inside an index (e.g. the linux/arm64 entry of
 * the index) cannot be resolved offline from a tag-saved tar. The verify step fails with an error that
 * names this case and asks for the top-level digest (`docker buildx imagetools inspect repo:tag`,
 * the top-level "Digest:").
 */

import { createHash } from 'node:crypto'

export interface ImageRef {
    /** the ref exactly as written in compose.yaml */
    ref: string
    /** repository incl. registry/namespace, e.g. koenswings/kolibri, ghcr.io/kiwix/kiwix-serve */
    repo: string
    /** tag, or null when the ref has none */
    tag: string | null
    /** sha256:<64 hex>, or null when the ref is not pinned */
    digest: string | null
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

/** Parse `repo[:tag][@sha256:…]`. A ':' after the last '/' is a tag; earlier it is a registry port. */
export const parseImageRef = (ref: string): ImageRef => {
    const r = ref.trim()
    let rest = r
    let digest: string | null = null
    const at = r.indexOf('@')
    if (at !== -1) {
        digest = r.slice(at + 1)
        rest = r.slice(0, at)
        if (!DIGEST_RE.test(digest)) throw new Error(`Image reference ${ref}: '${digest}' is not a sha256 digest`)
    }
    const slash = rest.lastIndexOf('/')
    const colon = rest.lastIndexOf(':')
    let repo = rest
    let tag: string | null = null
    if (colon > slash) { repo = rest.slice(0, colon); tag = rest.slice(colon + 1) }
    if (!repo) throw new Error(`Image reference ${ref} has no repository`)
    return { ref: r, repo, tag, digest }
}

/**
 * The name the image is tagged and saved under: repo:tag. Digest pins require a tag, because a
 * tar saved by digest has no name after load (see the header).
 */
export const saveName = (ref: string): string => {
    const p = parseImageRef(ref)
    if (p.tag) return `${p.repo}:${p.tag}`
    if (p.digest) throw new Error(`Image reference ${ref} pins a digest without a tag: use repo:tag@${p.digest} so the saved image keeps its name after docker image load (idea#322)`)
    return p.repo
}

/**
 * File name part of the saved tar under services/: the save name with every '/' → '_'.
 * Tag-only refs map exactly as before (traefik/whoami:v1 → traefik_whoami:v1.tar), so existing
 * App Disks and release tooling keep working; a pinned ref maps to the same file as its tag.
 */
export const serviceImageTarName = (ref: string): string => `${saveName(ref).replace(/\//g, '_')}.tar`

/** Pre-#322 file name for a pinned ref (the full ref incl. '@sha256:…'), for a clear warning only. */
export const legacyServiceImageTarName = (ref: string): string => `${ref.trim().replace(/\//g, '_')}.tar`

/** Strip a default registry prefix so docker.io/library/x, docker.io/x and x compare equal. */
const normRepo = (repo: string): string => repo.replace(/^docker\.io\//, '').replace(/^index\.docker\.io\//, '').replace(/^library\//, '')

export type DigestCheck = { ok: true } | { ok: false, reason: string }

/**
 * After `docker image load`, does the local image `repo:tag` carry the pinned digest?
 * `repoDigests` is `docker image inspect --format '{{json .RepoDigests}}'`, `imageId` its `.Id`
 * (on the containerd store the Id is the index/manifest digest). `null` repoDigests: not present.
 */
export const checkLoadedDigest = (ref: string, repoDigests: string[] | null, imageId: string | null): DigestCheck => {
    const p = parseImageRef(ref)
    if (!p.digest) return { ok: true }
    const name = saveName(ref)
    if (repoDigests === null) return { ok: false, reason: `Service image ${ref}: ${name} is not present after loading its saved image; with pull_policy: never the start cannot continue (idea#322)` }
    const want = p.digest
    const match = repoDigests.some(d => {
        const i = d.lastIndexOf('@')
        return i !== -1 && d.slice(i + 1) === want && normRepo(d.slice(0, i)) === normRepo(p.repo)
    })
    if (match) return { ok: true }
    // A single-platform image (no index) pinned by its manifest digest matches above via RepoDigests.
    // .Id equal to the pinned digest: the top-level digest on the containerd store. Checked on idea03
    // (Docker 29.4.0, PR #296 comment 6520480056): after a plain save the loaded .Id is the index digest;
    // after a --platform save it is the arm64 manifest, and this check then rejects the index pin, which
    // is correct because that tar does not start offline by tag@index. RepoDigests stays the primary check.
    // If RepoDigests name this repo under another digest, the pin is not the top-level digest: .Id
    // equal to a per-platform manifest digest inside an index never counts as a pass.
    const repoHasOtherDigest = repoDigests.some(d => { const i = d.lastIndexOf('@'); return i !== -1 && normRepo(d.slice(0, i)) === normRepo(p.repo) })
    if (imageId === want && !repoHasOtherDigest) return { ok: true }
    const have = repoDigests.length ? repoDigests.join(', ') : '(no RepoDigests)'
    return {
        ok: false,
        reason: `Service image ${ref}: the loaded ${name} has digest ${have}${imageId ? ` (id ${imageId})` : ''}, not the pinned ${want}. ` +
            `Either the saved image is a different build, or the compose pins a per-platform manifest digest from inside an index. ` +
            `Pin the top-level digest: the index digest if the image has one, otherwise its single manifest digest ` +
            `(use the top-level "Digest:" of \`docker buildx imagetools inspect ${name}\`) (idea#322)`,
    }
}

/**
 * The Engine runs on ARM64 only: images are PULLED for this platform only. The SAVE is a plain
 * `docker save repo:tag`, never `--platform`. Real Pi check on idea03 (Docker 29.4.0, containerd
 * store, PR #296 comment 6520480056): `save --platform linux/arm64` loads back as the arm64 manifest
 * (RepoDigests and .Id = arm64 digest), so `repo:tag@<index>` no longer resolves offline. A plain save
 * after a --platform pull by index digest kept the index (RepoDigests and .Id = index), and both the
 * start and the verify worked. If the plain save fails (possible "content not found" on Docker 29.8.1,
 * untested), the build fails: there is no fallback to a --platform save, which would not start offline.
 */
export const ENGINE_IMAGE_PLATFORM = 'linux/arm64'

/** The docker steps of the build (persist) path for one service image, in order. Pure, for tests. */
export const buildImageSteps = (ref: string): string[][] => {
    const p = parseImageRef(ref)
    const name = saveName(ref)
    const steps: string[][] = [['docker', 'image', 'pull', '--platform', ENGINE_IMAGE_PLATFORM, p.ref]]
    if (p.digest) steps.push(['docker', 'image', 'tag', p.ref, name])
    steps.push(['docker', 'save', name])
    return steps
}

/** Build-failure message when the plain `docker save repo:tag` of a service image fails (idea#322). */
export const saveFailedMessage = (ref: string, dockerVersion: string, detail: string): string =>
    `Service image ${ref}: \`docker save ${saveName(ref)}\` failed on Docker ${dockerVersion || 'unknown'}: ${detail.trim() || '(no output)'}. ` +
    `The build stops: a --platform save is not used as a fallback because that tar loads as the platform manifest ` +
    `and does not start offline by tag@index digest (idea#322, PR #296 comment 6520480056)`

/**
 * idea#445: a pinned image is addressed as repo@digest, not repo:tag.
 * `docker image inspect repo@sha256:…` succeeds when the pin is local, even if
 * a mutable tag like :1.0 currently points at a different build.
 */
export const digestInspectRef = (ref: string): string | null => {
    const p = parseImageRef(ref)
    return p.digest ? `${p.repo}@${p.digest}` : null
}

const INDEX_MEDIA = new Set([
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
])
const MANIFEST_MEDIA = new Set([
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
])

const sha256Hex = (bytes: Buffer | Uint8Array): string =>
    'sha256:' + createHash('sha256').update(bytes).digest('hex')

const isDigest = (v: unknown): v is string => typeof v === 'string' && DIGEST_RE.test(v)

const memberBytes = (members: ReadonlyMap<string, Buffer>, name: string): Buffer | undefined =>
    members.get(name) ?? members.get(`./${name}`)

/** Compose / tar image name, with docker.io and library prefixes stripped (Kid verify_service_tar.norm_name). */
export const normImageName = (name: string): string => {
    const p = parseImageRef(name)
    return p.tag ? `${normRepo(p.repo)}:${p.tag}` : normRepo(p.repo)
}

/** Name on an index.json descriptor: io.containerd.image.name, else a repo-like OCI ref.name. */
export const entryImageName = (entry: any): string | null => {
    const ann = entry?.annotations ?? {}
    if (typeof ann['io.containerd.image.name'] === 'string' && ann['io.containerd.image.name']) return ann['io.containerd.image.name']
    const ref = ann['org.opencontainers.image.ref.name']
    if (typeof ref === 'string' && (ref.includes('/') || ref.includes(':'))) return ref
    return null
}

export type TarPinState = 'missing' | 'matches' | 'mismatch' | 'unreadable'

export type ServiceTarLayout = 'index' | 'manifest'
export type ServiceTarPinResult = {
    state: Exclude<TarPinState, 'missing'>
    digest: string | null
    layout: ServiceTarLayout | null
    reason?: string
}

/**
 * Pre-load check of a digest-pinned services/*.tar, aligned with Kid's
 * app-usage-dashboard script/verify_service_tar.py (PR #15), idea#445:
 *  (a) named entry is an image index whose digest equals the pin → matches
 *  (b) named entry is a single manifest whose digest equals the pin → matches
 *      (one-platform image, no index, e.g. the old ef48f1fa pin)
 *  (c) named entry is only a platform manifest while the pin is something else
 *      (typically the index) → mismatch; refused. No --platform-digest escape
 *      hatch: after docker load, repo:tag@<index> does not resolve offline.
 *  (d) no index.json, no manifest.json, a missing or corrupt top-level blob,
 *      or the same repo:tag name on two different digests → unreadable.
 *
 * Also accepts a bare image-index index.json (no name annotation) whose file
 * digest equals the pin: that is still (a). Kid's name check would fail this
 * rarer layout; Engine-produced and --export-tar tars use a named wrapper.
 */
export const checkServiceTarPin = (ref: string, members: ReadonlyMap<string, Buffer>): ServiceTarPinResult => {
    const p = parseImageRef(ref)
    if (!p.digest) return { state: 'unreadable', digest: null, layout: null, reason: 'not digest-pinned' }
    const pin = p.digest
    const want = saveName(ref)

    const indexBytes = memberBytes(members, 'index.json')
    if (!indexBytes) return { state: 'unreadable', digest: null, layout: null, reason: 'no index.json' }
    let index: any
    try { index = JSON.parse(indexBytes.toString('utf8')) } catch { return { state: 'unreadable', digest: null, layout: null, reason: 'index.json is not JSON' } }

    const manifestBytes = memberBytes(members, 'manifest.json')
    if (!manifestBytes) return { state: 'unreadable', digest: null, layout: null, reason: 'no manifest.json' }
    let manifest: any
    try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { return { state: 'unreadable', digest: null, layout: null, reason: 'manifest.json is not JSON' } }

    const entries = Array.isArray(index?.manifests) ? (index.manifests as any[]).filter(e => e && typeof e === 'object') : []
    if (!entries.length) return { state: 'unreadable', digest: null, layout: null, reason: 'index.json lists no manifests' }

    const named = entries.filter(e => {
        const n = entryImageName(e)
        return n !== null && normImageName(n) === normImageName(want)
    })
    let chosen = named
    if (named.length === 0) {
        // (a) extra: index.json itself is the image index and hashes to the pin.
        const fileDigest = sha256Hex(indexBytes)
        if (fileDigest === pin && (INDEX_MEDIA.has(index?.mediaType) || entries.some(e => e.platform))) {
            return { state: 'matches', digest: fileDigest, layout: 'index' }
        }
        if (entries.length === 1 && entryImageName(entries[0]) === null) chosen = entries
        else return { state: 'unreadable', digest: null, layout: null, reason: `image name mismatch: index.json does not name ${want}` }
    }
    const digests = [...new Set(chosen.map(e => e.digest).filter(isDigest))]
    if (digests.length > 1) {
        return { state: 'unreadable', digest: null, layout: null, reason: `duplicate name ${want} with different digests (${digests.join(', ')})` }
    }
    const top = chosen[0]
    const topDigest = top.digest
    if (!isDigest(topDigest)) return { state: 'unreadable', digest: null, layout: null, reason: 'index.json entry has no sha256 digest' }

    const tags: string[] = []
    if (Array.isArray(manifest)) for (const item of manifest) for (const t of (item?.RepoTags ?? [])) tags.push(String(t))
    if (!tags.some(t => normImageName(t) === normImageName(want))) {
        return { state: 'unreadable', digest: topDigest, layout: null, reason: `image name mismatch: manifest.json RepoTags do not include ${want}` }
    }

    const blob = memberBytes(members, `blobs/sha256/${topDigest.slice('sha256:'.length)}`)
    if (!blob) return { state: 'unreadable', digest: topDigest, layout: null, reason: `top-level blob ${topDigest} is not in the tar` }
    const got = sha256Hex(blob)
    if (got !== topDigest) return { state: 'unreadable', digest: topDigest, layout: null, reason: `top-level blob ${topDigest} hashes to ${got}` }

    let media: string = typeof top.mediaType === 'string' ? top.mediaType : ''
    if (!INDEX_MEDIA.has(media) && !MANIFEST_MEDIA.has(media)) {
        try {
            const doc = JSON.parse(blob.toString('utf8'))
            if (Array.isArray(doc?.manifests)) media = 'application/vnd.oci.image.index.v1+json'
            else if (doc?.config) media = 'application/vnd.oci.image.manifest.v1+json'
        } catch { /* keep */ }
    }
    if (INDEX_MEDIA.has(media)) {
        if (topDigest === pin) return { state: 'matches', digest: topDigest, layout: 'index' }
        return { state: 'mismatch', digest: topDigest, layout: 'index' }
    }
    if (MANIFEST_MEDIA.has(media)) {
        if (topDigest === pin) return { state: 'matches', digest: topDigest, layout: 'manifest' }
        // (c) conservative: no --platform-digest override (idea#445, pending Steve)
        return { state: 'mismatch', digest: topDigest, layout: 'manifest', reason: `platform-manifest only: tar top-level entry is manifest ${topDigest}, compose pins ${pin}` }
    }
    return { state: 'unreadable', digest: topDigest, layout: null, reason: `unknown top-level media type ${media || '(none)'}` }
}

export type PinnedLoadPlan = {
    action: 'skip-retag' | 'load' | 'stale-fail' | 'missing'
    quarantine: boolean
    warning?: string
    error?: string
}

/**
 * Start-path plan for a digest-pinned service image (idea#445).
 *
 * If the pin is already local, never load the tar (a stale tar would retag :tag
 * away from the pin). A mismatched tar is still quarantined. Start only fails
 * for a stale or unreadable tar when the pin is not local and a load would be
 * needed — otherwise idea03 could not start while its pin is already present.
 */
export const planPinnedServiceImageLoad = (args: {
    ref: string
    pin: string
    tarPath: string
    pinPresent: boolean
    tarState: TarPinState
    tarDigest?: string | null
    tarReason?: string
}): PinnedLoadPlan => {
    const { ref, pin, tarPath, pinPresent, tarState, tarDigest, tarReason } = args
    if (pinPresent) {
        if (tarState === 'mismatch') {
            return {
                action: 'skip-retag',
                quarantine: true,
                warning: `Service image ${ref}: stale service tar ${tarPath} has digest ${tarDigest}, not the pinned ${pin}; quarantined and not loaded because the pin is already local (idea#445)`,
            }
        }
        return { action: 'skip-retag', quarantine: false }
    }
    if (tarState === 'matches') return { action: 'load', quarantine: false }
    if (tarState === 'missing') return { action: 'missing', quarantine: false }
    if (tarState === 'mismatch') {
        return {
            action: 'stale-fail',
            quarantine: true,
            error: `Service image ${ref}: stale service tar ${tarPath} has digest ${tarDigest}, not the pinned ${pin}; quarantined and not loaded (idea#445)`,
        }
    }
    return {
        action: 'stale-fail',
        quarantine: false,
        error: `Service image ${ref}: cannot read a digest from service tar ${tarPath}${tarReason ? ` (${tarReason})` : ''}; not loading it (idea#445)`,
    }
}

/** Install path: an existing tar is reused only when it is unpinned or matches the pin. */
export const planExistingTarOnInstall = (pinned: boolean, tarState: TarPinState | 'absent'): 'use' | 'create' | 'quarantine-and-create' => {
    if (tarState === 'absent' || tarState === 'missing') return 'create'
    if (!pinned) return 'use'
    if (tarState === 'matches') return 'use'
    return 'quarantine-and-create'
}

/** Rename suffix for a quarantined service tar (never deleted). 2026-11-11T21:51:00.000Z → 20261111T215100Z */
export const serviceTarQuarantineName = (tarPath: string, now = Date.now()): string => {
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    return `${tarPath}.quarantine-${stamp}`
}
