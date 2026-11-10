/**
 * Discover listed instances (compose files on disk) and unlisted running
 * containers (Docker labels / image). Never opens the Automerge store (idea#411).
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { usageLog } from './log.js'
import { INSTANCE_ID_RE, disksRootPath, systemAppsRoot, systemInstancesRoot } from './paths.js'
import { parseHookDecl } from './runner.js'
import type { BundleHook, DockerContainer, ListedTarget, UsageTarget } from './types.js'

const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']

export function syntheticInstanceId(project: string | undefined, containerName: string): string {
    if (project && INSTANCE_ID_RE.test(project)) return project
    const sanitized = `unlisted-${containerName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}`
    return sanitized.slice(0, 64) || 'unlisted-unknown'
}

export function appFromImage(image: string): string {
    const noTag = image.split(':')[0] || image
    const last = (noTag.split('/').pop() || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '')
    return last || 'unknown'
}

export function findComposeFile(dir: string): string | null {
    for (const name of COMPOSE_NAMES) {
        const p = path.join(dir, name)
        if (fs.existsSync(p)) return p
    }
    return null
}

export function loadCompose(file: string): Record<string, unknown> | null {
    try {
        const parsed = parseYaml(fs.readFileSync(file, 'utf8'))
        if (!parsed || typeof parsed !== 'object') return null
        return parsed as Record<string, unknown>
    } catch {
        return null
    }
}

export function xAppOf(compose: Record<string, unknown> | null): Record<string, unknown> | null {
    const x = compose?.['x-app']
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null
    return x as Record<string, unknown>
}

function listedFromDir(dir: string): ListedTarget | null {
    const file = findComposeFile(dir)
    if (!file) return null
    const compose = loadCompose(file)
    const xapp = xAppOf(compose)
    const instanceId = path.basename(dir)
    const name = typeof xapp?.instanceName === 'string' && xapp.instanceName
        ? xapp.instanceName
        : instanceId
    const app = typeof xapp?.name === 'string' && xapp.name ? String(xapp.name).toLowerCase() : 'unknown'
    const appVersion = typeof xapp?.version === 'string' ? xapp.version : undefined
    return {
        kind: 'listed',
        instanceId,
        name,
        app,
        appVersion,
        listed: true,
        cwd: dir,
        hook: parseHookDecl(xapp?.usage ?? null),
    }
}

export function discoverListedDirs(opts?: {
    systemInstances?: string | null
    disksRoot?: string
}): string[] {
    const dirs: string[] = []
    const systemRoot = opts?.systemInstances === undefined ? systemInstancesRoot() : opts.systemInstances
    if (systemRoot && fs.existsSync(systemRoot)) {
        try {
            for (const ent of fs.readdirSync(systemRoot, { withFileTypes: true })) {
                if (ent.isDirectory()) dirs.push(path.join(systemRoot, ent.name))
            }
        } catch { /* unreadable */ }
    }
    const disks = opts?.disksRoot ?? disksRootPath()
    if (disks && fs.existsSync(disks)) {
        try {
            for (const disk of fs.readdirSync(disks, { withFileTypes: true })) {
                if (!disk.isDirectory()) continue
                const instRoot = path.join(disks, disk.name, 'instances')
                if (!fs.existsSync(instRoot)) continue
                for (const ent of fs.readdirSync(instRoot, { withFileTypes: true })) {
                    if (ent.isDirectory()) dirs.push(path.join(instRoot, ent.name))
                }
            }
        } catch { /* unreadable */ }
    }
    return dirs
}

export function discoverListed(opts?: { systemInstances?: string | null; disksRoot?: string }): ListedTarget[] {
    const out: ListedTarget[] = []
    for (const dir of discoverListedDirs(opts)) {
        const t = listedFromDir(dir)
        if (t) out.push(t)
    }
    return out
}

