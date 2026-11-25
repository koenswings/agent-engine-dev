/**
 * httpMonitor.ts — Engine HTTP server
 *
 * Responsibilities:
 *   1. Serve the Console production web app (static files from `consolePath`)
 *   2. Expose GET /api/store-url — returns the Automerge document URL so the
 *      Console can discover it automatically without manual configuration
 *
 * Port: configurable via `config.yaml` settings.httpPort (default 80).
 *
 * idea#203: clients open `http://idea.local` (port 80) and must get the Console of
 * whichever Engine holds that name. When httpPort is not 80 (e.g. an Engine that
 * serves its Console on :8080), start.ts passes `alsoPort` = settings.ideaLocalHttpPort
 * (default 80) and the same handler (Console + API) is also served there, so
 * same-origin calls such as /api/store-url keep working. Closing the main server
 * closes the extra listener.
 *
 * If `consolePath` is empty, static requests get 404 "Console UI not configured". If it is
 * set but `<consolePath>/index.html` is missing (e.g. mid-rebuild), they get 503 "Console UI
 * not built yet" and the check is repeated on every request, so a Console built after the
 * Engine started is served without a restart (agent-engine-dev#264). /api/* always works:
 * known routes return JSON, and unknown /api/* paths return a JSON 404 (engine#357)
 * instead of the Console SPA fallback, so a typo does not look like success.
 *
 * The Console uses /api/store-url as:
 *   GET http://<engine-hostname>/api/store-url
 *   → { "url": "automerge:<hash>", "wsPort": 4321 }
 *
 * CORS (engine#582): /api/* answers carry Access-Control-Allow-Origin only for this
 * Engine's own Console origins and settings.devConsoleOrigins (consoleOrigins.ts);
 * OPTIONS on /api/* is answered for preflights.
 *
 * `wsPort` is the Engine's effective WebSocket port (config.yaml settings.port,
 * after the IDEA_ENGINE_PORT override in Config.ts), so the Console does not
 * have to assume the default. `url` is unchanged for backward compatibility.
 */

import http from 'http'
import net from 'net'
import path from 'path'
import { fs } from 'zx'
import { log } from '../utils/utils.js'
import { config } from '../data/Config.js'
import type { DocHandle } from '@automerge/automerge-repo'
import type { CommandLogStore } from '../data/CommandLogStore.js'
import { corsHeadersFor, CORS_PREFLIGHT_HEADERS } from './consoleOrigins.js'
import { handleAuthApi, AuthContext } from './authApi.js'
import { handleCommandApi } from './commandApi.js'

const STORE_URL_FILE = path.join(
    config.settings.storeIdentityFolder,
    'store-url.txt'
)

const COMMAND_LOG_URL_FILE = path.join(
    config.settings.storeIdentityFolder,
    'command-log-url.txt'
)

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
}

/** JSON payload returned by GET /api/store-url. */
export interface StoreUrlPayload {
    url: string
    wsPort: number
    /** idea#203 / Console #159: which Engine answered (behind idea.local the Console must know). Omitted when unknown. */
    engineId?: string
}

/**
 * Build the /api/store-url response body.
 *
 * @param storeUrl Automerge store document URL (as read from store-url.txt)
 * @param wsPort   Effective WebSocket port (default: config.settings.port, which
 *                 already has the IDEA_ENGINE_PORT override applied)
 */
export const buildStoreUrlPayload = (
    storeUrl: string,
    wsPort: number = config.settings.port,
    engineId?: string
): StoreUrlPayload => (engineId ? { url: storeUrl, wsPort, engineId } : { url: storeUrl, wsPort })

const mimeType = (filePath: string): string => {
    const ext = path.extname(filePath).toLowerCase()
    return MIME_TYPES[ext] ?? 'application/octet-stream'
}

/** Result of resolveStaticPath: a file to serve, or a status to answer with (no body detail). */
export type StaticPathResult =
    | { kind: 'file', filePath: string }
    | { kind: 'reject', status: 400 | 404 }

const isInside = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep)

/**
 * Map a raw request target to a file under consolePath, or refuse it.
 *
 * - The query and fragment are dropped; the target must start with '/'.
 * - Encoded dots, slashes, backslashes and NUL (%2e, %2f, %5c, %00), raw
 *   backslashes and NUL bytes, malformed escapes, double-encoded forms of these
 *   and '.' or '..' segments → 400.
 * - The decoded path is resolved under the real consolePath and must stay inside it.
 * - An existing file must also be inside after symlinks are resolved (realpath);
 *   a symlink that leads out of the folder → 404.
 * - A path inside the folder that is no file (missing or a directory) gets
 *   index.html, the SPA fallback, as before.
 */
