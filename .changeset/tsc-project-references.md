---
---

Build tooling: compile the backend libraries as a TypeScript project-reference
graph and run both `build` and `typecheck` through `tsgo`
(the `@typescript/native-preview` compiler) — `tsgo -b` at the root and per
package — so unchanged packages are cached (`.tsbuildinfo`) instead of recompiled
on every build. The libraries' `typescript` devDependency is dropped (tsgo is the
only compiler they use; the internal harnesses and `deploy/*` keep `tsc`). Also
de-duplicates the root `test`/`test:run` scripts. No shipped package code changes
(published tarballs still contain only `dist`).
