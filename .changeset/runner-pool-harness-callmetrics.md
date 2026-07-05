---
'@cat-factory/integrations': patch
---

fix(runners): forward subscription-harness `callMetrics` through the runner-pool result mapper

The Node self-hosted runner-pool transport (`HttpRunnerPoolProvider.coerceRunnerResult`)
rebuilds a finished job's result from a fixed allow-list and never copied `callMetrics`, so
a Claude Code / Codex run dispatched to a pool recorded zero rows in `llm_call_metrics` — the
Cloudflare and local transports return the harness view verbatim and were unaffected. Coerce
and forward `callMetrics` (validating each entry) so pool-backed subscription runs are
observed identically, restoring runtime symmetry.