export const resolveStaticPath = (consolePath: string, rawUrl: string): StaticPathResult => {
    const bad: StaticPathResult = { kind: 'reject', status: 400 }
    const target = String(rawUrl ?? '/').split('?')[0].split('#')[0]
    if (!target.startsWith('/')) return bad
    if (target.includes('\\') || target.includes('\0') || /%(2e|2f|5c|00)/i.test(target)) return bad
    let decoded: string
    try { decoded = decodeURIComponent(target) } catch { return bad }
    if (decoded.includes('\0') || decoded.includes('\\') || /%(2e|2f|5c|00)/i.test(decoded)) return bad  // also double-encoded
    if (decoded.split('/').some(seg => seg === '..' || seg === '.')) return bad

    let root: string
    try { root = fs.realpathSync(path.resolve(consolePath)) } catch { return { kind: 'reject', status: 404 } }
    const index = path.join(root, 'index.html')
    const rel = decoded === '/' ? 'index.html' : '.' + decoded
    const candidate = path.resolve(root, rel)
    if (!isInside(root, candidate)) return bad

    let real: string
    try { real = fs.realpathSync(candidate) } catch { return { kind: 'file', filePath: index } }  // missing → SPA fallback
    if (!isInside(root, real)) return { kind: 'reject', status: 404 }
    try { if (!fs.statSync(real).isFile()) return { kind: 'file', filePath: index } } catch { return { kind: 'file', filePath: index } }
    return { kind: 'file', filePath: real }
}

/**
 * Start the Engine HTTP server.
 *
 * @param port        TCP port to listen on (default: config.settings.httpPort)
 * @param consolePath Absolute path to Console dist/ directory (default: config.settings.consolePath)
 */
