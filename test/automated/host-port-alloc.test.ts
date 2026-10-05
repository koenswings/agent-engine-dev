/**
 * Prefer A r30: host-port allocation helpers (Console :8080 reserved; Kolibri listen sync).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs, YAML } from 'zx'
import path from 'path'
import os from 'os'
import {
  RESERVED_HOST_PORTS,
  isReservedHostPort,
  syncKolibriHostListenPort,
} from '../../src/data/Instance.js'
import type { PortNumber } from '../../src/data/CommonTypes.js'

describe('host port allocation (Prefer A r30)', () => {
  it('reserves Console / legacy proxy ports', () => {
    expect(isReservedHostPort(8080)).to.equal(true)
    expect(isReservedHostPort(80)).to.equal(true)
    expect(isReservedHostPort(18080)).to.equal(false)
    expect(isReservedHostPort(49152)).to.equal(false)
    expect(RESERVED_HOST_PORTS.has(8080)).to.equal(true)
  })

  describe('syncKolibriHostListenPort', () => {
    let dir: string
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-host-port-'))
    })
    afterEach(async () => {
      await fs.remove(dir)
    })

    it('injects KOLIBRI_* listen env on host-network kolibri when missing (tag 1.0 shape)', async () => {
      const composePath = path.join(dir, 'compose.yaml')
      await fs.writeFile(composePath, YAML.stringify({
        'x-app': { name: 'kolibri' },
        services: {
          kolibri: {
            image: 'koenswings/kolibri:1.0-0.15.5-dev',
            network_mode: 'host',
            environment: ['KOLIBRI_RUN_MODE=docker'],
          },
        },
      }))
      await syncKolibriHostListenPort(composePath, 51234 as PortNumber)
      const compose = YAML.parse(await fs.readFile(composePath, 'utf8'))
      const env: string[] = compose.services.kolibri.environment
      expect(env).to.include('KOLIBRI_HTTP_PORT=51234')
      expect(env).to.include('KOLIBRI_LISTEN_PORT=51234')
      expect(env).to.include('KOLIBRI_RUN_MODE=docker')
    })

    it('rewrites hardcoded fixture 18080 when Engine reallocates', async () => {
      const composePath = path.join(dir, 'compose.yaml')
      await fs.writeFile(composePath, YAML.stringify({
        services: {
          kolibri: {
            image: 'koenswings/kolibri:1.0-0.15.5-dev',
            network_mode: 'host',
            environment: [
              'KOLIBRI_RUN_MODE=docker',
              'KOLIBRI_HTTP_PORT=18080',
              'KOLIBRI_LISTEN_PORT=18080',
            ],
          },
        },
      }))
      await syncKolibriHostListenPort(composePath, 19090 as PortNumber)
      const compose = YAML.parse(await fs.readFile(composePath, 'utf8'))
      const env: string[] = compose.services.kolibri.environment
      expect(env).to.include('KOLIBRI_HTTP_PORT=19090')
      expect(env).to.include('KOLIBRI_LISTEN_PORT=19090')
      expect(env.some((e) => e.includes('18080'))).to.equal(false)
    })

    it('leaves non-kolibri host-network services untouched', async () => {
      const composePath = path.join(dir, 'compose.yaml')
      const before = YAML.stringify({
        services: {
          other: {
            image: 'traefik/whoami',
            network_mode: 'host',
            environment: ['FOO=1'],
          },
        },
      })
      await fs.writeFile(composePath, before)
      await syncKolibriHostListenPort(composePath, 51234 as PortNumber)
      expect(await fs.readFile(composePath, 'utf8')).to.equal(before)
    })
  })
})
