/**
 * PeerCommands.ts — follow-up commands to another Engine through its API (engine#582).
 *
 * Engines do not hold each other's keys, so a command for Engine B is always signed
 * by B. Engine A sends a follow-up (startInstance after a copy, verifyMoveTarget,
 * cleanupMoveTarget, pushAppBundle, appFetchResult) as
 *   POST http://<B>/api/command   Authorization: Grant <grant issued by B for A>
 *   { command, fromEngineId: A, replyGrant: <grant issued by A for B> }
 * B checks its own grant and signs the command into its own queue (src peer-A).
 * The reply grant lets B answer A (appFetchResult) the same way.
 *
 * A keeps one dispatch trace per follow-up: ok with B's seq, or an error with the
 * code (GRANT_REQUIRED / GRANT_EXPIRED / GRANT_INVALID / ENGINE_UNREACHABLE /
 * ENGINE_VERSION_MISMATCH) and `issuerEngineId` = B in the trace result.
 *
 * Before a copy or move stops, writes or registers anything for B, A asks B whether it
 * still knows the grant (preflightPeerGrant, `grantCheck`). A stale grant fails the
 * operation there, so nothing that needs B's permission happens on either Engine.
 */

import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from './Store.js'
import { localEngineId } from './Engine.js'
import { grantFrom, forgetGrant, issueGrant, GRANT_CHECK_COMMAND } from './PeerGrants.js'
import { peerJson, PeerError } from './PeerHttp.js'
import { addTrace, closeTrace, getCommandLogHandle } from './CommandLogStore.js'
import { log } from '../utils/utils.js'

export const SIGNED_COMMANDS_CAPABILITY = 'signedCommands1'
export const PEER_COMMAND_TIMEOUT_MS = 15_000

/** idea#128 pattern: capability counted only when stamped by the current boot. */
export const hasSignedCommands = (store: Store | undefined, engineId: string): boolean => {
    const e = (store?.engineDB as any)?.[engineId]
    return !!e && Array.isArray(e.capabilities) && e.capabilities.includes(SIGNED_COMMANDS_CAPABILITY) && e.capabilitiesBootedAt === e.lastBooted
}

export interface DispatchResult { ok: boolean, seq?: number, code?: string, message?: string, issuerEngineId: string }

const traceDispatch = (target: string, command: string, r: DispatchResult): void => {
    const h = getCommandLogHandle()
    if (!h) return
    const traceId = crypto.randomUUID()
    addTrace(h, {
        traceId, command: String(command).split(' ')[0],
        args: JSON.stringify({ dispatchedTo: target, command: String(command) }),
        startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null,
        source: { kind: 'engine' },
    })
    if (r.ok) closeTrace(h, traceId, 'ok', undefined, JSON.stringify({ dispatchedTo: target, seq: r.seq ?? null }))
    else closeTrace(h, traceId, 'error', r.message ?? 'dispatch failed', JSON.stringify({ dispatchedTo: target, issuerEngineId: r.issuerEngineId }), r.code ?? null)
}

/**
 * Send `command` to Engine `engineId`. For this Engine itself it goes on the own
 * queue (signed, src engine). Never throws; the result is traced and returned.
 */
export const dispatchToPeer = async (storeHandle: DocHandle<Store>, engineId: string, command: string): Promise<DispatchResult> => {
    const self = String(localEngineId)
    if (engineId === self) {
        const { enqueueSigned } = await import('./SignedQueue.js')
        try {
            const seq = enqueueSigned(storeHandle, command, 'engine')
            return { ok: true, seq, issuerEngineId: self }
        } catch (e: any) {
            return { ok: false, code: 'COMMAND_REFUSED', message: e?.message ?? String(e), issuerEngineId: self }
        }
    }
    const store = storeHandle.doc()
    let r: DispatchResult
    if (!hasSignedCommands(store, engineId)) {
        const version = String((store?.engineDB as any)?.[engineId]?.version ?? 'unknown')
        r = { ok: false, code: 'ENGINE_VERSION_MISMATCH', message: `Engine ${engineId} runs an older Engine version (${version}); it cannot take follow-up commands.`, issuerEngineId: engineId }
    } else {
        const grant = grantFrom(engineId)
        if (!grant) {
            r = { ok: false, code: 'GRANT_EXPIRED', message: `No valid permission from Engine ${engineId} (expired, or this Engine restarted). Start the operation again.`, issuerEngineId: engineId }
        } else {
            try {
                const reply = issueGrant(self, engineId)
                const res = await peerJson(store, engineId, 'POST', '/api/command',
                    { command, fromEngineId: self, replyGrant: reply.grant }, { Authorization: `Grant ${grant}` }, PEER_COMMAND_TIMEOUT_MS)
                if (res.status === 202) r = { ok: true, seq: Number(res.json?.seq), issuerEngineId: engineId }
                else {
                    const code = typeof res.json?.error === 'string' ? res.json.error : `HTTP_${res.status}`
                    if (code === 'GRANT_EXPIRED' || code === 'GRANT_INVALID') forgetGrant(engineId)
                    r = { ok: false, code, message: String(res.json?.message ?? `Engine ${engineId} refused the follow-up (${res.status}).`), issuerEngineId: engineId }
                }
            } catch (e: any) {
                const pe = e instanceof PeerError ? e : null
                r = { ok: false, code: pe?.code ?? 'ENGINE_UNREACHABLE', message: e?.message ?? String(e), issuerEngineId: engineId }
            }
        }
    }
    if (!r.ok) log(`[peer] follow-up '${String(command).split(' ')[0]}' to ${engineId} not sent: ${r.code} ${r.message}`)
    traceDispatch(engineId, command, r)
    return r
}

