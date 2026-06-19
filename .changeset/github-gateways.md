---
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Make the GitHub controllers runtime-neutral and move them into `@cat-factory/server`.
The workspace-scoped GitHub controller and the public webhook/setup-callback
controller now delegate their out-of-band work to two new gateways —
`GitHubBackfillScheduler` (full-installation backfill) and `GitHubWebhookIngest`
(webhook + incremental repo resync) — and read the install-state HMAC secret from
config. `StateSigner` moves to the shared package. The Worker supplies
`WorkflowsBackfillScheduler` (Cloudflare Workflows) and `CfGitHubWebhookIngest`
(the sync Queue), each falling back to inline handling when its binding is absent.
Behaviour on the Worker is unchanged.
