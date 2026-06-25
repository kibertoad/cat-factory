import type {
  AgentContextRecorder,
  AgentContextSnapshot,
  AgentContextSnapshotRepository,
  Clock,
  IdGenerator,
  RecordAgentContextInput,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'

/**
 * Defensive upper bound (characters) on any single stored body — a prompt or one
 * injected file. Real agent context sits far below this; the cap exists only so a
 * pathological body can't blow past the store's per-value limit and make the whole
 * snapshot fail to record. A truncated-but-recorded body beats a dropped one.
 */
export const MAX_AGENT_CONTEXT_CHARS = 512 * 1024

function clamp(text: string): string {
  if (text.length <= MAX_AGENT_CONTEXT_CHARS) return text
  return `${text.slice(0, MAX_AGENT_CONTEXT_CHARS)}\n…[truncated ${text.length - MAX_AGENT_CONTEXT_CHARS} chars]`
}

export interface AgentContextObservabilityServiceDependencies {
  agentContextSnapshotRepository: AgentContextSnapshotRepository
  workspaceSettingsRepository: WorkspaceSettingsRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * The deployment's prompt-recording switch (`LLM_RECORD_PROMPTS`, default true). When
   * false the operator has opted out of retaining prompt text, so the full agent
   * context (prompts + injected file bodies) is NOT stored either — the operator
   * opt-out wins over the per-workspace toggle.
   */
  recordPrompts?: boolean
}

/**
 * The agent-context observability sink. The container-agent dispatch site (the
 * {@link ContainerAgentExecutor}) calls {@link record} best-effort after dispatch with
 * the assembled, redacted context (composed system + user prompts, folded-in fragment
 * bodies, the files injected into the container). The sibling of
 * {@link LlmObservabilityService}: that keeps what the model received per call, this
 * keeps the complete context the agent was provided — including the `.cat-context`
 * files the agent reads via tools, which never reach proxy telemetry.
 *
 * Storing is gated twice: the deployment-wide prompt-recording switch
 * ({@link recordPrompts}) AND the per-workspace `storeAgentContext` setting must both be
 * enabled. Wired only when a snapshot repository is present, so tests and unconfigured
 * facades collect nothing.
 */
export class AgentContextObservabilityService implements AgentContextRecorder {
  private readonly repository: AgentContextSnapshotRepository
  private readonly settings: WorkspaceSettingsRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly recordPrompts: boolean

  constructor({
    agentContextSnapshotRepository,
    workspaceSettingsRepository,
    idGenerator,
    clock,
    recordPrompts = true,
  }: AgentContextObservabilityServiceDependencies) {
    this.repository = agentContextSnapshotRepository
    this.settings = workspaceSettingsRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.recordPrompts = recordPrompts
  }

  /**
   * Persist one dispatch's context, assigning its id + timestamp. Returns without
   * storing when prompt recording is disabled deployment-wide or the workspace has
   * turned `storeAgentContext` off. Bodies are clamped so an oversized prompt/file
   * never drops the whole snapshot.
   */
  async record(input: RecordAgentContextInput): Promise<void> {
    if (!this.recordPrompts) return
    if (!(await this.storeEnabled(input.workspaceId))) return
    const snapshot: AgentContextSnapshot = {
      ...input,
      id: this.idGenerator.next('ctx'),
      createdAt: this.clock.now(),
      systemPrompt: clamp(input.systemPrompt),
      userPrompt: clamp(input.userPrompt),
      fragments: input.fragments.map((f) => ({ id: f.id, body: clamp(f.body) })),
      contextFiles: input.contextFiles.map((f) => ({ ...f, content: clamp(f.content) })),
    }
    await this.repository.record(snapshot)
  }

  /** Snapshots recorded for a run, newest first (for the observability drill-down). */
  listByExecution(workspaceId: string, executionId: string): Promise<AgentContextSnapshot[]> {
    return this.repository.listByExecution(workspaceId, executionId)
  }

  private async storeEnabled(workspaceId: string): Promise<boolean> {
    const settings = (await this.settings.get(workspaceId)) ?? DEFAULT_WORKSPACE_SETTINGS
    return settings.storeAgentContext
  }
}
