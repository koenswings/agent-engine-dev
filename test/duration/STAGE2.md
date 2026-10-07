# Duration harness — Stage 2 (real SSD per test Pi)

Plan: Atlas `/workspace/duration-evidence/stage2-plan/PLAN.md`. Switch: `DURATION_STAGE=2` (unset/`1` = Stage 1, unchanged).

## Fixture homes (2 per Pi — Engine sees sdX1/sdX2 only, ext4 only, /disks/sd[a-z][12])
| Pi | p | PARTLABEL | FS label | diskId | reset diskTypes | walk role |
|---|---|---|---|---|---|---|
| idea01 | 1 | IDEA-KOLIBRI | DUR-KOLIBRI | duration-kolibri-grade5a-001 | [app] | Prefer A app, move source |
| idea01 | 2 | IDEA-ADDFILES | ADDFILES01 | duration-add-files-001 | [app] (no files) | add_files_role |
| idea03 | 1 | IDEA-NEXTCLOUD | DUR-NEXTCLOUD | duration-nextcloud-grade5a-001 | [app] | Prefer A app |
| idea03 | 2 | IDEA-EMPTY001 | DUR-EMPTY001 | duration-empty-001 | [empty] | **Files** (never a move target) |
| idea04 | 1 | IDEA-EMPTY002 | DUR-EMPTY002 | duration-empty-002 | [empty] | **Erase** + late installs; **move target** (default) |
| idea04 | 2 | IDEA-EMPTY003 | DUR-EMPTY003 | duration-empty-003 | [empty] | **Backup** (95→112) |

`DURATION_STAGE2_MOVE_TARGET` may pick empty-003 instead; it must be an Empty on idea04.

### Roles do NOT all fit (cover-all)
Kolibri is network-copied onto the move target at infra_move_disk@62 and is still needed there through backup_instance@112 (co-located with Backup 003 on idea04). With target 002, Erase needs 002 Empty at erase_disk@104 → conflict. With target 003, make_backup_disk@95 needs it Empty → conflict. 6 partitions cannot hold 3 Empty roles + a move target. `stage2RoleTimeline` detects this and the Stage 2 preflight FAILS (exit 10) on cover-all until one of:
- a 7th partition: a **second SSD on idea04** (sdc1 is visible to the unmodified Engine) as a dedicated move target — preferred, hardware only (ties into D4);
- Engine D1 (udev/validDevice/sudoers to sd[a-z][1-9]);
- a Stage 2 walk variant that ends the Kolibri-on-idea04 window before @104.
If 002 is re-docked as Erase while holding the moved copy, the harness ejects the copy, re-docks Kolibri on its home partition (pre-move state; declared gap) and resets 002.

## Dock split (Atlas)
Per-disk steps use **partition** verbs only. **Whole-SSD** verbs only for reboot/yank-type events.

| Step / event | Level | Verbs |
|---|---|---|
| infra_dock_fixture | partition | `dock` each fixture on its HOME Pi (Kolibri idea01, Nextcloud idea03) |
| infra_undock_fixtures, enter_infra_fleet_walk, return_to_start | partition | Engine eject (WS) → `undock` |
| infra_move_disk | partition | Engine eject → target `reset` → `export` \| `import` (walker relay) → source `undock` → target `dock` |
| install_app (2nd), make_files_disk, erase_disk redocks | partition | Engine eject → `undock` → `reset` → `dock` (= Stage 1 fresh Empty pack) |
| add_files_role restore | partition | `dock` add-files on idea01 |
| eject_disk / confirm_eject | none | Console/Engine eject only |
| infra_reboot_engine, reboot_engine | ssd | after boot: `status` → `dock-ssd` iff both partitions missing → re-apply partition state |
| 05:00 daily reboot (D5, kept) | ssd | detected by `bootId` change before the next fixture op → same redock |
| yank (no cover-all step yet) | ssd | `eject-ssd` without Engine eject → `dock-ssd` |

Redock after any reboot: real partitions survive and the Engine re-detects them at boot. The harness (1) runs `dock-ssd` if the SSD did not come back, (2) Engine-ejects + `undock`s fixtures it was holding undocked (boot re-adds them), (3) waits until every other home fixture (or the moved copy on the move target) shows docked on that Pi.

## stage2-dock.sh contract (assumed; Atlas ships the script)
Path `DURATION_STAGE2_DOCK` (default `/usr/local/sbin/stage2-dock.sh`), always `sudo -n`. JSON object on the last stdout line with boolean `ok`. Exit 0 ok, 2 usage, 3 refused (root disk / idea02 / unknown label), 4 device/timeout, 5 state mismatch. Resolves diskId → PARTLABEL → `/dev/disk/by-partlabel` → kname; refuses parent == root disk; hostname/machine-id deny idea02.

- `status --json` → `{ok,host,bootId,rootDisk,fixtures:[{partLabel,diskId,kname,parent,fsType,fsLabel,mounted,present}],ugreenDetached,extraSdDisks}` (read-only; `bootId` = /proc/sys/kernel/random/boot_id; `diskId` from META.yaml — for a moved copy report the META diskId actually on the partition)
- `dock <diskId> --json` → `partx -a --nr N`; idempotent
- `undock <diskId> --json` → `partx -d --nr N`; refuses while mounted
- `reset <diskId> --json` → **Empty fixtures only**; refuses while mounted; `mkfs.ext4 -F -L <fsLabel>` on the same PARTLABEL partition, META.yaml `{diskId, diskTypes:[empty]}`, root pi:pi 0755
- `export <diskId>` → tar (numeric-owner, xattrs) on stdout; works on the **unmounted** partition after Engine eject: mounts read-only at a private path (never under /disks), tars, unmounts
- `import <targetDiskId> --as <diskId> --json` ← tar on stdin into the freshly reset target (keeps target fs/PARTLABEL; the source META diskId lands on it)
- `eject-ssd --json` / `dock-ssd --json` → USB unbind/bind of this Pi's fixture SSD by serial
- `yank <diskId> --json` → removal without umount (dirty path)

## Engine settings = production (golden idea02, read-only)
Read the way production does: `/home/pi/idea/agents/agent-engine-dev/config.yaml` + IDEA_* env of the running Engine (pm2 `engine`). idea02 @745f2c3: settings `mdns: true, isDev: false, testMode: false` (+ port/httpPort/consolePath/store folders/heartbeat); no disksRoot/skip*/peerAccess/staticPeers keys; pm2 env has no IDEA_*. Stage 2 Pis must match: those keys unset, no IDEA_* override (no test-only env), effective values = Config.ts defaults (disksRoot /disks, skipImageLoad/MetaWrite/Borg/MetaUpdate false, peerAccess on, mDNS on, no static peers). `skipHardwareId` reported but not enforced until D4.

## Preflight (exit 10, before step 1)
Engine settings as above; per Pi partitions present on ONE non-root SSD as sdX1/sdX2, ext4, FS label + META diskId, mounted at /disks/<kname>; no extra sd disks; idea03 Ugreen detached; store: fixtures on their homes with reset diskTypes, Empties without instances; role/move-target timeline for the walk. Store (exit 6) and peer-key (exit 9) preflights unchanged; slot layout (exit 7) skipped; fixture-disk (exit 8) checks Empties on their Stage 2 homes.

## Declared gaps
- `infra_move_disk` = network copy into idea04's move target; physical SSD move not covered (`stage2Gaps` / `stage2NotCovered` in duration_start/summary/done).
- A moved copy evicted from the move target is not carried back; Kolibri re-docks from its home partition in its pre-move state.
