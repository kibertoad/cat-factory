---
'@cat-factory/executor-harness': patch
---

Repo housekeeping: separate published libraries from private packages by moving
the harnesses out of `backend/packages/` into a new `backend/internal/`
directory — `@cat-factory/executor-harness` and `@cat-factory/benchmark-harness`.
Updates the pnpm workspace globs, the CI path-filters + Docker build context, the
acceptance-test worker-src alias, and the package tables in the
README/CONTRIBUTING/CLAUDE docs. No source, public API, or image contents change
(the patch bump just keeps the GHCR image tag in lockstep with the relocated
package).
