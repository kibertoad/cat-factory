---
'@cat-factory/app': patch
'@cat-factory/executor-harness': minor
'@cat-factory/node-server': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
---

Bump both runner images and take the dependency majors that are actually safe.

**Runner images** (`@cat-factory/executor-harness` 1.85.0, `@cat-factory/deploy-harness` 0.2.9, with the three pinned tags synced):

- Executor: Pi `0.82.1 → 0.83.0`, Codex `0.145.0 → 0.146.0`, and the two lockstep Pi extensions `rpiv-todo`/`rpiv-web-tools` `2.1.0 → 2.3.1`. Claude Code stays at `2.1.220` — already the latest.
- Deploy: `kubectl v1.36.2 → v1.36.3`, `helm v4.2.2 → v4.2.3` (`kustomize v5.8.1` is already the latest). `backend/docs/local-kubernetes-setup-windows.md` mirrors these pins and moves with them.
- Both: the `node:26-trixie-slim` base re-pinned to the current multi-arch index digest, plus the in-range `@types/node`/`hono` refresh the harnesses sat out of the previous sweep. With the executor harness now bumped, `hono` moves to `^4.12.33` across the whole workspace rather than being held back by the single-version constraint.

**Dependency majors** — taken: `markdown-it@14 → 15` (it now ships its own types, so `@types/markdown-it` is dropped; the instance type is a separate export from the constructor, which is the one call site that changed) and `ioredis@5 → 6` (the optional multi-node Redis propagator + cache-invalidation bus).

Not taken: `typescript@6 → 7` for the frontend, because `vue-tsc` still loads `typescript/lib/tsc`, which the TS 7 Go port no longer exports — the frontend stays on 6 until vue-tsc supports it.
