# Duration harness — Stage 2 (real SSD per test Pi)

Plan: Atlas `/workspace/duration-evidence/stage2-plan/PLAN.md`. Switch: `DURATION_STAGE=2` (unset/`1` = Stage 1, unchanged).

## Fixture homes (2 per Pi — Engine sees sdX1/sdX2 only, ext4 only, /disks/sd[a-z][12])
| Pi | p | PARTLABEL | FS label | diskId | reset diskTypes |
|---|---|---|---|---|---|
| idea01 | 1 | IDEA-KOLIBRI | DUR-KOLIBRI | duration-kolibri-grade5a-001 | [app] |
| idea01 | 2 | IDEA-ADDFILES | ADDFILES01 | duration-add-files-001 | [app] (no files) |
| idea03 | 1 | IDEA-NEXTCLOUD | DUR-NEXTCLOUD | duration-nextcloud-grade5a-001 | [app] |
| idea03 | 2 | IDEA-EMPTY001 | DUR-EMPTY001 | duration-empty-001 | [empty] |
| idea04 | 1 | IDEA-EMPTY002 | DUR-EMPTY002 | duration-empty-002 | [empty] |
| idea04 | 2 | IDEA-EMPTY003 | DUR-EMPTY003 | duration-empty-003 | [empty] |

## stage2-dock.sh contract (assumed; Atlas ships the script)
Path `DURATION_STAGE2_DOCK` (default `/usr/local/sbin/stage2-dock.sh`), always `sudo -n`. JSON object on the last stdout line with boolean `ok`. Exit 0 ok, 2 usage, 3 refused (root disk / idea02 / unknown label), 4 device/timeout, 5 state mismatch. Resolves diskId → PARTLABEL → `/dev/disk/by-partlabel` → kname; refuses parent == root disk.

- `status --json` → `{ok,host,rootDisk,fixtures:[{partLabel,diskId,kname,parent,fsType,fsLabel,mounted,present}],ugreenDetached,extraSdDisks}` (read-only)
- `dock <diskId> --json` → partition add (`partx -a --nr N`); idempotent
- `undock <diskId> --json` → partition remove (`partx -d`); refuses while mounted (harness ejects via Engine first)
- `eject-ssd --json` / `dock-ssd --json` → USB unbind/bind of this Pi's fixture SSD by serial
- `yank <diskId> --json` → remove without umount (dirty path), only when a step asks
- `export <diskId>` → tar stream of the mounted partition on stdout
- `import <targetDiskId> --as <diskId> --json` ← tar on stdin into the empty target partition (writes source META)

## Preflight (exit 10, before step 1)
Engine `config.yaml` pins: testMode false, disksRoot /disks, skipImageLoad false, skipMetaWrite true, skipMetaUpdate true, skipHardwareId true, skipBorg false, peerAccess true, mdns true, no staticPeers. Per Pi: partitions present on ONE non-root SSD as sdX1/sdX2, ext4, FS label + META diskId match, mounted at /disks/<kname>; no extra sd disks; idea03 Ugreen detached. Store: each fixture dockedTo its home with reset diskTypes, Empties hold no instances. Existing store (exit 6, mDNS ON / no static peers / 3zoqd) and peer-key (exit 9) preflights run unchanged; slot-layout (exit 7) is skipped (no idea-test-N slots); fixture-disk (exit 8) checks Empties on their Stage 2 homes, not the Console engine.

## Declared gap
`infra_move_disk` = network copy (`export | import` relayed via the walker into the target Pi's Empty partition, then dock). Physical SSD move is not covered; listed as `stage2Gaps` / `stage2NotCovered` in duration_start, duration_summary and duration_done.
