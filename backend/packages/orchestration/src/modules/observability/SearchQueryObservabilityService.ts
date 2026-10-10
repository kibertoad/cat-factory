import type {
  AgentSearchQuery,
  AgentSearchQueryRecorder,
  AgentSearchQueryRepository,
  Clock,
  IdGenerator,
  RecordAgentSearchQueryInput,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'

/**
 * Defensive upper bound (characters) on a stored query. Real search queries sit far
 * below this; the cap exists only so a pathological query can't blow past the store's
 * per-value limit and make the whole row fail to record.
 */
export const MAX_SEARCH_QUERY_CHARS = 8 * 1024

function clamp(text: string): string {
  if (text.length <= MAX_SEARCH_QUERY_CHARS) return text
  return `${text.slice(0, MAX_SEARCH_QUERY_CHARS)}…`
}

export interface SearchQueryObservabilityServiceDependencies {
  agentSearchQueryRepository: AgentSearchQueryRepository
  workspaceSettingsRepository: WorkspaceSettingsRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * The deployment's prompt-recording switch (`LLM_RECORD_PROMPTS`, default true). When
   * false the operator has opted out of retaining prompt/search text, so the performed
   * queries are NOT stored either — the operator opt-out wins over the per-workspace
   * toggle.
   */
  recordPrompts?: boolean
}

/**
 * The agent-search-query observability sink. The container web-search proxy
 * (`webSearchProxyController`) calls {@link record} best-effort after each search the
 * agent performs. A sibling of the {@link AgentContextObservabilityService}: that keeps
 * the complete context the agent was provided, this keeps the searches the agent ran.
 *
 * Storing is gated twice: the deployment-wide prompt-recording switch
 * ({@link recordPrompts}) AND the per-workspace `storeAgentContext` setting must both be
 * enabled. Wired only when a search-query repository is present, so tests and
 * unconfigured facades collect nothing.
 */
export class SearchQueryObservabilityService implements AgentSearchQueryRecorder {
  private readonly repository: AgentSearchQueryRepository
  private readonly settings: WorkspaceSettingsRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly recordPrompts: boolean

  constructor({
    agentSearchQueryRepository,
    workspaceSettingsRepository,
    idGenerator,
    clock,
    recordPrompts = true,
  }: SearchQueryObservabilityServiceDependencies) {
    this.repository = agentSearchQueryRepository
    this.settings = workspaceSettingsRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.recordPrompts = recordPrompts
  }

  /**
   * Persist one performed search query, assigning its id + timestamp. Returns without
   * storing when prompt recording is disabled deployment-wide or the workspace has
   * turned `storeAgentContext` off.
   */
  async record(input: RecordAgentSearchQueryInput): Promise<void> {
    if (!this.recordPrompts) return
    if (!(await this.storeEnabled(input.workspaceId))) return
    const query: AgentSearchQuery = {
      ...input,
      query: clamp(input.query),
      id: this.idGenerator.next('asq'),
      createdAt: this.clock.now(),
    }
    await this.repository.record(query)
  }

  /** Queries recorded for a run, newest first (for the observability drill-down). */
  listByExecution(workspaceId: string, executionId: string): Promise<AgentSearchQuery[]> {
    return this.repository.listByExecution(workspaceId, executionId)
  }

  private async storeEnabled(workspaceId: string): Promise<boolean> {
    const settings = (await this.settings.get(workspaceId)) ?? DEFAULT_WORKSPACE_SETTINGS
    return settings.storeAgentContext
  }
}
