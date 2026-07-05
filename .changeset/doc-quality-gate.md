---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/gates': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

feat(documents): add the `doc-quality` gate (WS4) to the forward document pipelines

A new deterministic polling gate `doc-quality`, authored through the public `registerGate`
seam in `@cat-factory/gates`, is inserted into `pl_document` (after `doc-finalizer`) and
`pl_document_quick` (after `doc-reviewer`). It reads the drafted document on the PR head
checkout-free via a new `DocQualityProvider` (wired per facade over `RepoFiles`) and checks
— against the WS1 template (`docTemplateFor`, the single source of truth) — that every
required section is present, no leftover placeholders remain, the heading hierarchy is sane,
and in-repo relative links resolve. On a red verdict it escalates to a new `doc-fixer`
container helper that repairs the document on the PR branch; a green document advances with
nothing spun up. Both doc pipelines' `version` is bumped (reseed offer).
