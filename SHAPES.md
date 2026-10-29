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
