import * as v from 'valibot'
import {
  blockSchema,
  executionInstanceSchema,
  pipelineSchema,
  spendStatusSchema,
  workspaceSchema,
} from './entities.js'
import { bootstrapJobSchema } from './bootstrap.js'
import { notificationSchema } from './notifications.js'
import { mergeThresholdPresetSchema } from './merge.js'

// The full board snapshot returned by GET /workspaces/:id (and POST /workspaces).
// It lives in its own module because it references both ./entities and
// ./bootstrap, and ./bootstrap imports from ./entities — defining it in either
// would be a circular import.

export const workspaceSnapshotSchema = v.object({
  workspace: workspaceSchema,
  blocks: v.array(blockSchema),
  pipelines: v.array(pipelineSchema),
  executions: v.array(executionInstanceSchema),
  /**
   * Bootstrap runs for this workspace (the unified `agent_runs` table's bootstrap
   * rows). Carried in the snapshot so the board can render a bootstrap's live
   * progress / failure + retry the moment it loads, without a separate fetch that
   * could fail independently. Attached by the worker, so optional on the wire.
   */
  bootstrapJobs: v.optional(v.array(bootstrapJobSchema)),
  /**
   * The current spend-safeguard status. Attached by the worker (it depends on
   * deployment-wide pricing/budget config), so it is optional on the wire.
   */
  spend: v.optional(spendStatusSchema),
  /**
   * Open human-actionable notifications for this workspace (PRs awaiting a merge
   * decision, completed pipelines awaiting confirmation, CI that gave up). Carried
   * in the snapshot so the board renders the inbox + badges on load. Attached by
   * the worker, so optional on the wire.
   */
  notifications: v.optional(v.array(notificationSchema)),
  /**
   * The workspace's merge threshold presets (the library a task picks its
   * auto-merge policy from). Attached by the worker, so optional on the wire.
   */
  mergePresets: v.optional(v.array(mergeThresholdPresetSchema)),
})
export type WorkspaceSnapshot = v.InferOutput<typeof workspaceSnapshotSchema>
