# Operator sign-in and signed commands (engine#582)

**Status:** built in steps (see "Steps" below). This page describes what is on the branch
it ships with.

Design record: [engine#582](https://github.com/koenswings/agent-engine-dev/issues/582).

## Steps

| Step | What | State |
|---|---|---|
| 1 | CORS and store WebSocket Origin check for own Console origins, second confirmation gate (module), `createInstance` local-only, git account pin, command source on traces, local audit log | this page |
| 2 | Engine-local operator accounts, setup code, challenge sign-in, sessions, rate limits, `/api/auth/*`, `idea-engine-auth` CLI | this page |
| 3 | Command key, signed queue entries, `POST /api/command`, peer grants, mixed-version refusal | this page |
| 4 | `/api/engines/<id>/…` relay | this page |
| 5 | Firewall script for Ops; cleanup (`defaults.password`, Tailscale key source) | this page |

## Engine-local auth folder

`settings.authFolder` (env `IDEA_AUTH_DIR` wins). Default `~/.idea-engine/auth`, which is
`/home/pi/.idea-engine/auth` under pm2 on a Pi: outside the checkout, so a redeploy keeps
it. Created 0700 on first use; files in it are 0600. It is never synced, never part of a
disk backup or a kit image, and must never be copied between Pis. In `testMode`, without a
setting or env, it is a per-process folder under the OS temp dir.

Files: `command-audit.log` (step 1); `operators.json`, `auth-secret`, `setup-code.txt`
while setup is open (step 2).

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
    is a known client image. Summary `{ command, candidateId, sizeBytes, model, version, contents }`,
    where `contents` is what is on the card now, as in `Engine.clientCards[].contents`
    (`{ kind: 'idea-client', imageName, version }`, `raspios`, `ubuntu`, `empty`, `{ kind: 'other', summary }`, `unknown`).
    This summary is the single flash confirmation.
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

## Engine-local operator accounts (step 2)

`src/data/Operators.ts`. `<authFolder>/operators.json` (0600, atomic writes):

```json
{ "version": 1, "importedFromStore": { "at": 1795600000000, "count": 2 },
  "operators": [{ "id": "user-…", "username": "admin", "passwordHash": "$2b$10$…", "role": "operator", "created": 1795600000000 }] }
```

- **One-time import.** The Engine imports the store `userDB` entries with a well-formed
  bcrypt hash (`$2a$`/`$2b$`/`$2y$`, any cost; the cost is kept until the next password
  change) once, recorded in `importedFromStore`. Later `userDB` changes are never imported.
  The log shows the count and the usernames, never hashes. The store `userDB` itself is
  not changed.
  - **Merge rule.** When operators.json already has operators (setup or the CLI ran before
    the store synced), this Engine's accounts win: a store account with a username that
    already exists here is skipped; the others are added.
  - **Waiting for the store.** When the store maps have not arrived yet (a fresh store
    waiting for peer sync), the import waits for them; setup stays open meanwhile.
  - **No userDB.** A loaded store without `userDB` (made from `store-template.json`) has
    nothing to import: the log says so and the Engine stops waiting
    (`importedFromStore.none`). If a `userDB` arrives later by peer sync, it is imported
    once by the same rule.
- New hashes (setup, add operator, password change) must be bcrypt cost 10–12; the
  Console makes them at cost 10.
- Usernames are 1–64 characters without control characters; across Engines the Console
  matches operators by username. The last operator cannot be removed (`409 LAST_OPERATOR`).

## Setup code (step 2)

`src/data/SetupCode.ts`. With no operators, the Engine makes a code of 8 Crockford base32
characters, `XXXX-XXXX`, shown in the Engine log at start and every 10 minutes, on the Pi
console (`/dev/tty1`, best effort, not in testMode) and in `<authFolder>/setup-code.txt`.
`POST /api/auth/setup` with the code creates the first operator and signs in. Single use;
expires after 24 h of Engine uptime; a restart makes a new code; after 5 wrong codes setup
is locked for 15 minutes (`429 LOGIN_RATE_LIMITED`). Each Engine has its own code.

Ops can skip setup on the Pi with the local CLI (run as the Engine user, `pi`):

```
node dist/script/idea-engine-auth.js set-password <username>   # asks twice, no echo; or one line on stdin
node dist/script/idea-engine-auth.js list
```

It hashes with bcrypt cost 10 and writes only the hash. Run on an Engine that never ran
this build, it creates `operators.json` and so skips the one-time store import.

## Challenge sign-in (step 2)

`src/data/LoginChallenge.ts`. The password never leaves the browser.

1. `POST /api/auth/challenge { username }` → `{ challengeId, salt, nonce, expiresInMs: 60000 }`.
   `salt` is the 29-character salt prefix of the operator's hash. An unknown username gets
   a stable fake salt in the same `$2b$` format, with the cost of the newest operator hash
   (HMAC of the username with `<authFolder>/auth-secret`).
2. The Console computes `h = bcrypt(password, salt)` and
   `proof = hex(HMAC-SHA256(key = utf8(h), "idea-login-v1|" + engineId + "|" + challengeId + "|" + nonce))`.
3. `POST /api/auth/login { challengeId, username, proof }`: the Engine recomputes it with the
   stored hash and compares in constant time. A challenge is used up by the first try.

Reference vector (unit test): password `idea-test`, salt `$2b$10$abcdefghijklmnopqrstuu` →
`h = $2b$10$abcdefghijklmnopqrstuuTz0XgmRlzyslBgX7qxsZ1WQYR9WyyzG`; engineId `eng-test`,
challengeId `ch1`, nonce `n1` → proof `cd1abc0204f9362e41dfe9733db7e9206385588aece117f80ab3e6ea2e94d538`.

## Sessions and rate limits (step 2)

`src/data/Sessions.ts`: 32 random bytes as a Bearer token; the Engine keeps only its
SHA-256, in memory (a restart signs everyone out). 15 minutes idle, renewed by every
accepted call and `POST /api/auth/renew`; hard cap 8 hours; at most 32 sessions (least
recently used dropped). Monotonic clock. Removing an operator or changing a password ends
that operator's other sessions.

`src/data/LoginRateLimit.ts`, failed proofs only: per client address 5 in 5 minutes →
locked 60 s, doubling per further lock to 15 minutes, cleared by a success; per username 20
in 15 minutes from any client → that username locked 15 minutes; globally 30 per minute.
Answer `429 LOGIN_RATE_LIMITED` with `Retry-After` and `retryAfterSeconds`. The client
address is the socket address; step 4 adds the address vouched for by a relaying Engine.

## HTTP API (step 2)

`src/monitors/authApi.ts`. JSON bodies up to 16 KB; answers carry `Cache-Control: no-store`
and the CORS rule above. Errors are `{ error, message, … }`.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /api/auth/info` | none | | `200 { engineId, engineName, version, authVersion: 1, setupRequired, capabilities }` |
| `POST /api/auth/setup` | none | `{ setupCode, username, passwordHash }` | `201 { token, expiresInMs, operator: { id, username } }`; `403 SETUP_CODE_INVALID`, `409 SETUP_DONE` |
| `POST /api/auth/challenge` | none | `{ username }` | `200 { challengeId, salt, nonce, expiresInMs }`; `403 SETUP_REQUIRED` |
| `POST /api/auth/login` | none | `{ challengeId, username, proof }` | `200 { token, expiresInMs, operator }`; `401 LOGIN_FAILED`, `429` |
| `POST /api/auth/renew` | Bearer | `{}` | `200 { expiresInMs }` |
| `POST /api/auth/logout` | Bearer | `{}` | `204` |
| `POST /api/auth/password` | Bearer | `{ challengeId, proof, newPasswordHash }` | `204`; `401 LOGIN_FAILED` |
| `GET /api/auth/operators` | Bearer | | `200 { operators: [{ id, username, created }] }` |
| `POST /api/auth/operators` | Bearer | `{ username, passwordHash }` | `201 { operator: { id, username, created } }`; `409 OPERATOR_EXISTS` |
| `DELETE /api/auth/operators/<id>` | Bearer | | `204`; `404 OPERATOR_UNKNOWN`, `409 LAST_OPERATOR` |

Tokens: no `Authorization` header → `401 AUTH_REQUIRED`; a malformed or unknown token →
`401 TOKEN_INVALID`; a known session past its expiry → `401 TOKEN_EXPIRED` (once; after
that the token is unknown, `TOKEN_INVALID`). A body over 16 KB → `413 PAYLOAD_TOO_LARGE`; the
size is checked before the token, so this holds with or without a (valid) token.
An unknown `/api/*` route → `404 { error: "NOT_FOUND", message }`. An older Engine
answers `404` on `/api/auth/info`. Sign-in events go to `command-audit.log` as
`auth:<event>` lines (username, client address; never hashes, proofs or tokens).

`engineName` is the Engine's `engineDB` hostname; `version` its `engineDB` version.

**Capability `engineSignIn1`.** Step 2 advertises it so a Console can use sign-in before
commands move to `POST /api/command` (`signedCommands1`, step 3). In step 2 commands still
go through the store queue as before; nothing about them changes.

## Command key and signed queue entries (step 3)

`src/data/CommandKey.ts`, `src/data/SignedQueue.ts`. On first start the Engine creates
`<authFolder>/command-key` (32 random bytes, 0600). It is never synced, logged or copied.

The queue `engineDB[<id>].commands` keeps its shape (an array of strings). The Engine runs
only entries it signed itself:

```
@v1.<seq>.<src>.<mac> <command>
mac = base64url(HMAC-SHA256(command-key, "idea-cmd-v1\n" + engineId + "\n" + seq + "\n" + src + "\n" + command))
src = op-<session8> | peer-<engineId> | cli | engine
```

- `seq` comes from `<authFolder>/command-seq` (started at the time of the first start, +1
  per entry, under a lock file so the CLI and the Engine never issue the same number).
- A seq is recorded as run in `<authFolder>/command-done` when it **starts** (a command that
  crashes the Engine is not run again by the startup replay). Entries older than the last
  4096 seqs, or above the highest issued seq, are refused too.
- Refusals get an error trace (`seq` when the prefix parses) and an audit line; the entry
  is removed like any finished head, so it never blocks the queue:

| Code | When |
|---|---|
| `COMMAND_UNSIGNED` | No `@v1` prefix: written into the store by an older Console or tool. Message: "Refused: this Engine only runs commands from a signed-in operator. Open this Engine's own Console to sign in." |
| `COMMAND_SIGNATURE_INVALID` | Changed text, another Engine's entry, or a forged prefix. |
| `COMMAND_REPLAYED` | The seq already ran, is out of the window, or was never issued. |

The Engine log shows a queue entry as `[seq <seq>, src <src>] <command>`; the mac is never
logged.

`sendCommand` only queues on this Engine (signed, `src engine`). Commands for another
Engine go through that Engine's API (peer follow-ups below). Scripts that run on the Pi as
the Engine user sign with `script/cli-queue-entry.ts` (`src cli`).

## POST /api/command (step 3)

`src/monitors/commandApi.ts`. Order: body size → token → validation → `GRANT_REQUIRED` →
`CONFIRM_REQUIRED` → signed entry.

| Auth | Body | Answer |
|---|---|---|
| `Bearer <token>` | `{ command, confirmId?, confirmText?, grants?: { <engineId>: <grant> } }` | `202 { engineId, seq }` |
| `Grant <grant>` (another Engine) | `{ command, fromEngineId, replyGrant? }` | `202 { engineId, seq }` |
| `Grant <grant>` (another Engine) | `{ command: "grantCheck", fromEngineId }` | `200 { engineId, issuerEngineId, ok: true }`, nothing queued |
| `Grant <grant>` (another Engine) | `{ command: "grantCheck <targetDiskId> <dstId> <appId\|-> <opId\|-> <0\|1>", fromEngineId }` (engine#595) | `200 { engineId, issuerEngineId, ok: true, tickets? }`, nothing queued; B's helper lets that transfer through (see below). `409 TARGET_NOT_DOCKED`, `400 BAD_REQUEST`, `503 TRANSFER_PERMISSION_FAILED` |

Errors: `413 PAYLOAD_TOO_LARGE` (before the token), `400 BAD_REQUEST` (not one line of text),
`503 STORE_NOT_READY` (the Engine has not loaded its store yet; try again), `401` token codes, `422 COMMAND_REFUSED`
with `reason` `unknown` / `local-only` (`createInstance`) / `validation` /
`not-a-follow-up`, `409 GRANT_REQUIRED { engineIds }`, `403 GRANT_INVALID` /
`GRANT_EXPIRED`, `409 ENGINE_VERSION_MISMATCH { engineId, version }`,
`428 CONFIRM_REQUIRED { confirmId, summary, confirmField, expiresInMs }` (the flash summary
includes `contents`), `409 CONFIRM_INVALID { reason }`. Every error on a `Grant` request
carries `issuerEngineId` (this Engine).

## Peer grants (step 3)

`src/data/PeerGrants.ts`, `src/data/PeerCommands.ts`, `src/data/PeerHttp.ts`.

A copy, move or update with `--source` across Engines needs follow-ups on the other Engine
(`startInstance`, `verifyMoveTarget`, `cleanupMoveTarget`, `pushAppBundle`,
`appFetchResult`; nothing else). Engines hold no keys of each other, so the other Engine
signs its own entries:

1. The Console asks the other Engine B (`POST /api/auth/grant { toEngineId: A }`, Bearer
   token for B) → `200 { grant, expiresInMs, issuerEngineId: B }`.
   `grant = v1.<issuerEngineId>.<toEngineId>.<grantId>.<mac>`, valid 6 hours, kept in B's
   memory (a restart of B ends it: `GRANT_EXPIRED`).
2. The Console sends the command to A with `grants: { B: <grant> }`. Without it A answers
   `409 GRANT_REQUIRED { engineIds: [B] }`.
3. A sends each follow-up as `POST http://<B>/api/command`, `Authorization: Grant <grant>`,
   `{ command, fromEngineId: A, replyGrant }`. The reply grant (issued by A for B) lets B
   answer (`appFetchResult`). B checks the grant (issued by B, for A, not expired) and the
   follow-up list, then signs the entry with `src peer-A`.

A keeps one trace per follow-up it sent: `ok` with B's seq, or `error` with the code and
`issuerEngineId` in the result. Grant errors from B always name B as `issuerEngineId`;
errors from `/api/auth/grant` also carry it.

**B checks the grant before anything happens for B.** A only checks that a grant names B
as issuer and A as receiver; it cannot tell whether B still knows it, so a stale grant (6 h
passed, or B restarted) is still accepted by A: `202` means only "queued". Before a
cross-Engine copy or move stops, writes or registers anything, A asks B with
`grantCheck` (`PeerCommands.preflightPeerGrant`; read-only on both Engines):

- `copyApp`: first thing in the operation (before the resume step, the source stop, the
  directories, the in-flight marker and any rsync), and again just before the copy is
  registered for B's disk (B may have restarted during the copy).
- `moveApp`: before the move operation is created.

When B answers `403 GRANT_EXPIRED` (or `GRANT_INVALID`), A drops the grant and:

- the copy operation is `Failed` with `error: GRANT_EXPIRED: …` and `args.errorCode` /
  `args.issuerEngineId`; a move is refused with no operation;
- the command trace is `status: error`, `errorCode: GRANT_EXPIRED`, with `issuerEngineId: B`,
  `dispatchedTo: B` and `step` (`start` or `register`) in its result; a `grantCheck` trace
  records the refused check;
- nothing ran for B. After a refusal at `register`, the copied folder stays on B under its
  in-flight marker (deleting it would also need B's permission) and is never registered.

The Console asks B for a new grant and starts again. A later follow-up refused by B (for
example `cleanupMoveTarget` after B restarted mid-move) is traced the same way; a refused
cleanup is reported at once (`targetCleanup: failed`) instead of after the cleanup timeout.

### Transfer tickets: the ssh data path follows the grant (engine#595, helper v26)

The ssh data path (B's `idea-peer-gate`) is opened by the Engine keys (`PeerAccess.ts`). Since
helper v26 a WRITE through it also needs a live transfer ticket on B, and only B's Engine
registers tickets, when it accepts a grant:

- `copyApp` / `moveApp`: A's first `grantCheck` names the transfer (target disk, new instance
  id, app, op, whether service images follow). B checks that the disk is docked to B, takes
  the root token from its own store (never from A), and registers tickets for
  `instances/<dstId>`, `apps/<appId>` and `services/` for as long as the grant still has
  (`grantRemainingMs`, at most 6 h). A resumed copy registers them again under the same op.
- updateApp Fetch: B (the Engine that fetches) registers a ticket for `apps/<newAppId>` with
  the request id as op before it sends `pushAppBundle`, and drops it when the answer is in.

Tickets live in a root-only tmpfs list (`/run/idea-app-data/peer-tickets`), expire on the
helper's monotonic clock (`/proc/uptime` plus the boot id) and are dropped when B's Engine
starts (`peer-tickets-reset`, with `peerAccess` on). So when B restarts, A loses both the grant
check and the data path: a write after that is refused by B's helper with exit 2 and
`refused: GRANT_EXPIRED: …` before it creates a folder, marker or ledger line. Deleting a copy
B's ledger says A made, and clearing A's own in-flight marker, need no ticket.

On A, that refusal is the same as a refused grant check: `PeerCommands.ticketRefusal` turns it
into `GRANT_EXPIRED` (`step: transfer`), never a link interruption (`InFlight.isPeerLinkFailure`
is false for it), so the op never parks `RESUME_WAITING`:

- a copy is `Failed` `GRANT_EXPIRED: Engine B refused the transfer: …` (`args.errorCode`);
- a move whose target was marked ends `Failed` `GRANT_EXPIRED: …` (move code `RESUME_GAVE_UP`)
  and its source starts again if it ran; the partial copy stays on B under its marker;
- at Engine start, an op an earlier run parked with such a refusal is ended the same way
  (`recoverInterruptedOperations`), and never resumed.

A B on an earlier engine#582 build (no `grantCheck`) answers `422 COMMAND_REFUSED`
`not-a-follow-up` after a good grant check; A counts that as accepted. An Engine without
`signedCommands1` is never asked (`ENGINE_VERSION_MISMATCH`, no request).

Peer addresses come from B's `engineDB` row (`lanAddress`, `lanAddresses`, then
`<hostname>.local`; private ranges only) on `httpPort`. Before the first request A checks
B's `GET /api/auth/info` reports B's engine id. Connect timeout 3 s → `ENGINE_UNREACHABLE`.

## Mixed versions (step 3)

**Capability `signedCommands1`** (stamped as in idea#128). A Console uses
`POST /api/command` only on an Engine that advertises it.

| Situation | Result |
|---|---|
| Older Console writes a command into the store queue of a new Engine | Refused `COMMAND_UNSIGNED` (trace + audit), never run |
| New Engine needs a follow-up on an Engine without `signedCommands1` | Refused before anything starts: `409 ENGINE_VERSION_MISMATCH { engineId, version }` |
| Peer answers `404` on `/api/auth/info` | `ENGINE_VERSION_MISMATCH` |
| Copy or move after B restarted | Refused by B at the `grantCheck`, before anything runs: `GRANT_EXPIRED` with `issuerEngineId: B`; start the operation again |
| Follow-up after B restarted mid-operation | `GRANT_EXPIRED` with `issuerEngineId: B` on the follow-up trace |
| Transfer after B restarted mid-copy (helper v26 on B) | B's helper refuses the write (`refused: GRANT_EXPIRED`); A ends the op `GRANT_EXPIRED` (not parked); the partial stays on B under its marker |
| A before engine#582 (no `grantCheck`, e.g. adfd9d3) → B with helper v26 | B's helper refuses A's first remote step (`ensure-dirs`) with exit 2 and one line `refused: GRANT_EXPIRED: … too old to ask for one and must be updated first`; A's copy ends `Failed` with that text, nothing written on either Engine. Update A |
| A with engine#595 → B with helper below v26 | B registers no tickets (`HELPER_OUTDATED` skipped) and its gate needs none: works as before |
| A with engine#582 but not engine#595 → B with helper v26 | A's `grantCheck` names no transfer, so B registers no ticket and its helper refuses the transfer (`GRANT_EXPIRED`). Update A |

## Relay: /api/engines/<id>/… (step 4)

`src/monitors/relayApi.ts`, `src/data/RelayKey.ts`. A Console page talks only to its own
origin. For another Engine B of the store it calls its own Engine A at
`/api/engines/<B>/<path>`; A forwards server-to-server to B's `/api/<path>` and returns
B's answer unchanged (status, body, `Retry-After`).

- **Paths:** `auth/info`, `auth/setup`, `auth/challenge`, `auth/login`, `auth/renew`,
  `auth/logout`, `auth/password`, `auth/operators`, `auth/operators/<id>`, `auth/grant`,
  `command`, `store-url`, `command-log-url`. Anything else: `404 NOT_FOUND`.
- **Own id:** `/api/engines/<A>/<path>` on A is answered by A itself.
- **Address:** as for peer follow-ups (step 3): `lanAddress`, `lanAddresses`,
  `<hostname>.local`, private ranges only, on `httpPort`, after B's `/api/auth/info`
  reported engine id B.

| Situation | Answer |
|---|---|
| `<id>` not in the store | `404 ENGINE_UNKNOWN { engineId }` |
| Connect timeout 3 s, or no answer in 10 s (`auth/*`, info) / 15 s (`command`) | `502 ENGINE_UNREACHABLE { engineId }`, message "<Engine name> cannot be reached right now." |
| B answers `404` on `/api/auth/info` (older Engine) | `409 ENGINE_VERSION_MISMATCH { engineId, version }`; `store-url` and `command-log-url` are still forwarded |
| Body over 16 KB | `413 PAYLOAD_TOO_LARGE` (nothing forwarded) |
| A request to `auth/grant` | every error the relay itself makes also carries `issuerEngineId` (= B) |

**Original client (rate limit per client).** A adds

```
X-Idea-Relay: v1.<fromEngineId>.<clientAddr base64url>.<t>.<sig>
sig = base64url(Ed25519(relay key, "idea-relay-v1\n" + fromEngineId + "\n" + clientAddr + "\n" + t))
```

The relay key is `<authFolder>/relay-key.pem` (created on first start, 0600, never
synced); its public half is in A's `engineDB` entry as `relayPublicKey`. B uses
`clientAddr` for the sign-in rate limit and the audit `remoteAddr` (and `viaEngineId` on
command traces) when the signature verifies against the sender's published key and `t`
is within 60 s of B's clock; otherwise the socket address. The header never authorises
anything. A client's own `X-Idea-Relay` header is never passed on.

**Capability `engineRelay1`.** The page's Engine advertises it in `/api/auth/info` (and its
`engineDB` capabilities) when it relays `/api/engines/<id>/…` for the Engines it knows from
the store. A Console uses the relay only when the page's Engine advertises `engineRelay1`;
the target Engine itself does not need it (it only needs `engineSignIn1` /
`signedCommands1` for the request being relayed). A page Engine without `engineRelay1`
(older Engine) answers `404` on these paths; the Console then talks to other Engines as it
did before the relay. Relaying adds no rights: B checks the token, grant and confirmation
of every relayed request exactly as for a direct one, and the relay only answers with its
own errors (table above) when it could not get an answer from B.

## Firewall for the Engine ports (step 5, Ops)

`script/ops/idea-engine-firewall.sh`, run by Ops as root on an Engine Pi. Defence in depth:
sign-in and signed commands do not depend on it.

```
sudo script/ops/idea-engine-firewall.sh --dry-run [--allow <cidr>]... [--ports 80,8080,4321]
sudo script/ops/idea-engine-firewall.sh apply  [--allow <cidr>]... [--rollback-seconds 120]
sudo script/ops/idea-engine-firewall.sh confirm | status | remove
```

- Its own nftables table `inet idea_engine_fw`; other rules are never touched. Only TCP to
  the Engine ports (default 80, 8080, 4321) is filtered; ssh, mDNS and apps are not.
- Accepted on those ports: loopback; established/related; `10.42.0.0/16` (the Engine
  hotspot) plus `/etc/idea/firewall-allow` and `--allow` (one CIDR per line, `#`
  comments; `--allow` on `apply` is added to the file); IPv6 link-local `fe80::/10`;
  Docker bridges (`docker0`, `br-*`); Tailscale (`tailscale0`), only from the ranges in
  `/etc/idea/firewall-admins` when that file exists. Everything else is dropped.
- `--dry-run` prints the ruleset and changes nothing (no root needed).
- `apply` checks the ruleset with `nft -c`, loads it and rolls back after 120 s unless
  `confirm` runs in time (the previous table, if any, is restored).
- `confirm` writes `/etc/nftables.d/idea-engine-fw.nft` and enables
  `idea-engine-fw.service`, which loads it at boot.
- `remove` unloads the table, disables the unit and moves the boot file and unit aside.
- Exit codes: 0 ok, 1 failed, 2 usage or bad input.

Pool and kit Engines must allow each other on `httpPort` (relay and peer follow-ups):
add the pool LAN or Tailscale ranges with `--allow` or the allow file. The script
detects eth0's IPv4 subnet: `--dry-run` warns, and `apply` refuses, when that subnet
is not already allowed, and tells you to pass `--allow <cidr>` (for example a pool
LAN of `192.168.0.0/24`, which the default `10.42.0.0/16` list does not cover).

## Cleanup (step 5)

- `config.yaml` no longer has `defaults.password` (it was unused).
- `installTailscale()` reads the Tailscale key only from `TAILSCALE_AUTHKEY`
  (`provision-fleet.sh` sets it from `--authkey-file`); see docs/PI_FLEET.md.
