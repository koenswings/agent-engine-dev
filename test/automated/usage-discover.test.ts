/**
 * idea#411: listed vs unlisted discovery and synthetic instance ids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverBundles, discoverListed, discoverTargets, matchBundle, parseDockerCreatedAt, syntheticInstanceId } from '../../src/usage/discover.js'
import type { BundleHook, DockerContainer } from '../../src/usage/types.js'
import { instanceExistedOnDay, kitLocalDay } from '../../src/usage/paths.js'

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-usage-disc-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const listedCompose = `services:
  kolibri:
    image: example/kolibri:0.19.5
x-app:
  name: kolibri
  version: "0.19.5"
  instanceName: Grade 5 Kolibri
  usage:
    service: kolibri
    command: /hooks/usage.sh
    timeoutS: 30
`

const bundleCompose = `services:
  kolibri:
    image: example/kolibri:0.19.5
x-app:
  name: kolibri
  version: "0.19.5"
  usage:
    service: kolibri
    command: /hooks/usage.sh
    timeoutS: 30
`

describe('syntheticInstanceId', () => {
    it('prefers a compose project that looks like an instance id', () => {
        expect(syntheticInstanceId('old-kolibri', 'ctr')).toBe('old-kolibri')
    })
    it('falls back to unlisted-<sanitized name> trimmed to 64 chars', () => {
        expect(syntheticInstanceId(undefined, 'My_Container.Name')).toBe('unlisted-my-container-name')
        expect(syntheticInstanceId('NOT VALID', 'x'.repeat(80)).length).toBeLessThanOrEqual(64)
    })
})

describe('discoverListed and discoverTargets', () => {
    it('reads listed instances from system and disk trees', () => {
        const sys = path.join(tmp, 'instances', 'kolibri-abc')
        fs.mkdirSync(sys, { recursive: true })
        fs.writeFileSync(path.join(sys, 'compose.yaml'), listedCompose)
        const diskInst = path.join(tmp, 'disks', 'sda1', 'instances', 'nextcloud-xyz')
        fs.mkdirSync(diskInst, { recursive: true })
        fs.writeFileSync(path.join(diskInst, 'compose.yaml'), `services:\n  app:\n    image: nextcloud\nx-app:\n  name: nextcloud\n  version: "1.0"\n  instanceName: Files\n`)
        const listed = discoverListed({ systemInstances: path.join(tmp, 'instances'), disksRoot: path.join(tmp, 'disks') })
        expect(listed.map(t => t.instanceId).sort()).toEqual(['kolibri-abc', 'nextcloud-xyz'])
        const k = listed.find(t => t.instanceId === 'kolibri-abc')!
        expect(k.name).toBe('Grade 5 Kolibri')
        expect(k.hook?.service).toBe('kolibri')
        expect(listed.find(t => t.instanceId === 'nextcloud-xyz')!.hook).toBeNull()
        expect(k.createdAt).toBeTruthy()
        expect(instanceExistedOnDay(k.createdAt, kitLocalDay(new Date()))).toBe(true)
        expect(instanceExistedOnDay(k.createdAt, '2020-01-01')).toBe(false)
    })
    it('marks a running non-listed compose project as unlisted and borrows a matching bundle hook', () => {
        const bundleDir = path.join(tmp, 'apps', 'kolibri-0.19.5')
        fs.mkdirSync(path.join(bundleDir, 'hooks'), { recursive: true })
        fs.writeFileSync(path.join(bundleDir, 'compose.yaml'), bundleCompose)
        fs.writeFileSync(path.join(bundleDir, 'hooks', 'usage.sh'), '#!/bin/sh\necho hi\n')
        const bundles = discoverBundles({ systemApps: path.join(tmp, 'apps'), disksRoot: path.join(tmp, 'disks') })
        expect(bundles).toHaveLength(1)
        const containers: DockerContainer[] = [
            { id: 'c1', name: 'old_kolibri', image: 'example/kolibri:0.19.5', project: 'legacy-kolibri' },
            { id: 'c2', name: 'listed', image: 'example/kolibri:0.19.5', project: 'kolibri-abc' },
        ]
        const listed = [{
            kind: 'listed' as const,
            instanceId: 'kolibri-abc',
            name: 'Grade 5 Kolibri',
            app: 'kolibri',
            listed: true as const,
            cwd: '/instances/kolibri-abc',
            hook: bundles[0].hook,
        }]
        const targets = discoverTargets(containers, listed, bundles)
        expect(targets.some(t => t.kind === 'listed' && t.instanceId === 'kolibri-abc')).toBe(true)
        const u = targets.find(t => t.kind === 'unlisted')
        expect(u?.instanceId).toBe('legacy-kolibri')
        expect(u?.listed).toBe(false)
        expect(u && u.kind === 'unlisted' && u.hook).toBeTruthy()
        expect(u && u.kind === 'unlisted' && u.hookScript).toMatch(/echo hi/)
    })
    it('returns unlisted-no-hook when no bundle matches', () => {
        const containers: DockerContainer[] = [
            { id: 'c3', name: 'mystery', image: 'something/else:1.0', project: 'mystery' },
        ]
        const targets = discoverTargets(containers, [], [])
        expect(targets).toHaveLength(1)
        expect(targets[0].kind).toBe('unlisted')
        expect(targets[0].hook).toBeNull()
        expect(targets[0].app).toBe('else')
    })
    it('matchBundle requires name+version, so 0.15.5 does not use a 0.19.5 hook', () => {
        const bundle: BundleHook = {
            app: 'kolibri', version: '0.19.5', appId: 'kolibri-0.19.5',
            hook: { service: 'kolibri', command: ['/hooks/usage.sh'], timeoutS: 30 },
            hookScript: 'x', bundleDir: '/apps/kolibri-0.19.5',
        }
        expect(matchBundle({ id: '1', name: 'a', image: 'example/kolibri:0.19.5' }, [bundle])).toBe(bundle)
        expect(matchBundle({ id: '2', name: 'b', image: 'example/kolibri:0.15.5' }, [bundle])).toBeUndefined()
    })
})

describe('parseDockerCreatedAt', () => {
    it('parses docker ps CreatedAt and RFC 3339', () => {
        const iso = parseDockerCreatedAt('2026-11-11 02:05:22 +0100 CET')
        expect(iso).toBe('2026-11-11T01:05:22.000Z')
        expect(parseDockerCreatedAt('2026-11-11T01:05:22.000Z')).toBe('2026-11-11T01:05:22.000Z')
        expect(parseDockerCreatedAt(undefined)).toBeUndefined()
        expect(parseDockerCreatedAt('nonsense')).toBeUndefined()
    })
    it('copies container Created onto unlisted targets', () => {
        const createdAt = '2026-11-08T14:00:00.000Z'
        const out = discoverTargets(
            [{ id: 'c1', name: 'old_kolibri', image: 'example/kolibri:0.19.5', project: 'legacy-kolibri', createdAt }],
            [],
            [],
        )
        expect(out).toHaveLength(1)
        expect(out[0].createdAt).toBe(createdAt)
    })
})
