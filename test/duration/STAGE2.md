# Duration harness — Stage 2 (real SSD per test Pi)

Plan: Atlas `/workspace/duration-evidence/stage2-plan/PLAN.md`. Switch: `DURATION_STAGE=2` (unset/`1` = Stage 1, unchanged).

## Fixture homes (≤2 partitions per SSD — Engine sees sdX1/sdX2 of each sd disk, ext4 only; 8 partitions, idea04 has 2 SSDs)
| Pi | SSD | p | PARTLABEL | FS label | diskId | reset diskTypes | walk role |
|---|---|---|---|---|---|---|---|
| idea01 | 1 | 1 | IDEA-KOLIBRI | DUR-KOLIBRI | duration-kolibri-grade5a-001 | [app] | Prefer A app, move source |
| idea01 | 1 | 2 | IDEA-ADDFILES | ADDFILES01 | duration-add-files-001 | [app] (no files) | add_files_role |
| idea03 | 1 | 1 | IDEA-NEXTCLOUD | DUR-NEXTCLOUD | duration-nextcloud-grade5a-001 | **[app, files]** (seed keeps FILES.yaml) | Prefer A app |
| idea03 | 1 | 2 | IDEA-EMPTY001 | DUR-EMPTY001 | duration-empty-001 | [empty] | **Files** |
| idea04 | 1 | 1 | IDEA-EMPTY002 | DUR-EMPTY002 | duration-empty-002 | [empty] | **Erase** + late installs |
| idea04 | 1 | 2 | IDEA-EMPTY003 | DUR-EMPTY003 | duration-empty-003 | [empty] | **Backup** (95→112) |
| idea04 | 2 | 1 | IDEA-MOVE001 | DUR-MOVE001 | duration-empty-004 | [empty] | **move target** (infra_move_disk only) |
| idea04 | 2 | 2 | IDEA-SPARE001 | DUR-SPARE001 | duration-empty-005 | [empty] | spare — kept OUT of the Engine (partx -d) |

Ids 004/005 stay `duration-empty-*` because `stage2-dock.sh reset` only accepts that pattern. Layout check: ≤2 partitions per SSD, partitions 1/2 only, SSDs of one Pi on distinct disks, never the root disk, never idea02.

Role map: the move target is never a role disk. `stage2RoleTimeline(cover-all)` = no conflict (Kolibri sits on empty-004 from @62 through @112, next to Backup 003 on idea04; Erase 002 and Files 001 untouched). No fallback: re-docking the move target as itself mid-run, or Kolibri's home partition while its copy is docked, is refused (two partitions, one diskId).

## Dock split (Atlas)
Per-disk steps use **partition** verbs only. **Whole-SSD** verbs only for reboot/yank-type events.

| Step / event | Level | Verbs |
|---|---|---|
| infra_dock_fixture | partition | `dock` each fixture on its HOME Pi (Kolibri idea01, Nextcloud idea03) |
| infra_undock_fixtures, enter_infra_fleet_walk, return_to_start | partition | Engine eject (WS) → `undock` |
| infra_move_disk | partition | Engine eject source + empty-004 → `reset empty-004` → `export` \| `import` (walker relay) → source `undock` (held) → `dock empty-004` |
| install_app (2nd), make_files_disk, erase_disk redocks | partition | Engine eject → `reset` (partition stays present) → `dock` (re-add cycle) = Stage 1 fresh Empty pack |
| add_files_role restore | partition | `dock` add-files on idea01 |
| eject_disk / confirm_eject | none | Console/Engine eject only |
| infra_reboot_engine, reboot_engine | ssd | after boot: `status` → `dock-ssd --ssd <fixture>` for each SSD whose partitions are all missing → re-apply partition state |
| 05:00 daily reboot (D5, kept) | ssd | detected by `bootId` change before the next fixture op → same redock |
| yank (no cover-all step yet) | ssd | `yank <diskId>` (that SSD, no Engine eject) → `dock-ssd --ssd <diskId>` |

