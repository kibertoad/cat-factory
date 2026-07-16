import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Workspace-level RBAC wire contracts. A workspace membership is the tier BELOW
// account tenancy: an account admin can restrict a board to an explicit member
// list (with per-member workspace roles), while an unrestricted board keeps the
// legacy "every account member can see it" behaviour. These are the SPA-shared
// wire shapes; the permission catalog + resolution logic are server policy and
// live in `@cat-factory/kernel` (`domain/workspace-access.ts`), not here.
//
// Mirrors the shape of the account tier (`accounts.ts`): the wire unions live in
// this package and are re-exported by kernel `domain/types.ts`.
// ---------------------------------------------------------------------------

/**
 * A workspace member's role. Unlike {@link accountRoleSchema} these are NOT
 * combinable — they form a strict hierarchy `viewer < member < admin`, so a set
 * would add no expressive power (`{viewer, admin}` ≡ `admin`). Fixed pre-1.0
 * (no custom roles); each maps onto a permission set via the kernel catalog.
 */
export const workspaceRoleSchema = v.picklist(['admin', 'member', 'viewer'])
export type WorkspaceRole = v.InferOutput<typeof workspaceRoleSchema>

/**
 * The seven-permission capability catalog a workspace role resolves to. Kept at
 * exactly the number of distinct route groups the surface has, so every route maps
 * unambiguously (see the enforcement table in the RBAC initiative). `board.write`
 * vs `runs.execute` are split even though both resolve to `member`, because a
 * machine principal (a public-API key) wants run execution without board mutation.
 */
export const workspacePermissionSchema = v.picklist([
  // Snapshot + all read surfaces (runs/spend/usage/llm-metrics/agent-context/kaizen,
  // notifications list, artifacts blobs, spec, consensus, per-workspace models, events
  // stream + ticket mint).
  'workspace.read',
  // Board mutation: blocks CRUD/move/reparent/archive/dependencies, epics, service
  // mount/unmount, initiatives CRUD + planning, pipelines CRUD.
  'board.write',
  // Run lifecycle: execution start/stop/merge/restart, agent-run retry/stop, recurring
  // pipelines, all HITL windows, spend resume, notification act/dismiss.
  'runs.execute',
  // Board configuration: workspace settings, board rename/description/delete, tracker
  // settings, model presets, risk policies / merge presets, prompt-fragment library,
  // observability / release-health / incident-enrichment.
  'settings.manage',
  // Integration connections: GitHub/Slack/environments/runner-pool/task-source/
  // document-source, package registries, shared stacks, bootstrap + reference
  // architectures, sandbox, preview config.
  'integrations.manage',
  // Secrets: vendor credentials, workspace api-keys, public-api-keys, test-secrets.
  'secrets.manage',
  // Roster: workspace member CRUD + access-mode flip.
  'members.manage',
])
export type WorkspacePermission = v.InferOutput<typeof workspacePermissionSchema>

/**
 * A board's access mode. `account` (the default) is the legacy behaviour — every
 * account member sees the board; `restricted` limits it to the explicit member list.
 * The default means zero behaviour change for every existing row (no data migration).
 */
export const workspaceAccessModeSchema = v.picklist(['account', 'restricted'])
export type WorkspaceAccessMode = v.InferOutput<typeof workspaceAccessModeSchema>

/**
 * A workspace member as exposed to clients, enriched with the member's display
 * details (resolved from the users table via one batch, the {@link accountMemberSchema}
 * pattern). `addedBy` is audit metadata — who granted the row; null for system grants
 * (e.g. the creator auto-enroll).
 */
export const workspaceMemberSchema = v.object({
  workspaceId: v.string(),
  userId: v.string(),
  role: workspaceRoleSchema,
  createdAt: v.number(),
  /** Who granted this membership; null for system grants (creator auto-enroll). */
  addedBy: v.nullable(v.string()),
  /** Display details of the member (resolved from the users table), when available. */
  name: v.optional(v.nullable(v.string())),
  email: v.optional(v.nullable(v.string())),
  avatarUrl: v.optional(v.nullable(v.string())),
})
export type WorkspaceMember = v.InferOutput<typeof workspaceMemberSchema>

// Request bodies for the member-management API land with that API (a later slice of the
// workspace-rbac initiative) — this file is the shared VOCABULARY only.
