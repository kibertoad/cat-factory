---
'@cat-factory/sdk': patch
---

Keep the SDK `User-Agent` version constants in step with their manifests on release.

`@cat-factory/sdk` is an ordinary workspace package, so changesets bumps
`sdk/typescript/package.json` when it builds the release PR — but nothing updated the two constants
derived from that number (the TypeScript transport's `SDK_VERSION`, and Go's `Version`, which
tracks the TypeScript manifest because a Go module carries no version of its own). Every release PR
would have been born red on the version-skew half of `check:sdk`.

`scripts/sync-sdk-versions.mjs` now runs from the root `version` script, the twin of
`sync-runner-image-tags.mjs`, with the manifest/constant table shared with the guard so the writer
and the checker cannot drift.
