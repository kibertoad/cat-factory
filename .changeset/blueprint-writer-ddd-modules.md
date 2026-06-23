---
'@cat-factory/server': patch
'@cat-factory/worker': patch
---

Blueprinter: decompose repos into DDD domain modules, not technical layers.

The Blueprinter (and the manual board-scan scanner) system prompt now applies
Domain-Driven Design vocabulary: every module must be a **business domain** (a
bounded context / aggregate / subdomain) named after a business concept, not a
technical layer. Technical shapes like `api`, `routes`, `controllers`, `utils`,
`config`, `types` and `db` are explicitly NOT domains, and the genuinely
non-business, cross-cutting plumbing is collapsed into a single `infrastructure`
module instead of being scattered across many technical modules.
