---
---

chore: typecheck test files too. The per-package `typecheck` scripts now cover each package's `test/` directory (split a typecheck-only tsconfig from the src-only build config where needed: runtimes' `tsconfig.json` drops `rootDir` while `tsconfig.build.json` keeps it; the harness packages get a `tsconfig.typecheck.json`; the Worker typechecks `tsconfig.json` instead of the build config). Fixes the test-fixture type drift this surfaced across packages, refreshes the conformance onboarding probe types, and updates the Worker test env typing for vitest-pool-workers v4. Test/tooling only — no published runtime behaviour changes.
