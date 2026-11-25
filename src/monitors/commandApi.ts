/**
 * commandApi.ts — POST /api/command (engine#582).
 *
 * The only way a command from outside this Pi reaches this Engine's queue:
 *
 *   POST /api/command  { command, confirmId?, confirmText?, grants? }
 *     Authorization: Bearer <operator token>      (an operator, through the Console)
 *     Authorization: Grant <grant issued here>    (another Engine's follow-up;
 *                    body adds fromEngineId and optionally replyGrant)
 *   → 202 { engineId, seq }
 *
 * Order: token → validation → GRANT_REQUIRED → CONFIRM_REQUIRED → signed queue entry.
 * Errors are JSON { error, message, ... }; every error on a Grant request carries
 * issuerEngineId (this Engine). Refusals after authentication get an error trace and
 * an audit line with the source (no seq: nothing was queued).
 */

import type http from 'http'
import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from '../data/Store.js'
import { authenticate, clientOf, readJsonBody, HttpError } from './authApi.js'
import { sessionShortId } from '../data/Sessions.js'
import { checkGrant, GrantError, isPeerFollowUp, parseGrant, rememberGrant } from '../data/PeerGrants.js'
import { hasSignedCommands } from '../data/PeerCommands.js'
import { commandNeedsConfirm, issueConfirm, checkConfirm, prepareConfirm, ConfirmRefusal } from '../data/ConfirmGate.js'
import { enqueueSigned } from '../data/SignedQueue.js'
import type { CommandSource } from '../data/CommandSource.js'
import { log } from '../utils/utils.js'
import { authFolder } from '../data/Config.js'

export interface CommandApiContext {
    engineId: string
    storeHandle?: DocHandle<Store> | null
    /** Auth folder (default: Config.authFolder()). */
    dir?: string
}

const MAX_COMMAND_CHARS = 4096

const firstWord = (c: string): string => c.trim().split(/\s+/)[0] ?? ''

/** Find a disk by id, else by a unique name. */
const diskOf = (store: Store, arg: string): any => {
    const db = (store?.diskDB ?? {}) as Record<string, any>
    if (db[arg]) return db[arg]
    const byName = Object.values(db).filter(d => d?.name === arg)
    return byName.length === 1 ? byName[0] : null
}

/**
 * Engines (other than this one) that a command will send follow-ups to:
 * copyApp/moveApp with the target disk docked elsewhere, updateApp with a
 * --source disk docked elsewhere.
 */
export const peerEnginesNeeded = (store: Store | undefined, command: string, self: string): string[] => {
    if (!store) return []
    const words = command.trim().split(/\s+/)
    const name = words[0]
    const out = new Set<string>()
    if ((name === 'copyApp' || name === 'moveApp') && words[3]) {
        const d = diskOf(store, words[3])
        if (d?.dockedTo && String(d.dockedTo) !== self) out.add(String(d.dockedTo))
    }
    if (name === 'updateApp') {
        const i = words.indexOf('--source')
        if (i !== -1 && words[i + 1]) {
            const d = diskOf(store, words[i + 1])
            if (d?.dockedTo && String(d.dockedTo) !== self) out.add(String(d.dockedTo))
        }
    }
    return [...out]
}

const refuse = async (source: CommandSource, command: string, e: HttpError): Promise<never> => {
    const { recordRefusalTrace } = await import('../utils/commandUtils.js')
    const { getCommandLogHandle } = await import('../data/CommandLogStore.js')
    recordRefusalTrace(getCommandLogHandle(), command, e.message, e.code, { source })
    throw e
}

export interface CommandResult { status: number, body: unknown }

