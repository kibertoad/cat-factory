---
'@cat-factory/node-server': patch
---

Lint ratchet: `max-lines-per-function` step 1 (2453 → 1000; no behavioural change).

- **Test/product size split:** table-driven test suites (the cross-runtime conformance builders
  - Vitest specs) are carved into an `.oxlintrc.json` `overrides` entry held to their own ratchet
    at 2453 (globs `**/*.test.ts`, `**/*.spec.ts`, `internal/conformance/src/**`,
    `internal/e2e/**`), so the global (product) ceiling tightens without forcing product-code
    function limits onto the legitimately-large describe/it blocks.
- **Node DI god-builder split:** `buildNodeContainer` (the lone product function above 1000, at
  1616 lines) is split into seven cohesive sibling `container-*-deps.ts` helpers following the
  existing `container-executor-deps.ts` pattern — `container-github-deps.ts` (`selectNodeGitHubDeps`,
  mirroring the Worker's `selectGitHubDeps`), `container-model-deps.ts`,
  `container-run-services-deps.ts`, `container-transport-deps.ts`, `container-account-deps.ts`, and
  `container-realtime-deps.ts` — bringing the composition root to 991 lines. Behaviour-neutral
  (verified against the Node + local cross-runtime conformance suites on real Postgres).
