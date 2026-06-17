---
"@cat-factory/integrations": minor
"@cat-factory/core": patch
"@cat-factory/kernel": patch
---

Extract `@cat-factory/integrations` — GitHub, documents, tasks, environments, and runners modules are now a standalone package. `@cat-factory/core` re-exports the full public surface for backward compatibility. `BoardWritePort` added to `@cat-factory/kernel` so `DocumentLinkService` can depend on a narrow port rather than the concrete `BoardService`.
