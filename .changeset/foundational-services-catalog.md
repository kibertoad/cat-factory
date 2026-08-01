---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/caching': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': patch
---

Add foundational services: a tiered (account ⊕ workspace) catalog of the shared capabilities an
organisation already runs — file storage, notifications, audit — each with a description and its
API contracts (OpenAPI 3.x, `@toad-contracts/core` or `@lokalise/api-contract`), supplied either by
direct upload or by linking files/folders in a git repo that is cached and auto-refreshed on both
runtimes.

The Architect is folded the catalog (identity, capability tags and indexed operation names — never a
document body) and must declare the service ids its design consumes; the Researcher and Coder are
then handed the full API contracts of exactly those services, plus an explicit statement of anything
the design named that the catalog does not contain.

Also adds `fencedBlock`/`fenceFor` to `@cat-factory/kernel` — the canonical, self-sizing markdown
fence that a contract document (or any other body we hand an agent verbatim) cannot break out of.
The executor harness's `fencedOutput` becomes a pinned copy of it, in the same arrangement its
`host-markdown` copy already has.
