/**
 * CommandLogger.ts
 *
 * Captures console output per command invocation using AsyncLocalStorage.
 * Each command gets a unique trace context that flows automatically through
 * every async call in its chain — no changes needed in individual commands.
 *
 * Usage:
 *   1. Call initCommandLogger(handle) once at engine startup.
 *   2. Wrap every command dispatch in runWithTrace(ctx, fn).
 *   3. Everything inside fn() that calls console.log/warn/error/debug
 *      is automatically collected into that trace's log list.
 */

import { AsyncLocalStorage } from 'async_hooks'
import type { DocHandle } from '@automerge/automerge-repo'
import type { CommandLogStore, LogEntry } from '../data/CommandLogStore.js'
import { flushLogs } from '../data/CommandLogStore.js'

export interface TraceContext {
  traceId: string
  command: string
  args: string
}

// ── AsyncLocalStorage instance ───────────────────────────────────────────────

const storage = new AsyncLocalStorage<TraceContext>()

export const getActiveTrace = (): TraceContext | undefined => storage.getStore()

export const runWithTrace = async <T>(
  ctx: TraceContext,
  fn: () => Promise<T>
): Promise<T> => {
  return storage.run(ctx, fn)
}

// ── Per-trace pending buffers and debounced flush ────────────────────────────

const pendingBuffers = new Map<string, LogEntry[]>()
const flushTimers    = new Map<string, ReturnType<typeof setTimeout>>()
const FLUSH_DEBOUNCE_MS = 50

let _handle: DocHandle<CommandLogStore> | null = null

const scheduleFlush = (traceId: string): void => {
  const existing = flushTimers.get(traceId)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    flushTimers.delete(traceId)
    const buffer = pendingBuffers.get(traceId)
    if (buffer && buffer.length > 0 && _handle) {
      const batch = buffer.splice(0)           // drain in-place
      flushLogs(_handle, traceId, batch)
    }
  }, FLUSH_DEBOUNCE_MS)

  flushTimers.set(traceId, timer)
}

/**
 * Append a log entry to a trace's pending buffer and schedule a flush.
 * Called from the patched console methods.
 */
export const appendToTrace = (traceId: string, entry: LogEntry): void => {
  if (!pendingBuffers.has(traceId)) pendingBuffers.set(traceId, [])
  pendingBuffers.get(traceId)!.push(entry)
  scheduleFlush(traceId)
}

/**
 * Force-flush any remaining buffered entries for a trace immediately.
 * Call this right before closeTrace so logs aren't lost on fast commands.
 */
export const flushTrace = async (traceId: string): Promise<void> => {
  const timer = flushTimers.get(traceId)
  if (timer) {
    clearTimeout(timer)
    flushTimers.delete(traceId)
  }
  const buffer = pendingBuffers.get(traceId)
  if (buffer && buffer.length > 0 && _handle) {
    const batch = buffer.splice(0)
    flushLogs(_handle, traceId, batch)
  }
  pendingBuffers.delete(traceId)
}

// ── Console patch ────────────────────────────────────────────────────────────

let _patched = false

const patchConsole = (): void => {
  if (_patched) return
  _patched = true

  const originals = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  } as const

  type Level = keyof typeof originals

  const patch = (level: Level) => {
    console[level] = (...args: unknown[]) => {
      originals[level](...args)              // always write to stdout
      const ctx = getActiveTrace()
      if (ctx) {
        appendToTrace(ctx.traceId, {
          level,
          message: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
          timestamp: Date.now(),
        })
      }
    }
  }

  patch('log')
  patch('warn')
  patch('error')
  patch('debug')
}

// ── Public init ──────────────────────────────────────────────────────────────

/**
 * Call once at engine startup, after the CommandLogStore doc is created.
 * Patches console and connects the logger to the Automerge doc handle.
 */
export const initCommandLogger = (handle: DocHandle<CommandLogStore>): void => {
  _handle = handle
  patchConsole()
}
