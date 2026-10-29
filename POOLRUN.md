# idea#79 — real two-Engine pool run (plan; not run yet)

Runs after #283 in Axle's idea04 queue. Needs claims on BOTH Pis (one claim at a time per bot
rule: claim idea04, then idea03, coordinated with Kid/Atlas/Pixel). Never idea01 (golden) or
idea02 (client-only). No Milkwise, no kit Engines.

## Pis
- **idea03** — source Engine (App disk with a test instance).
- **idea04** — target Engine (an App disk with free space).

## Deploy on each
1. This PR's head (merge latest main into the branch right before the run), built on the Pi
   (`pnpm install && pnpm build`), `pm2 restart` as pi. Both must advertise
   `moveAppCrossEngine` with `capabilitiesBootedAt === lastBooted`.
2. `idea-app-data` helper v4+ (v5 already on idea04 from the release; check idea03:
   `sudo -n /usr/local/sbin/idea-app-data version`). No helper change in this PR.
3. Peer access in place both ways (Engine keys accepted; the existing cross-Engine copyApp works).
4. mDNS on, config.yaml untouched, store-template.json untouched, one shared store.

## Commands (via `node engine-cmd.mjs ENGINE_DIR send …` on idea03; ids from `list`/`disks`)
A. Success, running source:
   `moveApp <instanceId> <idea03 diskId> <idea04 diskId>`
B. Success, stopped source: stop it first (`stopInstance <id> <diskId>`), then as A.
C. Verify fail: on idea04 run an Engine built with this PR but with `verifyMoveTarget`
   forced to a size mismatch is NOT allowed (no test shortcuts). Instead: target disk on idea04
   docked, then undock it after the copy registers (during `Checking`) → verify must fail
   ("not on a disk docked to this Engine") or time out; source must stay.
D. Target unreachable: `pm2 stop` the idea04 Engine (claimed), send A → `TARGET_UNREACHABLE`
   refusal, no operation; then `pm2 restart` it.
E. Interrupt: during `Copying`, `pm2 restart` the idea03 Engine → after start the op is Failed
   `INTERRUPTED`, `MOVE FAILED: the Engine restarted during the move; source kept`; source folder
   intact; any partial `instances/<newId>` on idea04 is quarantined by hand via the helper, never rm.

## Pass criteria
- A/B: op Done, `move.code` MOVED, text `MOVED to idea04`; new instance on the idea04 disk,
  Running (A) / registered (B), opens in the browser; idea03 instance record gone, its folder in
  `<root>/.idea-quarantine/<id>-<stamp>` (not deleted), volumes kept; Console shows the 3 steps.
- C/D/E: source record and folder unchanged on idea03 and the source starts again;
  `MOVE FAILED: …; source kept`; nothing quarantined or deleted on idea03.
- Steps seen in order: Copying, Checking, Removing the old copy. Thermal < 75 °C, maxWorkers=1.
- Then `pnpm test:full` on idea04 from the PR head (mDNS on).

## Release (each Pi)
Restore main, pm2 restart as pi, :8080 → 200, pm2 save, quarantine scratch, clear the claim,
status idle. Moved test instances: move back or quarantine; never delete.
