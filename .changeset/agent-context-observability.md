---
"@cat-factory/kernel": minor
"@cat-factory/contracts": minor
"@cat-factory/orchestration": minor
"@cat-factory/server": minor
"@cat-factory/worker": minor
"@cat-factory/node-server": minor
"@cat-factory/app": minor
---

Capture the complete context provided to each container agent as observability, in an
isolated telemetry store.

- New `agent_context_snapshots` table records, per container-agent dispatch, the fully
  fragment-composed system + user prompts, the best-practice fragment bodies folded in,
  and the full content of the files injected into the container (`.cat-context/*`) — the
  gap the per-call LLM telemetry can't see (the agent reads those files via tools). The
  snapshot is a redacted allow-list projection of the dispatched job (never any token or
  credential-bearing URL). Recorded best-effort at dispatch by `ContainerAgentExecutor`
  via the new `AgentContextObservabilityService`, gated by the deployment prompt-recording
  switch (`LLM_RECORD_PROMPTS`) AND a new per-workspace `storeAgentContext` setting
  (on by default; a toggle in Workspace settings). Surfaced on demand via
  `GET /workspaces/:ws/executions/:executionId/agent-context` and a "Provided context"
  view in the observability panel.
- Telemetry now lives in an isolated store, separate from the transactional domain
  (append-heavy/high-volume/short-retention write profile). `llm_call_metrics` and the new
  `agent_context_snapshots` table both move there: a dedicated `telemetry` Postgres schema
  on Node (same connection) and a separate, **required** `TELEMETRY_DB` D1 database on
  Cloudflare. Both ride the existing `LLM_CALL_METRICS_RETENTION_DAYS` retention window.

BREAKING (pre-1.0, no migration provided): the Cloudflare Worker now requires a
`TELEMETRY_DB` D1 binding (provision with `wrangler d1 create cat_factory_telemetry` and
add the `[[d1_databases]]` entry pointing `migrations_dir` at
`telemetry-migrations`). `llm_call_metrics` is dropped from the main D1 / `public` schema;
existing rows are not migrated.
