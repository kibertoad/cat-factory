# Per-service provision type + per-type infra handlers

> Initiative tracker. A later iteration reads this FIRST to resume without re-deriving
> context. Plan of record:
> `/root/.claude/plans/environment-provisioning-type-needs-atomic-spindle.md` (session
> scratch — the durable summary lives here).

## Goal & rationale

Today an ephemeral environment is provisioned from a **single
`environment_connections` row per workspace** (`kind` ∈ `manifest`/`kubernetes`/custom),
and a per-service `defaultTestEnvironment` toggle (`local` compose vs `ephemeral`) drives
the Tester. There is no way to say "this service deploys Kubernetes manifests, that one a
docker-compose file, a third a custom manifest" and route each to a different engine.

Target end state — the **what/where ÷ how split**:

- **The service (repo) owns its provisioning config — the "what + where".** A
  service-frame `Block` declares a `provisionType` (`kubernetes` | `docker-compose` |
  `custom` | `infraless`) plus the in-repo specifics: where its k8s manifests live
  (colocated path **or a separate repo**), its compose path, or its custom `manifestId`.
  Add-service **auto-detects a non-binding suggestion**.
- **The workspace (and, in local mode, the user) owns HOW to handle each type — the
  "how".** Per provision type, an **engine** + connection: `local-docker`, `local-k3s`,
  `remote-kubernetes`, or a `remote-custom` provider (which declares the `manifestId` /
  input it accepts). A per-user override layers over the workspace handler in local mode.
- **One uniform path — no local/ephemeral toggle.** `defaultTestEnvironment` is removed.
  Every service gets its environment from the resolved handler; a `local-docker` handler
  (a local compose stack) and a remote cluster are just two kinds of handler. `infraless`
  = no environment. Local-vs-remote is purely _which handler the workspace configured_.

Custom types are an **open catalog**: programmatically-registered providers **plus**
workspace-defined entries (UI-editable), keyed by `manifestId`. A `remote-custom`
handler's `acceptsManifestId` is matched against a service's pinned id.

Run details surface the exact resolved **provision type + engine + provider**.

## Conventions & gotchas (carried between slices)

- **Runtime symmetry**: every table/column/migration lands in D1 **and** Drizzle **and**
  a conformance assertion, in the same change (CLAUDE.md "Keep the runtimes symmetric").
- **BC is a non-goal**: reshape `environment_connections`, drop `defaultTestEnvironment`,
  split the kube config cleanly — no dual-read shims; stale rows may break.
- **No N+1**: resolution batches (`listByWorkspace` + `listByUserWorkspace` + catalog
  list), resolve in memory.
- **`manifestSource` moves from the workspace kube config onto the SERVICE.** The
  provider is built by **merging** the service's `manifestSource` with the workspace
  engine config at provision time.
- **local-only per-user override**: enforced by controller mount + container wiring (only
  the local facade wires the service), not a runtime branch in shared code.
- **Ordering refinement (keep each slice green):** the single→multi reshape of the
  EXISTING `environment_connections` table breaks its sole consumer
  (`EnvironmentConnectionService`), so it is grouped with **slice 2** (service
  consumption) rather than slice 1. Slice 1 is the **additive** foundation (new schemas,
  the two brand-new tables, the new `environments` columns) and stays compiling.

## Target pattern (reference)

Mirror the **observability-connection / release-health-config** pattern (per-workspace
sealed connection + per-block config) and the **`local_model_endpoints`** per-user table.
The custom-type registry mirrors the backend-provider registry / `registerAgentKind` seam.

## Status checklist

| #   | Slice                                                                                                                                                                                                                                                                        | Status | PR  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 1   | Contracts (additive) + new tables (`environment_user_handlers`, `custom_manifest_types`) + `environments` columns + ports + repos + conformance                                                                                                                              | done   | this branch |
| 2   | Reshape `environment_connections` (single→multi) + registry engines/acceptsManifestIds + `infra-handler.logic` resolver + custom-type registry seam + `EnvironmentConnectionService`/`ProvisioningService` reshape + `tester-infra` collapse (drop `defaultTestEnvironment`) | todo   | —   |
| 3   | `RunDispatcher.runDeployerStep` merge source+engine + record provisionType/engine; infraless no-op; run-details handle fields                                                                                                                                                | todo   | —   |
| 4   | Controllers (per-type endpoints + custom-type CRUD + local-only per-user controller) + all three container wirings                                                                                                                                                           | todo   | —   |
| 5   | Frontend (service provisioning section + auto-detect; infra per-type/engine configurator + custom-type editor + local override; run-details surfacing; stores; i18n)                                                                                                         | todo   | —   |

Update the row (status + PR link) at the end of each slice.
