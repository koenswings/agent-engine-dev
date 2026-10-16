# Store history growth: r86q diagnosis (2026-10-13)

Summary of the r86q FAIL@42 investigation (cover-all-stage2-f702e6a-r86q, dev store 3zoqd, since retired for 2VroE). Raw evidence stays on the box (`/workspace/r86q-diag`). This is the reasoning behind engine #192/#194 and console #148 (ephemeral heartbeats/metrics) and the dev-pool compaction to 2VroE.

## What failed
Step 42, 13:12:43 CEST: the walker's store-host thread on idea02 was unresponsive for 58 s, just after a copyApp on idea01.

## Not an Engine stall
- idea01's 30 s heartbeat had every gap within 27–33 s all day (1,610 beats), including the copyApp window. No kernel USB/disk resets; low load.
- copyApp itself was clean and finished in 28.6 s.
- The walker's store host froze at about 13:11:29, just after the copyApp change burst. The harness's stale-view guard (refreshView → connect(forceNew)) then opened a fresh Repo for idea01 on the same frozen thread, i.e. a full first sync, which kept it busy past the 63 s bound.
- Verdict: walker-side. The freeze comes from applying changes to, and fully re-syncing, a store document with a very long history.

## Why a sync takes ~58 s: history, not state
| Pi | bytes | files |
|---|---|---|
| idea01 | 4.5 MB | 4,590 |
| idea03 | 3.0 MB | 174 |
| idea04 | 5.3 MB | 5,567 |

- ~174k changes since 2026-09-28. Full load on the box: ~10 s (5–6× slower on a Pi).
- Current state is small (925 KB as JSON, 916 KB of it operationDB). Compacted, the same state is 322 KB and loads in 0.39 s, **25× faster**.

Changes by origin (whole history):

| class | changes | ops | bytes |
|---|---|---|---|
| heartbeat (engineDB.*.lastRun) | 48 % | 3 % | 26 % |
| container metrics | 29 % | 44 % | 55 % |
| op progress/status | 10 % | 10 % | 6 % |
| other (ops, instances, disks, commands) | 13 % | 42 % | 13 % |

Per day: ~8.6k heartbeat changes (3 Engines × 2,880), ~9.8k metrics, 1–2k progress, 2–3k other: ~22–24k changes/day, adding ~7 s of Pi load time per day.

## Fixes
1. Heartbeats out of the CRDT (ephemeral messages): −8.6k changes/day. → engine #192/#194.
2. Container metrics out of the shared doc (ephemeral): −9.8k changes, −44 % ops/day. → engine #194, console #148.
3. Prune old Done/Failed operationDB entries (shrinks live state ~30×; not history). Open.
4. One-time compaction / store epoch (re-create the store from its current state; fleet-wide store-URL switch). Done for the dev pool (3zoqd → 2VroE); only lasting together with 1 + 2.
- With 1 + 2 + 3: ~3–6k changes/day instead of ~23k. Batch 2 target: < 2k/day.
- Harness: refreshView should reattach, not connect(forceNew), so a busy-but-progressing thread isn't torn down into a full re-sync.

Same pattern as the CommandLog (engine #183/#185: daily rotation).

## Not measured
The per-burst apply cost on a Pi (3 store sessions on one walker thread each applying the same changes) was not measured; it needs a run on idea02.
