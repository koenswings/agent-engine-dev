# moveApp across Engines — shapes (idea#79)

Types: `src/data/MoveAppShapes.ts`. Approach: idea#79 comment 6493314879.

## Capability
`moveAppCrossEngine` in `Engine.capabilities` (same rule as the others: counts only when
`capabilitiesBootedAt === lastBooted`). The Console offers a disk on another Engine for Move
only when **both** the source and the target Engine advertise it. Older Engines still refuse.

## Command (unchanged syntax)
```
moveApp <instanceId|name> <sourceDiskId> <targetDiskId>
```
Sent to the Engine the **source** disk is docked to. The target Engine is the target disk's
`dockedTo`; no extra argument. Same-Engine moves behave as before.

Internal (Engine → Engine, not for the Console):
`verifyMoveTarget <opId> <targetInstanceId> <expectedBytes> <expectRunning:true|false>`

## Progress — one `moveApp` Operation in `operationDB`
Usual fields: `status` Pending → Running → Done | Failed, `progressPercent`,
`currentStep` 0..2, `totalSteps` 3, `stepLabel`:

| step | stepLabel | phase |
|---|---|---|
| 0 | `Copying` | `copying` |
| 1 | `Checking` | `checking` |
| 2 | `Removing the old copy` | `removing` |

Extra field `Operation.move` (cross-Engine only):
```ts
move: {
  phase: 'copying'|'checking'|'removing'|'done'|'failed'
  targetEngineId: string
  sourceInstanceId: string
  targetInstanceId: string | null   // fresh id on the target
  expectedBytes: number | null
  expectRunning: boolean
  verify: { ok: boolean, bytes: number|null, detail: string|null, at: number } | null
  verified: boolean                  // the ONLY gate for removing the source
  sourceRemoved: boolean
  quarantinePath: string | null      // source folder, quarantined, never deleted
  code: MoveCode | null
  resultText: string | null
}
```

## Result texts (`Operation.error` on Failed, `move.resultText` always, trace result `.text`)
- Success: `MOVED to <Engine name>` — status Done, code `MOVED`.
- Copy or verify failed: `MOVE FAILED: <reason>; source kept` — status Failed; nothing deleted.
- Delete failed after a good copy: `MOVED, source not removed: <reason>` — status **Done**,
  code `SOURCE_NOT_REMOVED` (the App runs on the target; the old copy is still on the source).

## Codes
Refusals (command trace error, thrown before anything is copied; text
`MOVE FAILED: <reason>; source kept`):
`NOT_FOUND`, `AMBIGUOUS`, `SOURCE_REMOTE`, `TARGET_UNREACHABLE`, `PEER_ACCESS`,
`TARGET_OUTDATED`, `HELPER_OUTDATED`, `BUSY`, `INVALID`.

Outcomes (`move.code`): `MOVED`, `COPY_FAILED`, `VERIFY_FAILED`, `VERIFY_TIMEOUT`,
`INTERRUPTED`, `SOURCE_NOT_REMOVED`.

## Restart / interrupt
On Engine restart an interrupted cross-Engine move is never retried automatically:
- `verified` false → Failed, `INTERRUPTED`, `MOVE FAILED: the Engine restarted during the move; source kept`.
- `verified` true and not removed → Done, `SOURCE_NOT_REMOVED`,
  `MOVED, source not removed: the Engine restarted before the old copy was removed`.

## Console Q&A (Pixel)
1. **Capability:** `moveAppCrossEngine`, in `Engine.capabilities`. The usual rule applies: it counts only when `capabilitiesBootedAt === lastBooted`. Offer a remote disk for Move only when **both** the source and the target Engine have it.
2. **Command:** unchanged, `moveApp <instanceId|instanceName> <sourceDiskId> <targetDiskId>`. Sending the instance id is preferred, but a name still resolves as before. Send it to the **source** Engine, the one the source disk is docked to. The target Engine is taken from the target disk's `dockedTo`. `verifyMoveTarget` is internal (Engine → Engine), so the Console doesn't need it.
3. **Steps and progress:** a single op with kind **`moveApp`** (same naming style as `updateApp`). Read progress from that op in `operationDB`: `status` (Pending → Running → Done | Failed), `currentStep` 0..2, `totalSteps` 3, and `stepLabel` = `Copying` | `Checking` | `Removing the old copy`. `op.move.phase` mirrors this as `copying` | `checking` | `removing` | `done` | `failed`. There is **no ephemeral message and no bytesDone/bytesTotal**. `progressPercent` exists but isn't stored inside a step (store design), so don't rely on it. `op.move.expectedBytes` gives the source size if you want to show it.
4. **Texts.** They are always in `op.move.resultText` and in the command trace `result.text`, and failures also put them in `op.error`:
   - Success: `MOVED to <Engine hostname>`. Status **Done**, `op.error` null, `move.code` `MOVED`.
   - Copy or verify failed: `MOVE FAILED: <reason>; source kept`. Status **Failed**, the text is in `op.error`, and nothing is deleted. Codes: `COPY_FAILED`, `VERIFY_FAILED`, `VERIFY_TIMEOUT`, `INTERRUPTED`.
   - Partial success, where the copy is good but removing the old one failed: `MOVED, source not removed: <reason>`. Status **Done**, the text is in `op.error`, `move.code` `SOURCE_NOT_REMOVED`. Treat Done with a non-null `op.error` as a warning.
   - Refusals are thrown before any op exists: the command trace ends as `error` with `errorMessage` = `MOVE FAILED: <reason>; source kept`. Codes: `NOT_FOUND`, `AMBIGUOUS`, `SOURCE_REMOTE`, `TARGET_UNREACHABLE`, `PEER_ACCESS`, `TARGET_OUTDATED`, `HELPER_OUTDATED`, `BUSY`, `INVALID`. The code is on the error object but not yet in the trace text, so match on the text prefix `MOVE FAILED:`.
5. **Instance id:** the id is **not kept**. The target gets a fresh instance id, the existing cross-Engine copy behaviour, while the **name is kept** and the port is reassigned at start. `op.move.sourceInstanceId` and `op.move.targetInstanceId` give both ids, and `op.subject` stays the source id. Same-Engine moves still keep the id, as before.
