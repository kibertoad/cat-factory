---
'@cat-factory/node-server': patch
---

feat(node): pg-boss-backed async GitHub ingest (audit item 5)

The Node facade ran GitHub backfills, webhook deliveries and repo resyncs **inline in the
HTTP request handler** — the `githubBackfill` / `githubWebhook` gateway seams returned
`false`, so a large initial backfill or a webhook burst blocked the request and risked
timeouts / dropped deliveries, while the Worker enqueued the same work. Adds pg-boss-backed
implementations of both seams (`PgBossGitHubBackfillScheduler` / `PgBossGitHubWebhookIngest`)
that enqueue onto a new `github.sync` queue so the request acks fast (GitHub gets its prompt
2xx), plus `startGitHubSyncWorker` — the analogue of the Worker's `GITHUB_SYNC_QUEUE` consumer
and `GitHubBackfillWorkflow` — which drains the queue and applies each job via the SAME
`GitHubSyncService` / `WebhookService` the inline path used (idempotent, retried with backoff).
A container built with no boss (a pure-logic test) keeps the inline fallback. Closes the
"Async GitHub ingest still falls back to the inline paths" caveat in CLAUDE.md.
