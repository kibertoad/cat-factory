import type { BlockPatch } from '@cat-factory/kernel'
import type {
  AgentConfigValues,
  AgentFailure,
  Block,
  BlockLevel,
  BlockStatus,
  BlockType,
  CloudProvider,
  ExecutionInstance,
  ExecutionStatus,
  InstanceSize,
  Pipeline,
  PipelineStep,
  PullRequestRef,
  TaskEstimate,
  TaskType,
  TaskTypeFields,
  WritebackOverride,
  Workspace,
} from '@cat-factory/contracts'

// Row <-> domain mapping for the D1 (SQLite) tables. JSON-shaped columns are
// (de)serialised here so the repositories stay focused on SQL.

export interface WorkspaceRow {
  id: string
  name: string
  description?: string | null
  created_at: number
  account_id: string | null
}

export function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.created_at,
    accountId: row.account_id ?? null,
  }
}

export interface BlockRow {
  id: string
  title: string
  type: string
  description: string
  pos_x: number
  pos_y: number
  width: number | null
  height: number | null
  status: string
  progress: number
  depends_on: string
  execution_id: string | null
  level: string
  parent_id: string | null
  /** Task-level: membership link to an `epic`-level block (independent of parent_id). */
  epic_id?: string | null
  /** Task-level: preceding-task auto-start toggle (0/1); null ⇒ off. */
  auto_start_dependents?: number | null
  confidence: number | null
  module_name: string | null
  fragment_ids: string | null
  /** Service-level: the service's selected best-practice fragment ids, JSON array. */
  service_fragment_ids: string | null
  model_id: string | null
  pull_request: string | null
  merge_preset_id: string | null
  model_preset_id: string | null
  pipeline_id: string | null
  /** Task-level agent-contributed config values, JSON id→value map. */
  agent_config: string | null
  /** Service-level: docker-compose path for the Tester's local infra. */
  test_compose_path: string | null
  /** Service-level: whether the service has no infra dependencies (0/1). */
  no_infra_dependencies: number | null
  /** Service-level: default test environment for tasks ('local' | 'ephemeral'). */
  default_test_environment?: string | null
  /** Service-level: cloud provider the service's jobs run on. */
  cloud_provider: string | null
  /** Service-level: abstract instance size for the service's jobs. */
  instance_size: string | null
  created_by: string | null
  responsible_product_user_id: string | null
  /** Task-level: the task-estimator's triage (complexity/risk/impact), JSON object. */
  estimate?: string | null
  /** Task-level: the kind of work (feature/bug/document/spike/recurring). */
  task_type?: string | null
  /** Task-level: small per-type form fields (bug severity, spike timebox…), JSON object. */
  task_type_fields?: string | null
  /** Task-level: 1 ⇒ technical task, 0 ⇒ business task, null ⇒ not yet determined. */
  technical?: number | null
  /** Task-level: per-task issue-tracker writeback overrides ('on'/'off'); null ⇒ inherit. */
  tracker_comment_on_pr_open?: string | null
  tracker_resolve_on_merge?: string | null
}

