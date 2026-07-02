---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Performance: batch reads, parallelize independent awaits, and push work into SQL on hot paths.

- `GET /workspaces/:id` (the board-load endpoint) now fetches its ~15 independent snapshot
  ingredients concurrently instead of serially, so its latency is the slowest read rather
  than the sum of every round-trip; the create-workspace route parallelizes its spend +
  infra-setup reads the same way.
- Agent-context reference lookups (Jira keys / GitHub refs / URLs) run concurrently on the
  per-step dispatch path; run-start model-default resolutions run concurrently per agent kind.
- New batched port methods, mirrored on both runtimes with conformance coverage:
  `BlockRepository.findByIds` (cross-workspace dependency resolution — one chunked query
  instead of a point-read per id, also allow-listed for mothership mode),
  `NotificationRepository.escalateStaleOpen` (the escalation sweep is now one
  `UPDATE … RETURNING` statement instead of a load-filter-upsert loop), and
  `GitHubInstallationRepository.listByInstallationIds` (connect-UI annotation).
- GitHub webhook fan-out resolves linked workspaces via the existing batched
  `linkedWorkspaces` read instead of a per-workspace point-read on every delivery.
- The Node Drizzle GitHub projections write chunked multi-row upserts (matching the D1
  twins' `db.batch`) instead of one round-trip per row, and their list reads run
  `ORDER BY`/`LIMIT` in SQL (NULLS LAST for D1 parity) instead of sorting full result
  sets in JS.
- `autoStartDependents` hoists the invariant workspace-pipeline read out of its loop and
  stops re-fetching blocks it already holds.
- Session/WS-ticket/machine-token verification reuses a memoized `HmacSigner` per secret,
  so `crypto.subtle.importKey` no longer runs on every request (`signerFor` export).
- The Cloudflare Workflows drivers (execution / bootstrap / env-config-repair) build the
  DI container once per wake instead of once per `step.do` poll tick.
