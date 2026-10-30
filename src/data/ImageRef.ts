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
 * loaded image carries the pinned digest. Tag-only refs behave exactly as before.
 *
 * Platform digests: a pin on a per-platform manifest digest (e.g. the linux/arm64 entry of the
 * index) cannot be resolved offline from a tag-saved tar. The verify step fails with an error that
 * names this case and asks for the index digest (`docker buildx imagetools inspect repo:tag`,
 * the top-level "Digest:").
 */

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
    if (match || imageId === want) return { ok: true }
    const have = repoDigests.length ? repoDigests.join(', ') : '(no RepoDigests)'
    return {
        ok: false,
        reason: `Service image ${ref}: the loaded ${name} has digest ${have}${imageId ? ` (id ${imageId})` : ''}, not the pinned ${want}. ` +
            `Either the saved image is a different build, or the compose pins a per-platform manifest digest instead of the image index digest ` +
            `(use the top-level "Digest:" of \`docker buildx imagetools inspect ${name}\`) (idea#322)`,
    }
}

/** The docker steps of the build (persist) path for one service image, in order. Pure, for tests. */
export const buildImageSteps = (ref: string): string[][] => {
    const p = parseImageRef(ref)
    const name = saveName(ref)
    const steps: string[][] = [['docker', 'image', 'pull', p.ref]]
    if (p.digest) steps.push(['docker', 'image', 'tag', p.ref, name])
    steps.push(['docker', 'save', name])
    return steps
}
