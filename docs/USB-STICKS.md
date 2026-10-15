# idea#193 teacher USB sticks: Engine ⇄ app interface (for Kid, app-nextcloud#7 @84ef94a)

Engine side: agent-engine-dev branch `feat/193-usb-sticks` (PR link in the report). Not merged.

## 1. Host side (Engine)
- Mount root: `/run/idea-usb`, created at every boot by `/etc/tmpfiles.d/idea-usb.conf`
  (`d /run/idea-usb 0755 pi pi -`, installed by build-engine / `./install-root-helpers`).
- One folder per stick: `/run/idea-usb/<dev>` (`sdb1`, `sdc2`, or `sdb` for a stick without a
  partition table). Created by the Engine (pi) right before the mount, removed with `rmdir`
  right after the unmount.
- Mount, exactly (sudoers `11-engine-files`):
  - vfat: `mount -t vfat -o ro,nosuid,nodev,noexec,uid=1000,gid=1000,fmask=0222,dmask=0222,iocharset=utf8,shortname=mixed /dev/<dev> /run/idea-usb/<dev>`
  - exfat: `mount -t exfat -o ro,nosuid,nodev,noexec,uid=1000,gid=1000,fmask=0222,dmask=0222,iocharset=utf8 /dev/<dev> /run/idea-usb/<dev>`
  - Files are owned by 1000:1000, mode 0555 (dirs) / 0555 (files, noexec anyway): readable by
    everyone, incl. www-data (33). Writes fail with EROFS. No fsck, no chown, never a write on the stick.
- Unmount: `umount /run/idea-usb/<dev>`, `umount -l` only if busy; then `rmdir`.

## 2. Container side (x-app.usbMount)
```yaml
x-app:
  usbMount:
    path: /mnt/idea-usb
    services: [nextcloud-app]
    # optional; default when omitted and services contains nextcloud-app:
    # sync: { service: nextcloud-app, user: www-data, command: /idea/usb-sync.sh }
```
- The Engine adds to its per-instance compose override (same file as filesMount, `COMPOSE_FILE=compose.yaml:<override>`), for each listed service:
  `{ type: bind, source: /run/idea-usb, target: /mnt/idea-usb, read_only: true, bind: { create_host_path: false, propagation: rslave } }`
  Static: sticks plugged later appear in the running container by themselves. No recreate per plug.
- In the container: `/mnt/idea-usb/<dev>/…` (stick content) and `/mnt/idea-usb/.idea-usb.json`.

## 3. .idea-usb.json (`/run/idea-usb/.idea-usb.json` → `/mnt/idea-usb/.idea-usb.json`)
Written by the Engine, atomically (write `.idea-usb.json.tmp-<pid>` in the same folder, then `rename`), on every plug/unplug and at Engine start (empty list). Wrapped shape:
```json
{
  "version": 1,
  "engineId": "ENGINE_…",
  "updatedAt": 1760434800000,
  "sticks": [
    { "device": "sdb1", "displayName": "USB: MARY-STICK", "label": "MARY-STICK",
      "dir": "sdb1", "stickId": "usb-ABCD-1234", "uuid": "ABCD-1234", "fsType": "vfat",
      "sizeBytes": 32000000000, "usedBytes": 3200000000, "mountedAt": 1760434800000,
      "readOnly": true, "hasKolibriFolder": true, "kolibriFolder": "Kolibri" }
  ]
}
```
Kid's contract fields `stickId` ("usb-<filesystem UUID>", e.g. usb-ABCD-1234), `device`, `label`, `displayName` are always present; the folder is `/mnt/idea-usb/<device>`; the rest are extra (builder: `uuid` for `usb:<uuid>:<path>`, `kolibriFolder` = actual case of the folder name). A stick is listed only once it is mounted; on unplug it is removed from the JSON **before** the unmount. `displayName` is unique per Engine (`USB: X`, `USB: X (2)`). Label = filesystem label, else drive model, else `USB stick`.

## 4. Sync call (usb-sync.sh)
`timeout 120 docker exec -u www-data -e IDEA_USB_EVENT=<plug|unplug|start> -e IDEA_USB_ROOT=/mnt/idea-usb -e IDEA_USB_JSON=/mnt/idea-usb/.idea-usb.json <instanceId>-nextcloud-app-1 /idea/usb-sync.sh`
- When: after each plug (JSON already lists the stick), after each unplug (JSON already without it, mount still there until right after), at Engine start (after startup cleanup), and when the Nextcloud instance itself reaches Running (instance start).
- Only instances that are Running on a disk docked to this Engine. Calls are serialised (never two at once). Non-zero exit / timeout: logged, retried once after 15 s; the next event reconciles again. The script must be idempotent and treat the JSON as the full desired state (create missing `idea_usb=1` storages, delete `idea_usb=1` storages whose `device` is gone), and exit 0 when Nextcloud isn't ready yet only if it is fine to wait for the next event (the instance-start call can come before `occ` is ready).

## 5. Lifecycle summary
plug: probe (lsblk) → vfat/exfat on a non-system drive → mkdir → ro mount → Engine.usbSticks → JSON → sync(plug) → builder auto-start (kolibri folder only).
unplug: Engine.usbSticks → JSON → sync(unplug) → umount (lazy if busy) → rmdir.
Engine start: unmount + rmdir leftovers, usbSticks = [], JSON `{"sticks":[]}`, sync(start); the udev watcher then re-mounts sticks still plugged in (each a normal plug).
Erase of a stick: Engine unmounts it first (unplug path), then the normal erase.

## 6. Channel builder (§8.2a, for Kid's builder PRs)
App name `kolibri-channel-builder` (app id `kolibri-channel-builder-<version>`); opts in with `usbMount` (no `sync` needed; it watches the JSON). The Engine starts it only from Docked (or Error: one try) on the mount of a stick with a top-level `kolibri` folder; Stopped/Pauzed/operator stop → no start. Outcome in `Engine.usbSticks[].builderAutoStart` (`started|alreadyRunning|noBuilder|operatorStopped|disabled|busy|failed|notStartable`, null without kolibri folder) for Pixel's Console hints. Setting `autoStartChannelBuilder` (default true).
