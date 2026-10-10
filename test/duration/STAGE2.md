# Duration Stage 2 — real SSD partitions (Atlas Path A READY 2026-10-09 14:16)

`DURATION_STAGE=2` switches the duration walker from Stage 1 loop fixtures to real Intenso SSD
partitions, driven through Atlas's `stage2-dock.sh` (`/usr/local/sbin/stage2-dock.sh`, root-owned,
run as `sudo -n`). Stage 1 is unchanged when the variable is unset. Source of truth:
`/workspace/duration-evidence/path-a-stage2-20261009/READY.md`.

## Fixture homes (READY §2) — one SSD per Pi, two partitions each

| Pi | p | diskId | PARTLABEL / FS label | diskTypes | role |
|---|---|---|---|---|---|
| idea01 | 1 | duration-kolibri-grade5a-001 | IDEA-KOLIBRI / DUR-KOLIBRI | [app] | Prefer A app, move source |
| idea01 | 2 | duration-add-files-001 | IDEA-ADDFILES / ADDFILES01 | [app] | add_files_role |
| idea03 | 1 | duration-nextcloud-grade5a-001 | IDEA-NEXTCLOUD / DUR-NEXTCLOUD | [app, files] | Prefer A app |
| idea03 | 2 | duration-empty-001 | IDEA-EMPTY001 / DUR-EMPTY001 | [empty] | Files, then Erase + late installs |
| idea04 | 1 | duration-empty-002 | IDEA-EMPTY002 / DUR-EMPTY002 | [empty] | Backup (same Pi as moved Kolibri) |
| idea04 | 2 | duration-empty-003 | IDEA-EMPTY003 / DUR-EMPTY003 | [empty] | **move-only** target |

Disks are addressed only by diskId → PARTLABEL (the script resolves `/dev/disk/by-partlabel`),
never by sdX: idea01's fixture SSD is `sda` (root `sdb`), idea03/idea04's is `sdb` (root `sda`).
idea02 is never in the pool, never a host, never a target.

## Roles and the move-only target (READY §4.4)

Only three Empties exist but cover-all has four Empty uses. Resolution (`STAGE2_ROLE_MAP`):

| role | partition | cover-all window |
|---|---|---|
| move target | empty-003 (idea04) | infra_move_disk @62 → end of walk (move-only; never moved onto idea01) |
| Files | empty-001 (idea03) | install_app/make_files_disk @88–@92 |
| Backup | empty-002 (idea04) | make_backup_disk @95 → @112 (co-located with the moved Kolibri) |
| Erase + late installs | empty-001 (idea03) | erase_disk @104 → @122 |

Files and Erase share empty-001 **sequentially**. `stage2RedockSharedEraseDisk` re-docks it fresh
(Engine eject → `reset` → `dock`, plus a store purge) before the first erase. `stage2RoleTimeline` and
`allowedSequentialShare` (fixtureDisks) prove the windows do not overlap. Any other share, or a role
on the move target, fails the preflight (exit 10).

## Dock split

- Per-disk steps use **partition** verbs: `dock`, `undock`, `reset`, `export`, `import`. An Engine
  eject (WS) always comes first, and the harness waits until the store shows the disk undocked AND
  `status` shows the partition unmounted.
- `infra_move_disk` is a **network copy** (a declared gap; physical move = Stage 3). The steps:
  1. Engine-eject the source and empty-003.
  2. `reset` empty-003.
  3. `export <src> | import empty-003 --as <src>`, relayed by the walker.
  4. `undock` the source (held).
  5. `dock` empty-003.

  The sibling empty-002 (Backup) stays mounted throughout. No whole-SSD verb is involved.
- Whole-SSD verbs (`eject-ssd` / `dock-ssd`) are used only inside one call (reboot redock).
  `stage2WholeSsdProblems` refuses any walk step that would leave an SSD ejected, and Stage2FleetOps
  refuses partition verbs on fixtures of an ejected SSD.
- The Stage 1 dock-trigger folder (`duration-watch` sentinels / tree copies) is never written:
  `sshDockCopy` and `sshRemoveSentinel` throw.

## Preflight (exit 10)

- No `IDEA_*` env on the running Engines.
- Effective `testMode` false.
- `skipHardwareId` true (D4 pin, required). Reported per Pi as `pins: skipHardwareId=true (D4 pin, test-only), systemDiskSkip=true (pin)`.
- Every other effective setting equals production. `disksRoot`, `staticPeers` and `watchDir` are unset.
- mDNS on, no static peers.
- Every READY fixture is present on its home Pi's SSD (never the root disk), ext4, with the right
  FS label and META diskId, mounted at `/disks/<kname>`, docked on its home, with the READY diskTypes
  (Nextcloud `[app, files]`, Empties `[empty]` with no instances).
- Any non-READY row that is **present** fails the preflight. The installed script still lists
  82aeaa5's IDEA-MOVE001/SPARE001 as absent rows; that is fine.
