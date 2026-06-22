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
import { agentConfigCatalogSchema } from './agent-config.js'
import { modelDefaultsSchema } from './model-defaults.js'
import { pipelineScheduleSchema } from './recurring.js'
import { serviceSchema, workspaceMountSchema } from './services.js'
import { trackerSettingsSchema } from './tracker.js'

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
  /**
   * The catalog of agent config-contribution descriptors (the task-level parameters
   * the registered agent kinds surface, e.g. the Tester's environment). The board
   * renders the subset whose owning kind appears in a task's selected pipeline.
   * Static metadata derived from the agent registry; attached by the facade, so
   * optional on the wire.
   */
  agentConfigCatalog: v.optional(agentConfigCatalogSchema),
  /**
   * The workspace's per-agent-kind default models (the model each agent kind
   * defaults to, overriding the env routing for this workspace). Attached by the
   * worker, so optional on the wire.
   */
  modelDefaults: v.optional(modelDefaultsSchema),
  /**
   * The workspace's recurring pipelines (schedules that re-run a pipeline against
   * a service on a cadence). Carried in the snapshot so the board renders the
   * recurring-task badges + inspector on load. Run history is fetched lazily.
   */
  recurringPipelines: v.optional(v.array(pipelineScheduleSchema)),
  /**
   * The workspace's issue-tracker selection (where the tech-debt pipeline files
   * its ticket). Attached by the worker, so optional on the wire.
   */
  trackerSettings: v.optional(trackerSettingsSchema),
  /**
   * In-org shared services. `mounts` are the services this workspace mounts (with the
   * per-workspace frame layout); `serviceCatalog` is the org's services the board can
   * mount from (each annotated with `mountCount` so the UI can badge a shared frame).
   * Attached by the worker when the services module is wired, so optional on the wire.
   */
  mounts: v.optional(v.array(workspaceMountSchema)),
  serviceCatalog: v.optional(v.array(serviceSchema)),
})
export type WorkspaceSnapshot = v.InferOutput<typeof workspaceSnapshotSchema>
