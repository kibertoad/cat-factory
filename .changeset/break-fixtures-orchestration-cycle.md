---
"@cat-factory/orchestration": patch
"@cat-factory/sandbox-fixtures": patch
---

Break the `orchestration → sandbox → sandbox-fixtures → orchestration` package
dependency cycle so the workspace graph is acyclic. The cycle was closed by a
single type-only conformance test in `sandbox-fixtures` that imported
`@cat-factory/orchestration` (a `devDependency`). That test now lives in
`orchestration` (which owns the requirements/clarity logic types and already sees
the fixtures), leaving `sandbox-fixtures` a pure leaf data package. No runtime
behaviour changes; this only removes a dev-time cycle that blocked a per-package
build task graph.