export const enableHttpMonitor = (
    port: number = config.settings.httpPort,
    consolePath: string = config.settings.consolePath,
    _commandLogHandle?: DocHandle<CommandLogStore> | null,  // unused at runtime — URL comes from disk
    alsoPort?: number,     // idea#203: also serve on this port (idea.local, :80) when it differs from `port`
    opts: { engineId?: string, wsPort?: number, auth?: AuthContext } = {},  // engineId for /api/store-url; wsPort = Engine WebSocket port for Upgrade pass-through; auth = /api/auth/* (engine#582)
): http.Server => {

    // agent-engine-dev#264: the Console is not settled at startup. A build that lands after
    // the Engine started (vite empties dist/ first) is served on the next request, no restart.
    let lastState: 'none' | 'missing' | 'ready' | null = null
    const consoleState = (): 'none' | 'missing' | 'ready' => {
        const state = !consolePath ? 'none'
            : fs.existsSync(path.join(consolePath, 'index.html')) ? 'ready' : 'missing'
        if (state !== lastState) {
            lastState = state
            if (state === 'ready') log(`[http] Serving Console UI from ${consolePath}`)
            else if (state === 'missing') log(`[http] Console UI not built yet in "${consolePath}" (no index.html) — answering 503 until it appears`)
            else log(`[http] No consolePath configured — Console UI will not be served`)
        }
        return state
    }
    consoleState()

    const handler: http.RequestListener = async (req, res) => {
        const url = req.url ?? '/'
        // engine#582: CORS only for this Engine's own Console origins (consoleOrigins.ts)
        const cors = corsHeadersFor(req, [port, alsoPort, config.settings.httpPort, config.settings.ideaLocalHttpPort ?? 80])
        const apiPathOnly = (url.split('?')[0] ?? '/')
        if (req.method === 'OPTIONS' && (apiPathOnly === '/api' || apiPathOnly.startsWith('/api/'))) {
            res.writeHead(204, cors['Access-Control-Allow-Origin'] ? { ...cors, ...CORS_PREFLIGHT_HEADERS } : cors)
            res.end()
            return
        }

        // ── API routes ──────────────────────────────────────────────────────
        if (url === '/api/store-url' || url === '/api/store-url/') {
            try {
                const storeUrl = (await fs.readFile(STORE_URL_FILE, 'utf-8')).trim()
                res.writeHead(200, { 'Content-Type': 'application/json', ...cors })
                res.end(JSON.stringify(buildStoreUrlPayload(storeUrl, undefined, opts.engineId)))
            } catch (e) {
                log(`[http] /api/store-url: failed to read store URL — ${e}`)
                res.writeHead(503, { 'Content-Type': 'application/json', ...cors })
                res.end(JSON.stringify({ error: 'Store URL not available yet' }))
            }
            return
        }

        if (url === '/api/command-log-url' || url === '/api/command-log-url/') {
            try {
                const logUrl = (await fs.readFile(COMMAND_LOG_URL_FILE, 'utf-8')).trim()
                res.writeHead(200, { 'Content-Type': 'application/json', ...cors })
                res.end(JSON.stringify({ url: logUrl }))
            } catch (e) {
                log(`[http] /api/command-log-url: failed to read URL — ${e}`)
                res.writeHead(503, { 'Content-Type': 'application/json', ...cors })
                res.end(JSON.stringify({ error: 'Command log URL not available yet' }))
            }
            return
        }

        // engine#582: Engine sign-in (authApi.ts). Without an auth context (older callers) these are 404s.
        if (opts.auth && (apiPathOnly === '/api/auth' || apiPathOnly.startsWith('/api/auth/'))) {
            if (await handleAuthApi(req, res, apiPathOnly, cors, opts.auth)) return
        }
        // engine#582: signed commands (commandApi.ts) — operator token or peer grant.
        if (opts.auth && (apiPathOnly === '/api/command' || apiPathOnly === '/api/command/')) {
            if (await handleCommandApi(req, res, apiPathOnly, cors, opts.auth)) return
        }

        // engine#357: unknown /api/* is a JSON 404, never the Console SPA fallback.
        // engine#582: contract error shape { error: 'NOT_FOUND', message }; CORS headers as the 503s above.
        const apiPath = (url.split('?')[0] ?? '/')
        if (apiPath === '/api' || apiPath.startsWith('/api/')) {
            res.writeHead(404, { 'Content-Type': 'application/json', ...cors })
            res.end(JSON.stringify({ error: 'NOT_FOUND', message: `No API route ${apiPath} on this Engine.` }))
            return
        }

        // ── Static Console files ────────────────────────────────────────────
        const state = consoleState()
        if (state === 'none') {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Console UI not configured on this Engine')
            return
        }
        if (state === 'missing') {
            res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' })
            res.end('Console UI not built yet on this Engine')
            return
        }

        // Resolve the requested path to a file strictly under consolePath (resolveStaticPath).
        // A path that stays inside but is not a file falls back to index.html (SPA
        // client-side routing); anything that tries to leave the folder is refused.
        const resolved = resolveStaticPath(consolePath, url)
        if (resolved.kind === 'reject') {
            res.writeHead(resolved.status, { 'Content-Type': 'text/plain' })
            res.end(resolved.status === 400 ? 'Bad request' : 'Not found')
            return
        }
        const filePath = resolved.filePath

        try {
            const data = await fs.readFile(filePath)
            res.writeHead(200, { 'Content-Type': mimeType(filePath) })
            res.end(data)
        } catch (e) {
            log(`[http] Failed to serve ${filePath}: ${e}`)
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Internal error')
        }
    }

    const listen = (p: number, what: string): http.Server => {
        const srv = http.createServer(handler)
        // idea#203: a WebSocket Upgrade on the HTTP port(s) is passed through to the Engine's
        // WebSocket server (127.0.0.1:wsPort), so the store sync also works via http://idea.local.
        srv.on('upgrade', (req, socket, head) => {
            const wsPort = opts.wsPort ?? config.settings.port
            const up = net.connect(wsPort, '127.0.0.1', () => {
                const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
                for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
                up.write(lines.join('\r\n') + '\r\n\r\n')
                if (head?.length) up.write(head)
                up.pipe(socket); socket.pipe(up)
            })
            const end = () => { up.destroy(); socket.destroy() }
            up.on('error', end); socket.on('error', end); up.on('close', end); socket.on('close', end)
        })
        srv.on('error', (e: NodeJS.ErrnoException) => {
            if (e.code === 'EACCES') {
                log(`[http] Permission denied on port ${p} (${what}). Grant node cap_net_bind_service or use a port > 1024.`)
            } else if (e.code === 'EADDRINUSE') {
                log(`[http] Port ${p} already in use (${what}).`)
            } else {
                log(`[http] Server error on port ${p} (${what}): ${e}`)
            }
        })
        srv.listen(p, () => {
            log(`[http] Engine HTTP server listening on port ${(srv.address() as any)?.port ?? p} (${what})`)
        })
        return srv
    }

    const server = listen(port, 'Console')
    if (alsoPort !== undefined && alsoPort !== port) {
        const extra = listen(alsoPort, 'idea.local Console')
        ;(server as any).ideaLocalServer = extra
        server.on('close', () => { if (extra.listening) extra.close() })
    }

    return server
}
