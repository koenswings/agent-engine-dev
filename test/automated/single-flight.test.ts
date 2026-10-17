/**
 * single-flight.test.ts — addDevice dedupe (idea01 2026-10-16, trace 93de80a4): a udev add and
 * eraseDisk's re-add of the same partition join one run instead of docking the disk twice.
 */
import { describe, it, expect } from 'vitest'
import { singleFlight } from '../../src/utils/singleFlight.js'

describe('singleFlight (addDevice dedupe)', () => {
    it('a second add of the same device while one runs joins it; other devices run; later adds run again', async () => {
        const runs: string[] = []
        const joined: string[] = []
        let release!: () => void
        const gate = new Promise<void>(r => { release = r })
        const add = singleFlight(
            (p: string) => p.split('/').pop()!,
            async (p: string) => { runs.push(p); if (p.endsWith('sdb1')) await gate },
            (k) => joined.push(k),
        )
        const a = add('/dev/engine/sdb1')
        const b = add('/dev/engine/sdb1')
        await add('/dev/engine/sdc1')
        expect(b).toBe(a)
        expect(joined).toEqual(['sdb1'])
        release()
        await Promise.all([a, b])
        expect(runs).toEqual(['/dev/engine/sdb1', '/dev/engine/sdc1'])
        await add('/dev/engine/sdb1')
        expect(runs).toEqual(['/dev/engine/sdb1', '/dev/engine/sdc1', '/dev/engine/sdb1'])
    })

    it('a failed run is forgotten so the next add retries', async () => {
        let n = 0
        const add = singleFlight((p: string) => p, async () => { n++; if (n === 1) throw new Error('boom') })
        await expect(add('sdb1')).rejects.toThrow('boom')
        await add('sdb1')
        expect(n).toBe(2)
    })
})
