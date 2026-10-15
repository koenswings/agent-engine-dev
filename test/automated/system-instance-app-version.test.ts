/**
 * wh #207 proof follow-ups (idea#193):
 *  1. A system-disk instance whose compose.yaml names a newer app version moves to
 *     that app record (same rule as createOrUpdateInstance for docked disks), so it
 *     gets the newer app's usbMount.
 *  2. A Running instance whose containers were stopped outside the Engine is set to
 *     Docked (not Stopped) after EXTERNAL_STOP_MISSES polls without a container.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import { upsertSystemInstanceRecord } from '../../src/data/Disk.js'
import { detectExternalStops, resetExternalStopTrackingForTests, EXTERNAL_STOP_GRACE_MS } from '../../src/monitors/dockerMetricsMonitor.js'
import { createTestStore } from '../harness/diskSim.js'

const INST = 'kolibri-channel-builder-g509emkmdwrb6kxp3jk88'
const OLD = '2407800'
const NEW = '27f615c6e366ba9b62b74a0fc87546cd6ddcdf2e'
const compose = (version: string, image = 'builder:1') => ({
    services: { builder: { image } },
    'x-app': { name: 'kolibri-channel-builder', version, instanceName: 'Channel builder' },
})
const disk = { id: 'sysdisk' } as any

describe('system-disk instance follows its compose app version', () => {
    let h: DocHandle<Store>
    beforeEach(async () => { h = (await createTestStore()).storeHandle })

    it('create sets instanceOf from the compose', () => {
        upsertSystemInstanceRecord(h, disk, INST as any, compose(OLD))
        expect(h.doc().instanceDB[INST as any].instanceOf).toBe(`kolibri-channel-builder-${OLD}`)
    })

    it('update moves instanceOf to the newer app and refreshes serviceImages; Stopped is preserved', () => {
        upsertSystemInstanceRecord(h, disk, INST as any, compose(OLD))
        h.change(d => { d.instanceDB[INST as any].status = 'Stopped' as any })
        upsertSystemInstanceRecord(h, disk, INST as any, compose(NEW, 'builder:2'))
        const inst: any = h.doc().instanceDB[INST as any]
        expect(inst.instanceOf).toBe(`kolibri-channel-builder-${NEW}`)
        expect([...inst.serviceImages]).toEqual(['builder:2'])
        expect(inst.status).toBe('Stopped')
    })

    it('update resets Error to Docked, like docked-disk instances', () => {
        upsertSystemInstanceRecord(h, disk, INST as any, compose(OLD))
        h.change(d => { d.instanceDB[INST as any].status = 'Error' as any })
        upsertSystemInstanceRecord(h, disk, INST as any, compose(NEW))
        expect(h.doc().instanceDB[INST as any].status).toBe('Docked')
    })
})

describe('containers stopped outside the Engine', () => {
    const now = 10_000_000
    const old = now - EXTERNAL_STOP_GRACE_MS - 1
    const running = [{ id: 'a', status: 'Running', lastStarted: old }]
    const unlocked = () => false
    beforeEach(() => resetExternalStopTrackingForTests())

    it('two consecutive polls without a container → reported once', () => {
        expect(detectExternalStops(running, [], unlocked, now)).toEqual([])
        expect(detectExternalStops(running, [], unlocked, now)).toEqual(['a'])
    })
    it('a container seen in between resets the count', () => {
        detectExternalStops(running, [], unlocked, now)
        detectExternalStops(running, ['a-builder-1'], unlocked, now)
        expect(detectExternalStops(running, [], unlocked, now)).toEqual([])
    })
    it('docker ps failure (null) never concludes a stop', () => {
        detectExternalStops(running, null, unlocked, now)
        expect(detectExternalStops(running, null, unlocked, now)).toEqual([])
    })
    it('skips instances the Engine holds a lock on, recently started ones, and non-Running ones', () => {
        for (let i = 0; i < 3; i++) expect(detectExternalStops(running, [], () => true, now)).toEqual([])
        const fresh = [{ id: 'b', status: 'Running', lastStarted: now - 1000 }]
        for (let i = 0; i < 3; i++) expect(detectExternalStops(fresh, [], unlocked, now)).toEqual([])
        const stopped = [{ id: 'c', status: 'Stopped', lastStarted: old }]
        for (let i = 0; i < 3; i++) expect(detectExternalStops(stopped, [], unlocked, now)).toEqual([])
    })
})
