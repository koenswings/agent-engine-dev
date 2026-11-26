/**
 * PeerTickets.ts — peer transfer tickets (engine#595, helper v26).
 *
 * A peer Engine writes into this Engine's disks through idea-peer-gate and the root helper
 * (cross-Engine copyApp/moveApp, updateApp fetch). Helper v26 lets such a write through only
 * while this Engine holds a live TICKET for that peer and target. This Engine registers them:
 *
 *  - copyApp/moveApp: when it accepts the source Engine's grant at the grantCheck preflight
 *    (the preflight names the target disk, the new instance id, the app and the op). The tickets
 *    (instance, app master, service images) live as long as the grant still has, at most 6 h.
 *  - updateApp fetch: just before it asks the source Engine to push the bundle (pushAppBundle),
 *    for apps/<newAppId> with the request id as op; dropped when the fetch ends.
 *
 * At start the Engine drops every ticket (peer-tickets-reset): a restart forgets every grant,
 * so it forgets the tickets too. A reboot clears them anyway (tmpfs). Tickets expire on the
 * helper's own monotonic clock (/proc/uptime + boot id), never the wall clock.
 *
 * Below helper v26 nothing is registered: an older helper and gate need no ticket.
 */

import crypto from 'crypto'
import { log } from '../utils/utils.js'
import {
    runAppData, helperAtLeast, AppDataRunner,
    peerTicketAddArgs, peerTicketDropArgs, peerTicketsResetArgs,
    PEER_TICKETS_HELPER_MIN, PEER_TICKET_MAX_SECONDS, PeerTicketKind,
} from '../utils/appDataHelper.js'

export interface TicketDeps {
    run: AppDataRunner
    /** null when the helper has tickets (v26+), else why not */
    helperProblem: () => Promise<string | null>
}

export const defaultTicketDeps: TicketDeps = {
    run: runAppData,
    helperProblem: () => helperAtLeast(PEER_TICKETS_HELPER_MIN, 'Peer transfer tickets'),
}

/** What a copy or move from `peer` into this Engine writes here. */
export interface TransferTarget {
    /** helper root token of the target disk on THIS Engine (system, sdX1 or a test slot) */
    root: string
    /** the new instance folder id (instances/<dstId>) */
    dstId: string
    /** the app master (apps/<appId>); omitted when the copy sends none */
    appId?: string | null
    /** the source Engine's operation id (the in-flight marker's op) */
    opId?: string | null
    /** whether service image tars are sent (services/) */
    services?: boolean
}

/** Whole seconds a ticket may live: what the grant still has, at least 1, at most 6 h. */
export const ticketSeconds = (remainingMs: number): number =>
    Math.max(1, Math.min(PEER_TICKET_MAX_SECONDS, Math.floor(remainingMs / 1000)))

export type TicketResult = { ok: true, registered: number, skipped?: string } | { ok: false, error: string }

/**
 * Register the tickets for one copy/move from `peer` under grant `grantId` (this Engine issued it
 * and has just accepted it). Never throws; a helper below v26 registers nothing (ok, skipped).
 */
export const registerTransferTickets = async (peer: string, grantId: string, remainingMs: number, t: TransferTarget, d: TicketDeps = defaultTicketDeps): Promise<TicketResult> => {
    const old = await d.helperProblem()
    if (old) return { ok: true, registered: 0, skipped: old }
    const secs = ticketSeconds(remainingMs)
    const want: [PeerTicketKind, string | null][] = [['instance', t.dstId]]
    if (t.appId) want.push(['app', t.appId])
    if (t.services !== false) want.push(['services', null])
    let registered = 0
    try {
        for (const [kind, id] of want) {
            await d.run(peerTicketAddArgs(peer, t.root, kind, id, t.opId ?? null, grantId, secs))
            registered++
        }
    } catch (e: any) {
        const error = `could not register the transfer permission for Engine ${peer}: ${e?.message ?? e}`
        log(`[peer] ${error}`)
        return { ok: false, error }
    }
    log(`[peer] Engine ${peer} may write ${t.dstId}${t.appId ? ` (app ${t.appId})` : ''} on ${t.root} for ${secs} s (grant ${grantId}, op ${t.opId ?? '-'})`)
    return { ok: true, registered }
}

/** A ticket id for a transfer this Engine asked for itself (updateApp fetch): 16 base64url chars. */
export const newTicketId = (): string => crypto.randomBytes(12).toString('base64url')