- The role/move timeline and the whole-SSD check must pass.
- Store step (READY §4.7), opt-in: `DURATION_STAGE2_STORE_FIX=off` (default), `plan` or `apply`.
  It runs `stage2-store-fix.sh` with `ENGINE_SRC=/workspace/storefix-node` and
  `D10_IDEA02_LAN=10.99.0.12`, and never uses the gate-bypass flag.
  - `plan`: the D10 gate must PASS and the plan must be empty.
  - `apply`: the write is gate-enforced by the wrapper.

  It is off by default because the D10 check reads idea02.

## Per-Pi sidecar checks (READY §4.2)

- Sidecar URLs come from the store: the instance's host and `port`. READY's values are Kolibri
  `idea01:18080` and Nextcloud `idea03:61820`; 18280 is idea166's Nextcloud.
- Before every sidecar-settle Intent, `verifySidecarOwner` must prove the port belongs to THIS
  instance on THIS Pi. The check runs only for Running instances, and a failure fails the step (no soft-pass):
  - bridge containers must publish `:port`;
  - host-network containers (Kolibri) must own the `ss` listener pid.
- idea04's native kolibri-0.15.5 also answers :18080, so a bare HTTP 200 proves nothing.

## D5 — the 05:00 daily reboot during walks (proposal)

Options:

- (a) hold/skip the 05:00 reboot on pool Pis while a walk runs;
- (b) schedule walks around it;
- (c) detect a bootId change, redock via `dock-ssd`, and resume.

**Recommendation: (a) + (b) as the plan, with (c) kept as a safety net only.** Hold the 05:00
reboot on idea01/03/04 for the duration of a walk (a flag/inhibit the reboot job honours, removed at
walk end), and start walks so they finish well before 05:00.

Why not rely on (c):

- An idea01 reboot with two USB disks (Pi 5, BOOT_ORDER 0xf461) is untested.
- idea04 is a Pi 4 with no powered hub; an SSD hung it at about 12:19.
- A reboot mid-step would also make Engine and Console state transitions a confounder in a duration measurement.

(c) is implemented and unit-tested:

- `recordBootIds` at walk start;
- a `boot_id` check before every fixture op;
- `redockAfterBoot`: `dock-ssd` when the whole SSD is missing, re-undock held fixtures, wait for the rest to dock.

It would catch an unplanned reboot and either recover or fail loud. It has not been exercised against a real reboot. The planned `reboot_engine` @128 (idea01) uses the same path and is the first real test of it.

## No "already docked" shortcuts around the per-Pi paths (r53 FAIL@58)

r53: `eject_disk@45` ejected Nextcloud on idea03; `infra_dock_fixture@58` saw Kolibri docked on idea01,
returned "already docked (no-op)" and waited 420 s for a Nextcloud nobody re-docked. Now:

- `infra_dock_fixture`: in Stage 2 the no-op holds only when EVERY fixture is docked; otherwise each
  fixture is docked on its home Pi (a network-copied fixture stays on the move target).
- `Stage2FleetOps.dockFixture`: "already docked" needs the store row AND the partition mounted on that Pi.
- `infra_move_disk`: the Stage 2 source is the store holder (not walker state); undocked or already on
  the move target fails loud. `Stage2FleetOps.moveDisk(x, x)` is refused instead of a silent no-op.

## Partition dock = undock → gap → dock, verified (Atlas reset-r53)

`stage2-dock.sh dock` on a partition that is present but not mounted (Engine-ejected, or fresh from
reset/import) re-adds it with `partx -d`/`-a` milliseconds apart; chokidar merges that into a `change`
and the Engine (add/unlink only) silently does nothing. Every harness partition dock
(`Stage2FleetOps.dockPartition`: dockFixture, Empty fresh docks, move_disk target) therefore:
present + unmounted → `undock`, wait `DURATION_STAGE2_REDOCK_GAP_MS` (default 5000), `dock`; absent →
`dock`; mounted → nothing to add. Then it verifies, within `DURATION_STAGE2_DOCK_WAIT_MS`, that the store
has the disk docked on that Pi AND the partition is mounted — otherwise it fails loud ("had no effect").
Whole-SSD `dock-ssd` is unchanged. The Pi script is Atlas's and is not changed here.

## No any-Pi fallback for any App port (r54 → r55)

r54 steps 21–33 "passed" against `idea166-nextcloud-live-app` on idea01:18280 — the Console's default
Nextcloud port on the Console host — not the fixture `nextcloud-grade5a-001` on idea03:61820 (whose
`trusted_domains` only lists `idea01:18280`, so step 58 then failed on HTTP 400 "untrusted domain").
Step 34 used `idea166-kiwix-live` on idea01:18380 the same way. The Console Intents (cda87d2
`e2e/intents/sidecarUrls.ts`) resolve every App as `DURATION_<APP>_URL`, else Console host +
`DURATION_<APP>_PORT`, else 18080 / 18280 / 18380. In Stage 2 (`test/duration/appUrls.ts`, `actions.ts`
`pinAppsForStep` / `verifyAppUseAfterIntent`):

