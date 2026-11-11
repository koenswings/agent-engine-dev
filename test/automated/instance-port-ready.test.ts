/**
 * r40 / idea#437: assertInstancePortReady must not mark a dead sidecar as OK,
 * and must not treat docker-proxy's TCP accept as HTTP-ready.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { fs } from 'zx'
import path from 'path'
import os from 'os'
import http from 'http'
import net from 'net'
import type { AddressInfo } from 'net'

const listenTcp = async (handler?: (socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> => {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    if (handler) handler(socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise((resolve, reject) => {
      for (const s of sockets) s.destroy()
      server.close(err => err ? reject(err) : resolve())
    }),
  }
}

const listenHttp = async (status: number): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = http.createServer((_req, res) => {
    if (status === 302) res.writeHead(302, { Location: '/elsewhere' })
    else res.writeHead(status)
    res.end(status === 302 ? '' : 'ok')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
  }
}

describe('assertInstancePortReady (r40 / idea#437)', () => {
  let dir: string | undefined
  const servers: Array<{ close: () => Promise<void> }> = []

  const track = async <T extends { close: () => Promise<void> }>(started: Promise<T> | T): Promise<T> => {
    const s = await started
    servers.push(s)
    return s
  }

  afterEach(async () => {
    while (servers.length) await servers.pop()!.close().catch(() => undefined)
    if (dir) await fs.remove(dir)
  })

  const freshDir = async (): Promise<string> => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-port-ready-'))
    dir = created
    return created
  }

  it('returns immediately when port is 0 / missing', async () => {
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    await assertInstancePortReady('inst' as any, 0, await freshDir(), { readyTimeoutMs: 100, stableMs: 50, forceRecreate: false })
  })

  it('throws when the port never becomes ready (no force-recreate)', async () => {
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    await expect(
      assertInstancePortReady('dead-inst' as any, 59999, await freshDir(), {
        readyTimeoutMs: 50,
        stableMs: 20,
        forceRecreate: false,
      }),
    ).rejects.toThrow(/never stayed ready/)
  })

  it('tcp probe succeeds when the port accepts TCP for stableMs', async () => {
    const s = await track(listenTcp())
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    await assertInstancePortReady('ok-tcp' as any, s.port, await freshDir(), {
      readyTimeoutMs: 5_000,
      stableMs: 50,
      forceRecreate: false,
      probe: 'tcp',
    })
  })

  for (const status of [200, 302, 503] as const) {
    it(`succeeds when HTTP ${status} stays up for stableMs`, async () => {
      const s = await track(listenHttp(status))
      const { assertInstancePortReady } = await import('../../src/data/Instance.js')
      await assertInstancePortReady('ok-http' as any, s.port, await freshDir(), {
        readyTimeoutMs: 5_000,
        stableMs: 50,
        forceRecreate: false,
      })
    })
  }

  it('fails when the port accepts TCP but never answers HTTP', async () => {
    // docker-proxy analogue: accept the connection and never write a status line.
    const s = await track(listenTcp())
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    await expect(
      assertInstancePortReady('proxy-only' as any, s.port, await freshDir(), {
        readyTimeoutMs: 400,
        stableMs: 50,
        forceRecreate: false,
        probeTimeoutMs: 80,
      }),
    ).rejects.toThrow(/without answering HTTP/)
  })

  it('does not force-recreate when TCP accepts but HTTP never answers', async () => {
    const s = await track(listenTcp())
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    const err = await assertInstancePortReady('no-recreate' as any, s.port, await freshDir(), {
      readyTimeoutMs: 400,
      stableMs: 50,
      forceRecreate: true,
      probeTimeoutMs: 80,
    }).then(
      () => { throw new Error('expected assertInstancePortReady to reject') },
      (e: unknown) => e as Error,
    )
    expect(err.message).toMatch(/without answering HTTP/)
    expect(err.message).not.toMatch(/force-recreate/)
  })
})
