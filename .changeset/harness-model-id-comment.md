---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Drop the version-pinned model ids from the harness's `model` doc comment. It read
`e.g. claude-opus-4-8 / gpt-5.5-codex` — and `gpt-5.5-codex` was never a valid Codex slug,
so the example pointed at a model that cannot run. A pinned example rots on every vendor
release for no benefit: the field's contract is "the vendor's own id, not a catalog id",
which the comment now states directly instead of illustrating.

Comment-only, but it lands under `executor-harness/src`, so the image tag is bumped
(1.86.0 → 1.86.1) with the three pins synced. **Publishing still requires
`pnpm image:publish` + `pnpm deploy` from `deploy/backend`** — reusing a tag does not roll
out, which is the whole reason the tag moves.