- every step that lands in an App state (`kolibri_*`, `nc_*`, `wiki_*`), names an App
  (`open_*_as_*`, `search_browse_wikipedia`), or opens/settles an instance (`open_app`, `copy_app`,
  `move_app`, `restore_from_backup`) gets `DURATION_<APP>_URL` from the STORE (instance's Pi + published
  port) before its Intent; no store instance / no port / a manual URL or port → the step fails;
- the port must be that instance's container on that Pi (`verifySidecarOwner`), and Nextcloud must not
  answer 400 "untrusted domain";
- after the Intent, the active tab, any tab the step opened, and the Console page must be on a Console
  host:8080 or on one of the step's store URLs (any alias of that Pi), and each used instance must still
  be Running and owned — otherwise the step fails ("Console Intent reported ok");
- `DURATION_NC_FILE_REQUEST_URL`, if set, must be on the Nextcloud store host:port;
- the `infra_dock_fixture` Nextcloud wait uses the store URL only and fails fast on repeated
  "untrusted domain" answers (`untrustedFailAfter`, default 30).

Kiwix has no instance in the Stage 2 store, so `open_wikipedia_*` / `search_browse_wikipedia` fail
loud until a Kiwix fixture exists.

## infra_dock_fixture docks only what needs docking (r54 step 58)

The per-Pi path used to dock every fixture disk, and an Empty dock is always fresh (Engine eject → reset
→ dock), so step 58 re-made empty-001/002 although only Nextcloud had been ejected. Now a disk the store
has Docked on its target AND whose partition is mounted there (`Stage2FleetOps.stage2DockedAndMounted`)
is left alone; the step message lists `[already Docked+mounted, not re-docked: …]`.

## Smoke (D9)

`test/duration/stage2Smoke.ts` (idea04 only, empty-002/003). Phases:

- status;
- negative (exit codes 2/3/4/5, `already:true`);
- partition ×N on empty-003, with sibling empty-002 kept mounted;
- ssd ×N;
- move (reset → export | import → META → refuse re-import → reset);
- final (READY start state).

```
DURATION_FLEET_HOSTS=idea01=…,idea03=…,idea04=… npx tsx test/duration/stage2Smoke.ts --out <dir> --cycles 10
```

## r57: the Console Open must open the App tab (r56 FAIL@34)

The Console's Open (`AppCard.tsx` `window.open(http://<engineHostname>:<port>)`) uses `<engine>.local` for a
remote engine and the page hostname for its own engine. The box resolver answers `.local` with a sink
(198.18.0.1), so Chromium opened **no tab**. Kiwix (single-shot open in `wikipedia.ts`) failed. NC and Kolibri
"passed" only through the intents' Path B (goto the pinned URL), which hid the same dead Open.

- The Playwright driver launches Chromium with `--host-resolver-rules=MAP <engine>.local <--hosts addr>`. The
  real Console Open now produces the real tab. Nothing is rewritten, and there is no fallback.
- Every `open_{kolibri,nextcloud,wikipedia}_as_*` step must show a tab from the Console Open
  (`<engine>.local:<port>`, or `<engine>:<port>` for the Console's own engine). A Path B tab (bare remote
  name or IP) or no tab fails the step (`consoleOpenProblem`). A real learner would have got nothing there.

## r58: tab matching by port + engine host forms (r57 FAIL@35)

For each App a step uses, the harness sets `DURATION_<APP>_HOSTS` next to `DURATION_<APP>_URL`. It lists the
bare name, `.local`, the --hosts IP and the LAN IP. The LAN IP comes from store `engineDB[].lanAddress`
(Engine PR #166), else from `DURATION_LAN_HOSTS`. The Console intents (Console PR #140) match tabs by port plus
any of these host forms, not by exact origin. The Open check also accepts the engine's LAN IP, because
Console #139 Open uses `engine.lanAddress`. Fallback tabs (bare remote name or Tailscale IP) still fail.

## r59: instances settle after instance-changing steps (r58 FAIL@58)

`instanceSettle.ts`. Each Engine is authoritative for the disks docked on it. Every instance on a docked disk
must settle before the harness pins App URLs or uses Apps:
- Running or Pauzed with a port, or Stopped or Docked, counts as settled. Missing is ignored.
- Undocked, Starting, or Running without a port means keep waiting.
- Error fails at once.

The wait is bounded by `DURATION_INSTANCE_SETTLE_MS` (default 300 s) and dumps every instance's status, port and
disk on timeout. It runs at three points:
- at the start of every Stage 2 URL resync (dock, move, backup co-locate, sidecar-settle Intents);
- before every App pin (`pinAppsForStep`);
- after every step in `SETTLE_AFTER_ACTIONS` (`settleAfterStep`): dock 58/61, reboot 59/128, move 62, copy 43/116,
  move_app 102, restore 100, start 109/115, backup 98/112, make_backup 95, make_files 91, add_files 93,
  cancel_eject 107, notice_usb_dock 55, confirm_erase 105.

It only reads the store. No user action is retried.
