import type {
  AgentContextRecorder,
  AgentContextSnapshot,
  AgentContextSnapshotRepository,
  Clock,
  IdGenerator,
  RecordAgentContextInput,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import {
  DEFAULT_WORKSPACE_SETTINGS,
  isSecretShapedFilename,
  redactSecrets,
  redactSecretsDeep,
} from '@cat-factory/kernel'

/**
 * Defensive upper bound (characters) on any single stored body — a prompt or one
 * injected file. Real agent context sits far below this; the cap exists only so a
 * pathological body can't blow past the store's per-value limit and make the whole
 * snapshot fail to record. A truncated-but-recorded body beats a dropped one.
 */
export const MAX_AGENT_CONTEXT_CHARS = 512 * 1024

/**
 * Aggregate ceiling (characters) across ALL bodies in one snapshot — both prompts plus
 * every fragment and every injected file. The per-body {@link MAX_AGENT_CONTEXT_CHARS}
 * cap bounds a single pathological value, but a dispatch that injects many large files
 * could still assemble a multi-megabyte row. Recording is best-effort and swallowed at
 * the call site, so an oversized row the store rejects would silently drop the WHOLE
 * snapshot. This bounds the row instead. Bodies are filled in priority order (the
 * prompts first), so the most useful context survives when the budget is reached.
 */
export const MAX_AGENT_CONTEXT_TOTAL_CHARS = 4 * 1024 * 1024

function clamp(text: string): string {
  if (text.length <= MAX_AGENT_CONTEXT_CHARS) return text
  return `${text.slice(0, MAX_AGENT_CONTEXT_CHARS)}\n…[truncated ${text.length - MAX_AGENT_CONTEXT_CHARS} chars]`
}

/**
 * Stored in place of a secret-bearing file's body. A file whose NAME marks it as a raw
 * credential store (`.env`, `*.pem`, an SSH key, `.npmrc`, …) has no field-name/URL
 * scaffolding for {@link redactSecrets}'s pattern rules to latch onto — a bare PEM block or
 * a `KEY=value` dump would pass through the shape scrub verbatim — so its whole body is
 * dropped rather than persisted.
 */
export const SECRET_FILE_PLACEHOLDER = '[REDACTED: secret-shaped file omitted from snapshot]'

/**
 * A shared character budget for one snapshot. Each call first applies the per-body cap,
 * then trims against the remaining aggregate budget — so the bodies passed earlier (the
 * prompts) are preserved and later ones (trailing injected files) are truncated once the
 * row would grow too large. The trailing marker can push a single body marginally past
 * the budget; the cap is defensive, not exact.
 */
function makeBudget(total = MAX_AGENT_CONTEXT_TOTAL_CHARS): (text: string) => string {
  let remaining = total
  return (text: string): string => {
    const capped = clamp(text)
    if (capped.length <= remaining) {
      remaining -= capped.length
      return capped
    }
    const slice = capped.slice(0, Math.max(0, remaining))
    remaining = 0
    return `${slice}\n…[truncated: snapshot size budget reached]`
  }
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
   * turned `storeAgentContext` off.
   *
   * Every stored body is a defence-in-depth SECRET SCRUB before it lands in the telemetry
   * store: prompts, fragment bodies and injected file contents run through
   * {@link redactSecrets} (a value the dispatch site's allow-list can't fully guarantee is
   * clean — a task description, a linked doc, or an injected file may embed a token), and a
   * file whose NAME marks it as a raw credential store ({@link isSecretShapedFilename}) has
   * its whole body dropped ({@link SECRET_FILE_PLACEHOLDER}), since a bare PEM/`.env` body
   * has no scaffolding for the shape rules to catch. Scrub happens BEFORE the size budget so
   * truncation can never split a secret across the cap and defeat the pattern match. Bodies
   * are then clamped so an oversized prompt/file never drops the whole snapshot.
   *
   * The `extras` bag is deep-scrubbed too ({@link redactSecretsDeep}): several of its values
   * are human-authored free text (the run's decisions, revision feedback) — the SAME token-
   * in-prose risk as a task description — so every string it carries at any depth is scrubbed
   * rather than trusting the dispatch-site allow-list to have kept it clean.
   */
  async record(input: RecordAgentContextInput): Promise<void> {
    if (!this.recordPrompts) return
    if (!(await this.storeEnabled(input.workspaceId))) return
    // One shared budget per snapshot, consumed prompts-first so the most useful context
    // survives if a dispatch injects an unusual amount of file content.
    const budget = makeBudget()
    // Scrub credentials, THEN clamp — a truncated body must never hide a half-cut secret.
    const scrub = (text: string): string => budget(redactSecrets(text) ?? '')
    const snapshot: AgentContextSnapshot = {
      ...input,
      id: this.idGenerator.next('ctx'),
      createdAt: this.clock.now(),
      systemPrompt: scrub(input.systemPrompt),
      userPrompt: scrub(input.userPrompt),
      fragments: input.fragments.map((f) => ({ id: f.id, body: scrub(f.body) })),
      contextFiles: input.contextFiles.map((f) => ({
        ...f,
        content: isSecretShapedFilename(f.path)
          ? budget(SECRET_FILE_PLACEHOLDER)
          : scrub(f.content),
      })),
      // Structural bits, but some values (decisions, revision feedback) are free-text prose
      // that can embed a token — scrub every string in the bag, not just the known bodies.
      extras: redactSecretsDeep(input.extras),
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
