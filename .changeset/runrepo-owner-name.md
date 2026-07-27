---
'@cat-factory/kernel': patch
'@cat-factory/server': patch
---

Surface the resolved repo's `owner`/`name` on `RunRepoContext`. The run-repo seam already resolves a block's repo per-frame (on both the deployer and env-self-test paths) but only exposed `repoId` (an opaque provider id), `baseBranch`, and `provider` — it dropped the GitHub `owner`/`name` it had in hand. Code environment adapters need the repo identity to resolve a per-SERVICE target (e.g. a Kargo project, whose name IS the repo name) instead of a single static default. `RunRepoContext` now carries optional `owner`/`name` (populated by both real resolvers from the resolved `RepoTarget` / coords; optional for back-compat with older callers and test fakes).
