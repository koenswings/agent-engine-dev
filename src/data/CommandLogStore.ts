/**
 * CommandLogStore.ts
 *
 * Manages the ephemeral Automerge document that holds command traces and their
 * captured log output. Lives in the same Repo as the main store so Console
 * clients can sync both over the existing WebSocket connection.
 *
 * The doc URL is exposed at GET /api/command-log-url (added to httpMonitor).
 */

import { DocHandle, Repo, isValidAutomergeUrl } from '@automerge/automerge-repo'
import { log } from '../utils/utils.js'
import { fs } from 'zx'
import path from 'path'
import { config } from './Config.js'
import { stopPeriodicFlush } from '../repo.js'

// ── Types (also exported for use in CommonTypes consumers) ───────────────────

export type LogLevel = 'log' | 'warn' | 'error' | 'debug' | 'info'

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
  /** JSON result for commands that return data (summariseDisk, idea#134); null otherwise */
  result?: string | null
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

/**
 * Point the module-level handle at an existing doc. createCommandLogStore sets
 * it in production; tests use this to record into an in-memory doc without
 * touching store-identity/.
 */
export const setCommandLogHandle = (handle: DocHandle<CommandLogStore> | null): void => {
  _handle = handle
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * How long createCommandLogStore waits for the doc named in
 * command-log-url.txt (idea#145). The doc is normally in local storage and
 * loads in milliseconds. On a fresh Engine the tracked URL points at the
 * fleet's shared log, which no peer may have (a new school Pi has no peers),
 * and after a store-data wipe the Engine's own previous log is gone: then
 * repo.find()/whenReady() could wait forever and the Console never came up.
 */
export const COMMAND_LOG_LOAD_TIMEOUT_MS = 10_000

export interface CommandLogStoreOptions {
  /** Default: <storeIdentityFolder>/command-log-url.txt */
  urlFile?: string
  /** Default: COMMAND_LOG_LOAD_TIMEOUT_MS */
  timeoutMs?: number
}

/**
 * Load the doc at `url`, giving up after `timeoutMs` (idea#145). Rejects when
 * the doc is unavailable (not in storage, no peer has it) or the time runs out;
 * the pending find is aborted.
 */
export const findCommandLogWithTimeout = async (
  repo: Repo,
  url: string,
  timeoutMs: number,
): Promise<DocHandle<CommandLogStore>> => {
  if (!isValidAutomergeUrl(url)) throw new Error(`'${url}' is not a valid Automerge URL`)
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const load = async () => {
    const handle = await repo.find<CommandLogStore>(url, { signal: controller.signal })
    await handle.whenReady()
    return handle
  }
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`not available after ${timeoutMs} ms (not in local storage and no peer supplied it)`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([load(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create the CommandLogStore Automerge doc inside the given Repo.
 * Persists the doc URL next to the main store URL so it survives restarts.
 *
 * If command-log-url.txt names a doc that cannot be loaded within the timeout
 * (fresh Engine whose tracked URL no peer has, or store-data wiped), a fresh
 * CommandLogStore is created and its URL is written to command-log-url.txt, so
 * startup never hangs (idea#145). The command log is ephemeral history, so
 * nothing needed is lost; the main store is not affected.
 */
export const createCommandLogStore = async (
  repo: Repo,
  options: CommandLogStoreOptions = {},
): Promise<DocHandle<CommandLogStore>> => {
  const urlFile = options.urlFile ?? path.join('./' + config.settings.storeIdentityFolder, 'command-log-url.txt')
  const timeoutMs = options.timeoutMs ?? COMMAND_LOG_LOAD_TIMEOUT_MS

  let handle: DocHandle<CommandLogStore>

  const existingUrl = fs.existsSync(urlFile) ? (await fs.readFile(urlFile, 'utf-8')).trim() : ''
  if (existingUrl) {
    log(`[commandLog] Loading existing CommandLogStore from ${existingUrl} (timeout ${timeoutMs} ms)`)
    try {
      handle = await findCommandLogWithTimeout(repo, existingUrl, timeoutMs)
      log(`[commandLog] CommandLogStore loaded, state: ${handle.state}`)
    } catch (e) {
      log(`[commandLog] Could not load ${existingUrl}: ${e instanceof Error ? e.message : e}. Creating a fresh CommandLogStore and rewriting ${urlFile}`)
      handle = await _createFresh(repo, urlFile)
    }
  } else {
    log(`[commandLog] No existing CommandLogStore found, creating fresh one`)
    handle = await _createFresh(repo, urlFile)
  }

  _handle = handle
  return handle
}

/**
 * Shut a Repo down without failing on a handle that never became ready
 * (idea#145). repo.shutdown() flushes every cached handle and throws
 * "DocHandle is not ready" for one that is still unavailable, such as a
 * command log that timed out. Then only the ready handles are flushed again,
 * so the store and the new command log are still saved.
 */
export const shutdownRepo = async (repo: Repo): Promise<void> => {
  // r34 DURABILITY: stop the backstop flush (src/repo.ts) first, so no periodic
  // tick runs during or after the final flush.
  await stopPeriodicFlush(repo)
  try {
    await repo.shutdown()
  } catch (e) {
    log(`[repo] shutdown flush failed (${e instanceof Error ? e.message : e}); flushing the ready documents only`)
    const ready = Object.values(repo.handles).filter(h => h.isReady()).map(h => h.documentId)
    await repo.flush(ready)
  }
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
  await fs.ensureDir(path.dirname(urlFile))
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

/** Stash for attachTraceResult → closeTrace atomic publish (Prefer A r42). */
const pendingTraceResults = new Map<string, string>()

export const stashTraceResult = (traceId: string, resultJson: string): void => {
  pendingTraceResults.set(traceId, resultJson)
}

export const takePendingTraceResult = (traceId: string): string | undefined => {
  const v = pendingTraceResults.get(traceId)
  pendingTraceResults.delete(traceId)
  return v
}

/**
 * Mark a trace as completed. Call after the command resolves or rejects.
 * A trace already closed as 'error' stays 'error': a later 'ok' close (e.g. the
 * wrapper of a command whose inner work recorded a failure, idea#109) does not
 * hide the failure. Pending attachTraceResult is applied in the same change.
 */
export const closeTrace = (
  handle: DocHandle<CommandLogStore>,
  traceId: string,
  status: 'ok' | 'error',
  errorMessage?: string,
  /** When set, written in the same Automerge change as status (Console sees both together). */
  resultJson?: string | null,
): void => {
  const fromStash = resultJson !== undefined ? resultJson : takePendingTraceResult(traceId)
  handle.change(doc => {
    const trace = doc.traces[traceId]
    if (!trace) return
    if (trace.status === 'error' && status === 'ok') return
    trace.status = status
    trace.completedAt = Date.now()
    if (errorMessage) trace.errorMessage = errorMessage
    if (fromStash !== undefined && fromStash !== null) trace.result = fromStash
  })
}
