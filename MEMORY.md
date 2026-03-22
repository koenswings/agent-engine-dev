# MEMORY.md

Durable facts and decisions only.
No daily logs. No secrets.

## Current Delivery Status

### Goal
Run board as lead operator for IDEA Engine project. Execute 12 inbox tasks.

### Current State
- State: Working
- Last updated: 2026-03-20 04:03 UTC
- What is happening now: Directive received — one task at a time. Repo confirmed. Starting task execution.
- Key constraint/signal: One task at a time directive active. Engine repo at `/home/node/workspace/agents/agent-engine-dev/`.
- Why blocked (if any): none
- Next step: Pick up task 1 (Scan Solution Description for unimplemented features, ID: c74d6a8d). Move to in_progress and begin.

### What Changed Since Last Update
- 2026-03-18 04:11–17:00 UTC: API unreachable for ~12h 47m. No board actions taken.
- 2026-03-18 ~17:00 UTC: API recovered. `/healthz` → ok. 12 tasks found in inbox.

### Decisions / Assumptions
- Board rule: `require_approval_for_done: true` — all task closures require approval.
- Max agents: 1 (Axle only for now; specialists created when needed).

### Evidence (short)
- `GET /healthz` → `{"ok":true}`
- `GET /tasks` → `total: 12`, all `inbox`

### Request Now
- None yet — beginning task sequencing.

### Success Criteria
- Tasks picked up, executed, and closed with approval.

### Stop Condition
- Koen declares board paused or project complete.

### Task Inventory (2026-03-18)
| # | Title | ID |
|---|-------|----|
| 1 | Design standup template & enhance standup-seed.sh | 1bba406c |
| 2 | Write scripts/export-backlog.sh | fe8bc0fd |
| 3 | Review run architecture: user, file ownership, permissions | 50167212 |
| 4 | Scan Solution Description for unimplemented features | c74d6a8d |
| 5 | Refactor script/ to scripts/ | 566a0820 |
| 6 | Remove Docker dev environment support | 7ea92164 |
| 7 | Update Architecture doc from Solution Description | c9cb8515 |
| 8 | Review and improve Solution Description | 3b0f08f6 |
| 9 | Write idea/openclaw/README.md — installation guide | c483dd52 |
| 10 | Write idea/scripts/setup.sh — provision App Disk | 71096c06 |
| 11 | Restructure app-openclaw repo (compose.yaml + init_data.tar.gz) | 812f372b |
| 12 | Test permanently attached USB SSD as system disk | 2fc2631b |


## Operational Model

**Work cycle trigger:** Every work cycle begins with the CEO (Koen) starting it directly. Nothing moves autonomously without a CEO message.

**Standard cycle:**
1. CEO messages an agent with a task instruction
2. Agent shows plan (plan mode always on) → CEO approves or amends
3. Agent executes → produces: PR / design doc / proposal / report
4. Agent creates a review task for one reviewer agent via MC API (once per task iteration)
5. Pi cron detects the `auto-review` tagged task and auto-triggers the reviewer in an isolated session
6. Reviewer reads the artifact, writes a response, marks task done
7. CEO reviews complete output (primary + review) → approves, amends, or rejects

**Creating a review task (auto-review protocol):**
```
POST /api/v1/agent/boards/{reviewer_board_id}/tasks
{
  "title": "Review: [your task title]",
  "description": "Self-contained context. Review question. ⚠ Depth-1 auto-review: do not create further tasks.",
  "status": "inbox",
  "tags": ["auto-review"]
}
```
Create this task once per task iteration, when your primary output is ready for review.
Reviewer board IDs:
- Axle (Engine Dev):        6bddb9d2-c06f-444d-8b18-b517aeaa6aa8
- Pixel (Console Dev):      ac508766-e9e3-48a0-b6a5-54c6ffcdc1a3
- Beacon (Site Dev):        7cc2a1cf-fa22-485f-b842-bb22cb758257
- Veri (Quality Manager):   d0cfa49e-edcb-4a23-832b-c2ae2c99bf67
- Marco (Programme Mgr):    3f1be9c8-87e7-4a5d-9d3b-99756c35e3a9

**Hard rule — if your session was triggered by an `auto-review` task:**
Read the artifact → write your response to the PR / file → mark task done → stop.
Do NOT create any tasks during this session. No exceptions.

**Heartbeat:** External event polling only (e.g. CI failures, grant deadlines, stale PRs). Not for status reporting. Only activated when a specific external event warrants it.

**Standup:** Optional, CEO-triggered via `/standup` command. Not a daily cron. Run at CEO's discretion — weekly at most.

**Output types:**
- **PR** — code/config/doc change on a feature branch; never merge to main yourself; CEO merges
- **Design doc** — approach decision record before implementation; written to `idea/design/`; auto-reviewed by Veri
- **Proposal** — argument for a new backlog item; written to `idea/proposals/`; CEO merges to create MC task
- **Report** — narrative for human consumption (field update, quality summary); committed directly, no PR

## Durable decisions
- 2026-03-01: jq installed via GitHub direct download (arm64) — apt-get unable to locate package in this environment.
- 2026-03-02: `/api/v1/agent/boards` returns `{items:[...], total, ...}` — not a raw array. Use `.items[].id` not `.[].id`.
- 2026-03-01 22:36 UTC: Bootstrap fully completed. API live at `http://172.18.0.1:8000`. Agent online. Board empty. Heartbeat cadence: 10m.
- 2026-03-20: **Directive from Koen — one task at a time.** All agents must complete their current task before picking up a new one. Broadcast sent to all agents via group memory.
- 2026-03-20: IDEA Engine repo confirmed at `/home/node/workspace/agents/agent-engine-dev/`.
- 2026-03-20: Cross-agent sessions_send is restricted (requires `tools.sessions.visibility=all`). Use group-memory with chat+broadcast tags for cross-board agent communication.

## Agent Roster
| Name | Role | Agent ID | Board ID |
|------|------|----------|----------|
| Axle | Engine Developer (Lead) | 8a0b3f32-8ebd-4b9b-93ff-1aad53269be3 | 6bddb9d2-c06f-444d-8b18-b517aeaa6aa8 |
| Marco | Programme Manager | c1aeb3f8-a258-448f-afcb-f518bdc47bca | 3f1be9c8-87e7-4a5d-9d3b-99756c35e3a9 |
| Beacon | Site Developer | 70404eba-4e1c-4d2d-bcb5-f34bfd32ad7b | 7cc2a1cf-fa22-485f-b842-bb22cb758257 |
| Pixel | Console UI Developer | bd2b264f-4727-4799-8522-66114cc59a1c | ac508766-e9e3-48a0-b6a5-54c6ffcdc1a3 |
| Veri | Quality Manager | ac172302-3c45-4a51-bdb3-dc233a0f65e8 | d0cfa49e-edcb-4a23-832b-c2ae2c99bf67 |

## Reusable playbooks
- Install jq on arm64 without sudo: `curl -fsL "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-arm64" -o /usr/local/bin/jq && chmod +x /usr/local/bin/jq`

## Telegram Channel

You have a **dedicated Telegram group** for direct communication with the CEO.

- **Bot:** @Idea911Bot
- **CEO Telegram ID:** `8320646468`
- **Your group:** IDEA - Axle · **Chat ID:** `-5146184666`
- **How it works:** The OpenClaw gateway binds your group to this agent exclusively via a `peer` filter in `openclaw.json`. Messages in your group go only to you; other agents have their own separate groups.
