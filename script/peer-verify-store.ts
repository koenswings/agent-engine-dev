/**
 * peer-verify-store.ts — the store side of script/peer-verify.sh (per-Pi Engine keys).
 *
 * Talks to ONE Engine the way the Console and the duration harness do: GET
 * http://<host>/api/store-url, then the Automerge store over ws://<host>:<wsPort>.
 * Read-only except `push-command` (what the Console does to run a command, e.g.
 * copyApp / ejectDisk) and `purge` (removes the scratch rows peer-verify created,
 * by exact id, like the harness's purgeInstancesStoredOn).
 *
 *   tsx script/peer-verify-store.ts <host> dump [--instances a,b] [--disks c,d] [--ops-since <ms>]
 *   tsx script/peer-verify-store.ts <host> push-command <engineId> <command…>
 *   tsx script/peer-verify-store.ts <host> purge [--instances a,b] [--disks c,d]
 *
 * Output: one JSON object on stdout. Exit 0 ok, 1 error (message on stderr).
 * Env: PV_HTTP_PORT (80), PV_STORE_TIMEOUT_MS (45000), PV_STORE_URL / PV_WS_PORT (skip HTTP).
 */
import { Repo, type DocHandle, type DocumentId, type PeerId } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'

const [host, cmd, ...rest] = process.argv.slice(2)
const TIMEOUT = Number(process.env.PV_STORE_TIMEOUT_MS ?? 45000)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const die = (msg: string): never => { process.stderr.write(`peer-verify-store: ${msg}\n`); process.exit(1) }
const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> =>
    Promise.race([p, sleep(TIMEOUT).then(() => die(`${what} timed out after ${TIMEOUT} ms`))]) as Promise<T>

const flag = (name: string): string[] => {
    const i = rest.indexOf(`--${name}`)
    return i === -1 ? [] : (rest[i + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

const storeEndpoint = async (): Promise<{ docId: DocumentId, wsPort: number }> => {
    if (process.env.PV_STORE_URL) return { docId: process.env.PV_STORE_URL.replace(/^automerge:/, '') as DocumentId, wsPort: Number(process.env.PV_WS_PORT ?? 4321) }
    const res = await withTimeout(fetch(`http://${host}:${process.env.PV_HTTP_PORT ?? 80}/api/store-url`), 'GET /api/store-url')
    if (!res.ok) die(`GET http://${host}/api/store-url: HTTP ${res.status}`)
    const body = await res.json() as { url?: string, wsPort?: number }
    if (!body.url?.startsWith('automerge:')) die(`GET /api/store-url gave no automerge URL: ${JSON.stringify(body)}`)
    return { docId: body.url!.replace(/^automerge:/, '') as DocumentId, wsPort: Number(body.wsPort ?? 4321) }
}

const main = async () => {
    if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) die('usage: peer-verify-store.ts <host> dump|push-command|purge …')
    const { docId, wsPort } = await storeEndpoint()
    const repo = new Repo({ network: [new WebSocketClientAdapter(`ws://${host}:${wsPort}`, 2000)], peerId: `peer-verify-${process.pid}-${Date.now()}` as PeerId })
    const handle: DocHandle<any> = await withTimeout(repo.find<any>(docId), `opening store ${docId} on ${host}`)
    await withTimeout(handle.whenReady(), `syncing store ${docId} on ${host}`)
    const doc = handle.doc()
    if (!doc) die(`store ${docId} on ${host} is empty`)
    let out: unknown
    if (cmd === 'dump') {
        const wantInst = new Set(flag('instances'))
        const wantDisks = new Set(flag('disks'))
        const opsSince = Number(flag('ops-since')[0] ?? NaN)
        const engineDB: Record<string, unknown> = {}
        for (const [id, e] of Object.entries<any>(doc.engineDB ?? {})) {
            engineDB[id] = {
                hostname: e?.hostname ?? null, lastRun: e?.lastRun ?? null, lastBooted: e?.lastBooted ?? null,
                version: e?.version ?? null, commands: [...(e?.commands ?? [])],
                peerAccess: e?.peerAccess == null ? (e?.peerAccess === null ? null : undefined)
                    : { sshKey: e.peerAccess.sshKey, hostKey: e.peerAccess.hostKey, publishedAt: e.peerAccess.publishedAt, authorized: [...(e.peerAccess.authorized ?? [])] },
            }
        }
        const diskDB: Record<string, unknown> = {}
        for (const [id, d] of Object.entries<any>(doc.diskDB ?? {})) {
            if (wantDisks.has(id)) diskDB[id] = { id, name: d?.name ?? null, dockedTo: d?.dockedTo ?? null, device: d?.device ?? null, diskTypes: [...(d?.diskTypes ?? [])] }
        }
        const instanceDB: Record<string, unknown> = {}
        for (const [id, i] of Object.entries<any>(doc.instanceDB ?? {})) {
            if (wantInst.has(id) || (i?.storedOn != null && wantDisks.has(String(i.storedOn)))) {
                instanceDB[id] = { id, name: i?.name ?? null, instanceOf: i?.instanceOf ?? null, storedOn: i?.storedOn ?? null, status: i?.status ?? null, created: i?.created ?? null }
            }
        }
        const operations: unknown[] = []
        if (Number.isFinite(opsSince)) {
            for (const [id, o] of Object.entries<any>(doc.operationDB ?? {})) {
                const t = Number(o?.startedAt ?? 0)
                if (t >= opsSince) operations.push({ id, kind: o?.kind ?? null, status: o?.status ?? null, error: o?.error ?? null, args: o?.args ?? null, engineId: o?.engineId ?? null, startedAt: t, completedAt: o?.completedAt ?? null })
            }
        }
        out = { docId, engineDB, diskDB, instanceDB, operations }
    } else if (cmd === 'push-command') {
        const [engineId, ...words] = rest
        const command = words.join(' ')
        if (!engineId || !command) die('push-command <engineId> <command…>')
        if (!doc.engineDB?.[engineId]) die(`Engine ${engineId} is not in the store on ${host}`)
        handle.change((d: any) => { d.engineDB[engineId].commands.push(command) })
        await sleep(3000)   // let the change reach the Engine before the socket closes
        out = { pushed: command, engineId }
    } else if (cmd === 'purge') {
        const inst = flag('instances')
        const disks = flag('disks')
        const removed: string[] = []
        const kept: string[] = []
        handle.change((d: any) => {
            for (const id of inst) if (d.instanceDB?.[id]) { delete d.instanceDB[id]; removed.push(`instance ${id}`) }
            for (const id of disks) {
                const disk = d.diskDB?.[id]
                if (!disk) continue
                if (disk.dockedTo) { kept.push(`disk ${id} (still docked to ${disk.dockedTo})`); continue }
                delete d.diskDB[id]; removed.push(`disk ${id}`)
            }
        })
        await sleep(3000)
        out = { removed, kept }
    } else {
        die(`unknown command '${cmd}'`)
    }
    // a pipe takes large output asynchronously: exit only once it is flushed
    await new Promise<void>(resolve => process.stdout.write(JSON.stringify(out) + '\n', () => resolve()))
    await repo.shutdown().catch(() => undefined)
    process.exit(0)
}

main().catch(e => die(e?.stack ?? String(e)))
