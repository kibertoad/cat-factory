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
  confidence: number | null
  module_name: string | null
  fragment_ids: string | null
  /** Service-level: the service's selected best-practice fragment ids, JSON array. */
  service_fragment_ids: string | null
  model_id: string | null
  pull_request: string | null
  merge_preset_id: string | null
  pipeline_id: string | null
  /** Task-level agent-contributed config values, JSON id→value map. */
  agent_config: string | null
  /** Service-level: docker-compose path for the Tester's local infra. */
  test_compose_path: string | null
  /** Service-level: whether the service has no infra dependencies (0/1). */
  no_infra_dependencies: number | null
  /** Service-level: cloud provider the service's jobs run on. */
  cloud_provider: string | null
  /** Service-level: abstract instance size for the service's jobs. */
  instance_size: string | null
  created_by: string | null
  responsible_product_user_id: string | null
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
  if (row.confidence !== null) block.confidence = row.confidence
  if (row.module_name !== null) block.moduleName = row.module_name
  if (row.fragment_ids !== null) block.fragmentIds = JSON.parse(row.fragment_ids) as string[]
  if (row.service_fragment_ids !== null)
    block.serviceFragmentIds = JSON.parse(row.service_fragment_ids) as string[]
  if (row.model_id !== null) block.modelId = row.model_id
  if (row.pull_request !== null) block.pullRequest = JSON.parse(row.pull_request) as PullRequestRef
  if (row.merge_preset_id !== null) block.mergePresetId = row.merge_preset_id
  if (row.pipeline_id !== null) block.pipelineId = row.pipeline_id
  if (row.agent_config !== null)
    block.agentConfig = JSON.parse(row.agent_config) as AgentConfigValues
  if (row.test_compose_path !== null) block.testComposePath = row.test_compose_path
  if (row.no_infra_dependencies !== null)
    block.noInfraDependencies = row.no_infra_dependencies === 1
  if (row.cloud_provider !== null) block.cloudProvider = row.cloud_provider as CloudProvider
  if (row.instance_size !== null) block.instanceSize = row.instance_size as InstanceSize
  if (row.created_by !== null) block.createdBy = row.created_by
  if (row.responsible_product_user_id !== null)
    block.responsibleProductUserId = row.responsible_product_user_id
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
    confidence: block.confidence ?? null,
    module_name: block.moduleName ?? null,
    fragment_ids: block.fragmentIds ? JSON.stringify(block.fragmentIds) : null,
    service_fragment_ids: block.serviceFragmentIds
      ? JSON.stringify(block.serviceFragmentIds)
      : null,
    model_id: block.modelId ?? null,
    pull_request: block.pullRequest ? JSON.stringify(block.pullRequest) : null,
    merge_preset_id: block.mergePresetId ?? null,
    pipeline_id: block.pipelineId ?? null,
    agent_config:
      block.agentConfig && Object.keys(block.agentConfig).length
        ? JSON.stringify(block.agentConfig)
        : null,
    test_compose_path: block.testComposePath ?? null,
    no_infra_dependencies: block.noInfraDependencies ? 1 : null,
    cloud_provider: block.cloudProvider ?? null,
    instance_size: block.instanceSize ?? null,
    created_by: block.createdBy ?? null,
    responsible_product_user_id: block.responsibleProductUserId ?? null,
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
  if (patch.cloudProvider !== undefined) set.cloud_provider = patch.cloudProvider ?? null
  if (patch.instanceSize !== undefined) set.instance_size = patch.instanceSize ?? null
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
}

export function rowToPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id,
    name: row.name,
    agentKinds: JSON.parse(row.agent_kinds) as Pipeline['agentKinds'],
    ...(row.gates ? { gates: JSON.parse(row.gates) as boolean[] } : {}),
    ...(row.thresholds ? { thresholds: JSON.parse(row.thresholds) as Pipeline['thresholds'] } : {}),
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
    steps: detail.steps ?? [],
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
    steps: instance.steps,
    currentStep: instance.currentStep,
    initiatedBy: instance.initiatedBy ?? null,
  } satisfies ExecutionDetail)
}
