---
'@cat-factory/server': patch
---

mothership: allow-list the shared-service mount management surface

In mothership mode the org-catalog / shared-service mounting flow (`ServiceMountService` /
`ServiceMountController` — mount / unmount / re-layout a shared account service onto a workspace
board) was not fully remotely callable over `/internal/persistence`: the reads that badge the
catalog (`workspaceMountRepository.listByWorkspace` / `countByServiceIds`) were exposed, but the
single-service read the mount flow performs and the mount write/update/remove methods came back
`unknown_method`, so a mothership-mode SPA could display the catalog but not mount from it. This
widens `REMOTE_PERSISTENCE_METHODS` to the write surface, each with a correct scope rule:

- `serviceRepository.get(serviceId)` — the single-service read behind `ServiceMountService.mount`
  (the cross-org guard that a service is mounted only within its own account). Bound by a NEW
  `service` scope kind (a single serviceId → owning account, the single-id form of `serviceList`),
  reusing the controller's existing service→account resolver — no controller change.
- `workspaceMountRepository` — `get` / `update` / `remove` (arg0 = workspaceId → the `workspace`
  rule) and the record-based `upsert(mount)` (bound on the mount's `workspaceId` FIELD → the
  `workspaceField` rule).

Each is member-level (the mount endpoints are not admin-gated) and workspace-scoped. Sharing stays
within one account: the local node's `mount()` reads `serviceRepository.get` first (the `service`
rule 404s a foreign service, so `assertFound` throws before any write), and a stray direct `upsert`
of a foreign service fails closed on board composition (its blocks read via the account-scoped
`listByServices`). The real-time fan-out reads (`listByService` / `listWorkspaceIdsMountingBlock`)
and the frame-deletion batch cleanup (`removeByServices`) stay off the SPA path. These are core
repos, so a mothership-mode node already sources them from the full-surface remote registry — no
`pickRepoSource` routing change, just the allow-list plus the one new scope kind. Server-only,
symmetric by construction (the dispatcher reflects over each facade's registry). Round-trip +
cross-account-scope tests cover every new method (incl. the new `service` kind's fail-closed edges);
the static drift guard moves them out of `pending`.
