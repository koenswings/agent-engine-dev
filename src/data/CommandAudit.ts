/**
 * CommandAudit.ts — Engine-local command audit log (engine#582).
 *
 * One JSON line per command or refusal in <authFolder>/command-audit.log:
 *   { t, engineId, seq, command, args, source, result, errorCode }
 * Args are redacted (redact.ts). Rotates at AUDIT_MAX_BYTES and keeps
 * AUDIT_KEEP_FILES older files (command-audit.log.1 … .5). Never synced, and kept
 * when the command-log document is rotated. Writing never throws: an audit
 * failure is logged once and the command goes on.
 */

import fs from 'fs'
import { authFile, ensureAuthFolder } from './AuthFolder.js'
import { authFolder } from './Config.js'
import { redactString } from '../utils/redact.js'
import { log } from '../utils/utils.js'
import type { CommandSource } from './CommandSource.js'

export const AUDIT_FILE_NAME = 'command-audit.log'
export const AUDIT_MAX_BYTES = 10 * 1024 * 1024
export const AUDIT_KEEP_FILES = 5

export interface AuditEntry {
    t: number
    engineId: string
    seq?: number | null
    command: string
    args: string
    source?: CommandSource | null
    result: 'ok' | 'error' | 'refused'
    errorCode?: string | null
}

let warned = false

/** Rotate `file` when it is at or over maxBytes: .4 → .5, …, file → .1. */
export const rotateAuditFile = (file: string, maxBytes: number = AUDIT_MAX_BYTES, keep: number = AUDIT_KEEP_FILES): void => {
    let size = 0
    try { size = fs.statSync(file).size } catch { return }
    if (size < maxBytes) return
    for (let i = keep - 1; i >= 1; i--) {
        try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`) } catch { /* gap */ }
    }
    try { fs.renameSync(file, `${file}.1`) } catch { /* raced */ }
}

/** Append one audit line. Options are for tests. */
export const appendAudit = (
    entry: AuditEntry,
    opts: { dir?: string, maxBytes?: number, keep?: number } = {},
): void => {
    try {
        const dir = ensureAuthFolder(opts.dir ?? authFolder())
        const file = authFile(AUDIT_FILE_NAME, dir)
        rotateAuditFile(file, opts.maxBytes, opts.keep)
        const line: Record<string, unknown> = {
            t: entry.t,
            engineId: entry.engineId,
            seq: entry.seq ?? null,
            command: entry.command,
            args: redactString(entry.args ?? ''),
            source: entry.source ?? null,
            result: entry.result,
            errorCode: entry.errorCode ?? null,
        }
        fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 })
    } catch (e: any) {
        if (!warned) {
            warned = true
            log(`[audit] could not write the command audit log: ${e?.message ?? e}`)
        }
    }
}