/** Handle POST /api/command. Returns null for other paths. */
export const routeCommand = async (req: http.IncomingMessage, pathname: string, ctx: CommandApiContext): Promise<CommandResult | null> => {
    if (pathname.replace(/\/+$/, '') !== '/api/command') return null
    if (req.method !== 'POST') throw new HttpError(405, 'BAD_REQUEST', 'Use POST.')
    const self = ctx.engineId
    const auth = String(req.headers.authorization ?? '')
    const isPeer = /^Grant /.test(auth)
    try {
        const b = await readJsonBody(req)
        const command = typeof b.command === 'string' ? b.command.trim() : ''
        if (!command || command.length > MAX_COMMAND_CHARS || /[\r\n\0]/.test(command)) throw new HttpError(400, 'BAD_REQUEST', "'command' must be one line of text.")
        const store = ctx.storeHandle?.doc() as Store | undefined
        const { client: remoteAddr, viaEngineId } = clientOf(req, store)
        const via = viaEngineId ? { viaEngineId } : {}
        if (!ctx.storeHandle || !store?.engineDB?.[self as any]) throw new HttpError(503, 'BAD_REQUEST', 'The store is not ready yet.')
        const { commands, } = await import('../data/Commands.js')
        const { LOCAL_ONLY_COMMANDS } = await import('../utils/commandUtils.js')
        const name = firstWord(command)

        if (isPeer) {
            const from = typeof b.fromEngineId === 'string' ? b.fromEngineId : ''
            const source: CommandSource = { kind: 'peer', peerEngineId: from || undefined, remoteAddr, ...via }
            try { checkGrant(auth.slice(6).trim(), self, from, undefined, ctx.dir ?? authFolder()) } catch (e) {
                if (e instanceof GrantError) await refuse(source, command, new HttpError(403, e.code, e.message))
                throw e
            }
            if (!isPeerFollowUp(command) || !commands.some(c => c.name === name)) {
                await refuse(source, command, new HttpError(422, 'COMMAND_REFUSED', `'${name}' cannot be sent by another Engine.`, { reason: 'not-a-follow-up' }))
            }
            if (typeof b.replyGrant === 'string') {
                const p = parseGrant(b.replyGrant)
                if (p && p.issuer === from) { try { rememberGrant(b.replyGrant, self) } catch { /* ignore a bad reply grant */ } }
            }
            const seq = enqueueSigned(ctx.storeHandle, command, `peer-${from}`, source, self)
            log(`[command] ${name} queued from Engine ${from} (seq ${seq})`)
            return { status: 202, body: { engineId: self, seq } }
        }

        const session = authenticate(req)
        const source: CommandSource = { kind: 'operator', operator: session.username, session: sessionShortId(session), remoteAddr, ...via }
        if (!commands.some(c => c.name === name)) await refuse(source, command, new HttpError(422, 'COMMAND_REFUSED', `Unknown command: ${name}`, { reason: 'unknown' }))
        if (LOCAL_ONLY_COMMANDS.includes(name)) await refuse(source, command, new HttpError(422, 'COMMAND_REFUSED', `'${name}' only runs from the command line on this Engine. Use installApp instead.`, { reason: 'local-only' }))

        // grants for follow-ups on other Engines
        const needed = peerEnginesNeeded(store, command, self)
        const grants = (b.grants && typeof b.grants === 'object' && !Array.isArray(b.grants)) ? b.grants as Record<string, unknown> : {}
        const missing: string[] = []
        for (const id of needed) {
            if (!hasSignedCommands(store, id)) {
                const version = String((store.engineDB as any)?.[id]?.version ?? 'unknown')
                await refuse(source, command, new HttpError(409, 'ENGINE_VERSION_MISMATCH', `Engine ${id} runs an older Engine version (${version}).`, { engineId: id, version }))
            }
            const g = grants[id]
            if (typeof g !== 'string') { missing.push(id); continue }
            const p = parseGrant(g)
            if (!p || p.issuer !== id || p.to !== self) {
                await refuse(source, command, new HttpError(403, 'GRANT_INVALID', `The permission for Engine ${id} is not valid for this Engine.`, { issuerEngineId: id }))
            }
        }
        if (missing.length) throw new HttpError(409, 'GRANT_REQUIRED', `This command needs permission from ${missing.length === 1 ? 'Engine ' + missing[0] : 'Engines ' + missing.join(', ')}.`, { engineIds: missing })

        // second confirmation (disk wipe, card flash)
        if (commandNeedsConfirm(command)) {
            if (typeof b.confirmId !== 'string') {
                let prep
                try { prep = await prepareConfirm(ctx.storeHandle, command) } catch (e) {
                    if (e instanceof ConfirmRefusal) await refuse(source, command, new HttpError(422, 'COMMAND_REFUSED', e.message, { reason: 'validation' }))
                    throw e
                }
                const c = issueConfirm(session.key, command, prep)
                throw new HttpError(428, 'CONFIRM_REQUIRED', 'Confirm this action.', { ...c })
            }
            const r = checkConfirm(session.key, command, b.confirmId, typeof b.confirmText === 'string' ? b.confirmText : '')
            if (!r.ok) await refuse(source, command, new HttpError(409, 'CONFIRM_INVALID', 'The confirmation expired or did not match. Start again.', { reason: r.reason }))
        }

        for (const id of needed) rememberGrant(grants[id] as string, self)
        const seq = enqueueSigned(ctx.storeHandle, command, `op-${sessionShortId(session)}`, source, self)
        log(`[command] ${name} queued by ${session.username} (seq ${seq})`)
        return { status: 202, body: { engineId: self, seq } }
    } catch (e) {
        if (isPeer && e instanceof HttpError) e.extra = { issuerEngineId: self, ...e.extra }
        throw e
    }
}

/** Write the answer of POST /api/command. Returns false for other paths. */
export const handleCommandApi = async (
    req: http.IncomingMessage, res: http.ServerResponse, pathname: string, cors: Record<string, string>, ctx: CommandApiContext,
): Promise<boolean> => {
    let result: CommandResult | null
    try {
        result = await routeCommand(req, pathname, ctx)
        if (!result) return false
    } catch (e: any) {
        if (e instanceof HttpError) result = { status: e.status, body: { error: e.code, message: e.message, ...e.extra } }
        else {
            log(`[command] POST /api/command failed: ${e?.message ?? e}`)
            result = { status: 500, body: { error: 'INTERNAL', message: 'The Engine could not handle this request.' } }
        }
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors })
    res.end(JSON.stringify(result.body ?? {}))
    return true
}
