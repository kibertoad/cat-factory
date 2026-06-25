---
"@cat-factory/contracts": minor
"@cat-factory/kernel": minor
"@cat-factory/integrations": minor
"@cat-factory/orchestration": minor
"@cat-factory/server": minor
"@cat-factory/worker": minor
"@cat-factory/node-server": minor
"@cat-factory/app": minor
---

Declutter settings/navbar and make post-release health a pluggable observability integration.

**Frontend**
- Workspace settings is now a single tabbed window: **Merge thresholds**, **Issue writeback**
  and **Default service best practices** moved from standalone modals into tabs (their navbar/
  command-bar entries now deep-link to the tab). Fixed the **Mode** select clipping its options.
- Removed the **Add a block** button and **all** "Add &lt;type&gt; block" command-bar commands
  (services come from Bootstrap / Add-from-repo, tasks from the add-task flow); dropped the
  unsupported `external` / `environment` block types.
- The new-task form now shows **Context documents** and **Context issues** sections (inspector-
  style) **ungated** — the *Attach* button is disabled with a tooltip until the relevant
  integration is connected. (`ContextPicker.vue` removed.)
- Post-release health is no longer a Datadog-named window: the **connection** is an
  **Observability** entry in the Integrations hub (`ObservabilityConnectionPanel`, provider
  picker — Datadog today), and the per-service **monitor/SLO mapping** moved into the **service
  inspector** (`ServiceReleaseHealthConfig`, keyed by the selected frame — no manual block-id
  entry, disabled with a hint until a connection exists).

**Backend — pluggable observability (Datadog = one adapter)**
- The `ReleaseHealthProvider` is now served by `RegistryReleaseHealthProvider`, a registry of
  per-vendor adapters; the Datadog logic became `DatadogObservabilityAdapter`. Adding a second
  provider is a new registry entry — the gate, service, routes and persistence are vendor-neutral.

**Breaking (acceptable per pre-1.0 policy — no migration):**
- Persistence: the `datadog_connections` table is **dropped** and replaced by
  `observability_connections` (`provider` discriminator + a single sealed `credentials` JSON blob
  + a non-secret `summary`), mirrored D1 ⇄ Drizzle. Existing connections must be re-entered.
- Kernel: `DatadogConnectionRecord`/`DatadogConnectionRepository` →
  `ObservabilityConnectionRecord`/`ObservabilityConnectionRepository` (+ `ObservabilityProviderKind`).
- Contracts: `upsertDatadogConnectionSchema` / `datadogConnectionViewSchema` →
  `upsertObservabilityConnectionSchema` / `observabilityConnectionViewSchema` (now `{ provider,
  credentials }` / `{ connected, provider, summary }`), plus `observabilityConnectionSummary`.
- HTTP: `GET|PUT|DELETE /workspaces/:ws/datadog/connection` → `…/observability/connection`.
- Config/env: `DATADOG_ENABLED` → `OBSERVABILITY_ENABLED`; `AppConfig.datadog` → `AppConfig.releaseHealth`
  (`DatadogConfig` → `ReleaseHealthConfig`); the sealed-secret domain tag `cat-factory:datadog` →
  `cat-factory:observability`.

Note: the cross-runtime conformance suite does not yet cover the observability connection CRUD
(it never covered the Datadog connection either); both facades wire the same repos/cipher/provider
and ship mirrored D1 + Drizzle migrations.
