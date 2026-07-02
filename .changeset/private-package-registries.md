---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Private package registries: workspace-scoped npm registry credentials (npm private
orgs + GitHub Packages) that agent containers use to resolve private dependencies on
checkout.

- **Storage**: one `package_registry_connections` row per workspace (D1 migration 0034
  ⇄ Drizzle mirror) holding a single sealed JSON array of entries
  (`{ id, ecosystem: 'npm', vendor: 'npmjs' | 'github-packages', scopes, token }`,
  cipher tag `cat-factory:package-registries`) plus a non-secret summary (vendor +
  scopes + token tail). Ecosystem-discriminated so pip/maven/cargo are later additive.
- **API**: `GET|POST /workspaces/:ws/package-registries`, `DELETE …/:entryId`
  (`PackageRegistriesController`, 503 when the module is unwired). Tokens are
  write-only — the list view never returns them; edit = delete + re-add.
- **Dispatch**: `ContainerAgentExecutor` + `ContainerRepoBootstrapper` accept a
  `resolvePackageRegistries` seam (wired in both facades from the same store) and
  forward the decrypted entries as a `packageRegistries` field on every container job
  body, like `ghToken`. The registry host is derived backend-side from the fixed
  vendor set. A resolution failure fails the dispatch rather than silently running
  without auth. The agent-context snapshot's allow-list projection excludes the field.
- **UI**: a "Private package registries" panel in the Integrations hub
  (`PackageRegistriesPanel.vue`) — vendor preset + scopes + write-only token, entries
  listed from the redacted summary.
- **Conformance**: a new suite section asserts add → redacted list → decrypted
  dispatch resolution → remove identically on D1 and Postgres.