/** updateApp fetch: let `peer` push apps/<appId> on `root` for request `requestId`. Never throws. */
export const registerFetchTicket = async (peer: string, root: string, appId: string, requestId: string, ticketId: string, seconds: number, d: TicketDeps = defaultTicketDeps): Promise<TicketResult> => {
    const old = await d.helperProblem()
    if (old) return { ok: true, registered: 0, skipped: old }
    try {
        await d.run(peerTicketAddArgs(peer, root, 'app', appId, requestId, ticketId, ticketSeconds(seconds * 1000)))
    } catch (e: any) {
        const error = `could not register the fetch permission for Engine ${peer}: ${e?.message ?? e}`
        log(`[peer] ${error}`)
        return { ok: false, error }
    }
    return { ok: true, registered: 1 }
}

/** Drop the tickets of one grant or fetch. Never throws (they expire anyway). */
export const dropTickets = async (ticketId: string, d: TicketDeps = defaultTicketDeps): Promise<void> => {
    if (await d.helperProblem()) return
    try { await d.run(peerTicketDropArgs(ticketId)) } catch (e: any) { log(`[peer] could not drop transfer permission ${ticketId}: ${e?.message ?? e}`) }
}

/**
 * At Engine start: drop every ticket of the previous run (its grants are gone). Retries once;
 * a failure is logged loudly (the tickets still expire by themselves) and returned.
 */
export const resetPeerTickets = async (d: TicketDeps = defaultTicketDeps): Promise<string | null> => {
    const old = await d.helperProblem()
    if (old) return null
    let last = ''
    for (let i = 0; i < 2; i++) {
        try {
            const out = (await d.run(peerTicketsResetArgs())).trim()
            log(`[peer] transfer permissions of the previous run dropped (${out})`)
            return null
        } catch (e: any) { last = String(e?.message ?? e) }
    }
    const problem = `WARNING: could not drop the transfer permissions of the previous run: ${last}. They expire by themselves within 6 h.`
    log(problem)
    return problem
}

// ── grantCheck on this (the issuing) Engine ──────────────────────────────────

export type GrantCheckAnswer =
    | { ok: true, registered: number, skipped?: string }
    | { ok: false, status: number, code: string, message: string }

const DISK_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * engine#595: the grantCheck words after the command name (PeerCommands.grantCheckCommand):
 * none → only the grant check (nothing registered); else `<targetDiskId> <dstId> <appId|-> <opId|-> <0|1>`.
 * The target disk must be docked HERE; its root token is this Engine's own (appDataRoot), never
 * one the peer names. The tickets live as long as the grant (`grantId`, issued here) still has.
 */
export const acceptGrantCheck = async (
    store: { diskDB?: Record<string, any> } | undefined, self: string, peer: string, grantId: string, remainingMs: number, command: string,
    d: TicketDeps = defaultTicketDeps,
    rootOf: (disk: any) => Promise<string> = async (disk) => (await import('./Disk.js')).appDataRoot(disk),
): Promise<GrantCheckAnswer> => {
    const words = String(command).trim().split(/\s+/).slice(1)
    if (words.length === 0) return { ok: true, registered: 0 }
    const bad = (message: string): GrantCheckAnswer => ({ ok: false, status: 400, code: 'BAD_REQUEST', message })
    if (words.length !== 5) return bad(`grantCheck takes no words or <targetDiskId> <dstId> <appId|-> <opId|-> <0|1>.`)
    const [diskId, dstId, appWord, opWord, servicesWord] = words
    if (!DISK_ID_RE.test(diskId) || !/^[01]$/.test(servicesWord)) return bad('grantCheck: bad target disk id or services flag.')
    const disk = store?.diskDB?.[diskId]
    if (!disk || !disk.device || String(disk.dockedTo ?? '') !== String(self)) {
        return { ok: false, status: 409, code: 'TARGET_NOT_DOCKED', message: `Disk ${diskId} is not docked to Engine ${self}.` }
    }
    const t: TransferTarget = { root: await rootOf(disk), dstId, appId: appWord === '-' ? null : appWord, opId: opWord === '-' ? null : opWord, services: servicesWord === '1' }
    try {
        // the same checks the helper makes, before anything runs as root
        peerTicketAddArgs(peer, t.root, 'instance', t.dstId, t.opId ?? null, grantId, 1)
        if (t.appId) peerTicketAddArgs(peer, t.root, 'app', t.appId, t.opId ?? null, grantId, 1)
    } catch (e: any) { return bad(`grantCheck: ${e?.message ?? e}`) }
    if (remainingMs <= 0) return { ok: false, status: 403, code: 'GRANT_EXPIRED', message: `No valid permission for Engine ${peer} (expired, or this Engine restarted). Start the operation again.` }
    const r = await registerTransferTickets(peer, grantId, remainingMs, t, d)
    return r.ok ? r : { ok: false, status: 503, code: 'TRANSFER_PERMISSION_FAILED', message: r.error }
}
