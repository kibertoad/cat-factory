---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Link Confluence/Notion/GitHub documents as **living** best-practice fragments.

A team can now link an external document (a Confluence page, a Notion page, or a
GitHub file — any connected Document source) as a prompt-fragment whose guidance is
**re-resolved from the source at the moment an agent run uses it**, rather than a
one-time snapshot. Edit the upstream doc and the next agent run follows the new
version — no re-import. The body is cached on the fragment as a last-resolved
snapshot and refreshed on a short TTL (default 5 min); if the source is unreachable
the run falls back to the cached body, so resolution never blocks a run. Available
at both the account and workspace tiers; an account-tier link fetches through a
chosen workspace's connection.

New surface: `POST /:scope/document-fragments` (link a document as a fragment) and
`POST /:scope/prompt-fragments/:id/refresh` (force an immediate re-resolve), a
"Documents" tab in the fragment-library manager with a "Live · <source>" badge, and
a `documentRef`/`resolvedAt` provenance block on `PromptFragment`.

As part of this, run-time fragment-id resolution now goes through the merged tenant
catalog (built-in ∪ account ∪ workspace) instead of only the built-in static pool,
so **managed (DB-authored) fragments also reach a run** — previously only built-in
ids resolved at run time. Behaviour is unchanged when the prompt-fragment library is
not configured.

Persistence: `prompt_fragments` gains `doc_source` / `doc_external_id` /
`resolved_at` columns on both runtimes (a D1 migration and a Drizzle migration);
stale pre-existing rows simply carry nulls.
