/**
 * ConfirmGate.ts — second confirmation for the heaviest commands (engine#582).
 *
 * Disk wipe (eraseDisk, and makeBackupDisk when it erases) and card flash
 * (flashCard) run only after two steps through the Engine API. App installs are
 * not gated (Koen, 25 Nov: too heavy for teachers); createInstance never runs from
 * outside this Pi. Steps:
 *
 *   1. The command is sent without a confirmation. The Engine checks it strictly
 *      (prepareConfirm), builds a summary from its own data and answers
 *      CONFIRM_REQUIRED with a confirmId, the summary, the field the operator
 *      must type (confirmField) and how long the confirmation stays valid.
 *   2. The same command is sent again with the confirmId and the typed text.
 *      checkConfirm accepts it once: the confirmId is tied to the session and
 *      the exact command text, expires after CONFIRM_TTL_MS (monotonic clock),
 *      and is used up by the first check, whatever its outcome.
 *
 * The command itself still runs every existing check (EraseDisk.ts, FlashCard.ts,
 * MakeBackupDisk.ts) when it executes.
 */

import crypto from 'crypto'
import type { DocHandle } from '@automerge/automerge-repo'
import type { Store } from './Store.js'
import { localEngineId } from './Engine.js'
import { splitArgs } from '../utils/commandUtils.js'
import { readSummaryFromTrace, resolveSummaryTarget } from './SummariseDisk.js'
import { findClientCard, resolveFlashImage } from './FlashCard.js'
import { monoNow } from '../utils/monoClock.js'

export const CONFIRM_TTL_MS = 60_000
export const GATED_COMMANDS: readonly string[] = ['eraseDisk', 'makeBackupDisk', 'flashCard']
export type ConfirmField = 'label' | 'sizeBytes'

export interface ConfirmPrep {
    /** What the operator is about to do, from the Engine's own data. */
    summary: Record<string, unknown>
    /** The field whose value the operator types to confirm. */
    confirmField: ConfirmField
    /** The text that confirms (compared exactly). */
    expected: string
}

export interface ConfirmChallenge {
    confirmId: string
    summary: Record<string, unknown>
    confirmField: ConfirmField
    expiresInMs: number
}

export type ConfirmCheck =
    | { ok: true }
    | { ok: false, code: 'CONFIRM_INVALID', reason: 'unknown' | 'expired' | 'session' | 'command' | 'text' }

/** A strict-validation refusal before any confirmation is issued. */
export class ConfirmRefusal extends Error {
    code = 'COMMAND_REFUSED' as const
    constructor(message: string) { super(message) }
}

interface Pending { sessionKey: string, command: string, expected: string, expiresAt: number }
const pending = new Map<string, Pending>()

const commandName = (command: string): string => command.trim().split(/\s+/)[0] ?? ''
const commandRest = (command: string): string => {
    const t = command.trim()
    const i = t.indexOf(' ')
    return i === -1 ? '' : t.slice(i + 1)
}

/**
 * Whether `command` needs the second confirmation. makeBackupDisk only when it
 * erases (it carries a summaryTraceId); adopting an IDEA disk erases nothing.
 */
export const commandNeedsConfirm = (command: string): boolean => {
    const name = commandName(command)
    if (!GATED_COMMANDS.includes(name)) return false
    if (name === 'makeBackupDisk') return splitArgs(commandRest(command)).length >= 2
    return true
}

const prune = (now: number): void => {
    for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id)
}

/** Issue a confirmation for `command` in session `sessionKey`. */
export const issueConfirm = (sessionKey: string, command: string, prep: ConfirmPrep, now: number = monoNow()): ConfirmChallenge => {
    prune(now)
    const confirmId = crypto.randomBytes(16).toString('base64url')
    pending.set(confirmId, { sessionKey, command: command.trim(), expected: prep.expected, expiresAt: now + CONFIRM_TTL_MS })
    return { confirmId, summary: prep.summary, confirmField: prep.confirmField, expiresInMs: CONFIRM_TTL_MS }
}

/** Check (and use up) a confirmation. */
export const checkConfirm = (
    sessionKey: string, command: string, confirmId: string, confirmText: string, now: number = monoNow(),
): ConfirmCheck => {
    const p = pending.get(confirmId)
    pending.delete(confirmId)
    prune(now)
    if (!p) return { ok: false, code: 'CONFIRM_INVALID', reason: 'unknown' }
    if (p.expiresAt <= now) return { ok: false, code: 'CONFIRM_INVALID', reason: 'expired' }
    if (p.sessionKey !== sessionKey) return { ok: false, code: 'CONFIRM_INVALID', reason: 'session' }
    if (p.command !== command.trim()) return { ok: false, code: 'CONFIRM_INVALID', reason: 'command' }
    if (String(confirmText ?? '') !== p.expected) return { ok: false, code: 'CONFIRM_INVALID', reason: 'text' }
    return { ok: true }
}

