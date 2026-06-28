---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Add a document-authoring pipeline and a richer document task definition.

A new forward-authoring track produces an in-repo Markdown document (PRD / RFC / design
doc / ADR / technical reference / runbook / research report) shipped as a pull request —
distinct from the reverse-documentation kinds (`documenter` / `business-documenter` /
`blueprints`) that describe existing code. Four new agent kinds are registered through the
public `registerAgentKind` seam — `doc-researcher` and `doc-outliner` (inline), `doc-writer`
(container-coding, opens the PR coder-style) and `doc-finalizer` (container-coding, polishes
on the PR branch) — plus a `doc-reviewer` companion that loops the writer back for rework.

Two built-in pipelines are seeded: `pl_document` (research → outline [human gate] → write →
AI review loop [human gate] → finalize → conflicts → ci → merger) and `pl_document_quick`.

The `document` task type gains a wider `docKind` set (`prd`/`rfc`/`adr`/`design`/`technical`/
`api`/`runbook`/`research`/`reference`/`other`) and optional `audience`, `targetPath` and
`outlineHints` fields, threaded into the agent context so the document agents specialise their
prompts. No new persisted tables — the committed Markdown is the durable artifact.
