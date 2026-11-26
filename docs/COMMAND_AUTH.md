# Operator sign-in and signed commands (engine#582)

**Status:** being built in steps (see "Steps" below). This page describes what is on the
branch it ships with; later steps add their sections.

Design record: [engine#582](https://github.com/koenswings/agent-engine-dev/issues/582).

## Steps

| Step | What | State |
|---|---|---|
| 1 | CORS and store WebSocket Origin check for own Console origins, second confirmation gate (module), `createInstance` local-only, git account pin, command source on traces, local audit log | this page |
| 2 | Engine-local operator accounts, setup code, challenge sign-in, sessions | later |
| 3 | Command key, signed queue entries, `POST /api/command`, peer grants, mixed-version refusal | later |
| 4 | `/api/engines/<id>/…` relay | later |
| 5 | Firewall script for Ops | later |

## Engine-local auth folder

`settings.authFolder` (env `IDEA_AUTH_DIR` wins). Default `~/.idea-engine/auth`, which is
`/home/pi/.idea-engine/auth` under pm2 on a Pi: outside the checkout, so a redeploy keeps
it. Created 0700 on first use; files in it are 0600. It is never synced, never part of a
disk backup or a kit image, and must never be copied between Pis. In `testMode`, without a
setting or env, it is a per-process folder under the OS temp dir.

Step 1 writes only `command-audit.log` there.

## CORS: own Console origins only

`src/monitors/consoleOrigins.ts`. `/api/*` answers carry `Access-Control-Allow-Origin` (the
request's origin, echoed, plus `Vary: Origin`) only when the `Origin` is one of this
Engine's own Console origins:

- hosts: `<hostname>`, `<hostname>.local`, `idea.local`, `localhost`, `127.0.0.1` and every
  non-internal IPv4 address of the Pi (LAN, Tailscale);
- ports: the port the request came in on, `httpPort` and `ideaLocalHttpPort` (port 80 is
  written without a port);
- plus the exact origins in `settings.devConsoleOrigins` (default none; for Console
  development, for example `http://localhost:5173`).

A request without `Origin` gets no CORS header. `OPTIONS` on `/api/*` answers 204; for an
allowed origin it also allows `GET, POST, DELETE, OPTIONS` and the `Authorization` and
`Content-Type` headers.

**Store WebSocket (port `settings.port`, and the Upgrade pass-through on the HTTP ports).**
The same allow-list applies to a browser `Origin` on the WebSocket handshake
(`src/utils/originCheck.ts` `isWsOriginAllowed`, checked in the server thread). A request
without `Origin` (Engines, the CLI) goes on to the store-scoped peering check as before. A
`chrome-extension://<id>` origin (the Console side panel) is let through; a web page cannot
send that origin. Any other origin gets HTTP 401 and is logged at most once a minute per origin.

**Console impact:** a Console page served by one Engine can no longer read another
Engine's `/api/store-url` or `/api/command-log-url` directly (remote command logs,
probing another Engine in Connection management). Step 4 adds the relay the Console uses
instead. The Console extension is not affected (host permissions, no CORS).

## Second confirmation (module)

`src/data/ConfirmGate.ts`. Disk wipe (`eraseDisk`, and `makeBackupDisk` when it erases,
that is when it carries a summary trace) and card flash (`flashCard`) are gated. App
installs are not (decision of 25 Nov: too heavy for teachers); `createInstance` never runs
from outside this Pi; `summariseDisk` and other read-only commands need no confirmation.

- `prepareConfirm` checks the command against this Engine's own data and builds a summary:
  - `eraseDisk` / `makeBackupDisk`: the target is a disk docked here or an unformatted
    candidate here, not the system disk; the summary trace is this Engine's own
    `summariseDisk` trace (see below) and at most 10 minutes old.
    Summary `{ command, targetId, label, sizeBytes, device, apps: ["<name> <version>"] }`.
    Confirm field `label`; the confirm text is the label exactly as in the summary.
  - `flashCard`: the card is present here with no refusal and the size shown; the version
    is a known client image. Summary `{ command, candidateId, sizeBytes, model, version }`.
    Confirm field `sizeBytes`; the confirm text is the size in bytes as a decimal string.
- `issueConfirm` returns `{ confirmId, summary, confirmField, expiresInMs: 60000 }`.
- `checkConfirm` accepts a confirmation once: same session, same command text, confirm text
  equal to the expected value, within 60 s on the monotonic clock. Any check uses it up.

Step 3 wires this into `POST /api/command`; the store queue path is unchanged in step 1.

**Own summaries only.** `readSummaryFromTrace` (used by `eraseDisk` and `makeBackupDisk`)
only accepts a `summariseDisk` trace this Engine process wrote itself
(`rememberOwnSummaryTrace`). A trace that only appears in the command-log document is
ignored. A restart forgets them; the disk is checked again.

## createInstance and the git account pin

`createInstance` (deprecated) clones an app from a GitHub account given as an argument. It
now only runs when the command comes from this Pi (`commandUtils` `LOCAL_ONLY_COMMANDS`).
From the store queue, an operator or a peer it is refused with `COMMAND_REFUSED` and
nothing runs. `installApp` replaces it.

`buildInstance` (used by both) only clones from accounts in `settings.allowedGitAccounts`
(default `['koenswings']`); another account fails with `GIT_ACCOUNT_NOT_ALLOWED`.

## Command source and the audit log

`handleCommand(commands, store, context, input, log, { source, seq })`.
`source` (`src/data/CommandSource.ts`) is one of:

| kind | meaning |
|---|---|
| `operator` | a signed-in operator through the Engine API (`operator`, `session`, `remoteAddr`) |
| `peer` | another Engine with a grant (`peerEngineId`) |
| `cli` | the local command line on this Pi |
| `engine` | the Engine's own scheduling |
| `queue` | an entry in this Engine's store command queue whose writer is unknown |

Step 1 marks every store queue entry as `queue`. The trace gets `source` and, when given,
`seq` (optional fields; older traces have neither). Refusals get an error trace with the
same source and a stable `errorCode` where there is one.

`<authFolder>/command-audit.log` gets one JSON line per command or refusal:
`{ t, engineId, seq, command, args, source, result: ok|error|refused, errorCode }`. Args are
redacted like the command log. It rotates at 10 MB and keeps 5 older files
(`command-audit.log.1` … `.5`). A write failure is logged once and never fails the command.
