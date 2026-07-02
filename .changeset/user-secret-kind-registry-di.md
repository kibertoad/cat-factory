---
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

refactor(integrations): app-own the user-secret-kind registry (registry DI migration)

Migrates the per-user secret KIND registry off its module-global `Map` onto an app-owned
instance, the next slice of the registry-DI initiative (see
`docs/initiatives/registry-di-migration.md`). The composition root now owns the registry and
injects it, so a deployment-registered custom kind is seen by reference regardless of module
identity — the same footgun-free pattern as the environment/runner backend registries.

- New `UserSecretKindRegistry` class (`register`/`get`/`list`) + `defaultUserSecretKindRegistry()`
  pre-loaded with the built-in `github_pat` kind, added to `BackendRegistries` /
  `createBackendRegistries()`. `UserSecretService` reads the injected registry.
- **Breaking:** the free `registerUserSecretKind` / `getUserSecretKind` / `listUserSecretKinds`
  exports are removed (pre-1.0, no back-compat). The built-in kind is now the exported
  `githubPatUserSecretKind` handler, registered into the default registry.
- Wired symmetrically into the Worker + Node facades (local inherits via `buildNodeContainer`);
  the cross-runtime conformance suite asserts a programmatically-registered custom kind is
  described identically on every runtime.
