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
import { log, print } from '../utils/utils.js'
import { fs } from 'zx'
import path from 'path'
import { redactString } from '../utils/redact.js'
import { config, commandLogArchiveMaxBytes } from './Config.js'
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
  /** #158: storeTag of the fleet whose Engine wrote this log; another tag = a foreign log, never served. */
  storeTag?: string
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TRACES = 200

// ── Module-level handle (set by createCommandLogStore) ───────────────────────

let _handle: DocHandle<CommandLogStore> | null = null

export const getCommandLogHandle = (): DocHandle<CommandLogStore> | null => _handle

/**
 * Doc ids of command logs retired by a daily rotation (idea#183). A caller that
 * captured the handle at startup (storeMonitor, CommandLogger, a long command
 * that started before midnight) still passes the old handle; every write helper
 * redirects such a handle to the current doc, where open traces were carried.
 */
const _retired = new Set<string>()

/** The doc a write for `handle` should go to: the current doc if `handle` was rotated out. */
export const liveCommandLogHandle = (handle: DocHandle<CommandLogStore>): DocHandle<CommandLogStore> =>
  (_handle && handle !== _handle && _retired.has(handle.documentId)) ? _handle : handle

/**
 * Point the module-level handle at an existing doc. createCommandLogStore sets
 * it in production; tests use this to record into an in-memory doc without
 * touching store-identity/.
 */
export const setCommandLogHandle = (handle: DocHandle<CommandLogStore> | null): void => {
  _handle = handle
  if (handle === null) { _retired.clear(); _currentDay = null }
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
  /** Clock, for tests. Default: () => new Date() */
  now?: () => Date
  /** Default: <dir of urlFile>/command-log-archive */
  archiveDir?: string
  /** Size cap of archiveDir in bytes; oldest archives are deleted until under it. Default: settings.commandLogArchiveMaxBytes (1 GB) */
  archiveMaxBytes?: number
  /** #158: this fleet's storeTag, stamped on every log this Engine creates (and backfilled on load). */
  storeTag?: string
}

/** storeTag stamped on new command logs (#158); set by createCommandLogStore. */
let _storeTag: string | undefined
const tagged = (): CommandLogStore => ({ traces: {}, recentTraceIds: [], ...(_storeTag ? { storeTag: _storeTag } : {}) })

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
  const urlFile = options.urlFile ?? defaultUrlFile()
  const timeoutMs = options.timeoutMs ?? COMMAND_LOG_LOAD_TIMEOUT_MS
  if (options.storeTag) _storeTag = options.storeTag

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

  // #158: logs created before the tag existed get our tag (this is our own log, by our url file)
  if (_storeTag && handle.doc() && !handle.doc().storeTag) {
    handle.change(d => { d.storeTag = _storeTag })
    log(`[commandLog] Stamped storeTag ${_storeTag} on ${handle.url}`)
  }
  _handle = handle
  const today = localDay(options.now?.() ?? new Date())
  if (!existingUrl || handle.url !== existingUrl) {
    // A fresh doc was just created: it belongs to today.
    await writeAtomic(dayFileFor(urlFile), today)
    _currentDay = today
    return handle
  }
  _currentDay = readDayFile(urlFile)

  // idea#183: rotate at startup when the loaded doc is from another day (or
  // predates rotation and has no day file), so an Engine that was off at
  // midnight, or is upgraded, starts on a small doc.
  if (_currentDay !== today) {
    log(`[commandLog] CommandLog day is ${_currentDay ?? 'unknown'}, today is ${today}: rotating at startup`)
    await rotateCommandLog(repo, options)
  }
  return _handle!
}

// ── Daily rotation (idea#183) ────────────────────────────────────────────────


/**
 * Traces closed less than this long before a rotation are carried into the new
 * doc, so a reader that switches docs right after midnight still finds the
 * result of a command it sent just before. Running traces are always carried.
 */
export const COMMAND_LOG_CARRY_GRACE_MS = 15 * 60_000

/** How often the Engine checks for a local date change. */
export const COMMAND_LOG_ROTATION_CHECK_MS = 60_000

let _currentDay: string | null = null
let _rotating: Promise<DocHandle<CommandLogStore>> | null = null

