---
'@cat-factory/executor-harness': patch
'@cat-factory/worker': minor
---

Finish the `implementer` → `executor` rename so the package, directory, and
Durable Object class match the already-published `cat-factory-executor` image.

- `@cat-factory/implementer-harness` → `@cat-factory/executor-harness`
  (`backend/internal/implementer-harness` → `backend/internal/executor-harness`).
- The per-run container Durable Object `ImplementationContainer` →
  `ExecutionContainer`, bound as `EXEC_CONTAINER` (was `IMPL_CONTAINER`). A
  `renamed_classes` migration (`tag = "v3"`) carries the class rename.

**Deployment action required:** in your `wrangler.toml`, rename the
`[[durable_objects.bindings]]` `name`/`class_name` to `EXEC_CONTAINER` /
`ExecutionContainer`, update the `[[containers]]` `class_name`, and add the
`v3` `renamed_classes` migration (see `deploy/backend/wrangler.toml`).
