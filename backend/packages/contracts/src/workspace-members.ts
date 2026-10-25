import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Workspace-level RBAC wire contracts. A workspace membership is the tier BELOW
// account tenancy: an account admin can restrict a board to an explicit member
// list (with per-member workspace roles), while an unrestricted board keeps the
// legacy "every account member can see it" behaviour. These are the SPA-shared
// wire shapes, plus the static role → permission map, which the SPA needs to read a
// board's `viewerRole` the way the backend enforces it. The resolution logic (which
// role a caller holds on a board) is server policy and lives in `@cat-factory/kernel`
// (`domain/workspace-access.ts`), not here.
//
// Mirrors the shape of the account tier (`accounts.ts`): the wire unions live in
// this package and are re-exported by kernel `domain/types.ts`.
// ---------------------------------------------------------------------------

/**
 * A workspace member's role. Unlike {@link accountRoleSchema} these are NOT
 * combinable — they form a strict hierarchy `viewer < member < admin`, so a set
 * would add no expressive power (`{viewer, admin}` ≡ `admin`). Fixed pre-1.0
 * (no custom roles); each maps onto a permission set via {@link WORKSPACE_ROLE_PERMISSIONS}.
 */
export const WORKSPACE_ROLES = ['admin', 'member', 'viewer'] as const

export const workspaceRoleSchema = v.picklist(WORKSPACE_ROLES)
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

/** The full permission set an `admin` holds (also the catalog's canonical order). */
const ALL_WORKSPACE_PERMISSIONS: readonly WorkspacePermission[] = workspacePermissionSchema.options

/**
 * The static role → permission map. `viewer` reads only; `member` adds board
 * mutation + run execution (the developer surface); `admin` holds everything.
 * `board.write` and `runs.execute` are carried separately even though both land on
 * `member`, so a post-1.0 custom-role model (and machine principals) can split them
 * without re-cataloguing: the cost of the split now is one array entry.
 *
 * Here rather than in kernel because the SPA must agree with it: the board list carries
 * only the caller's ROLE per board (`viewerRole`), and a surface that offers a board for
 * a permission-gated action reads the permission off this map.
 */
export const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  viewer: ['workspace.read'],
  member: ['workspace.read', 'board.write', 'runs.execute'],
  admin: ALL_WORKSPACE_PERMISSIONS,
}

/** The permission set a role resolves to, as a `Set` for O(1) `requirePermission` checks. */
export function permissionsForRole(role: WorkspaceRole): ReadonlySet<WorkspacePermission> {
  return new Set(WORKSPACE_ROLE_PERMISSIONS[role])
}

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

/**
 * The signed-in caller's resolved access to one board — their effective workspace role
 * plus the permission set it grants. Attached to the workspace snapshot (see
 * {@link workspaceSnapshotSchema}) so the SPA can hide/disable affordances the caller
 * lacks. Optional on the wire: absent ⇒ dev-open (auth disabled) ⇒ the SPA allows all.
 */
export const workspaceAccessSchema = v.object({
  role: workspaceRoleSchema,
  permissions: v.array(workspacePermissionSchema),
})
export type WorkspaceAccess = v.InferOutput<typeof workspaceAccessSchema>

// ---- Request bodies (member-management API) -------------------------------

/**
 * Add a member to a board by their internal user id, at a workspace role. The target
 * MUST already belong to the board's owning account (contractors join the account first,
 * then get scoped) — the service rejects a non-account-member. Upsert semantics.
 */
export const addWorkspaceMemberSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1)),
  role: workspaceRoleSchema,
})
export type AddWorkspaceMemberInput = v.InferOutput<typeof addWorkspaceMemberSchema>

/** Change an existing member's workspace role. */
export const setWorkspaceMemberRoleSchema = v.object({
  role: workspaceRoleSchema,
})
export type SetWorkspaceMemberRoleInput = v.InferOutput<typeof setWorkspaceMemberRoleSchema>

/**
 * Flip a board's access mode. `restricted` limits it to the explicit member list;
 * `account` restores the legacy "every account member sees it" behaviour.
 */
export const setWorkspaceAccessModeSchema = v.object({
  accessMode: workspaceAccessModeSchema,
})
export type SetWorkspaceAccessModeInput = v.InferOutput<typeof setWorkspaceAccessModeSchema>
