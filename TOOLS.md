# TOOLS.md — Axle, Engine Developer

## API Credentials

- `BASE_URL=http://mission-control-backend:8000`
- `AUTH_TOKEN` — load from `.env` in this directory (gitignored, never committed)
- `AGENT_NAME=Axle`
- `AGENT_ID=8a0b3f32-8ebd-4b9b-93ff-1aad53269be3`
- `BOARD_ID=6bddb9d2-c06f-444d-8b18-b517aeaa6aa8`
- `WORKSPACE_ROOT=/home/node/workspace`
- `WORKSPACE_PATH=/home/node/workspace/agents/agent-engine-dev`
- Required tools: `curl`, `jq`

See the **mc-api** shared skill for OpenAPI refresh, discovery policy, and usage examples:
`/home/node/workspace/skills/mc-api/SKILL.md`

## Environment

- **Runtime:** OpenClaw runs **natively on the Pi as user `pi`** — no Docker container. You are running directly on the hardware.
- **Pi hostname:** `wizardly-hugle` (Linux), `openclaw-pi` (Tailscale)
- **Projects root:** `/home/pi/idea/` (same as `/home/node/workspace/` via symlink)
- **Engine repo:** `/home/node/workspace/agents/agent-engine-dev`
- **Org root:** `/home/node/workspace/` (CONTEXT.md, BACKLOG.md, proposals/, etc.)
- **OpenClaw data:** `/home/pi/.openclaw/`

## SSH

- **You are already on the Pi.** No SSH needed for normal dev work.
- **Test fleet** (idea01–idea04, LAN-only): `ssh pi@<fleet-ip>`
- **External access** (Tailscale): `ssh pi@openclaw-pi.tail2d60.ts.net`
- Use `./script/sync-engine --machine <host>` to push code to test fleet Pis

## Native Runtime — What Changed

OpenClaw was migrated from Docker to native systemd on 2026-04-06. Key implications:

- **Direct hardware access** — `/dev/` devices (USB, I2C, etc.) are accessible without Docker `--device` flags. `pnpm test` can run udev/hardware tests locally on the Pi.
- **No container UID mismatch** — files created by the agent are owned by `pi`. No more root-owned workspace files.
- **Restart OpenClaw:** `systemctl --user restart openclaw-gateway` (or via the `gateway` tool)
- **Test fleet Pis** (idea01–idea04) are separate LAN machines; still access via SSH.

## Key Paths

- Engine source: `src/`
- Tests: `src/**/*.test.ts`
- Built output: `dist/`

## GitHub Push & PR

`gh` is not available in the sandbox. Use `git` + `curl` with `GITHUB_TOKEN` from `.env`.

### Push a branch
```bash
source .env
git remote set-url origin https://koenswings:${GITHUB_TOKEN}@github.com/koenswings/agent-engine-dev.git
git push origin BRANCH_NAME
git remote set-url origin https://github.com/koenswings/agent-engine-dev.git
```

### Open a PR
```bash
source .env
curl -s -X POST "https://api.github.com/repos/koenswings/agent-engine-dev/pulls" \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"PR TITLE\",
    \"head\": \"BRANCH_NAME\",
    \"base\": \"main\",
    \"body\": \"PR description\"
  }" | python3 -c "import sys,json; print(json.load(sys.stdin).get('html_url','error'))"
```

`GITHUB_TOKEN` must be present in `.env` (gitignored, never committed).
