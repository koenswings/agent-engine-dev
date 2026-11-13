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

describe('portReadyTimeoutMs (idea#437)', () => {
  it('takes a valid x-app.healthTimeout in seconds, whatever the App', async () => {
    const { portReadyTimeoutMs } = await import('../../src/data/Instance.js')
    expect(portReadyTimeoutMs('nextcloud', 300)).toBe(300_000)
    expect(portReadyTimeoutMs('kiwix', '90')).toBe(90_000)
    expect(portReadyTimeoutMs('kolibri', 120)).toBe(120_000)
  })

  it('falls back to updateApp\'s per-App defaults, not 60 s (Steve decision 3)', async () => {
    const { portReadyTimeoutMs } = await import('../../src/data/Instance.js')
    expect(portReadyTimeoutMs('nextcloud')).toBe(300_000)
    expect(portReadyTimeoutMs('kolibri')).toBe(900_000)
    expect(portReadyTimeoutMs('Kolibri')).toBe(900_000)
    expect(portReadyTimeoutMs('kiwix')).toBe(600_000)
    expect(portReadyTimeoutMs('')).toBe(600_000)
    for (const bad of [undefined, null, 0, -5, NaN, 'nope', {}]) {
      expect(portReadyTimeoutMs('kiwix', bad)).toBe(600_000)
      expect(portReadyTimeoutMs('kolibri', bad)).toBe(900_000)
      expect(portReadyTimeoutMs('nextcloud', bad)).toBe(300_000)
    }
    for (const app of ['nextcloud', 'kolibri', 'kiwix', 'milkwise', 'sample']) {
      expect(portReadyTimeoutMs(app)).not.toBe(60_000)
    }
  })

  it('60 s fallback constant is gone from Instance.ts', async () => {
    const instance: Record<string, unknown> = await import('../../src/data/Instance.js')
    expect(instance.DEFAULT_PORT_READY_TIMEOUT_MS).toBeUndefined()
  })

  it('updateApp and the port-ready check read ONE shared table (AppHealthTimeout.ts)', async () => {
    const shared = await import('../../src/data/AppHealthTimeout.js')
    const policy = await import('../../src/data/UpdateAppPolicy.js')
    const { portReadyTimeoutMs } = await import('../../src/data/Instance.js')
    expect(policy.healthTimeoutSeconds).toBe(shared.healthTimeoutSeconds)
    expect(policy.APP_HEALTH_TIMEOUT_S).toBe(shared.APP_HEALTH_TIMEOUT_S)
    expect(shared.APP_HEALTH_TIMEOUT_S).toEqual({ kolibri: 900, nextcloud: 300 })
    expect(shared.DEFAULT_HEALTH_TIMEOUT_S).toBe(600)
    expect(Object.isFrozen(shared.APP_HEALTH_TIMEOUT_S)).toBe(true)
    for (const app of ['nextcloud', 'kolibri', 'kiwix', 'milkwise']) {
      for (const declared of [undefined, 45, 'junk']) {
        expect(portReadyTimeoutMs(app, declared)).toBe(policy.healthTimeoutSeconds(app, declared) * 1000)
      }
    }
  })

  it('runInstance takes the App name from instanceOf the same way updateApp does (parseAppId)', async () => {
    const { parseAppId } = await import('../../src/data/App.js')
    const { portReadyTimeoutMs } = await import('../../src/data/Instance.js')
    expect(portReadyTimeoutMs(parseAppId('kolibri-0.19.5').name)).toBe(900_000)
    expect(portReadyTimeoutMs(parseAppId('nextcloud-1.4').name)).toBe(300_000)
    expect(portReadyTimeoutMs(parseAppId('kiwix-3.7').name)).toBe(600_000)
  })

  it('reads healthTimeout from compose.yaml and falls back to the per-App default when missing', async () => {
    const { readPortReadyTimeoutMs } = await import('../../src/data/Instance.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-port-ready-compose-'))
    try {
      const withField = path.join(dir, 'with.yaml')
      const withoutField = path.join(dir, 'without.yaml')
      await fs.outputFile(withField, 'x-app:\n  name: nextcloud\n  healthTimeout: 300\n')
      await fs.outputFile(withoutField, 'x-app:\n  name: kiwix\n')
      expect(await readPortReadyTimeoutMs(withField, 'nextcloud')).toBe(300_000)
      expect(await readPortReadyTimeoutMs(withoutField, 'kiwix')).toBe(600_000)
      expect(await readPortReadyTimeoutMs(withoutField, 'kolibri')).toBe(900_000)
      expect(await readPortReadyTimeoutMs(path.join(dir, 'missing.yaml'), 'nextcloud')).toBe(300_000)
      expect(await readPortReadyTimeoutMs(path.join(dir, 'missing.yaml'), 'kiwix')).toBe(600_000)
    } finally {
      await fs.remove(dir)
    }
  })
})

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

  it('TCP-up-no-HTTP waits up to the budget then fails without recreating', async () => {
    // docker-proxy analogue: accept the connection and never write a status line.
    const s = await track(listenTcp())
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    const budget = 400
    const started = Date.now()
    const err = await assertInstancePortReady('proxy-only' as any, s.port, await freshDir(), {
      readyTimeoutMs: budget,
      stableMs: 50,
      forceRecreate: true,
      probeTimeoutMs: 80,
    }).then(
      () => { throw new Error('expected assertInstancePortReady to reject') },
      (e: unknown) => e as Error,
    )
    const elapsed = Date.now() - started
    expect(err.message).toMatch(/without answering HTTP/)
    expect(err.message).not.toMatch(/force-recreate/)
    expect(elapsed).toBeGreaterThanOrEqual(budget - 30)
    expect(elapsed).toBeLessThan(budget * 2)
  })

  it('force-recreates once when TCP never comes up, without starting a second budget', async () => {
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    let recreates = 0
    const budget = 600
    const started = Date.now()
    const err = await assertInstancePortReady('dead-tcp' as any, 59998, await freshDir(), {
      readyTimeoutMs: budget,
      stableMs: 20,
      forceRecreate: true,
      probeTimeoutMs: 40,
      recreateAfterMs: 150,
      runForceRecreate: async () => { recreates += 1 },
    }).then(
      () => { throw new Error('expected assertInstancePortReady to reject') },
      (e: unknown) => e as Error,
    )
    const elapsed = Date.now() - started
    expect(recreates).toBe(1)
    expect(err.message).toMatch(/never stayed ready/)
    expect(err.message).toMatch(/force-recreate/)
    expect(elapsed).toBeGreaterThanOrEqual(budget - 40)
    expect(elapsed).toBeLessThan(budget * 2)
  })

  it('does not force-recreate when the budget leaves no time after the TCP-down threshold', async () => {
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    let recreates = 0
    await expect(
      assertInstancePortReady('no-window' as any, 59997, await freshDir(), {
        readyTimeoutMs: 80,
        stableMs: 20,
        forceRecreate: true,
        probeTimeoutMs: 30,
        recreateAfterMs: 80,
        runForceRecreate: async () => { recreates += 1 },
      }),
    ).rejects.toThrow(/never stayed ready/)
    expect(recreates).toBe(0)
  })
})
