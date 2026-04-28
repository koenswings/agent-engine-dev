/**
 * CommandLogStore.ts
 *
 * Manages the ephemeral Automerge document that holds command traces and their
 * captured log output. Lives in the same Repo as the main store so Console
 * clients can sync both over the existing WebSocket connection.
 *
 * The doc URL is exposed at GET /api/command-log-url (added to httpMonitor).
 */

import { DocHandle, Repo } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { fs } from 'zx'
import path from 'path'
import { config } from './Config.js'

// ── Types (also exported for use in CommonTypes consumers) ───────────────────

export type LogLevel = 'log' | 'warn' | 'error' | 'debug'

export interface LogEntry {
  level: LogLevel
  message: string
  timestamp: number
}

export type TraceStatus = 'running' | 'ok' | 'error'

export interface CommandTrace {
  traceId: string
  command: string
  args: string              // JSON.stringify of raw args array
  startedAt: number
  completedAt: number | null
  status: TraceStatus
  errorMessage: string | null
  logs: LogEntry[]          // Automerge list — appended in batches via flushLogs
}

export interface CommandLogStore {
  traces: Record<string, CommandTrace>
  recentTraceIds: string[]  // insertion-ordered ring buffer, max MAX_TRACES entries
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TRACES = 200

// ── Module-level handle (set by createCommandLogStore) ───────────────────────

let _handle: DocHandle<CommandLogStore> | null = null

export const getCommandLogHandle = (): DocHandle<CommandLogStore> | null => _handle

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Create the CommandLogStore Automerge doc inside the given Repo.
 * Persists the doc URL next to the main store URL so it survives restarts.
 */
export const createCommandLogStore = async (
  repo: Repo
): Promise<DocHandle<CommandLogStore>> => {
  const identityDir = './' + config.settings.storeIdentityFolder
  const urlFile = path.join(identityDir, 'command-log-url.txt')

  let handle: DocHandle<CommandLogStore>

  if (fs.existsSync(urlFile)) {
    const existingUrl = (await fs.readFile(urlFile, 'utf-8')).trim() as any
    log(`[commandLog] Loading existing CommandLogStore from ${existingUrl}`)
    try {
      handle = await repo.find<CommandLogStore>(existingUrl)
      await handle.whenReady()
      log(`[commandLog] CommandLogStore loaded, state: ${handle.state}`)
    } catch (e) {
      log(`[commandLog] Failed to load existing doc (${e}), creating fresh one`)
      handle = await _createFresh(repo, urlFile)
    }
  } else {
    log(`[commandLog] No existing CommandLogStore found, creating fresh one`)
    handle = await _createFresh(repo, urlFile)
  }

  _handle = handle
  return handle
}

const _createFresh = async (
  repo: Repo,
  urlFile: string
): Promise<DocHandle<CommandLogStore>> => {
  const handle = repo.create<CommandLogStore>({
    traces: {},
    recentTraceIds: [],
  })
  await handle.whenReady()
  await fs.writeFile(urlFile, handle.url)
  log(`[commandLog] Created new CommandLogStore: ${handle.url}`)
  return handle
}

// ── Mutation helpers (called from CommandLogger / handleCommand) ─────────────

/**
 * Register a new trace as 'running'. Call before the command executes.
 */
export const addTrace = (
  handle: DocHandle<CommandLogStore>,
  trace: Omit<CommandTrace, 'logs'>
): void => {
  handle.change(doc => {
    doc.traces[trace.traceId] = { ...trace, logs: [] }
    ;(doc.recentTraceIds as string[]).push(trace.traceId)

    // Evict oldest when over the limit
    if ((doc.recentTraceIds as string[]).length > MAX_TRACES) {
      const evicted = (doc.recentTraceIds as string[]).splice(0, 1)[0]
      if (evicted) delete doc.traces[evicted]
    }
  })
}

/**
 * Append a batch of log entries to a trace's logs list.
 * Call this from the debounced flush in CommandLogger.
 */
export const flushLogs = (
  handle: DocHandle<CommandLogStore>,
  traceId: string,
  entries: LogEntry[]
): void => {
  if (!entries.length) return
  handle.change(doc => {
    const trace = doc.traces[traceId]
    if (!trace) return
    for (const entry of entries) {
      ;(trace.logs as LogEntry[]).push(entry)
    }
  })
}

/**
 * Mark a trace as completed. Call after the command resolves or rejects.
 */
export const closeTrace = (
  handle: DocHandle<CommandLogStore>,
  traceId: string,
  status: 'ok' | 'error',
  errorMessage?: string
): void => {
  handle.change(doc => {
    const trace = doc.traces[traceId]
    if (!trace) return
    trace.status = status
    trace.completedAt = Date.now()
    if (errorMessage) trace.errorMessage = errorMessage
  })
}
