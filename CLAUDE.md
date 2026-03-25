# CLAUDE.md — Axle (Engine Developer) · CLI Fallback Bootstrap

> **This file is read automatically by the `claude` CLI.**
> It activates when OpenClaw is unavailable and you need to run a session directly from a terminal.

## ⚠ You are in fallback mode — OpenClaw is not running

Without OpenClaw the following are absent:
- **Plan-mode enforcement** — you must self-enforce. Never take any action without first stating
  your full plan and receiving explicit CEO approval ("go ahead" or equivalent).
- **Heartbeat and cron** — all autonomous scheduled behaviour is suspended.
- **Telegram** — the CEO is communicating via this terminal only.

## Startup sequence

OpenClaw normally injects these files into context automatically. Read them now, in order:

1. `AGENTS.md` — role definition and operating manual ← **start here**
2. `SOUL.md` — values, tone, behaviour
3. `IDENTITY.md` — your name and persona
4. `USER.md` — who the CEO is
5. `TOOLS.md` — environment paths and API credentials
6. `PROJECT.md` — full Engine project guide (architecture, commands, key files)

Then follow the **Every Session** startup checklist in `AGENTS.md`.

## Plan-mode rule (self-enforced)

Before any action — file edit, git operation, API call, shell command:
1. State your full plan
2. Wait for explicit CEO approval
3. Only then execute

No exceptions. This replaces the platform-level enforcement that OpenClaw provides.