export function rowToBlock(row: BlockRow): Block {
  const block: Block = {
    id: row.id,
    title: row.title,
    type: row.type as BlockType,
    description: row.description,
    position: { x: row.pos_x, y: row.pos_y },
    status: row.status as BlockStatus,
    progress: row.progress,
    dependsOn: JSON.parse(row.depends_on) as string[],
    executionId: row.execution_id,
    level: row.level as BlockLevel,
    parentId: row.parent_id,
  }
  if (row.width !== null && row.height !== null) block.size = { w: row.width, h: row.height }
  if (row.epic_id != null) block.epicId = row.epic_id
  if (row.auto_start_dependents != null)
    block.autoStartDependents = row.auto_start_dependents === 1
  if (row.confidence !== null) block.confidence = row.confidence
  if (row.module_name !== null) block.moduleName = row.module_name
  if (row.fragment_ids !== null) block.fragmentIds = JSON.parse(row.fragment_ids) as string[]
  if (row.service_fragment_ids !== null)
    block.serviceFragmentIds = JSON.parse(row.service_fragment_ids) as string[]
  if (row.model_id !== null) block.modelId = row.model_id
  if (row.pull_request !== null) block.pullRequest = JSON.parse(row.pull_request) as PullRequestRef
  if (row.merge_preset_id !== null) block.mergePresetId = row.merge_preset_id
  if (row.model_preset_id !== null) block.modelPresetId = row.model_preset_id
  if (row.pipeline_id !== null) block.pipelineId = row.pipeline_id
  if (row.agent_config !== null)
    block.agentConfig = JSON.parse(row.agent_config) as AgentConfigValues
  if (row.test_compose_path !== null) block.testComposePath = row.test_compose_path
  if (row.no_infra_dependencies !== null)
    block.noInfraDependencies = row.no_infra_dependencies === 1
  if (row.default_test_environment != null)
    block.defaultTestEnvironment = row.default_test_environment as 'local' | 'ephemeral'
  if (row.cloud_provider !== null) block.cloudProvider = row.cloud_provider as CloudProvider
  if (row.instance_size !== null) block.instanceSize = row.instance_size as InstanceSize
  if (row.created_by !== null) block.createdBy = row.created_by
  if (row.responsible_product_user_id !== null)
    block.responsibleProductUserId = row.responsible_product_user_id
  if (row.estimate != null) block.estimate = JSON.parse(row.estimate) as TaskEstimate
  if (row.task_type != null) block.taskType = row.task_type as TaskType
  if (row.task_type_fields != null)
    block.taskTypeFields = JSON.parse(row.task_type_fields) as TaskTypeFields
  if (row.technical != null) block.technical = row.technical === 1
  if (row.tracker_comment_on_pr_open != null)
    block.trackerCommentOnPrOpen = row.tracker_comment_on_pr_open as WritebackOverride
  if (row.tracker_resolve_on_merge != null)
    block.trackerResolveOnMerge = row.tracker_resolve_on_merge as WritebackOverride
  return block
}

/** Full column tuple for inserting a block. */
export function blockInsertValues(block: Block): Record<string, unknown> {
  return {
    id: block.id,
    title: block.title,
    type: block.type,
    description: block.description,
    pos_x: block.position.x,
    pos_y: block.position.y,
    width: block.size?.w ?? null,
    height: block.size?.h ?? null,
    status: block.status,
    progress: block.progress,
    depends_on: JSON.stringify(block.dependsOn),
    execution_id: block.executionId,
    level: block.level,
    parent_id: block.parentId,
    epic_id: block.epicId ?? null,
    auto_start_dependents: block.autoStartDependents ? 1 : null,
    confidence: block.confidence ?? null,
    module_name: block.moduleName ?? null,
    fragment_ids: block.fragmentIds ? JSON.stringify(block.fragmentIds) : null,
    service_fragment_ids: block.serviceFragmentIds
      ? JSON.stringify(block.serviceFragmentIds)
      : null,
    model_id: block.modelId ?? null,
    pull_request: block.pullRequest ? JSON.stringify(block.pullRequest) : null,
    merge_preset_id: block.mergePresetId ?? null,
    model_preset_id: block.modelPresetId ?? null,
    pipeline_id: block.pipelineId ?? null,
    agent_config:
      block.agentConfig && Object.keys(block.agentConfig).length
        ? JSON.stringify(block.agentConfig)
        : null,
    test_compose_path: block.testComposePath ?? null,
    no_infra_dependencies: block.noInfraDependencies ? 1 : null,
    default_test_environment: block.defaultTestEnvironment ?? null,
    cloud_provider: block.cloudProvider ?? null,
    instance_size: block.instanceSize ?? null,
    created_by: block.createdBy ?? null,
    responsible_product_user_id: block.responsibleProductUserId ?? null,
    estimate: block.estimate ? JSON.stringify(block.estimate) : null,
    task_type: block.taskType ?? null,
    task_type_fields: block.taskTypeFields ? JSON.stringify(block.taskTypeFields) : null,
    technical: block.technical == null ? null : block.technical ? 1 : 0,
    tracker_comment_on_pr_open: block.trackerCommentOnPrOpen ?? null,
    tracker_resolve_on_merge: block.trackerResolveOnMerge ?? null,
  }
}