Redock after any reboot: real partitions survive and the Engine re-detects them at boot. The harness (1) runs `dock-ssd --ssd` per SSD that did not come back, (2) undocks the spare and Engine-ejects + `undock`s fixtures it was holding undocked (boot re-adds them), (3) waits until every other home fixture (or the moved copy on the move target) shows docked on that Pi.

## stage2-dock.sh contract (Atlas's script: duration-evidence/stage2-plan/scripts/stage2-dock.sh)
Path `DURATION_STAGE2_DOCK` (default `/usr/local/sbin/stage2-dock.sh`), always `sudo -n`. JSON object on the last stdout line with boolean `ok` (export: tar only). Exit 0 ok, 2 usage, 3 refused (root disk / Ugreen / idea02 / unknown label), 4 device/timeout, 5 state mismatch.

- `status --json` → `{ok,host,bootId,rootDisk,ssds:[{kname,serial,model}],fixtures:[{partLabel,diskId,kname,parent,fsType,fsLabel,mounted,present}],ugreenDetached,extraSdDisks}`; `diskId` = META on the partition (moved copy → source id); every fixture SSD of the Pi (idea04: 2) is NOT in `extraSdDisks`
- `dock <diskId> --json` → mounted (Engine has it) → `{ok,already:true}` — harness treats as success and waits for the store; present+unmounted → partx -d/-a cycle (`cycled:true`); absent → partx -a
- `undock <diskId> --json` → partx -d; refuses while mounted; absent → `already:true`
- `reset <diskId> --json` → Empty fixtures only; partition must be PRESENT and unmounted (harness Engine-ejects, never partx-removes first); mkfs + META `{diskId, diskTypes:[empty]}`, root pi:pi 0755
- `export <diskId>` → partition present + unmounted (after Engine eject); private ro mount, tar on stdout
- `import <targetDiskId> --as <diskId> --json` ← tar on stdin into a freshly reset target
- `eject-ssd --ssd <diskId> --json` / `dock-ssd --ssd <diskId> --json` → the SSD that carries <diskId>, by serial; state per serial/port; only that SSD's partitions are checked
- `yank <diskId> --json` → unbind of the SSD carrying <diskId>, no umount

## Engine settings = production (golden idea02, read-only)
Read the way production does: `/home/pi/idea/agents/agent-engine-dev/config.yaml` + IDEA_* env of the running Engine (pm2 `engine`). idea02 @745f2c3: settings `mdns: true, isDev: false, testMode: false` (+ port/httpPort/consolePath/store folders/heartbeat); no disksRoot/skip*/peerAccess/staticPeers keys; pm2 env has no IDEA_*. Stage 2 Pis must match: those keys unset, no IDEA_* override (no test-only env), effective values = Config.ts defaults (disksRoot /disks, skipImageLoad/MetaWrite/Borg/MetaUpdate false, peerAccess on, mDNS on, no static peers). `skipHardwareId` reported but not enforced until D4.

## Preflight (exit 10, before step 1)
D4 (hardware id): fail if two fixture partitions resolve to one diskId (status META on any Pi), or an SSD model is Intenso / Samsung FIT while effective skipHardwareId is false (readHardwareId would give both partitions the SSD serial).
Engine settings as above; per Pi partitions present on ONE non-root SSD as sdX1/sdX2, ext4, FS label + META diskId, mounted at /disks/<kname>; no extra sd disks; idea03 Ugreen detached; store: fixtures on their homes with reset diskTypes, Empties without instances; role/move-target timeline for the walk. Store (exit 6) and peer-key (exit 9) preflights unchanged; slot layout (exit 7) skipped; fixture-disk (exit 8) checks Empties on their Stage 2 homes.

## Declared gaps
- `infra_move_disk` = network copy into idea04's move target; physical SSD move not covered (`stage2Gaps` / `stage2NotCovered` in duration_start/summary/done).
