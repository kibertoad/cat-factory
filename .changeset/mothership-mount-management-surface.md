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
  reusing the controller's existing service→account resolver — no controller change. The dispatched
  `get` is routed through the same per-request `listByIds` memo the scope check already reads, so a
  mount precheck resolves the service in ONE query, not two.
- `workspaceMountRepository` — `get` / `update` / `remove` (arg0 = workspaceId → the `workspace`
  rule) and the record-based `upsert(mount)` (bound by a NEW `serviceMount` scope kind).

Each is member-level (the mount endpoints are not admin-gated) and workspace-scoped. The cross-org
mount invariant ("a service can only be mounted within its own organization") is enforced at the
RPC layer, not only in the bypassed service layer: the `serviceMount` rule binds `upsert` on the
mount's `workspaceId` FIELD (out-of-scope workspace → refused) AND requires the mounted `serviceId`
to be owned by the SAME account as that workspace. So a raw `upsert` can never plant a cross-org
mount — including for a machine token that spans several accounts (a user in multiple orgs, where a
workspace-only check would let one org's service be mounted onto another org's board). Board
composition (`blockRepository.listByServices` / `serviceRepository.listByIds`) stays account-scoped
as a second line of defence. The real-time fan-out reads (`listByService` /
`listWorkspaceIdsMountingBlock`) and the frame-deletion batch cleanup (`removeByServices`) stay off
the SPA path. These are core repos, so a mothership-mode node already sources them from the
full-surface remote registry — no `pickRepoSource` routing change, just the allow-list plus the two
new scope kinds. Server-only, symmetric by construction (the dispatcher reflects over each facade's
registry). Round-trip + cross-account-scope tests cover every new method (incl. the `service` kind's
fail-closed edges and the `serviceMount` rule's cross-org / multi-account denials); the static drift
guard moves them out of `pending`.