/** Map a domain patch onto `{ column: value }` pairs for an UPDATE. */
export function blockPatchToColumns(patch: BlockPatch): Record<string, unknown> {
  const set: Record<string, unknown> = {}
  if (patch.title !== undefined) set.title = patch.title
  if (patch.type !== undefined) set.type = patch.type
  if (patch.description !== undefined) set.description = patch.description
  if (patch.position !== undefined) {
    set.pos_x = patch.position.x
    set.pos_y = patch.position.y
  }
  if (patch.size !== undefined) {
    set.width = patch.size?.w ?? null
    set.height = patch.size?.h ?? null
  }
  if (patch.status !== undefined) set.status = patch.status
  if (patch.progress !== undefined) set.progress = patch.progress
  if (patch.dependsOn !== undefined) set.depends_on = JSON.stringify(patch.dependsOn)
  if (patch.executionId !== undefined) set.execution_id = patch.executionId
  if (patch.level !== undefined) set.level = patch.level
  if (patch.parentId !== undefined) set.parent_id = patch.parentId
  // Epic membership; an empty string / null detaches the task from its epic.
  if (patch.epicId !== undefined) set.epic_id = patch.epicId ? patch.epicId : null
  if (patch.autoStartDependents !== undefined) {
    set.auto_start_dependents = patch.autoStartDependents ? 1 : null
  }
  if (patch.confidence !== undefined) set.confidence = patch.confidence
  if (patch.moduleName !== undefined) set.module_name = patch.moduleName
  if (patch.fragmentIds !== undefined) {
    set.fragment_ids = patch.fragmentIds ? JSON.stringify(patch.fragmentIds) : null
  }
  // Service-level selection (frame blocks). An empty array clears it.
  if (patch.serviceFragmentIds !== undefined) {
    set.service_fragment_ids =
      patch.serviceFragmentIds && patch.serviceFragmentIds.length
        ? JSON.stringify(patch.serviceFragmentIds)
        : null
  }
  // An empty string clears the selection (back to the routing default).
  if (patch.modelId !== undefined) set.model_id = patch.modelId ? patch.modelId : null
  // The responsible product person; an empty string clears the assignment.
  if (patch.responsibleProductUserId !== undefined) {
    set.responsible_product_user_id = patch.responsibleProductUserId
      ? patch.responsibleProductUserId
      : null
  }
  if (patch.pullRequest !== undefined) {
    set.pull_request = patch.pullRequest ? JSON.stringify(patch.pullRequest) : null
  }
  // An empty string clears the selection (back to the workspace default preset).
  if (patch.mergePresetId !== undefined) {
    set.merge_preset_id = patch.mergePresetId ? patch.mergePresetId : null
  }
  // An empty string clears the selection (back to the workspace default model preset).
  if (patch.modelPresetId !== undefined) {
    set.model_preset_id = patch.modelPresetId ? patch.modelPresetId : null
  }
  // An empty string clears the pinned pipeline selection.
  if (patch.pipelineId !== undefined) {
    set.pipeline_id = patch.pipelineId ? patch.pipelineId : null
  }
  // Replace the whole task-level config map; an empty map clears it.
  if (patch.agentConfig !== undefined) {
    set.agent_config =
      patch.agentConfig && Object.keys(patch.agentConfig).length
        ? JSON.stringify(patch.agentConfig)
        : null
  }
  // Service-level fields. An empty compose path clears it.
  if (patch.testComposePath !== undefined) {
    set.test_compose_path = patch.testComposePath ? patch.testComposePath : null
  }
  if (patch.noInfraDependencies !== undefined) {
    set.no_infra_dependencies = patch.noInfraDependencies ? 1 : null
  }
  if (patch.defaultTestEnvironment !== undefined) {
    set.default_test_environment = patch.defaultTestEnvironment ?? null
  }
  if (patch.cloudProvider !== undefined) set.cloud_provider = patch.cloudProvider ?? null
  if (patch.instanceSize !== undefined) set.instance_size = patch.instanceSize ?? null
  // The task-estimator's triage; null clears it.
  if (patch.estimate !== undefined) {
    set.estimate = patch.estimate ? JSON.stringify(patch.estimate) : null
  }
  if (patch.taskType !== undefined) set.task_type = patch.taskType ?? null
  if (patch.taskTypeFields !== undefined) {
    set.task_type_fields = patch.taskTypeFields ? JSON.stringify(patch.taskTypeFields) : null
  }
  // Technical label: 1/0 column, null clears it back to "not yet determined" (so the
  // engine may infer it). A human-set value is what reaches here via the inspector toggle;
  // an explicit `null` is the tri-state "unset".
  if (patch.technical !== undefined) {
    set.technical = patch.technical == null ? null : patch.technical ? 1 : 0
  }
  // Per-task writeback overrides; an empty string clears it (back to inheriting the
  // workspace setting).
  if (patch.trackerCommentOnPrOpen !== undefined) {
    set.tracker_comment_on_pr_open = patch.trackerCommentOnPrOpen
      ? patch.trackerCommentOnPrOpen
      : null
  }
  if (patch.trackerResolveOnMerge !== undefined) {
    set.tracker_resolve_on_merge = patch.trackerResolveOnMerge ? patch.trackerResolveOnMerge : null
  }
  return set
}

