# Design: `installApp` — Unified App Installation Command

**Status:** Proposed  
**Author:** Axle  
**Date:** 2026-04-11  

---

## Problem

Two separate paths exist for getting an app onto a disk, with inconsistent naming:

1. **`createInstance`** — provisions an instance from a GitHub repository. Internet-required.
   Named as a lifecycle command (`*Instance`) but it is not lifecycle — it is provisioning.
2. **Proposed `installApp`** (parked 2026-04-11) — copies an app from a local disk source
   (docked App Disk, Backup Disk, or Catalog Disk) to an empty target disk. Offline-capable.

These two operations are the same thing from the user's perspective: *"I want this app on this disk."*
The source varies; the intent does not.

Additionally, `createInstance` violates the command naming convention:
- `*Instance` commands operate on an **already-existing** instance: `startInstance`, `stopInstance`, `runInstance`
- `*App` commands perform **management/transfer** operations: `backupApp`, `restoreApp`, `copyApp`, `moveApp`

`createInstance` should always have been `installApp`.

---

## Naming convention (confirmed)

| Pattern | Commands | Meaning |
|---------|----------|---------|
| `*Instance` | `startInstance`, `stopInstance`, `runInstance` | Lifecycle on an existing instance |
| `*App` | `installApp`, `backupApp`, `restoreApp`, `copyApp`, `moveApp` | Provision or transfer an app |
| `*Disk` | `ejectDisk`, `createBackupDisk` | Disk-level operations |

`createInstance` is renamed to `installApp`. A deprecated alias is kept for backward compatibility.

---

## Unified `installApp` command

```
installApp <appId> <targetDiskName> [--source <sourceDiskName>] [--name <instanceName>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `appId` | yes | App identifier (e.g. `kolibri`, `nextcloud`). Looked up in `appDB`. |
| `targetDiskName` | yes | Name of the docked disk to install onto (must be Empty Disk or App Disk with space). |
| `--source <sourceDiskName>` | no | Name of the docked source disk. Triggers local (offline) install path. |
| `--name <instanceName>` | no | Human-friendly instance name. Defaults to `<appId>-<short-id>`. |

### Source routing

The command auto-routes based on `--source` and network availability:

```
installApp <appId> <targetDisk>
         │
         ├─ --source given ──────────────────────► Local path (offline)
         │                                          Copy bundle from source disk
         │                                          (uses copyApp infrastructure)
         │
         └─ --source omitted
                   │
                   ├─ Internet available ──────────► GitHub path (online)
                   │                                  Clone repo, pull images
                   │                                  (current createInstance logic)
                   │
                   └─ No internet
                             │
                             ├─ appDB has local source ─► Local path (offline)
                             │                            Auto-select source disk
                             │
                             └─ No local source ─────────► Error:
                                                           "App not found locally.
                                                            Insert a disk containing
                                                            <appId> or connect to
                                                            the internet."
```

---

## `appDB` — unified app source index

All installable apps are surfaced through a single `appDB` in the Automerge store.
This replaces the current model where only docked App Disks are visible.

### Populated by `processDisk` (extended)

| Disk type | Current | Proposed |
|-----------|---------|----------|
| App Disk | ✅ written to `appDB` | unchanged |
| Backup Disk | ❌ invisible | ✅ write each backed-up instance as an `appDB` entry |
| Catalog Disk | ❌ invisible | ✅ same as Backup Disk |
| GitHub (online) | ❌ not in store | ✅ written to `appDB` with `source: 'github'` on discovery |

### `appDB` entry schema

```ts
interface AppEntry {
  appId: string            // e.g. 'kolibri'
  version: string          // e.g. '1.2.0'
  title: string            // human-readable label
  source: 'disk' | 'github'
  sourceDiskId?: DiskID    // set when source === 'disk'
  sourceDiskName?: string  // human-readable, for display
  instanceId?: string      // if from Backup/Catalog disk, the originating instance
}
```

The Console queries `appDB` for the install dialog — one list, all sources, no special cases.

---

## Internet detection

Internet availability is checked once per `installApp` call (not cached):

```ts
async function hasInternet(): Promise<boolean> {
  // Attempt a short TCP connect to a known reliable host (e.g. 1.1.1.1:53)
  // Timeout: 2 seconds
  // Does not make any HTTP request; no data sent
}
```

This is the only place in Engine that probes for internet. It is used solely for routing — never for telemetry or external calls.

---

## Migration: `createInstance` → `installApp`

`createInstance` is preserved as a **deprecated alias** that calls `installApp` with the GitHub path explicitly:

```ts
// In command dispatcher
case 'createInstance':
  console.warn('createInstance is deprecated; use installApp instead')
  return installApp({ ...args, source: 'github' })
```

No existing tests or scripts need to change immediately. The alias is removed in a future cleanup PR once callers are updated.

---

## Implementation plan

**Phase 1 — Rename and alias**
- Add `installApp` command handler (thin wrapper around existing `createInstance` logic)
- Add `createInstance` alias with deprecation warning
- Update `COMMANDS.md`

**Phase 2 — `appDB` extension**
- Extend `processDisk` to write Backup Disk and Catalog Disk apps into `appDB`
- Add `sourceDiskId` field to `AppEntry`

**Phase 3 — Source router**
- Implement `hasInternet()` probe
- Implement local install path in `installApp` (reuse `copyApp` infrastructure)
- Wire router: `--source` flag → local, no `--source` → probe → decide

**Phase 4 — Console integration**
- Console install dialog reads `appDB`; no disk-type-specific logic needed

---

## Open questions

1. **Catalog Disk distinction**: A Catalog Disk is technically a Backup Disk with on-demand mode. Should `processDisk` treat them identically for `appDB` purposes? Likely yes.

2. **Version conflicts**: If two disks have the same `appId` at different versions, both appear in `appDB`. Console must let the user choose. Engine does not auto-select.

3. **GitHub discovery**: When should Engine scan GitHub for available apps? On-demand (user triggers) or background? Background risks appearing to require internet. Suggest: on-demand only, triggered by Console.
