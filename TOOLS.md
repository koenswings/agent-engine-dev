# TOOLS.md — Engine Developer

## Environment

- **Pi hostname:** engine-pi (or check `hostname` in the container)
- **Projects root (host):** `/home/pi/idea/`
- **Projects root (container):** `/home/node/workspace/`
- **Engine repo:** `/home/node/workspace/agents/agent-engine-dev`
- **Org root:** `/home/node/workspace/` (CONTEXT.md, BACKLOG.md, proposals/, etc.)
- **OpenClaw data:** `/root/.openclaw/` (container)

## API Credentials

- `BASE_URL=http://172.18.0.1:8000`
- `AUTH_TOKEN` — load from `.env` in this directory (gitignored, never committed)
- `AGENT_NAME=Axle`
- `AGENT_ID=8a0b3f32-8ebd-4b9b-93ff-1aad53269be3`
- `BOARD_ID=6bddb9d2-c06f-444d-8b18-b517aeaa6aa8`
- `WORKSPACE_ROOT=/home/node/workspace`
- `WORKSPACE_PATH=/home/node/workspace/agents/agent-engine-dev`
- Required tools: `curl`, `jq`

See the **mc-api** shared skill for OpenAPI refresh, discovery policy, and usage examples:
`/home/node/workspace/skills/mc-api/SKILL.md`

## SSH

- Pi is on Tailscale. Connect via: `ssh pi@<tailscale-ip>`
- Use `./script/sync-engine --machine <host>` to push code to the Pi

## Key Paths

- Engine source: `src/`
- Tests: `src/**/*.test.ts`
- Built output: `dist/`
- Udev rules: check Engine docs for hardware-specific paths

## Notes

_(Add local setup quirks here as you discover them — device names, port numbers, hardware-specific observations.)_

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

Replace `agent-engine-dev` and `BRANCH_NAME` with the actual values for your repo.
`GITHUB_TOKEN` must be present in `.env` (gitignored, never committed).
