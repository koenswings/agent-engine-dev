/**
 * SignedQueue.ts — putting signed entries on this Engine's own queue (engine#582).
 *
 * The Engine signs an entry (CommandKey.signEntry) only after a check passed: an
 * operator session (/api/command), a peer grant it issued (/api/command from another
 * Engine), the local CLI, or its own scheduling. The details of who asked (operator
 * name, remote address, relaying Engine) stay in memory keyed by seq, so the trace
 * gets them when the entry runs; after a restart only what the entry's src says is
 * known.
 */

import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from './Store.js'
import { signEntry } from './CommandKey.js'
import { localEngineId } from './Engine.js'
import type { CommandSource } from './CommandSource.js'

const MAX_PENDING_SOURCES = 2048
const pendingSources = new Map<number, CommandSource>()

/** The CommandSource for a signed entry: the remembered details, else what src says. */
export const sourceForEntry = (src: string, seq: number): CommandSource => {
    const kept = pendingSources.get(seq)
    if (kept) { pendingSources.delete(seq); return kept }
    if (src.startsWith('op-')) return { kind: 'operator', session: src.slice(3) }
    if (src.startsWith('peer-')) return { kind: 'peer', peerEngineId: src.slice(5) }
    if (src === 'cli') return { kind: 'cli' }
    return { kind: 'engine' }
}

/**
 * Sign `command` and append it to this Engine's own queue. Returns its seq.
 * `details` (optional) is recorded on the trace when the entry runs.
 */
export const enqueueSigned = (
    storeHandle: DocHandle<Store>, command: string, src: string, details?: CommandSource, engineId: string = String(localEngineId),
): number => {
    const { entry, seq } = signEntry(command, src, engineId)
    if (details) {
        if (pendingSources.size >= MAX_PENDING_SOURCES) pendingSources.delete(pendingSources.keys().next().value as number)
        pendingSources.set(seq, details)
    }
    storeHandle.change(doc => {
        const e = doc.engineDB[engineId as any]
        if (!e) throw new Error(`Engine ${engineId} is not in the store`)
        ;(e.commands as any[]).push(entry)
    })
    return seq
}

/** Tests only. */
export const clearPendingSourcesForTests = (): void => pendingSources.clear()
