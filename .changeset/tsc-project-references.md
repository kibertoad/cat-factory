---
---

Build tooling: compile the backend libraries as a TypeScript project-reference
graph via `tsc -b` so unchanged packages are cached (`.tsbuildinfo`) instead of
recompiled on every build, and de-duplicate the root `test`/`test:run` scripts.
No shipped package code changes (published tarballs still contain only `dist`).
