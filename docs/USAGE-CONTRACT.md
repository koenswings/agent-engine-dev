# idea#411: idea-usage contract (hook runner, store, export)

**Status:** Contract for implementation (WIP)  ·  **Maintained by:** Axle
**Audience:** Kid (hooks, #413; dashboard collector, #414), Atlas (helper v7 / keys, #412), Pixel (D2 later, #417)
**Sources:** [idea PR #410](https://github.com/koenswings/idea/pull/410) (`proposals/2026-11-09-field-usage-monitoring.md`, especially §7.2–§7.6 and §10), [idea#411](https://github.com/koenswings/idea/issues/411), [idea#412](https://github.com/koenswings/idea/issues/412), [idea#413](https://github.com/koenswings/idea/issues/413), Design Review 2026-11-10.

This document is the Engine ⇄ App ⇄ collector contract. Implementation of `idea-usage` is on this branch; helper v7 (idea#412) follows separately. Nothing here is a secret, a key, or a token.

Field kits stay pinned at Engine `adfd9d3` until Koen approves idea#374. Proof work is on idea03 or idea04 only — never golden idea01, never idea, never the kits.

---

## 1. Scope and non-goals

**In scope**

- The `x-app.usage` declaration and how the Engine invokes it.
- The JSON schemas the hook prints (`idea-usage-day/1`, `idea-usage-sample/1`) and the fields the Engine adds when it stores a file.
- On-disk layout under `/var/lib/idea/usage/`, retention, and the export wire format (`since`, `archive-and-clear`).
- The persistent off switch, the `usageSummaries` capability, and the “never open Automerge” rule.

**Out of scope (settled elsewhere)**

- App-internal SQL and log parsing (Kid, #413).
- The idea-hosted collector, SQLite schema and dashboard UI (Kid #414, Pixel #415).
- The Tailscale ACL and sidecar auth key (Koen, idea#375).
- The school-local Console Usage panel and its read-only HTTP endpoint (D2, #417). That endpoint will serve this folder; it is not part of v1.
- A deployment id on the kit. idea maps `(engine hostname, day)` to a deployment when it stores a pulled file ([idea#411](https://github.com/koenswings/idea/issues/411), proposal §13 Q7).

**Hard rules**

1. `idea-usage` never opens the Automerge Repo. A unit test fails if anything under `src/usage/` imports Automerge or store modules. Nothing usage-related is added to heartbeat or metrics messages. **No store schema change.**
2. Usernames, email addresses, client addresses and document contents never leave the kit and never appear in hook stdout.
3. Fail open: a hung, slow, invalid or missing hook must not stall the Engine or the Apps, and must not overwrite a good day file.

---

## 2. Process, capability and off switch

### 2.1 `idea-usage` process

A separate pm2 process named `idea-usage`, running as `pi`, from the same repo and build as the Engine. A hung hook cannot stall the Engine. Killing `idea-usage` by hand does not affect the Engine or any App.

The process does two jobs when the switch is on:

- **Presence sampler** every 5 minutes (see §5.6).
- **Hook runner** that calls each target once at a time (see §4).

### 2.2 Capability `usageSummaries`

Add the string `usageSummaries` to `ENGINE_CAPABILITIES` in `src/data/Engine.ts` (currently the list at line 160 on `main`). It is boolean only: the string is on the list or it is not. No version and no extra fields.

The flag means “this Engine build can export usage”. It is advertised even when the switch is off. Nothing in the Engine, Console or sync requires the flag to be present. D2 (#417) will use it later to decide whether to show the school-local panel.

### 2.3 Persistent off switch `usageMonitoring`

`usageMonitoring` is `off` or `on`, default **off**. It survives a reboot and an Engine update. Toggling it never restarts the Engine or any App. Stopping the pm2 process by hand is not enough on its own: without the persistent switch, a reboot or an Engine update would start sampling again.

**Where it lives.** [idea#411](https://github.com/koenswings/idea/issues/411) says “Engine settings”, and also “no store schema change”. The switch therefore must **not** go in the shared Automerge store (that document reaches every Engine, at every school). It is a local file, owned by `pi`:

```
/var/lib/idea/usage/settings.json
{ "usageMonitoring": "off" }
```

The directory `/var/lib/idea/usage/` is created at install, owned by `pi` (0750). Creating the empty directory at install is allowed even when the switch is off. When the switch is off, `idea-usage` checks the file at start and then idles: no sampler, no hooks, no day / sample / presence files written. Existing files are left untouched. The export command returns `disabled` (see §7.4).

`idea-usage` re-reads the file at start, on SIGHUP, and at least once a minute, so a toggle takes effect without restarting pm2. An operator command over SSH (a `tools/fleet` script writing this file, and/or a helper verb that is **not** the forced-command binary) flips the value.

---

## 3. Hook declaration

Apps declare the hook on the App Disk, same shape as the agreed `x-app.backup` hook:

```yaml
x-app:
  usage:
    service: kolibri          # compose service name inside this instance
    command: /hooks/usage.sh  # argv prefix run inside that service (string or list)
    timeoutS: 30              # positive integer, seconds
```

| Field | Required | Meaning |
|---|---|---|
| `service` | yes | Compose service name. The Engine runs `docker compose exec -T <service> …` in the instance’s compose project. |
| `command` | yes | Executable inside the container. A YAML string is one token; a YAML list is an argv prefix. Mode arguments are appended (see §4). No shell is used. |
| `timeoutS` | yes | Per-invocation limit. The Engine also clamps to a hard maximum of 120 seconds. |

Engines without monitoring, or with `usageMonitoring` off, ignore `x-app.usage`. A missing or invalid block is treated as “no hook” for that App (`hookStatus: no-hook`); it is not an Engine error.

The hook must be short and read-only (review requirement, proposal §10): no writes to App databases, no disruptive locks. Kid proves that on a pool Pi before any kit sees the hooks.

The same script must also be invokable by piping it over stdin (`docker exec -i … sh -s -- …`), so the Engine can borrow it for an unlisted container of the same App and version (#413 acceptance). Put a copy of the script in the App bundle (typically `hooks/usage.sh`). If `command` is a path, the basename should match that file (`/hooks/usage.sh` → bundle file `hooks/usage.sh`).

---

## 4. Invocation

### 4.1 Listed instances

For every running instance the Engine lists that declares `x-app.usage`:

```
# user:    pi
# cwd:     <diskMount>/instances/<instanceId>
#          system disk: /instances/<instanceId>
# compose project name = instanceId
# no shell around the hook argv

timeout --signal=TERM --kill-after=10s <timeoutS clamped to 120> \
  nice -n 15 \
  ionice -c3 \
  docker compose exec -T \
    -e IDEA_USAGE_MODE=<mode> \
    -e IDEA_USAGE_DAY=<YYYY-MM-DD> \
    <service> \
    <command...> <mode-args>
```

`<mode-args>`:

- day mode: `day YYYY-MM-DD`
- sample mode: `sample`

`IDEA_USAGE_DAY` is set only in day mode (the date being requested). The Engine does not pass credentials, store paths, deployment ids, usernames or other secrets.

`docker compose exec` uses the instance’s compose file in `cwd`. The project name is the instance id (proposal §7.3).

### 4.2 Unlisted containers

happy-zebra already has a Kolibri on port 62561 that the Engine does not list. The runner also discovers containers by Docker image, `com.docker.compose.project`, `com.docker.compose.service` and `com.docker.compose.project.working_dir` labels, as well as by the Engine instance list.

A container is **unlisted** when its compose project is not a known instance id (or it has no Engine instance record). Unlisted containers are never dropped and never merged into another instance.

For an unlisted container the Engine picks the hook of a matching App **name + version** (Kolibri 0.15.5 vs 0.19.5 are different hooks) from a docked App bundle, including `/apps/<appId>` on the system disk:

1. Locate `apps/<appId>/` whose `x-app` name and version match the image / labels.
2. Read that bundle’s `x-app.usage` and the hook file from the bundle (`hooks/<basename of command>` or `hooks/usage.sh`).
3. Run:

```
timeout --signal=TERM --kill-after=10s <timeoutS clamped to 120> \
  nice -n 15 \
  ionice -c3 \
  docker exec -i \
    -e IDEA_USAGE_MODE=<mode> \
    -e IDEA_USAGE_DAY=<YYYY-MM-DD> \
    <container> \
    sh -s -- <mode-args>  <  hooks/usage.sh
```

If no matching bundle or hook file exists, the Engine writes an `unlisted-no-hook` day row for that identity (see §5.7) and does not invent metrics.

Synthetic `instance` id for an unlisted container, in order:

1. The compose project name, if it matches `^[a-z0-9][a-z0-9-]{0,63}$`.
2. Otherwise `unlisted-<sanitized container name>` (lowercase, non `[a-z0-9-]` → `-`, trimmed to 64 characters).

`listed` is always `false` on these rows. `name` is the compose project or container name (the Engine has no display name). `demo` follows §5.1 (name heuristic and any `demo` the borrowed hook reports).

### 4.3 Stdout, stderr, caps, exit codes

| Stream | Limit | Handling |
|---|---|---|
| stdout | day: 256 KiB; sample: 64 KiB | Must be UTF-8, no BOM, **one** JSON object (leading/trailing whitespace allowed). Oversize, non-JSON, or more than one value → `invalid`. |
| stderr | 16 KiB captured | Written only to the `idea-usage` log. Never stored under `/var/lib/idea/usage/`, never exported. JSON must not go to stderr. |

Hook exit codes (listed and borrowed):

| Hook exit | Meaning | Engine action |
|---|---|---|
| 0 | Success | Parse and schema-check stdout. |
| non-zero | Failed | `hookStatus: failed`; fail open. |
| killed by timeout | Timed out | `hookStatus: timeout`; fail open. |

`sample` on an App that has nothing to snapshot (Kolibri, Kiwix) is valid: print `{"schema":"idea-usage-sample/1","app":"<app>","supported":false}` and exit 0. The Engine does not store a sample record for `supported: false`.

The runner is global one-at-a-time (one hook in flight on the Pi). Fail open: the Engine and the Apps keep running; a bad result never overwrites a good day file for that `instance` and `day`.

### 4.4 Scheduling

- **`sample`:** every 15 minutes, for every listed or unlisted target whose hook does not report `supported: false`. This is the Nextcloud Office token snapshot.
- **`day`:** once per night by default, in the window 02:00–03:30 in the **kit’s local timezone**, and not within 30 minutes of the 05:00 reboot. The date argument is the calendar day just finished (so at 02:10 on 2026-11-13 the runner asks for `day 2026-11-12`) plus any catch-up dates.
- **Catch-up:** a past `YYYY-MM-DD` is allowed and required. After a power-off, on process start and each night, the runner requests any missing day in the last 14 days (oldest first) that has no good stored file *for that instance*. The window is `today-14` through yesterday inclusive (on 2026-11-11 the oldest catch-up day is 2026-10-28; 2026-10-26 and 2026-10-27 are outside the window). Kolibri and Nextcloud keep durable logs; Kiwix only has the rolled access log (14 days).
- **Catch-up existence:** a past day is written for an instance only when that instance provably existed on that day: its creation time is on or before the end of that kit-local day (the kit-local calendar date of `createdAt` is `<=` the requested day). Creation time is the instance directory’s birth time for a listed instance (the directory created by `installApp` or restore), or the container’s Docker `Created` timestamp for an unlisted container. If creation time cannot be determined, the instance is not written onto a past day. Catch-up must not copy the current instance inventory onto dates before those instances existed; it writes nothing for that instance and day rather than a stub.
- **Catch-up overwrite:** catch-up never overwrites an existing file whose `hookStatus` is `ok`, not even with another `ok` result. A stub may still be replaced by a later `ok` or by another stub (§5.5 / §5.7).
- Dates are kit-local calendar dates (`YYYY-MM-DD`). The Engine does not rewrite hook timestamps. Kolibri timestamps from before NTP sync cannot be corrected inside the hook.

### 4.5 Skip conditions

The runner does not invoke any hook when:

- `/run/idea/backup-running` exists;
- `/run/idea/update-running` or `/run/idea/move-running` exists (the Engine process writes these for the duration of an update or copy/move; `idea-usage` must not read `operationDB`, because that is the Automerge store);
- the Pi temperature is above 75 °C (`vcgencmd measure_temp`, falling back to `/sys/class/thermal/thermal_zone0/temp`).

A skipped run sets `hookStatus: skipped` with `skipReason` of `backup`, `update`, `move` or `temperature`, and does not overwrite a good day file. The night catch-up retries later.

---

## 5. JSON schemas

Schema ids are strings of the form `idea-usage-<kind>/<version>`. v1 is this contract. A later incompatible change bumps the number (`idea-usage-day/2`). Unknown schema ids are `invalid`.

### 5.1 Who emits which fields

The hook does **not** know the Engine instance id, the display name, or whether the container is listed. The Engine overwrites any of the following if a hook prints them:

| Field | Emitter | Rule |
|---|---|---|
| `schema` | hook (required) | `idea-usage-day/1` or `idea-usage-sample/1`. |
| `day` | hook (required in day mode) | Must equal the requested `YYYY-MM-DD`. |
| `app` | hook (required) | Lowercase app name: `kolibri`, `nextcloud`, `kiwix`, or another app. Not a closed enum. |
| `demo` | hook optional + Engine | Hook may set `true` when the Kolibri facility is the seed “IDEA Demo School”, or when a Kiwix ZIM is the simple-English demo set. Engine ORs that with a display-name heuristic: after splitting the instance name on spaces, `_` or `-`, any token equals `demo` (case-insensitive), so `Kolibri_Demo` and `Wikipedia (Demo)` both match. |
| app payload | hook | `setup`, `signins`, `content`, `teaching`, `guest`, `flags`, `logins`, `office`, `appsOpened`, `workflows`, `pageViews`, `distinctArticles`, `sessions`, `topArticles`, `byHour`, … See §5.3. |
| `engine` | Engine | Kernel / Pi hostname (`happy-zebra`), not the Automerge engine UUID and not a deployment id. |
| `instance` | Engine | Listed: store instance id (`kolibri-3f2a…`). Unlisted: synthetic id (§4.2). |
| `name` | Engine | Listed: display name (`x-app.instanceName` / store `instance.name`). Unlisted: compose project or container name. |
| `listed` | Engine | `true` or `false`. |
| `clock` | Engine | `{ "synced": <timedatectl NTPSynchronized>, "correctedBoots": <n> }` at collection time. The Engine does not rewrite hook timestamps. `correctedBoots` counts boots since the last NTP-synced sample during which the clock was unsynced (0 if none). |
| `collectedAt` | Engine | RFC 3339 timestamp with numeric offset. |
| `hookStatus` | Engine | `ok` \| `timeout` \| `failed` \| `invalid` \| `skipped` \| `unlisted-no-hook` \| `no-hook`. |
| `skipReason` | Engine | `backup` \| `update` \| `move` \| `temperature`, only when `hookStatus` is `skipped`. |

The hook emits each role count as `{total, beyondSeed}` so idea can see both the raw figure and the count after excluding demo-seed classwork. Seed exclusion uses the seed’s IDs, not usernames (#413). That is hook logic, not an Engine field.

### 5.2 Hook stdout: `idea-usage-day/1`

The hook prints one JSON object, no usernames. Minimum envelope:

```json
{
  "schema": "idea-usage-day/1",
  "day": "2026-11-12",
  "app": "kolibri"
}
```

Optional hook-owned identity hint:

```json
{ "demo": false }
```

App-specific payload fields sit alongside those three (plus optional `demo`). Numbers are non-negative integers unless noted. Counts only: no usernames, no client addresses, no file contents.

### 5.3 App payloads (day mode)

These names refine proposal §7.6. Unknown extra keys are ignored (forward compatible); required keys missing from an app that should have them fail the schema.

Role keys are singular everywhere — `admin`, `teacher`, `learner` — in `setup`, `logins` and `office.byGroup`, for every App (never `admins`, `teachers` or `learners`). `setup` and `logins` (and Kolibri `signins`) use `{total, beyondSeed}`: `total` includes demo-seed accounts, `beyondSeed` excludes them. `office.byGroup` holds open counts as plain numbers (`{admin: n, teacher: n, learner: n}`), not `{total, beyondSeed}`. Nextcloud `setup` also keeps `otherGroups`, a map of extra group names to `{total, beyondSeed}`. Kolibri `signins` also carry `sessions` and `minutes` on the same object (`coach` is an extra Kolibri role and uses the same shape).

**Kolibri** (`app: "kolibri"`) — Q3, Q4, Q6:

```json
{
  "schema": "idea-usage-day/1",
  "day": "2026-11-12",
  "app": "kolibri",
  "demo": false,
  "setup": {
    "classes": 0, "classesDelta": 0,
    "learner": { "total": 0, "beyondSeed": 0 },
    "learnerDelta": 0, "learnerEnrolled": 0,
    "teacher": { "total": 0, "beyondSeed": 0 },
    "teachersDelta": 0,
    "admin": { "total": 0, "beyondSeed": 0 }
  },
  "signins": {
    "learner": { "total": 0, "beyondSeed": 0, "sessions": 0, "minutes": 0 },
    "coach":   { "total": 0, "beyondSeed": 0, "sessions": 0, "minutes": 0 },
    "admin":   { "total": 0, "beyondSeed": 0, "sessions": 0, "minutes": 0 }
  },
  "content": [
    {
      "channel": "Maths", "title": "...", "kind": "video", "role": "learner",
      "visits": 0, "seconds": 0, "completions": 0, "assigned": true
    }
  ],
  "teaching": {
    "lessonsCreated": 0, "lessonsVisible": 0,
    "quizzesCreated": 0, "quizzesStarted": 0, "quizzesEnded": 0
  },
  "guest": { "visits": 0, "seconds": 0 },
  "flags": ["sharedLearnerAccount"]
}
```

`flags` is an array of short tokens. The shared-account flag is `sharedLearnerAccount` (the `?` in the §7.6 sketch was a placeholder). Deltas are day-over-day net change; a deletion is negative. Kolibri `classesDelta` and `teachersDelta` are always `0` (Kolibri has no timestamps for class or teacher-role changes).

**Nextcloud** (`app: "nextcloud"`) — Q3, Q5:

```json
{
  "schema": "idea-usage-day/1",
  "day": "2026-11-12",
  "app": "nextcloud",
  "demo": false,
  "setup": {
    "admin": { "total": 0, "beyondSeed": 0 },
    "teacher": { "total": 0, "beyondSeed": 0 },
    "learner": { "total": 0, "beyondSeed": 0 },
    "otherGroups": { "Grade 5": { "total": 0, "beyondSeed": 0 } }
  },
  "logins": {
    "admin": { "total": 0, "beyondSeed": 0 },
    "teacher": { "total": 0, "beyondSeed": 0 },
    "learner": { "total": 0, "beyondSeed": 0 }
  },
  "office": {
    "opens": 0, "distinctDocuments": 0, "read": 0, "edit": 0,
    "estimatedMinutes": 0,
    "byGroup": { "admin": 0, "teacher": 0, "learner": 0 },
    "mime": { "text": 0, "sheet": 0, "slides": 0 }
  },
  "workflows": {
    "worksheetShares": 0, "editShares": 0,
    "fileDropLinks": 0, "fileDropUploads": 0, "schoolFilesShares": 0
  }
}
```

`office` from the day hook may be incomplete (WOPI rows expire). The Engine prefers its own reduction of that day’s samples when any samples exist (see §5.5). Nextcloud `appsOpened` is omitted for now.

**Kiwix** (`app: "kiwix"`) — Q8:

```json
{
  "schema": "idea-usage-day/1",
  "day": "2026-11-12",
  "app": "kiwix",
  "demo": false,
  "pageViews": 0,
  "distinctArticles": 0,
  "sessions": 0,
  "topArticles": [ { "title": "...", "views": 0 } ],
  "byHour": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
}
```

`sessions` is the count only; sessionisation (client address, 30-minute idle gap) stays on the kit. `byHour` has exactly 24 integers for hours 0–23 in kit local time. `topArticles` is title + view count, no identity; the hook should cap the list (Engine accepts at most 50). Article views are content / raw-content / legacy article paths; skin, catalog, suggest and media are excluded.

### 5.4 Hook stdout: `idea-usage-sample/1`

Printed every 15 minutes. Nextcloud reads current WOPI token rows (no usernames: count by group, mime and read/edit only):

```json
{
  "schema": "idea-usage-sample/1",
  "app": "nextcloud",
  "sampledAt": "2026-11-12T10:15:00+02:00",
  "office": {
    "tokens": 0,
    "documentIds": ["aaaaaaaaaaaaaaaa"],
    "read": 0,
    "edit": 0,
    "byGroup": { "admin": 0, "teacher": 0, "learner": 0 },
    "mime": { "text": 0, "sheet": 0, "slides": 0 }
  }
}
```

`office.documentIds` is an array of 16-character lowercase hex strings: a truncated HMAC-SHA256 of the WOPI `fileId`, salted per instance. It is a field of `office`, not a top-level sample key, and it must not contain file names, raw file ids, or other content. The Engine uses the union of these ids across the day’s samples to compute stored `distinctDocuments`. `sampledAt` is optional (the Engine also records its own collection time). `supported: false` is the only required extra key when the App has no sample.

### 5.5 Stored day file (what lands on disk and is exported as `type: day`)

Path: `/var/lib/idea/usage/<day>/<instanceId>.json`.

The Engine writes this file after a successful schema check (`hookStatus: ok`), or as a no-payload stub (§5.7). A non-`ok` result never overwrites a file whose `hookStatus` is `ok`; a later `ok` result replaces a stub. During catch-up, an existing `ok` file is left untouched (not rewritten by another `ok` result either).

The stored object is the hook body plus the Engine envelope:

```json
{
  "schema": "idea-usage-day/1",
  "engine": "happy-zebra",
  "day": "2026-11-12",
  "app": "kolibri",
  "instance": "kolibri-3f2a…",
  "name": "Kolibri",
  "demo": false,
  "listed": true,
  "clock": { "synced": true, "correctedBoots": 0 },
  "collectedAt": "2026-11-13T02:12:04+02:00",
  "hookStatus": "ok",
  "setup": { },
  "signins": { },
  "content": [ ],
  "teaching": { },
  "guest": { },
  "flags": [ ]
}
```

**Merge rules**

1. **Presence is not merged into the instance file.** Kit-level presence samples stay in a sibling file (proposal §7.6: “not inside an instance file”). idea intersects presence windows with instance summaries after the pull.
2. **Identity and honesty** (`engine`, `instance`, `name`, `listed`, `clock`, `collectedAt`, `hookStatus`) always come from the Engine.
3. **`demo`** is the OR described in §5.1.
4. **`office` (Nextcloud):** if the Engine stored any `idea-usage-sample/1` records for that instance and day, it reduces them into a stored `office` object with exactly these keys: `{opens, distinctDocuments, read, edit, estimatedMinutes, byGroup:{admin,teacher,learner}, mime:{text,sheet,slides}}`. `opens` is the max of the sample `tokens` values. `distinctDocuments` is the size of the union of every sample’s `office.documentIds` (not a max of counts). `read` and `edit` are the max across samples (they are snapshot counts, not additive events). `estimatedMinutes` is the number of consecutive `tokens > 0` samples × 15 (each contiguous run of active samples counts every sample in the run). `byGroup` and `mime` take the max per key and always emit the keys above (0 if never seen). `byGroup` values are plain open counts (`admin`, `teacher`, `learner`), not `{total, beyondSeed}`. If no samples exist, the hook’s `office` is kept when present; otherwise `office` is omitted.
5. Other app payload fields are copied from the hook as validated.

### 5.6 Presence samples: `idea-usage-presence/1`

One append every 5 minutes to `/var/lib/idea/usage/<day>/presence.ndjson` (the `<day>` is the kit-local calendar date of the sample’s wall time). The sampler does not open Automerge. “Engine up” means localhost TCP port 80 accepts a connection. “Instances up” is the list of running Docker compose projects that look like instance ids, from Docker, not from the store.

```json
{
  "schema": "idea-usage-presence/1",
  "engine": "happy-zebra",
  "ts": "2026-11-12T10:05:00+02:00",
  "bootId": "........",
  "uptimeS": 12345,
  "ntpSynced": true,
  "engineUp": true,
  "instancesUp": ["kolibri-3f2a…", "nextcloud-…"],
  "tempC": 52.1,
  "throttled": "0x0"
}
```

Sources: `/proc/sys/kernel/random/boot_id`, `/proc/uptime`, `timedatectl show --property=NTPSynchronized`, `vcgencmd get_throttled` and `vcgencmd measure_temp`. Clock honesty: `bootId` plus `uptimeS` gives reliable on-durations; an off-duration is only known once a later NTP-synced sample arrives. The dashboard uses `gapUnknown` rather than guessing (that derivation happens on idea, not on the kit).

### 5.7 Stub rows (`timeout`, `failed`, `invalid`, `skipped`, `unlisted-no-hook`, `no-hook`)

A hook run whose status is not `ok` writes a **no-payload** stub day file (identity and honesty fields only: `schema`, `engine`, `day`, `app`, `instance`, `name`, `demo`, `listed`, `clock`, `collectedAt`, `hookStatus`, and `skipReason` when `hookStatus` is `skipped`). This happens only when no `ok` file already exists for that `instance` and `day`, and (during catch-up) only when the instance existed on that day (§4.4). A stub never overwrites an `ok` file; a later `ok` result replaces the stub. One stub may replace another (for example `failed` then `skipped`). Catch-up does not invent a stub for an instance on a date before that instance existed.

When `hookStatus` is `skipped`, `skipReason` is one of `backup`, `update`, `move` or `temperature`.

Unlisted container with no borrowed hook:

```json
{
  "schema": "idea-usage-day/1",
  "engine": "happy-zebra",
  "day": "2026-11-12",
  "app": "kolibri",
  "instance": "unlisted-kolibri-old",
  "name": "…",
  "demo": false,
  "listed": false,
  "clock": { "synced": true, "correctedBoots": 0 },
  "collectedAt": "2026-11-13T02:12:04+02:00",
  "hookStatus": "unlisted-no-hook"
}
```

Listed instance whose App has no usable `x-app.usage`:

```json
{
  "schema": "idea-usage-day/1",
  "engine": "happy-zebra",
  "day": "2026-11-12",
  "app": "kolibri",
  "instance": "kolibri-3f2a…",
  "name": "Kolibri",
  "demo": false,
  "listed": true,
  "clock": { "synced": true, "correctedBoots": 0 },
  "collectedAt": "2026-11-13T02:12:04+02:00",
  "hookStatus": "no-hook"
}
```

`app` is best-effort from the image name when the instance is unlisted.

---

## 6. On-disk layout and retention

Created at install, owned by `pi`, mode 0750 on directories and 0640 on files. Outside the Automerge store and outside App data.

```
/var/lib/idea/usage/
  settings.json                         # { "usageMonitoring": "off"|"on" }
  <YYYY-MM-DD>/
    <instanceId>.json                   # stored day file (§5.5 / §5.7)
    <instanceId>.samples.ndjson         # one idea-usage-sample/1 object per line
    presence.ndjson                     # one idea-usage-presence/1 object per line
  .archive/                             # not exported; see §7.3
    <before>-<utc>/
      …
```

This matches [idea#411](https://github.com/koenswings/idea/issues/411): `/var/lib/idea/usage/<day>/<instanceId>.json`. The kit does not store a deployment id. Presence samples sit beside the instance files, not inside them.

**Caps and retention**

- Each day file is capped at 256 KiB. Each samples file is capped at 1 MiB (oldest lines dropped if the cap would be exceeded). Each presence line is small; the presence history is a **90-day ring**: `presence.ndjson` files whose day is older than 90 days are deleted, even if that day’s instance files remain.
- Day summaries stay until idea sends `archive-and-clear --before <day>` after it has confirmed its copy (so they do not travel to the next school). They are not deleted merely because they are older than 90 days.
- If more than 400 live day directories accumulate, `idea-usage` logs a warning and keeps writing; it does not auto-delete summaries.
- `.archive/` is not read by `since`. Archives older than 14 days may be deleted to free disk (idea already has the copy).

---

## 7. Export wire format

Binary: root-owned `/usr/local/sbin/idea-usage-export` (not a script under `/home/pi/idea/scripts/`, which `pi` can rewrite). Helper v7 installs that path from `script/build_image_assets/idea-usage-export` (standalone Python forced command). `src/usage/exportCmd.ts` / `exportMain.ts` is the TypeScript implementation used by the idea-usage tests and in-process runner; it is not copied to `/usr/local/sbin`. Both must produce the same wire format. The installed binary accepts only the two verbs below. It cannot open a shell, change unrelated files, or run anything else. It reads `$SSH_ORIGINAL_COMMAND` when invoked as an SSH forced command, and also accepts the same tokens as argv (so tests can call it directly).

A date token must match `^[0-9]{4}-[0-9]{2}-[0-9]{2}$` and be a real calendar date. Any other argument, a shell metacharacter, or a missing flag is rejected.

### 7.1 `since YYYY-MM-DD`

Print every stored day file, sample record and presence sample whose day is **on or after** that date (inclusive), from the live tree only (never `.archive/`).

Stdout is **NDJSON** (one JSON object per line, UTF-8). Records are wrapped in an envelope so the collector can parse a mixed stream:

```json
{"type":"presence","schema":"idea-usage-presence/1","day":"2026-11-12","payload":{…}}
{"type":"day","schema":"idea-usage-day/1","day":"2026-11-12","instance":"kolibri-3f2a…","payload":{…full stored file…}}
{"type":"sample","schema":"idea-usage-sample/1","day":"2026-11-12","instance":"nextcloud-…","payload":{…one sample object…}}
{"type":"end","schema":"idea-usage-export/1","since":"2026-11-12","engine":"happy-zebra","usageMonitoring":"on","counts":{"day":3,"sample":48,"presence":288},"errors":0}
```

**Order**

1. By `day` ascending.
2. Within a day: all `presence` records in file order (chronological), then `day` records sorted by the envelope `instance`, then `sample` records sorted by `instance` then file order.
3. Exactly one `end` marker, last.

`payload` for `day` is the stored file as written (§5.5). `payload` for `presence` and `sample` is the stored object as written (one NDJSON line each). Partial or unreadable files are skipped and counted in `end.errors`; the stream still ends with `end`.

When there is nothing since that date, stdout is only the `end` marker with zero counts.

### 7.2 Exit codes

| Code | When | stdout | stderr |
|---|---|---|---|
| 0 | `since` produced a valid stream (including an empty range); `archive-and-clear` succeeded | NDJSON as specified | empty (or diagnostics that the collector ignores) |
| 2 | arguments rejected | empty | `invalid arguments` |
| 10 | `usageMonitoring` is off | **empty** | `disabled` |
| 1 | unexpected runtime failure (unreadable or unparsable `settings.json`, permissions) | empty or a partial stream; no promise of `end` | `unreadable settings` when the switch file cannot be read or parsed; otherwise a short reason, no paths that are secrets |

[idea#411](https://github.com/koenswings/idea/issues/411) / [idea#412](https://github.com/koenswings/idea/issues/412) require that a disabled export “returns `disabled` with an empty body” and does not modify files. That is exit 10, empty stdout, stderr line `disabled`. A missing `settings.json` is off (exit 10). An unreadable or unparsable `settings.json` is exit 1, empty stdout, stderr line `unreadable settings`. The collector treats 10 as “no new data”, not as a parse error.

### 7.3 `archive-and-clear --before YYYY-MM-DD`

The collector sends `archive-and-clear --before (today-14)` only after a successful store, so one school’s data never travels to the next school. `(today-14)` is the cut date: live day directories strictly before that calendar day are archived. The space form `--before YYYY-MM-DD` is the contract spelling; `--before=YYYY-MM-DD` is accepted as an extra alias.

- Selects live day directories whose date is **strictly before** `<YYYY-MM-DD>` (and their instance files, samples and presence files).
- Moves them to `/var/lib/idea/usage/.archive/<before>-<UTC stamp>/`. If no days are selected (`days` is 0), that destination directory is not created and nothing is written under `.archive/`.
- Does not touch `settings.json`, does not touch other files on the system, and does not follow symlinks out of `/var/lib/idea/usage/`.
- Does not run when the switch is off (exit 10, no modifications).

On success, stdout is a single JSON line:

```json
{"type":"archived","schema":"idea-usage-export/1","before":"2026-11-01","days":12,"files":40}
```

Exit 0.

### 7.4 Disabled behaviour

When `usageMonitoring` is `off` (missing file = off):

- `since` and `archive-and-clear` both exit 10, stdout empty, stderr `disabled`.
- No files are created, rewritten or moved.

---

## 8. Helper v7 and the key drop-in (idea#412)

Current `main` ships `idea-app-data` **v5** (`APP_DATA_HELPER_VERSION` in `src/utils/appDataHelper.ts`). Open [agent-engine-dev#307](https://github.com/koenswings/agent-engine-dev/pull/307) takes **v6** (partitions 3–9). The usage-export key install (idea#412) is helper **v7** (Atlas). [idea#401](https://github.com/koenswings/idea/issues/401) (borg prune/delete/compact) is tracked separately.

The usage-pull public key must not live in `~/.ssh/authorized_keys` or `/etc/ssh/idea_authorized_keys/pi`: `sync-peers` rewrites that file in one atomic swap. It must not go through `idea-peer-gate`: every peer Engine key shares that gate, and making export a gate verb would let any kit pull another school’s summaries.

Current drop-in (`script/build_image_assets/10-idea-peer.conf` on `main`):

```
AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/idea_authorized_keys/%u
```

v7 adds `/etc/ssh/idea_usage_keys/%u` to that list without removing the existing entries, installs root-owned `/usr/local/sbin/idea-usage-export`, and writes the public key to root-owned `/etc/ssh/idea_usage_keys/pi` (directory 0755, file 0644, root:root). `sync-peers` does not touch that file.

The key line (Atlas fills in the sidecar’s own Tailscale IPv4 during the idea#374 window; that is **not** idea’s Engine address `100.115.60.6`):

```
restrict,from="<sidecar Tailscale IPv4>",command="/usr/local/sbin/idea-usage-export" ssh-ed25519 … comment
```

`restrict` disables forwarding, pty, agent and X11. A connection whose source is not that IPv4 is refused by sshd. Never paste a key or token into chat or GitHub; refer to these paths only. The matching private key lives only on idea, under the dashboard App’s `./data/keys` (mode 0600), and is never placed on a school kit.

---

## 9. Privacy

Hook stdout, stored files and the export stream may contain role-level counts, content and channel titles, article titles, app names and instance display names. They must not contain usernames, email addresses, client IP or MAC addresses, file contents, or raw WOPI / session identifiers.

Kiwix sessionisation uses client addresses only in memory / in the on-kit access log; only the session count leaves.

---

## 10. Notes for implementers

- `src/usage/` is a new tree. The Automerge-import unit test watches that directory.
- Filesystem skip flags (`/run/idea/backup-running`, `update-running`, `move-running`) are how a separate process learns that a heavy Engine op is running without opening the store. The Engine process must write and clear them; that write sits outside `src/usage/`.
- This contract does not change how Apps are installed. The dashboard App on idea is installed with `installApp` onto the system disk (see idea#414): `processDisk` registers the root partition as `diskTypes: ['system']` (`src/data/Disk.ts`, `isSystemDisk` / `processSystemDisk`), apps live at `/apps/<id>` and instances at `/instances/<id>`, and they are started at every Engine start. `docs/COMMANDS.md` line 215: “The resolver does not refuse the system disk (it is a valid `installApp` target)”. `ejectDisk` refuses it (`src/data/Commands.ts` around lines 474–476, idea#152). First proof on idea03 or idea04.