export function discoverBundles(opts?: { systemApps?: string | null; disksRoot?: string }): BundleHook[] {
    const roots: string[] = []
    const systemApps = opts?.systemApps === undefined ? systemAppsRoot() : opts.systemApps
    if (systemApps) roots.push(systemApps)
    const disks = opts?.disksRoot ?? disksRootPath()
    if (disks && fs.existsSync(disks)) {
        try {
            for (const disk of fs.readdirSync(disks, { withFileTypes: true })) {
                if (disk.isDirectory()) roots.push(path.join(disks, disk.name, 'apps'))
            }
        } catch { /* unreadable */ }
    }
    const out: BundleHook[] = []
    for (const root of roots) {
        if (!root || !fs.existsSync(root)) continue
        let ents: fs.Dirent[] = []
        try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
        for (const ent of ents) {
            if (!ent.isDirectory()) continue
            const bundleDir = path.join(root, ent.name)
            const file = findComposeFile(bundleDir)
            if (!file) continue
            const xapp = xAppOf(loadCompose(file))
            const hook = parseHookDecl(xapp?.usage ?? null)
            if (!hook) continue
            const app = typeof xapp?.name === 'string' ? String(xapp.name).toLowerCase() : ent.name.replace(/-[\d.]+$/, '')
            const version = typeof xapp?.version === 'string' ? xapp.version : ''
            const appId = version ? `${app}-${version}` : ent.name
            const hookFile = resolveHookFile(bundleDir, hook.command[0])
            if (!hookFile) continue
            let hookScript = ''
            try { hookScript = fs.readFileSync(hookFile, 'utf8') } catch { continue }
            out.push({ app, version, appId, hook, hookScript, bundleDir })
        }
    }
    return out
}

export function resolveHookFile(bundleDir: string, command0: string | undefined): string | null {
    const basename = command0 ? path.posix.basename(command0) : 'usage.sh'
    const candidates = [
        path.join(bundleDir, 'hooks', basename),
        path.join(bundleDir, 'hooks', 'usage.sh'),
    ]
    for (const c of candidates) {
        if (fs.existsSync(c)) return c
    }
    return null
}

export function matchBundle(container: DockerContainer, bundles: BundleHook[]): BundleHook | undefined {
    const image = container.image.toLowerCase()
    const imageName = appFromImage(container.image)
    const imageTag = container.image.includes(':') ? container.image.split(':').pop() || '' : ''
    const wd = (container.workingDir || '').toLowerCase()
    return bundles.find(b => {
        const idPath = `/apps/${b.appId}`.toLowerCase()
        if (wd.includes(idPath) || wd.endsWith(`/${b.appId.toLowerCase()}`)) return true
        const nameHit = image.includes(b.app) || imageName === b.app
        const verHit = !b.version || imageTag === b.version || image.includes(b.version)
        return nameHit && verHit
    })
}

export function discoverTargets(
    containers: DockerContainer[],
    listed: ListedTarget[],
    bundles: BundleHook[],
): UsageTarget[] {
    const listedById = new Map(listed.map(t => [t.instanceId, t]))
    const runningListed = new Set<string>()
    const out: UsageTarget[] = []

    for (const c of containers) {
        const project = c.project
        if (project && listedById.has(project)) {
            runningListed.add(project)
            continue
        }
        const bundle = matchBundle(c, bundles)
        out.push({
            kind: 'unlisted',
            instanceId: syntheticInstanceId(project, c.name),
            name: project || c.name,
            app: bundle?.app ?? appFromImage(c.image),
            appVersion: bundle?.version,
            listed: false,
            containerId: c.id,
            hook: bundle?.hook ?? null,
            hookScript: bundle?.hookScript,
        })
    }
    for (const id of runningListed) {
        const t = listedById.get(id)
        if (t) out.push(t)
    }
    return out
}

export async function listDockerContainers(): Promise<DockerContainer[]> {
    const { spawn } = await import('node:child_process')
    return new Promise(resolve => {
        const child = spawn('docker', [
            'ps', '--no-trunc',
            '--format',
            '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
        ], { shell: false })
        let out = ''
        child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
        child.on('error', err => {
            usageLog(`docker ps failed: ${err.message}`)
            resolve([])
        })
        child.on('close', code => {
            if (code !== 0) {
                resolve([])
                return
            }
            const rows: DockerContainer[] = []
            for (const line of out.split('\n')) {
                if (!line.trim()) continue
                const [id, name, image, project, service, workingDir] = line.split('\t')
                if (!id) continue
                rows.push({
                    id,
                    name: name || id,
                    image: image || '',
                    project: project || undefined,
                    service: service || undefined,
                    workingDir: workingDir || undefined,
                })
            }
            resolve(rows)
        })
    })
}

export async function defaultListTargets(): Promise<UsageTarget[]> {
    const listed = discoverListed()
    const bundles = discoverBundles()
    const containers = await listDockerContainers()
    return discoverTargets(containers, listed, bundles)
}