/** Tests only. */
export const clearConfirmsForTests = (): void => pending.clear()
export const pendingConfirmCountForTests = (): number => pending.size

/** Dependencies of prepareConfirm (card scan and image lookup touch hardware; tests replace them). */
export interface ConfirmDeps {
    findCard: typeof findClientCard
    resolveImage: typeof resolveFlashImage
}
const defaultDeps: ConfirmDeps = { findCard: findClientCard, resolveImage: resolveFlashImage }

/**
 * Strictly check a gated command against this Engine's own data and build its
 * confirmation summary. Throws ConfirmRefusal when the command cannot go on.
 */
export const prepareConfirm = async (
    storeHandle: DocHandle<Store>, command: string, deps: Partial<ConfirmDeps> = {},
): Promise<ConfirmPrep> => {
    const d = { ...defaultDeps, ...deps }
    const store = storeHandle.doc()
    if (!store) throw new ConfirmRefusal('The store is not available yet.')
    const name = commandName(command)
    const args = splitArgs(commandRest(command))

    if (name === 'eraseDisk' || name === 'makeBackupDisk') {
        const [targetId, summaryTraceId] = args
        if (!targetId || !summaryTraceId) {
            throw new ConfirmRefusal(name === 'eraseDisk'
                ? 'usage: eraseDisk <targetId> <summaryTraceId> <confirmName…>'
                : 'makeBackupDisk erases only with <targetId> <summaryTraceId> <confirmName…>')
        }
        const target = resolveSummaryTarget(store, targetId)
        if (!target) throw new ConfirmRefusal(`No disk or unformatted candidate '${targetId}' on this Engine.`)
        if (target.kind === 'disk') {
            const disk = target.disk!
            if ((disk.diskTypes ?? []).includes('system') || `ENGINE_${disk.id}` === localEngineId) {
                throw new ConfirmRefusal(`${disk.name} is this Pi's system disk and cannot be erased.`)
            }
        }
        const summary = readSummaryFromTrace(store, summaryTraceId, targetId)
        if (!summary) throw new ConfirmRefusal('The summary is missing, for another disk, older than 10 minutes, or not made by this Engine. Check the disk again.')
        return {
            summary: {
                command: name, targetId, label: summary.label, sizeBytes: summary.sizeBytes,
                device: target.kind === 'disk' ? target.disk!.device ?? null : target.candidate!.device,
                apps: (summary.apps ?? []).map(a => `${a.name} ${a.version}`.trim()),
            },
            confirmField: 'label',
            expected: summary.label,
        }
    }

    if (name === 'flashCard') {
        const [candidateId, versionArg, sizeArg] = args
        if (!candidateId || !versionArg || !/^[0-9]+$/.test(sizeArg ?? '')) {
            throw new ConfirmRefusal('usage: flashCard <candidateId> <version|current> <confirmSizeBytes>')
        }
        const card = await d.findCard(storeHandle, candidateId)
        if (!card) throw new ConfirmRefusal(`Card ${candidateId} is not present on this Engine.`)
        if (card.refusal) throw new ConfirmRefusal(`Card ${candidateId} cannot be flashed now (${card.refusal}).`)
        if (card.sizeBytes !== Number(sizeArg)) throw new ConfirmRefusal(`Card size is ${card.sizeBytes}, the dialog showed ${sizeArg}.`)
        let image: { version: string }
        try { image = await d.resolveImage(storeHandle, versionArg) } catch (e: any) { throw new ConfirmRefusal(e?.message ?? `Unknown client image '${versionArg}'.`) }
        // confirmText is the card size in bytes as a decimal string (the Console echoes
        // summary.sizeBytes once the operator confirms the Engine-built summary)
        return {
            summary: {
                command: 'flashCard', candidateId, sizeBytes: card.sizeBytes, model: card.model, version: image.version,
                // what is on the card now (the same classification as Engine.clientCards[].contents)
                contents: card.contents ? JSON.parse(JSON.stringify(card.contents)) : { kind: 'unknown' },
            },
            confirmField: 'sizeBytes',
            expected: String(card.sizeBytes),
        }
    }

    throw new ConfirmRefusal(`'${name}' does not use a confirmation.`)
}