/** YYYY-MM-DD of `d` in the Engine's local timezone. */
export const localDay = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const dayFileFor = (urlFile: string) => path.join(path.dirname(urlFile), 'command-log-day.txt')
const defaultUrlFile = () => path.join('./' + config.settings.storeIdentityFolder, 'command-log-url.txt')

const readDayFile = (urlFile: string): string | null => {
  try {
    const d = fs.readFileSync(dayFileFor(urlFile), 'utf-8').trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
  } catch { return null }
}

/** Write via temp file + rename, so a reader of /api/command-log-url never sees a half-written URL. */
const writeAtomic = async (file: string, content: string): Promise<void> => {
  await fs.ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, content)
  await fs.rename(tmp, file)
}

/** Day of the current CommandLog doc (null before createCommandLogStore). */
export const getCommandLogDay = (): string | null => _currentDay

/**
 * Start a fresh CommandLog doc and archive the current one (idea#183).
 *
 * 1. Create the new doc with every running trace, and every trace closed in the
 *    last COMMAND_LOG_CARRY_GRACE_MS, copied in (same traceIds, same order).
 * 2. Switch synchronously: module handle, retired set, so writes made through
 *    the old handle from now on land in the new doc.
 * 3. Point readers at it: command-log-url.txt (served by /api/command-log-url)
 *    and command-log-day.txt are rewritten atomically.
 * 4. Archive the old doc: Automerge binary saved to
 *    <archiveDir>/command-log-<day>-<documentId>.automerge, then the doc is
 *    deleted from the Repo (no more sync, removed from store-data).
 * 5. Size cap: while archiveDir is over archiveMaxBytes, delete the oldest archive
 *    (one at a time, each deletion logged). No age-based deletion (Koen 2026-10-15).
 *
 * Concurrent calls share one rotation.
 */
export const rotateCommandLog = (
  repo: Repo,
  options: CommandLogStoreOptions = {},
): Promise<DocHandle<CommandLogStore>> => {
  if (_rotating) return _rotating
  _rotating = _rotate(repo, options).finally(() => { _rotating = null })
  return _rotating
}

const _rotate = async (repo: Repo, options: CommandLogStoreOptions): Promise<DocHandle<CommandLogStore>> => {
  const urlFile = options.urlFile ?? defaultUrlFile()
  const archiveDir = options.archiveDir ?? path.join(path.dirname(urlFile), 'command-log-archive')
  const archiveMaxBytes = options.archiveMaxBytes ?? commandLogArchiveMaxBytes()
  const now = options.now?.() ?? new Date()
  const today = localDay(now)
  const old = _handle
  const oldDay = _currentDay ?? 'unknown'

  const fresh = repo.create<CommandLogStore>(tagged())
  await fresh.whenReady()

  // Snapshot + carry + switch with no await in between, so no write is lost.
  let carried = 0
  const oldDoc = old?.isReady() ? old.doc() : undefined
  if (oldDoc) {
    const cutoff = now.getTime() - COMMAND_LOG_CARRY_GRACE_MS
    const keep = (oldDoc.recentTraceIds ?? []).filter(id => {
      const t = oldDoc.traces[id]
      return t && (t.status === 'running' || (t.completedAt ?? 0) >= cutoff)
    })
    if (keep.length) {
      fresh.change(doc => {
        for (const id of keep) {
          doc.traces[id] = JSON.parse(JSON.stringify(oldDoc.traces[id]))
          ;(doc.recentTraceIds as string[]).push(id)
        }
      })
    }
    carried = keep.length
  }
  if (old) _retired.add(old.documentId)
  _handle = fresh
  _currentDay = today

  await writeAtomic(urlFile, fresh.url)
  await writeAtomic(dayFileFor(urlFile), today)
  log(`[commandLog] Rotated CommandLog ${old?.url ?? '(none)'} (${oldDay}) -> ${fresh.url} (${today}), carried ${carried} open/recent trace(s)`)

  if (old) {
    try {
      const bin = old.isReady() ? await repo.export(old.documentId) : undefined
      if (bin) {
        await fs.ensureDir(archiveDir)
        const file = path.join(archiveDir, `command-log-${oldDay}-${old.documentId}.automerge`)
        await fs.writeFile(file, bin)
        log(`[commandLog] Archived previous CommandLog to ${file} (${bin.byteLength} bytes)`)
      }
      repo.delete(old.documentId)
    } catch (e) {
      log(`[commandLog] Could not archive previous CommandLog ${old.url}: ${e instanceof Error ? e.message : e}`)
    }
  }
  await capCommandLogArchives(archiveDir, archiveMaxBytes)
  return fresh
}

