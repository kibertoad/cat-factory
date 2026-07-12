---
'@cat-factory/integrations': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
'@cat-factory/server': patch
---

feat(errors): UI-first remedies for runner-backend / runner-pool / Datadog failures (D2/D3/D4)

Continues the error-message-coverage initiative through Section D — runtime provider failures now
name their fix (the UI location first) and link the relevant docs, instead of surfacing a terse,
opaque condition.

- **D3 — `No runner backend available for workspace 'X'`** (both the Node and Cloudflare transport
  resolvers) now throws a `ConflictError` carrying the machine `reason` `agent_backend_unconfigured`
  instead of a plain `Error`. Synchronously it is a clean 409; on the async dispatch path
  `classifyDispatchFailure` lifts the reason onto the run's `AgentFailure`, so the SPA renders the
  existing "Agent backend not configured" title + jump (no new locale keys) rather than the
  misleading "container failed to start". The remedy names the UI path first (Settings → Self-hosted
  runner pool) and links `backend/docs/runner-pool-integration.md` via the new `DOCS.runnerPool`
  entry. The load-bearing `No runner backend available for workspace '<id>'` prefix is preserved.
- **D2 — runner-pool provider errors** (`RunnerPoolApiError`: a scheduler non-2xx, a missing
  manifest secret, an OAuth-token rejection) now append a shared UI-first remedy naming where the
  pool is registered / re-tested, while preserving the raw `<method> → <status>` / `Missing secret`
  detail ahead of it (still greppable + still matched by the transport's DispatchError re-wrap).
- **D4 — Datadog auth failure**: a `401`/`403` from the Datadog API now appends a UI-first remedy
  pointing at Integrations → Observability connection (the keys are UI-configured — no env var for
  this connection), preserving the raw `HTTP <status>` diagnostic. A non-auth status (5xx / mapping
  error) is unchanged.

`@cat-factory/integrations` keeps its own `docs.ts` (repo-doc + vendor-URL helpers) since it sits
below the server layer and cannot import `@cat-factory/server`'s `config/docs.ts`.
