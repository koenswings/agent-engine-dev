# TOOLS.md — Axle, Engine Developer

## API Credentials
- `BASE_URL=http://172.18.0.1:8000`
- `AUTH_TOKEN` — load from `.env` in this directory (gitignored, never committed)
- `AGENT_NAME=Axle`
- `AGENT_ID=8a0b3f32-8ebd-4b9b-93ff-1aad53269be3`
- `BOARD_ID=6bddb9d2-c06f-444d-8b18-b517aeaa6aa8`
- `WORKSPACE_ROOT=/home/node/workspace`
- `WORKSPACE_PATH=/home/node/workspace/agents/agent-engine-dev`
- Required tools: `curl`, `jq`

## OpenAPI refresh (run before API-heavy work)

```bash
mkdir -p api
curl -fsS "http://172.18.0.1:8000/openapi.json" -o api/openapi.json
jq -r '
  .paths | to_entries[] as $p
  | $p.value | to_entries[]
  | select((.value.tags // []) | index("agent-lead"))
  | "\(.key|ascii_upcase)\t\($p.key)\t\(.value.operationId // "-")\t\(.value["x-llm-intent"] // "-")\t\(.value["x-when-to-use"] // [] | join(" | "))\t\(.value["x-routing-policy"] // [] | join(" | "))"
' api/openapi.json | sort > api/agent-lead-operations.tsv
```

## API source of truth
- `api/openapi.json`
- `api/agent-lead-operations.tsv`
  - Columns: METHOD, PATH, OP_ID, X_LLM_INTENT, X_WHEN_TO_USE, X_ROUTING_POLICY

## API discovery policy
- Use operations tagged `agent-lead`.
- Prefer operations whose `x-llm-intent` and `x-when-to-use` match the current objective.
- Derive method/path/schema from `api/openapi.json` at runtime.
- Do not hardcode endpoint paths in markdown files.

## API safety
If no confident match exists for current intent, ask one clarifying question.
