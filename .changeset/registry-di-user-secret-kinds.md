---
'@cat-factory/integrations': minor
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

refactor(registry-di): app-owned user-secret kind registry

Migrate the per-user secret KINDS registry off the module-global `Map` (populated by
import side-effect) to an app-owned instance threaded through the composition root — the
next slice of the registry-DI migration (`docs/initiatives/registry-di-migration.md`),
following the environment/runner-backend pilot.

- New `UserSecretKindRegistry` class + `defaultUserSecretKindRegistry()` factory
  (pre-loaded with the built-in `github_pat` kind) in `@cat-factory/integrations`;
  `github_pat` is now the exported `githubPatUserSecretKind` const, registered by the
  factory rather than at module load.
- `UserSecretService` takes the registry via its deps (optional, defaulting to a fresh
  built-in-only registry) instead of reading module-global free functions.
- `createBackendRegistries()` / `BackendRegistries` now also builds the
  `userSecretKindRegistry`; each facade (Worker, Node, local-inherits) threads it into
  `UserSecretService` so a deployment-registered kind is seen by reference, regardless of
  module identity.
- Cross-runtime conformance asserts the injected registry is consulted by reference (a
  customised `github_pat` handler wins on every runtime).

**Breaking (`@cat-factory/integrations`):** the free `registerUserSecretKind`,
`getUserSecretKind`, and `listUserSecretKinds` exports are removed. Register a kind by
reference on an app-owned registry (`registries.userSecretKindRegistry.register(...)`)
instead. Pre-1.0, no back-compat shim.
