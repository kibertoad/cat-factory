---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Finish the foundational-services catalog: it now has a management surface, a way for a board to opt
out of an inherited service, and push-driven freshness.

The SPA gains an account-settings tab and an advanced-tier board panel: register a service with its
uploaded API contracts, link a repo of service definitions (a folder of them, or an explicit file
list for one named service), and — on a board — review the merged catalog an Architect is actually
handed, expanding a contract document through the same lazy read a consumer dispatch makes. Opening
the catalog still transfers no document body.

A board opts out of an inherited account service through a new suppression sub-resource
(`POST`/`DELETE /workspaces/:ws/foundational-services/:id/suppression`, plus a
`GET /workspaces/:ws/foundational-service-suppressions` list read). It is
deliberately not a delete: deleting removes the board's own registration and its documents, where a
suppression destroys nothing and is reversible. Suppressing an id the catalog does not carry, or one
the board registered itself, is refused rather than silently written.

Repo sources now also refresh on a GitHub push webhook, alongside the periodic sweep — the same
fan-out the skill library uses, cutting worst-case staleness from the sweep window to seconds. That
matters more here than for skills: a stale API contract is handed to a coder as the interface to
write against.

Breaking: adds a `hardDelete` method to `FoundationalServiceRepository` and a `listByRepo` to
`FoundationalServiceSourceRepository`, so an out-of-tree implementation of either port must
implement them; `GitHubWebhookIngest` likewise gains `queueFoundationalResync`.
