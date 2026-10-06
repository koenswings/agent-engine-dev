/**
 * r40: assertInstancePortReady must not mark a dead sidecar as OK.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fs } from 'zx'
import path from 'path'
import os from 'os'
import * as utils from '../../src/utils/utils.js'

describe('assertInstancePortReady (r40)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-port-ready-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.remove(dir)
  })

  it('returns immediately when port is 0 / missing', async () => {
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    await assertInstancePortReady('inst' as any, 0, dir, { readyTimeoutMs: 100, stableMs: 50, forceRecreate: false })
  })

  it('throws when the port never becomes ready (no force-recreate)', async () => {
    vi.spyOn(utils, 'isEngineOnline').mockResolvedValue(false)
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    await expect(
      assertInstancePortReady('dead-inst' as any, 59999, dir, {
        readyTimeoutMs: 50,
        stableMs: 20,
        forceRecreate: false,
      }),
    ).rejects.toThrow(/never stayed ready/)
  })

  it('succeeds when the port stays up for stableMs', async () => {
    vi.spyOn(utils, 'isEngineOnline').mockResolvedValue(true)
    const { assertInstancePortReady } = await import('../../src/data/Instance.js')
    await assertInstancePortReady('ok-inst' as any, 18080, dir, {
      readyTimeoutMs: 5_000,
      stableMs: 50,
      forceRecreate: false,
    })
  })
})
