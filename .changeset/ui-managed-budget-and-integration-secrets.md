---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/spend': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Move operator/integration config out of environment variables into encrypted, UI-editable
DB settings. DB is now the source of truth — the moved env vars are **removed** (no
fallback), so the listed vars below no longer have any effect.

**Per-workspace budget (Workspace settings → Budget).** A workspace's spend currency,
monthly limit, and per-model price overrides now live on the `workspace_settings` row.
The spend safeguard resolves each workspace's effective pricing (base table + overrides)
behind a short-TTL cache, scoping the budget gate to the workspace's own usage
(`SpendService.status`/`isOverBudget` now take a `workspaceId`; new
`TokenUsageRepository.totalsSinceForWorkspace`). **Behaviour change:** spend is metered +
gated per workspace, not deployment-wide; a workspace with no budget inherits the built-in
default (~100 EUR/month). Removes env: `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`,
`SPEND_MODEL_PRICES`. A budget of `0` is intentional ("no PAID spend"): metered runs are
refused **up front** at start/retry with a clear `409` (not just a silent mid-run pause),
while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS (flat-rate quota) keep
running since they incur no metered cost — so `0` is the "local-/subscription-only" setting.
The over-budget exemption (previously subscription-only) now also covers local-runner steps,
inline and container alike. The hot-path per-workspace rollup is indexed
(`idx_token_usage_workspace` on `(workspace_id, created_at)`, both runtimes).

**Per-workspace incident enrichment (service inspector → Post-release health).** PagerDuty

- incident.io credentials are sealed in a new per-workspace `incident_enrichment_connections`
  table (one grouped blob) and resolved/decrypted at enrichment time by a new
  `WorkspaceIncidentEnrichmentProvider`. Removes env: `PAGERDUTY_API_TOKEN`,
  `PAGERDUTY_FROM_EMAIL`, `INCIDENTIO_API_KEY`. The write API is three-state per provider
  group (omit ⇒ keep, `null` ⇒ clear, value ⇒ set) so one vendor can be removed without
  wiping the other.

**Per-account integration secrets (Account settings → Deployment integrations, admin only).**
The Slack app OAuth credentials and the container web-search upstream keys (Brave /
SearXNG) now live in a new per-account `account_settings` table (one sealed secrets blob,
HKDF tag `cat-factory:account-settings`), behind an admin-gated
`GET|PUT /accounts/:id/settings`. Resolved dynamically: Slack OAuth at connect time, the
web-search upstream per run (off the container session's account id). The executor now
advertises the container `web_search` tool to a run **only when its account actually has
keys** (so an agent is never handed a tool that always fails); a run with no upstream gets
an empty result set rather than a hard `503`. Removes env:
`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `WEB_SEARCH_BRAVE_API_KEY`,
`WEB_SEARCH_SEARXNG_URL`, `WEB_SEARCH_SEARXNG_API_KEY` (the env-built upstream + its
`createWebSearchUpstreamFromEnv`/`gateways.webSearch` fallback are deleted, not just
unwired). (`SLACK_ENABLED` still gates Slack module assembly; the new tables/services
assemble whenever `ENCRYPTION_KEY` is set.)

**Hardening.** Re-sealing a partial settings/credentials write now **refuses** (clear `409`)
when the stored blob can't be decrypted (e.g. after an encryption-key change) instead of
silently dropping the un-edited secret group on the re-seal.

New tables mirror across both runtimes (D1 migrations 0012–0014 ⇄ Drizzle schema +
generated migration) with cross-runtime conformance assertions for the budget +
incident-enrichment round-trips. `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, and the GitHub
App/OAuth secrets stay in env (bootstrap/auth). Retention windows, inline-web-search
toggles, Langfuse keys, and execution timeouts intentionally remain env-configured.