const ARCHIVE_RE = /^command-log-(.+)-[^-]+\.automerge$/
const ARCHIVE_DAY_RE = /^command-log-(\d{4}-\d{2}-\d{2})-.+\.automerge$/

/** Archive files of archiveDir, oldest first: by the day in the name, then mtime, then name. Other files are ignored. */
export const listCommandLogArchives = async (archiveDir: string): Promise<{ name: string, size: number, day: string, mtimeMs: number }[]> => {
  if (!fs.existsSync(archiveDir)) return []
  const out: { name: string, size: number, day: string, mtimeMs: number }[] = []
  for (const name of await fs.readdir(archiveDir)) {
    if (!ARCHIVE_RE.test(name)) continue
    const st = await fs.stat(path.join(archiveDir, name))
    if (!st.isFile()) continue
    // A file without a day in its name (command-log-unknown-…) sorts by mtime among dated ones of the same mtime day.
    const day = ARCHIVE_DAY_RE.exec(name)?.[1] ?? localDay(new Date(st.mtimeMs))
    out.push({ name, size: st.size, day, mtimeMs: st.mtimeMs })
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
}

/**
 * Size cap (#185, Koen 2026-10-15): while the archive files of archiveDir total more
 * than maxBytes, delete the oldest one, logging each deletion. Never deletes by age,
 * never touches other files. Returns the deleted file names in deletion order.
 */
export const capCommandLogArchives = async (archiveDir: string, maxBytes: number): Promise<string[]> => {
  const files = await listCommandLogArchives(archiveDir)
  let total = files.reduce((n, f) => n + f.size, 0)
  const removed: string[] = []
  for (const f of files) {
    if (total <= maxBytes) break
    await fs.remove(path.join(archiveDir, f.name))
    total -= f.size
    removed.push(f.name)
    // print, not log: always written (log is verbosity-gated), every deletion must be in the Engine log
    print(`[commandLog] Archive folder over its size cap (${maxBytes} bytes): deleted oldest archive ${f.name} (${f.size} bytes), ${total} bytes left`)
  }
  // One line per cap check that deletes nothing (Koen 2026-10-15), so every rotation shows the check ran
  if (removed.length === 0) print(`[commandLog] command-log archive ${total} bytes under cap ${maxBytes}, nothing deleted`)
  return removed
}

/**
 * Check the local date every COMMAND_LOG_ROTATION_CHECK_MS and rotate when it
 * changed (idea#183). Returns a stop function.
 */
export const startCommandLogRotation = (
  repo: Repo,
  options: CommandLogStoreOptions & { intervalMs?: number } = {},
): (() => void) => {
  const timer = setInterval(() => {
    const today = localDay(options.now?.() ?? new Date())
    if (_currentDay && _currentDay !== today && !_rotating) {
      rotateCommandLog(repo, options).catch(e =>
        log(`[commandLog] Rotation failed: ${e instanceof Error ? e.message : e}`))
    }
  }, options.intervalMs ?? COMMAND_LOG_ROTATION_CHECK_MS)
  timer.unref?.()
  return () => clearInterval(timer)
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
  const handle = repo.create<CommandLogStore>(tagged())
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
  liveCommandLogHandle(handle).change(doc => {
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
  liveCommandLogHandle(handle).change(doc => {
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
  liveCommandLogHandle(handle).change(doc => {
    const trace = doc.traces[traceId]
    if (!trace) return
    if (trace.status === 'error' && status === 'ok') return
    trace.status = status
    trace.completedAt = Date.now()
    if (errorMessage) trace.errorMessage = redactString(errorMessage)
    if (fromStash !== undefined && fromStash !== null) trace.result = redactString(fromStash)
  })
}
