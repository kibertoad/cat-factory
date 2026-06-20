---
---

Build tooling: move the native-compiler packages from the
`@typescript/native-preview` nightly channel (`tsgo`) to the TypeScript 7 release
candidate, published as `typescript@7.0.1-rc` (whose `tsc` binary is the native
compiler). The `build`/`typecheck` scripts now invoke `tsc` instead of `tsgo`
across the backend libraries, both runtime facades, the conformance suite and the
Node deploy example; `tsc -b` keeps the same project-reference graph + `.tsbuildinfo`
caching. The RC tarball ships only the CLI (no JS API), so the frontend keeps the
JS `typescript@^6` that `vue-tsc` needs, and the internal harnesses + `deploy/backend`
keep their existing `tsc`. No shipped package code changes (published tarballs still
contain only `dist`).
