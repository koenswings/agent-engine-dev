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
 * If `consolePath` is empty or the directory does not exist, the static file
 * serving is skipped but /api/store-url is still available.
 *
 * The Console uses /api/store-url as:
 *   GET http://<engine-hostname>/api/store-url
 *   → { "url": "automerge:<hash>" }
 */

import http from 'http'
import path from 'path'
import { fs } from 'zx'
import { log } from '../utils/utils.js'
import { config } from '../data/Config.js'

const STORE_URL_FILE = path.join(
    config.settings.storeIdentityFolder,
    'store-url.txt'
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

const mimeType = (filePath: string): string => {
    const ext = path.extname(filePath).toLowerCase()
    return MIME_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Start the Engine HTTP server.
 *
 * @param port        TCP port to listen on (default: config.settings.httpPort)
 * @param consolePath Absolute path to Console dist/ directory (default: config.settings.consolePath)
 */
export const enableHttpMonitor = (
    port: number = config.settings.httpPort,
    consolePath: string = config.settings.consolePath
): http.Server => {

    const hasConsole = consolePath && fs.existsSync(consolePath)

    if (consolePath && !hasConsole) {
        log(`[http] consolePath "${consolePath}" not found — Console UI will not be served`)
    } else if (hasConsole) {
        log(`[http] Serving Console UI from ${consolePath}`)
    } else {
        log(`[http] No consolePath configured — Console UI will not be served`)
    }

    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/'

        // ── API routes ──────────────────────────────────────────────────────
        if (url === '/api/store-url' || url === '/api/store-url/') {
            try {
                const storeUrl = (await fs.readFile(STORE_URL_FILE, 'utf-8')).trim()
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',  // Console may be on a different origin during dev
                })
                res.end(JSON.stringify({ url: storeUrl }))
            } catch (e) {
                log(`[http] /api/store-url: failed to read store URL — ${e}`)
                res.writeHead(503, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Store URL not available yet' }))
            }
            return
        }

        // ── Static Console files ────────────────────────────────────────────
        if (!hasConsole) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Console UI not configured on this Engine')
            return
        }

        // Resolve the requested path to a file under consolePath.
        // Any path that doesn't resolve to a real file falls back to index.html
        // (SPA client-side routing).
        let filePath = path.join(consolePath, url === '/' ? 'index.html' : url)

        // Strip query strings
        filePath = filePath.split('?')[0]

        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(consolePath, 'index.html')
        }

        try {
            const data = await fs.readFile(filePath)
            res.writeHead(200, { 'Content-Type': mimeType(filePath) })
            res.end(data)
        } catch (e) {
            log(`[http] Failed to serve ${filePath}: ${e}`)
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Internal error')
        }
    })

    server.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EACCES') {
            log(`[http] Permission denied on port ${port}. Run with sudo or use a port > 1024.`)
        } else if (e.code === 'EADDRINUSE') {
            log(`[http] Port ${port} already in use.`)
        } else {
            log(`[http] Server error: ${e}`)
        }
    })

    server.listen(port, () => {
        log(`[http] Engine HTTP server listening on port ${port}`)
    })

    return server
}
