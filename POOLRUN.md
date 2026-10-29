# idea#79 — real two-Engine pool run (plan; not run yet)

After #283 in Axle's idea04 queue. idea03 is shut down. **Source: idea04. Target: idea01
(golden).** Both are claimed together in one window; **Atlas holds the idea01 claim** and restores
idea01 to `77d961b` afterwards. Never idea02. No Milkwise, no kit Engines. Keep it short:
**no test:full on idea01**.

## Thermal hard stop (idea01 has no fan)
Before and during every step: `vcgencmd measure_temp` on idea01 (and idea04).
- idea01 > 75 °C → **stop at once**, no new step; if a move is running let it end (do not
  restart the Engine mid-copy), then wait below 65 °C. Same rule on idea04.
- Log the reading with each step.

## Deploy (Axle on idea04, Atlas on idea01)
1. PR head (latest main merged in), `pnpm install && pnpm build`, `pm2 restart` as pi.
   Both Engines advertise `moveAppCrossEngine` with `capabilitiesBootedAt === lastBooted`.
2. `idea-app-data` v4+ on idea04, the source (`sudo -n /usr/local/sbin/idea-app-data version`).
   No helper change in this PR.
3. Peer access both ways (keys accepted; a plain cross-Engine copyApp works).
4. mDNS on, config.yaml and store-template.json untouched, one shared store.
5. idea04: an App disk with a small test instance (e.g. a small Kolibri fixture) — keep the
   data small so idea01 does little work. idea01: a target App disk with free space.

## Steps (on idea04: `node engine-cmd.mjs ENGINE_DIR send …`; ids from `list` / `disks`)
A. Running source → `moveApp <instanceId> <idea04 diskId> <idea01 diskId>`.
   Watch op steps Copying → Checking → Removing the old copy.
B. Source changed: start a second small instance's move and, during `Checking`, run
   `startInstance <sourceId> <idea04 diskId>` on idea04 → `SOURCE_CHANGED`, source kept.
C. Target unreachable: Atlas `pm2 stop` on idea01 → send A for another instance →
   `TARGET_UNREACHABLE` refusal, no op. Atlas `pm2 restart`.
D. Interrupt: during `Copying` of a move, `pm2 restart` the idea04 Engine → op Failed
   `INTERRUPTED`, `MOVE FAILED: the Engine restarted during the move; source kept`.
(Skip any step if the thermal stop triggers; report which ran.)

## Pass criteria
- A: op Done, `MOVED to idea01`; the instance is Running on the idea01 disk with a fresh id and
  the same name, and it opens; the idea04 record is gone and its folder is in
  `<root>/.idea-quarantine/<id>-<stamp>` (not deleted), volumes kept.
- B: Done, `MOVED, source not removed: the source was started during the move …`; nothing
  quarantined on idea04.
- C, D: source record and folder unchanged on idea04 and it runs again; `MOVE FAILED: …; source kept`.
- idea01 stayed ≤ 75 °C throughout.
- Afterwards `pnpm test:full` on **idea04 only**, from the PR head (mDNS on).

## Cleanup and release
- On idea01: quarantine (never rm) the moved test instances via the helper
  (`idea-app-data quarantine <root> <id>`) or move them back first (Atlas).
- idea04: restore main, pm2 restart as pi, :8080 → 200, pm2 save, quarantine scratch, clear the
  claim, status idle. idea01: Atlas restores `77d961b` and releases his claim.
