import * as v from 'valibot'
import { positionSchema, sizeSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// In-org shared services.
//
// A *service* is the canonical, account-owned unit of work on the board: the
// service frame plus its modules + tasks, its linked GitHub repo, its
// executions and its sync. It is owned by an *account* (org), not a single
// workspace. A *workspace* is a curated VIEW that *mounts* a subset of the
// org's services; the same service can be mounted onto several teams' boards,
// where its state and task list are one shared set (only the frame's board
// position/size is per-workspace, carried on the mount).
//
// This is the deduplication seam: a service is synced once per org, and a state
// change to it is relevant to every workspace that mounts it.
// ---------------------------------------------------------------------------

/**
 * The canonical, account-owned service record. Owns exactly one service frame
 * block (`frameBlockId`) and, when connected, the GitHub repo the frame's tasks
 * target (`installationId` + `repoGithubId`). Shared across the workspaces that
 * mount it.
 */
export const serviceSchema = v.object({
  /** Globally unique service id (stable; survives re-mounting). */
  id: v.string(),
  /** The owning account (org/personal), or null for a legacy/unscoped board. */
  accountId: v.nullable(v.string()),
  /** The root service-frame block this service owns (its subtree is the service). */
  frameBlockId: v.string(),
  /** The GitHub App installation backing the linked repo, when connected. */
  installationId: v.nullable(v.number()),
  /** The GitHub numeric id of the linked repo, when connected. */
  repoGithubId: v.nullable(v.number()),
  /** Epoch ms the service was created. */
  createdAt: v.number(),
})
export type Service = v.InferOutput<typeof serviceSchema>

/**
 * A *mount*: a service placed onto a workspace's board. The primary key is
 * `(workspaceId, serviceId)`. The position/size are the per-workspace LAYOUT
 * OVERRIDE for the service's frame — each board can position the shared frame
 * independently, while the task/module positions inside it stay shared.
 */
export const workspaceMountSchema = v.object({
  workspaceId: v.string(),
  serviceId: v.string(),
  /** Per-workspace board position of the service's frame. */
  position: positionSchema,
  /** Per-workspace dragged frame size; absent => auto-size from contents. */
  size: v.optional(v.nullable(sizeSchema)),
  /** Epoch ms the service was mounted onto this workspace. */
  createdAt: v.number(),
})
export type WorkspaceMount = v.InferOutput<typeof workspaceMountSchema>

/** Body for mounting an existing org service onto a workspace board. */
export const mountServiceInputSchema = v.object({
  /** Where to place the frame on this board; defaults applied server-side when absent. */
  position: v.optional(positionSchema),
})
export type MountServiceInput = v.InferOutput<typeof mountServiceInputSchema>

/** Body for updating a mount's per-workspace layout override. */
export const updateMountInputSchema = v.object({
  position: v.optional(positionSchema),
  size: v.optional(v.nullable(sizeSchema)),
})
export type UpdateMountInput = v.InferOutput<typeof updateMountInputSchema>
