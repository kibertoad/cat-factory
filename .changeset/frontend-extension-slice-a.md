---
---

Docs/dogfood/test-only (frontend-extension-mechanism slice A): a worked consumer extension
module in `deploy/frontend` (the `acme:security` module — nav entry, inspector panel, and a
bespoke `security-auditor` result window reusing the shared `ResultWindowShell`/`StepRunMeta`
building blocks), the `@cat-factory/app` consumer-authoring guide (`app/docs/consumer-extensions.md`),
and an e2e spec driving all three (`backend/internal/e2e/tests/consumer-extension.spec.ts`).
`deploy/frontend` and `@cat-factory/e2e` are changeset-ignored; the layer change is docs-only.
