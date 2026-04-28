# Command Logging — Design Document

## Problem

Every command execution writes to `console.log/warn/error`. Because commands run
concurrently (copyApp on instance A and backupApp on instance B at the same time),
their log lines interleave in stdout with no way to associate a line back to its
originating command. The Console cannot display per-command logs today.

---

## Solution Overview

Use Node's built-in `AsyncLocalStorage` to attach a **trace context** to every
command invocation. Patch `console` once at startup so every log call inside an
async call chain automatically appends to that trace's log list. Store traces in
a dedicated Automerge doc that syncs to the Console. SolidJS renders the log list
reactively — Automerge list appends stream in as they arrive.

No external libraries are required.

---

## Data Model

### CommandLogStore (separate Automerge doc)

```typescript
interface CommandLogStore {
  traces: Record<string, CommandTrace>  // keyed by traceId (nanoid)
  recentTraceIds: string[]              // insertion-ordered ring buffer, max 200
}

interface CommandTrace {
  traceId: string
  command: string           // e.g. "backupApp"
  args: string              // JSON.stringify of raw args
  startedAt: number         // Date.now()
  completedAt: number | null
  status: 'running' | 'ok' | 'error'
  errorMessage: string | null
  logs: LogEntry[]          // Automerge list — appended in batches
}

interface LogEntry {
  level: 'log' | 'warn' | 'error' | 'debug'
  message: string
  timestamp: number
}
```

**Ring buffer:** when trace #201 is created, delete `traces[recentTraceIds[0]]`
and shift `recentTraceIds`. Max in-memory footprint: 200 traces × ~100 log lines
× ~200 bytes ≈ ~4 MB worst case, acceptable on Pi.

**Not stored in the main store.** The main store is persistent app/disk/instance
state synced to disk. Command logs are ephemeral, high-frequency, and non-critical.
Mixing them in would pollute the CRDT history.

---

## Log Batching

Appending one Automerge change per `console.log` call creates excessive CRDT churn.
Instead:

1. Each active trace keeps a small **pending buffer** in memory (`LogEntry[]`).
2. A **50 ms debounced flush** batches all pending entries into a single
   Automerge change (`trace.logs.push(...batch)`).
3. That single change propagates to all connected Console clients as one sync
   message.
4. SolidJS `<For>` renders all new rows in one pass.

50 ms lag is imperceptible in a UI log panel. A command that emits 50 lines in
10 ms produces one sync round-trip rather than 50.

---

## Module Design

### `src/utils/CommandLogger.ts` (new)

Owns the `AsyncLocalStorage` instance. Patches `console` once (idempotent guard).
Manages pending buffers and debounced flushes.

```typescript
export interface TraceContext {
  traceId: string
  command: string
  args: string
}

// Called once at engine startup
export const initCommandLogger = (store: CommandLogStore): void

// Wrap a command invocation — everything inside fn() runs in this trace context
export const runWithTrace = async <T>(
  ctx: TraceContext,
  fn: () => Promise<T>
): Promise<T>

// Read the active trace from any async depth (used by the patched console)
export const getActiveTrace = (): TraceContext | undefined
```

Console patch (applied once by `initCommandLogger`):

```typescript
const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug }

for (const level of ['log', 'warn', 'error', 'debug'] as const) {
  console[level] = (...args) => {
    original[level](...args)          // still write to stdout
    const ctx = getActiveTrace()
    if (ctx) pendingBuffer.get(ctx.traceId)?.push({ level, message: args.join(' '), timestamp: Date.now() })
  }
}
```

### `src/data/CommandLogStore.ts` (new)

Creates and owns the `commandLogStore` Automerge doc. The doc is created in the
same `Repo` as the main store — Console clients connect once and sync both.

```typescript
export interface CommandLogStore { traces: Record<string, CommandTrace>; recentTraceIds: string[] }

export const createCommandLogStore = async (repo: Repo): Promise<DocHandle<CommandLogStore>>

export const addTrace    = (handle: DocHandle<CommandLogStore>, trace: Omit<CommandTrace, 'logs'>): void
export const flushLogs   = (handle: DocHandle<CommandLogStore>, traceId: string, entries: LogEntry[]): void
export const closeTrace  = (handle: DocHandle<CommandLogStore>, traceId: string, status: 'ok' | 'error', errorMessage?: string): void
```