export interface PipelineRow {
  id: string
  name: string
  agent_kinds: string
  /** Nullable JSON array of per-step approval gates (migration 0022). */
  gates: string | null
  /** Nullable JSON array of per-step companion quality thresholds (migration 0035). */
  thresholds?: string | null
  /** Nullable JSON array of per-step enable flags (migration 0002). */
  enabled?: string | null
  /** Truthy (1) for the curated built-in catalog templates (migration 0002). */
  builtin?: number | boolean | null
  /** Nullable JSON array of per-step consensus configs (parallel to agent_kinds). */
  consensus?: string | null
  /** Nullable JSON array of per-step estimate gating (migration 0003). */
  gating?: string | null
  /** Nullable JSON array of organizational labels (migration 0003). */
  labels?: string | null
  /** Truthy (1) when the pipeline is archived / hidden from the default view (migration 0003). */
  archived?: number | boolean | null
}

export function rowToPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id,
    name: row.name,
    agentKinds: JSON.parse(row.agent_kinds) as Pipeline['agentKinds'],
    ...(row.gates ? { gates: JSON.parse(row.gates) as boolean[] } : {}),
    ...(row.thresholds ? { thresholds: JSON.parse(row.thresholds) as Pipeline['thresholds'] } : {}),
    ...(row.enabled ? { enabled: JSON.parse(row.enabled) as boolean[] } : {}),
    ...(row.consensus ? { consensus: JSON.parse(row.consensus) as Pipeline['consensus'] } : {}),
    ...(row.gating ? { gating: JSON.parse(row.gating) as Pipeline['gating'] } : {}),
    ...(row.labels ? { labels: JSON.parse(row.labels) as string[] } : {}),
    ...(row.archived ? { archived: true } : {}),
    ...(row.builtin ? { builtin: true } : {}),
  }
}

/**
 * A `kind='execution'` row of the unified `agent_runs` table (migration 0019).
 * The pipeline shape (pipelineId/Name, steps, currentStep) lives in the `detail`
 * JSON column; lifecycle/failure are top-level columns shared with bootstrap.
 */
export interface ExecutionRow {
  id: string
  block_id: string | null
  status: string
  /** JSON {pipelineId,pipelineName,steps,currentStep}. */
  detail: string
  error: string | null
  /** JSON-encoded AgentFailure; null unless the run failed. */
  failure: string | null
  // Lease for the cron sweeper; not surfaced on the entity.
  updated_at: number
  workflow_instance_id: string | null
}

/** The execution-specific payload packed into `agent_runs.detail`. */
interface ExecutionDetail {
  pipelineId: string
  pipelineName: string
  steps: PipelineStep[]
  currentStep: number
  /** Internal user id of the run's initiator (individual-usage credential ownership). */
  initiatedBy: string | null
}

/** Parse the JSON-encoded structured failure column, tolerating null/garbage. */
function parseAgentFailure(raw: string | null): AgentFailure | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as AgentFailure
    if (o && typeof o.kind === 'string' && typeof o.message === 'string') return o
  } catch {
    // fall through
  }
  return null
}

export function rowToExecution(row: ExecutionRow): ExecutionInstance {
  let detail: Partial<ExecutionDetail>
  try {
    detail = JSON.parse(row.detail) as Partial<ExecutionDetail>
  } catch {
    detail = {}
  }
  return {
    id: row.id,
    blockId: row.block_id ?? '',
    pipelineId: detail.pipelineId ?? '',
    pipelineName: detail.pipelineName ?? '',
    // Stamp each step with its run id (a projection of the row id) so a lone step is
    // self-describing for debugging; never read back from the detail JSON.
    steps: (detail.steps ?? []).map((s) => ({ ...s, runId: row.id })),
    currentStep: detail.currentStep ?? 0,
    status: row.status as ExecutionStatus,
    failure: parseAgentFailure(row.failure),
    initiatedBy: detail.initiatedBy ?? null,
  }
}

/** Build the `agent_runs.detail` JSON for an execution instance (shared by both repos). */
export function executionToDetail(instance: ExecutionInstance): string {
  return JSON.stringify({
    pipelineId: instance.pipelineId,
    pipelineName: instance.pipelineName,
    // `runId` is a read-time projection (it equals the row id) — drop it from the
    // stored JSON so it isn't persisted twice (JSON.stringify omits undefined keys).
    steps: instance.steps.map((s) => ({ ...s, runId: undefined })),
    currentStep: instance.currentStep,
    initiatedBy: instance.initiatedBy ?? null,
  } satisfies ExecutionDetail)
}
