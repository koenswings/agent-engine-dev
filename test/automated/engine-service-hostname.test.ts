/**
 * engine-service-hostname.test.ts — the Engine's `_engine._tcp` service must not claim the
 * host name avahi-daemon owns. Pool 2026-10-15 (and main): ciao defaulted the SRV host to
 * `<hostname>.local`, saw avahi answer for it while probing, and renamed every Engine to
 * 'idea03 (2)' on idea03-(2).local. Clients reach Engines by `<hostname>.local` (avahi).
 */
import { describe, it, expect } from 'vitest'
import ciao from '@homebridge/ciao'
import { readFileSync } from 'fs'
import { engineServiceHostname } from '../../src/monitors/mdnsMonitor.js'

describe('Engine mDNS service host name (idea#203 pool run ed2ab60)', () => {
    it('is distinct from <hostname>.local, and the service name stays the hostname', async () => {
        expect(engineServiceHostname('idea03')).toBe('idea03-engine')
        const responder = ciao.getResponder({ interface: ['lo'] })
        try {
            const s = responder.createService({ name: 'idea03', hostname: engineServiceHostname('idea03'), type: 'engine', port: 4321 })
            expect(s.getHostname()).toBe('idea03-engine.local.')
            expect(s.getFQDN()).toBe('idea03._engine._tcp.local.')
            // what ciao does without the option: the host avahi owns
            const d = responder.createService({ name: 'idea04', type: 'engine', port: 4321 })
            expect(d.getHostname()).toBe('idea04.local.')
            await s.destroy(); await d.destroy()
        } finally { await responder.shutdown() }
    })
    it('startAdvertising passes it to ciao', () => {
        const src = readFileSync(new URL('../../src/monitors/mdnsMonitor.ts', import.meta.url), 'utf8')
        expect(src).toMatch(/hostname: engineServiceHostname\(engineName\.toString\(\)\)/)
    })
})
