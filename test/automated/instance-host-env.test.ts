/**
 * Every app instance .env gets the Engine `hostname` and eth0 `ip` (not only Nextcloud).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fs } from 'zx'
import path from 'path'
import os from 'os'
import { writeEngineHostEnv } from '../../src/data/Instance.js'

const eth0 = (address: string): NodeJS.Dict<os.NetworkInterfaceInfo[]> => ({
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
  eth0: [
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: 'fe80::1/64', scopeid: 2 },
    { address, netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: `${address}/24` },
  ],
  docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:00:00:00:00', internal: false, cidr: '172.17.0.1/16' }],
})

describe('writeEngineHostEnv (hostname + ip for every app)', () => {
  let dir: string
  let envPath: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-host-env-'))
    envPath = path.join(dir, '.env')
    await fs.writeFile(envPath, 'port=18080\n')
  })
  afterEach(async () => { await fs.remove(dir) })

  it('adds hostname and eth0 IPv4 to a non-Nextcloud .env, keeping existing vars', async () => {
    await writeEngineHostEnv(envPath, 'idea03', 'kolibri-channel-builder-1', eth0('10.99.0.13'))
    const env = await fs.readFile(envPath, 'utf8')
    expect(env).to.match(/^port=18080$/m)
    expect(env).to.match(/^hostname=idea03$/m)
    expect(env).to.match(/^ip=10\.99\.0\.13$/m)
    expect(env).not.to.contain('172.17.0.1')
    expect(env).not.to.contain('fe80')
  })

  it('updates stale values in place without duplicating keys', async () => {
    await fs.writeFile(envPath, 'port=18080\nhostname=old\nip=10.0.0.9\n')
    await writeEngineHostEnv(envPath, 'idea04', 'x', eth0('10.99.0.14'))
    const env = await fs.readFile(envPath, 'utf8')
    expect(env.match(/^hostname=/gm)?.length).to.equal(1)
    expect(env.match(/^ip=/gm)?.length).to.equal(1)
    expect(env).to.match(/^hostname=idea04$/m)
    expect(env).to.match(/^ip=10\.99\.0\.14$/m)
  })

  it('skips ip when eth0 has no IPv4 and skips hostname when unknown', async () => {
    await writeEngineHostEnv(envPath, undefined, 'x', { wlan0: eth0('10.99.0.20').eth0 })
    const env = await fs.readFile(envPath, 'utf8')
    expect(env).to.equal('port=18080\n')
  })
})
