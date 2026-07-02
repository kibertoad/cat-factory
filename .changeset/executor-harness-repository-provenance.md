---
'@cat-factory/executor-harness': patch
---

Fix npm publish: add the `repository` field required by sigstore provenance

The first publish of `@cat-factory/executor-harness` as a public package failed
with `E422 … Error verifying sigstore provenance bundle: package.json:
"repository.url" is ""`. Provenance verification requires the package's
`repository.url` to match the source repo, and the manifest carried no
`repository` field at all. Add it (pointing at `backend/internal/executor-harness`,
like every other published package) plus the mandatory `prepublishOnly` build
guard so no publish path can ship an empty `dist/`.