/** A grant the issuer did not accept at the preflight; `code` and `traceResult` end up on the command trace. */
export class PeerGrantRefusal extends Error {
    traceResult: { code: string, issuerEngineId: string, dispatchedTo: string, step: string }
    constructor(public code: string, message: string, public issuerEngineId: string, step: string) {
        super(message)
        this.name = 'PeerGrantRefusal'
        this.traceResult = { code, issuerEngineId, dispatchedTo: issuerEngineId, step }
    }
}

/** The refusal for a failed preflight, or null when it passed. */
export const grantRefusal = (r: DispatchResult, step: string): PeerGrantRefusal | null => r.ok ? null
    : new PeerGrantRefusal(r.code ?? 'GRANT_EXPIRED', r.message ?? `Engine ${r.issuerEngineId} did not accept this Engine's permission.`, r.issuerEngineId, step)

/**
 * engine#595: what a copy or move is about to write on the issuer. With it, the grantCheck also
 * asks the issuer to let this Engine's transfer through its helper (transfer tickets, helper v26)
 * for as long as the grant lives: `grantCheck <targetDiskId> <dstId> <appId|-> <opId|-> <0|1>`.
 * An issuer without engine#595 ignores the words (its helper needs no ticket).
 */
export interface GrantCheckTransfer { targetDiskId: string, dstId: string, appId?: string | null, opId?: string | null, services: boolean }

export const grantCheckCommand = (t?: GrantCheckTransfer): string => t
    ? `${GRANT_CHECK_COMMAND} ${t.targetDiskId} ${t.dstId} ${t.appId || '-'} ${t.opId || '-'} ${t.services ? 1 : 0}`
    : GRANT_CHECK_COMMAND

/**
 * engine#595: the peer helper refused a transfer for want of a ticket ("refused: GRANT_EXPIRED: …",
 * e.g. the issuer restarted after the grantCheck). The same refusal as a failed preflight, or null.
 */
export const ticketRefusal = (e: unknown, issuerEngineId: string, step: string): PeerGrantRefusal | null => {
    const m = /refused: GRANT_EXPIRED: ([^\n]*)/.exec(String((e as any)?.message ?? e ?? ''))
    return m ? new PeerGrantRefusal('GRANT_EXPIRED', `Engine ${issuerEngineId} refused the transfer: ${m[1].trim()}`, issuerEngineId, step) : null
}

/**
 * Ask Engine `engineId` (the issuer) whether it still accepts the grant this Engine holds
 * from it. Read-only on both sides: B checks the grant and answers 200 without queueing.
 * A B on an earlier engine#582 build (no grantCheck) answers 422 not-a-follow-up AFTER a
 * good grant check; that counts as accepted. Never throws; a refusal is traced.
 */
export const preflightPeerGrant = async (storeHandle: DocHandle<Store>, engineId: string, transfer?: GrantCheckTransfer): Promise<DispatchResult> => {
    const self = String(localEngineId)
    if (engineId === self) return { ok: true, issuerEngineId: self }
    const store = storeHandle.doc()
    let r: DispatchResult
    if (!hasSignedCommands(store, engineId)) {
        const version = String((store?.engineDB as any)?.[engineId]?.version ?? 'unknown')
        r = { ok: false, code: 'ENGINE_VERSION_MISMATCH', message: `Engine ${engineId} runs an older Engine version (${version}); it cannot take follow-up commands.`, issuerEngineId: engineId }
    } else {
        const grant = grantFrom(engineId)
        if (!grant) {
            r = { ok: false, code: 'GRANT_EXPIRED', message: `No valid permission from Engine ${engineId} (expired, or this Engine restarted). Start the operation again.`, issuerEngineId: engineId }
        } else {
            try {
                const res = await peerJson(store, engineId, 'POST', '/api/command',
                    { command: grantCheckCommand(transfer), fromEngineId: self }, { Authorization: `Grant ${grant}` }, PEER_COMMAND_TIMEOUT_MS)
                if (res.status === 200 && res.json?.ok === true) r = { ok: true, issuerEngineId: engineId }
                else if (res.status === 422 && res.json?.reason === 'not-a-follow-up') r = { ok: true, issuerEngineId: engineId }
                else {
                    const code = typeof res.json?.error === 'string' ? res.json.error : `HTTP_${res.status}`
                    if (code === 'GRANT_EXPIRED' || code === 'GRANT_INVALID') forgetGrant(engineId)
                    r = { ok: false, code, message: String(res.json?.message ?? `Engine ${engineId} did not accept this Engine's permission (${res.status}).`), issuerEngineId: engineId }
                }
            } catch (e: any) {
                const pe = e instanceof PeerError ? e : null
                r = { ok: false, code: pe?.code ?? 'ENGINE_UNREACHABLE', message: e?.message ?? String(e), issuerEngineId: engineId }
            }
        }
    }
    if (!r.ok) {
        log(`[peer] permission check with ${engineId} failed: ${r.code} ${r.message}`)
        traceDispatch(engineId, GRANT_CHECK_COMMAND, r)
    }
    return r
}
