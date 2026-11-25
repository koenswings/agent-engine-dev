import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import net from 'net'
import os from 'os'
import path from 'path'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs'

/**
 * Static Console file serving stays inside consolePath: raw and encoded '..'
 * targets, backslashes, NUL bytes and symlinks that lead out of the folder are
 * refused with a bare 400/404; normal assets and the SPA fallback still work.
 * Raw sockets are used because fetch() normalises '..' before sending.
 */
const { enableHttpMonitor, resolveStaticPath } = await import('../../src/monitors/httpMonitor.js')

const SECRET = 'OUTSIDE-CONSOLE-CANARY'

const rawGet = (port: number, target: string): Promise<{ status: number, body: string }> =>
    new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => {
            s.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
        })
        let buf = ''
        s.setEncoding('latin1')
        s.on('data', (c) => { buf += c })
        s.on('error', reject)
        s.on('end', () => {
            const status = parseInt(buf.split(' ')[1] ?? '0', 10)
            resolve({ status, body: buf.split('\r\n\r\n').slice(1).join('\r\n\r\n') })
        })
    })

describe('static file serving stays inside consolePath', () => {
    let top: string
    let consoleDir: string
    let server: http.Server
    let port: number

    beforeAll(async () => {
        top = mkdtempSync(path.join(os.tmpdir(), 'idea-static-guard-'))
        consoleDir = path.join(top, 'console', 'dist')
        mkdirSync(path.join(consoleDir, 'assets'), { recursive: true })
        writeFileSync(path.join(consoleDir, 'index.html'), '<html>console-index</html>')
        writeFileSync(path.join(consoleDir, 'assets', 'app.js'), 'x=1')
        writeFileSync(path.join(consoleDir, 'assets', 'with space.css'), 'b{}')
        writeFileSync(path.join(top, 'secret.txt'), SECRET)
        writeFileSync(path.join(top, 'console', 'secret.txt'), SECRET)
        mkdirSync(path.join(top, 'console', 'dist-evil'))
        writeFileSync(path.join(top, 'console', 'dist-evil', 'x.txt'), SECRET)
        symlinkSync(path.join(top, 'secret.txt'), path.join(consoleDir, 'assets', 'link.txt'))
        symlinkSync(top, path.join(consoleDir, 'outdir'))
        server = enableHttpMonitor(0, consoleDir)
        await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())))
        port = (server.address() as AddressInfo).port
    })

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()))
        rmSync(top, { recursive: true, force: true })
    })

    it('still serves index, assets, encoded spaces and the SPA fallback', async () => {
        const idx = await rawGet(port, '/')
        expect(idx.status).toBe(200)
        expect(idx.body).toContain('console-index')
        const js = await rawGet(port, '/assets/app.js?v=3')
        expect(js.status).toBe(200)
        expect(js.body).toContain('x=1')
        const css = await rawGet(port, '/assets/with%20space.css')
        expect(css.status).toBe(200)
        expect(css.body).toContain('b{}')
        const spa = await rawGet(port, '/instances/abc/settings')
        expect(spa.status).toBe(200)
        expect(spa.body).toContain('console-index')
        const dir = await rawGet(port, '/assets/')
        expect(dir.status).toBe(200)
        expect(dir.body).toContain('console-index')
        const dbl = await rawGet(port, '//assets/app.js')
        expect(dbl.status).toBe(200)
        expect(dbl.body).toContain('x=1')
    })

    const traversals = [
        '/../secret.txt',
        '/../../secret.txt',
        '/assets/../../secret.txt',
        '/../dist-evil/x.txt',
        '/../../../../../../../../etc/hostname',
        '/%2e%2e/secret.txt',
        '/%2E%2E/%2E%2E/secret.txt',
        '/..%2fsecret.txt',
        '/..%2F..%2Fsecret.txt',
        '/%2e%2e%2f%2e%2e%2fsecret.txt',
        '/..%5c..%5csecret.txt',
        '/..\\..\\secret.txt',
        '/index.html%00.js',
        '/%252e%252e/secret.txt',
        '/./index.html',
        '/assets/%',
        '../secret.txt',
        'http://localhost/../secret.txt',
    ]
    for (const t of traversals) {
        it(`refuses ${JSON.stringify(t)} with 400/404 and no file content`, async () => {
            const r = await rawGet(port, t)
            expect([400, 404]).toContain(r.status)
            expect(r.body).not.toContain(SECRET)
            expect(r.body).not.toContain('console-index')
            expect(r.body.length).toBeLessThan(64)
        })
    }

    it('refuses a symlinked file or folder that leads out of consolePath (404)', async () => {
        for (const t of ['/assets/link.txt', '/outdir/secret.txt']) {
            const r = await rawGet(port, t)
            expect(r.status).toBe(404)
            expect(r.body).not.toContain(SECRET)
        }
    })

    it('resolveStaticPath: inside → file, fallback → index, outside → reject', () => {
        expect(resolveStaticPath(consoleDir, '/assets/app.js')).toMatchObject({ kind: 'file' })
        expect(resolveStaticPath(consoleDir, '/nope')).toMatchObject({ kind: 'file', filePath: expect.stringMatching(/index\.html$/) })
        expect(resolveStaticPath(consoleDir, '/../secret.txt')).toEqual({ kind: 'reject', status: 400 })
        expect(resolveStaticPath(consoleDir, '/%2e%2e/secret.txt')).toEqual({ kind: 'reject', status: 400 })
        expect(resolveStaticPath(consoleDir, '/assets/link.txt')).toEqual({ kind: 'reject', status: 404 })
    })

    it('a sibling folder whose name starts with the consolePath name is outside', () => {
        // consolePath …/dist vs …/dist-evil: a plain startsWith(root) would let this through
        const r = resolveStaticPath(consoleDir, '/../dist-evil/x.txt')
        expect(r.kind).toBe('reject')
    })
})
