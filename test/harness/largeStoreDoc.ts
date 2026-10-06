/**
 * largeStoreDoc.ts — a synthetic store doc comparable to the production 3zoqd store (WS concurrency test).
 *
 * Production 3zoqd (r30/r33 dumps): ~575 KB of JSON, 919 operationDB entries, 3
 * engines writing a heartbeat (engineDB.<id>.lastRun) every 30 s for days, plus
 * the operations' progress updates. The cost of a fresh-peer full sync scales
 * with the number of changes in the history, not with the JSON size, so this
 * builds a long history from many small changes by 3 actors (one per engine)
 * that merge each other periodically, like Engines that sync.
 *
 * Defaults (90 000 heartbeats + 919 operations x 7 changes ~ 96 000 changes,
 * ~360 KB saved, ~480 KB full-sync message) reproduce the shape of the
 * production stall: a fresh peer's full sync costs a few hundred ms of
 * synchronous Automerge work on a fast x86 core, several seconds on a Pi 4.
 *
 * Generating takes ~15-60 s, so the binary is cached in os.tmpdir() keyed by
 * the generator version and parameters.
 */

import os from 'os'
import path from 'path'
import fs from 'fs'
import { next as A } from '@automerge/automerge'

const GENERATOR_VERSION = 1

export interface LargeStoreDocOptions {
    heartbeats?: number
    operations?: number
    mergeEvery?: number
}

const hexActor = (i: number) => (i + 1).toString(16).padStart(32, '0')

export const generateLargeStoreDoc = (opts: LargeStoreDocOptions = {}): Uint8Array => {
    const heartbeats = opts.heartbeats ?? 90_000
    const operations = opts.operations ?? 919
    const mergeEvery = opts.mergeEvery ?? 1_000
    const engines = ['ENGINE_wsconcaaaaaaaaaaaaa', 'ENGINE_wsconcbbbbbbbbbbbbb', 'ENGINE_wsconccccccccccccc']
    const base = A.from<any>({ appDB: {}, diskDB: {}, engineDB: {}, instanceDB: {}, operationDB: {}, userDB: {} }, { actor: hexActor(9) })
    const docs: any[] = engines.map((_, i) => A.clone(base, { actor: hexActor(i) }))
    engines.forEach((id, i) => {
        docs[i] = A.change(docs[i], (d: any) => {
            d.engineDB[id] = {
                id, hostname: `wsconc${i}`, version: '1.0', hostOS: 'Linux',
                capabilities: ['diskIdArgs', 'filesDisk', 'filesMount', 'eraseDisk'], commands: [],
                created: 1790602314154, lastBooted: 1791251098308, lastHalted: null, lastRun: 0,
                unformattedDisks: [], eraseInProgress: null, capabilitiesBootedAt: 1791251098308,
            }
            d.diskDB[`disk-${i}`] = {
                id: `disk-${i}`, name: `Synthetic disk ${i}`, device: 'sda', diskTypes: ['app'],
                dockedTo: id, created: 1780000000000, lastDocked: 1791251292978,
                sizeBytes: 1021000000, freeBytes: 950000000, backupConfig: null, filesConfig: null, unmountError: null,
            }
        })
    })
    const opEvery = Math.max(1, Math.floor(heartbeats / operations))
    let opN = 0
    for (let k = 0; k < heartbeats; k++) {
        const i = k % engines.length
        const engineId = engines[i]
        docs[i] = A.change(docs[i], (d: any) => { d.engineDB[engineId].lastRun = 1790602314154 + k * 10_000 })
        if (k % opEvery === 0 && opN < operations) {
            const id = 'op' + (opN++).toString(36).padStart(17, '0')
            docs[i] = A.change(docs[i], (d: any) => {
                d.operationDB[id] = {
                    id, kind: 'startApp', cause: 'console-command', engineId, status: 'Running',
                    args: { diskId: `disk-${i}`, instanceId: 'kolibri-grade5a-001' },
                    subject: { id: 'kolibri-grade5a-001', type: 'instance' },
                    startedAt: 1790884459080 + k, completedAt: null, progressPercent: 0,
                    currentStep: null, totalSteps: null, stepLabel: null, error: null,
                }
            })
            for (let p = 1; p <= 5; p++) docs[i] = A.change(docs[i], (d: any) => { d.operationDB[id].progressPercent = p * 16; d.operationDB[id].currentStep = p })
            docs[i] = A.change(docs[i], (d: any) => { d.operationDB[id].status = 'Done'; d.operationDB[id].completedAt = 1790884462514 + k })
        }
        if (k % mergeEvery === mergeEvery - 1) {
            for (let j = 0; j < docs.length; j++) for (let m = 0; m < docs.length; m++) if (m !== j) docs[j] = A.merge(docs[j], docs[m])
        }
    }
    let final = docs[0]
    for (let m = 1; m < docs.length; m++) final = A.merge(final, docs[m])
    return A.save(final)
}

/** generateLargeStoreDoc(), cached in os.tmpdir() (generation is slow). */
export const largeStoreDoc = (opts: LargeStoreDocOptions = {}): Uint8Array => {
    const key = `v${GENERATOR_VERSION}-${opts.heartbeats ?? 'd'}-${opts.operations ?? 'd'}-${opts.mergeEvery ?? 'd'}`
    const file = path.join(os.tmpdir(), `idea-wsconc-store-${key}.bin`)
    try {
        const cached = fs.readFileSync(file)
        A.load(new Uint8Array(cached)) // reject a truncated or corrupt cache file
        return new Uint8Array(cached)
    } catch { /* (re)generate */ }
    const bin = generateLargeStoreDoc(opts)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, bin)
    fs.renameSync(tmp, file)
    return bin
}