The store URL for this doc is exposed at **`GET /api/command-log-url`**, mirroring
the existing `/api/store-url` pattern.

### `src/utils/commandUtils.ts` — `handleCommand` (modified)

Wrap the existing dispatch in `runWithTrace`. No changes to individual command
implementations.

```typescript
export const handleCommand = async (
  commands: CommandDefinition[],
  storeHandle: DocHandle<Store> | null,
  context: 'console' | 'engine',
  input: string,
  commandLogHandle?: DocHandle<CommandLogStore>   // optional; skipped when absent
): Promise<void> => {
  const traceId = nanoid()
  const ctx: TraceContext = { traceId, command: commandName, args: JSON.stringify(stringArgs) }

  if (commandLogHandle) addTrace(commandLogHandle, { traceId, command: commandName, args: ..., startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })

  try {
    await runWithTrace(ctx, () => command.execute(storeHandle, ...args))
    if (commandLogHandle) closeTrace(commandLogHandle, traceId, 'ok')
  } catch (e) {
    if (commandLogHandle) closeTrace(commandLogHandle, traceId, 'error', e.message)
    throw e
  }
}
```

### `src/start.ts` (modified)

After creating the Automerge repo and before starting monitors:

```typescript
const commandLogHandle = await createCommandLogStore(repo)
initCommandLogger(commandLogHandle)
// Pass commandLogHandle into enableStoreMonitor / handleCommand paths
```

### `src/monitors/httpMonitor.ts` (modified)

Add `GET /api/command-log-url` route, same pattern as `/api/store-url`.

---

## Console UI

The Console discovers the command log doc URL from `/api/command-log-url`, then
connects to it via the same Automerge WebSocket the main store already uses.

```
┌─────────────────────┬──────────────────────────────┐
│  Command History    │  Logs — backupApp(...)        │
│                     │  ● RUNNING                    │
│  ✅ listDisks       │                               │
│  ✅ installApp      │  [22:01:03] Pulling image...  │
│  🔄 backupApp   ◀── │  [22:01:04] Layer 1/3 done    │
│  ✅ ejectDisk       │  [22:01:06] Layer 2/3 done    │
│                     │  ▌ (auto-scroll)              │
└─────────────────────┴──────────────────────────────┘
```

**SolidJS (Console side):**

```typescript
const trace = () => commandLogStore()?.traces[selectedTraceId()]

<For each={trace()?.logs}>
  {(entry) => <LogRow level={entry.level} message={entry.message} ts={entry.timestamp} />}
</For>
```

Automerge list inserts propagate via WS sync → SolidJS store update →
`<For>` rerenders only the appended rows. No polling. No custom WS event types.

**Status badge:** `trace().status === 'running'` → spinner. `'ok'` → ✅. `'error'` → ❌ + `errorMessage`.

---

## What Does Not Change

- Individual command implementations (`InstallApp.ts`, `CopyMoveApp.ts`, etc.) — untouched.
- Main store schema — no new fields.
- Automerge repo/network setup — same WS server, same sync protocol.
- Tests — `commandLogHandle` is optional in `handleCommand`; existing tests pass `undefined`.

---

## File Changelist

| File | Change |
|------|--------|
| `src/utils/CommandLogger.ts` | **New** — AsyncLocalStorage, console patch, pending buffer, debounce |
| `src/data/CommandLogStore.ts` | **New** — Automerge doc lifecycle, addTrace / flushLogs / closeTrace |
| `src/utils/commandUtils.ts` | **Modified** — wrap handleCommand in runWithTrace |
| `src/data/Commands.ts` | **No change** |
| `src/start.ts` | **Modified** — create CommandLogStore, init CommandLogger, wire through |
| `src/monitors/httpMonitor.ts` | **Modified** — add /api/command-log-url route |
| `src/monitors/storeMonitor.ts` | **Modified** — pass commandLogHandle into handleCommand |
| `src/data/CommonTypes.ts` | **Modified** — add CommandTrace, LogEntry, CommandLogStore types |

Console changes are separate (not in this repo).
