// Persistence port for agent-context observability. The per-call LLM telemetry
// (see llm-metrics.ts) captures what the model received on each proxied call, but it
// does NOT capture the complete context a container agent was *provided* before it
// ran: the fully fragment-composed system prompt, the assembled user prompt, the
// best-practice fragment bodies folded in, and — the real gap — the files injected
// into the container (`.cat-context/*`, full bodies of linked docs/tracker issues),
// which the agent reads via tools during the run and which never surface in proxy
// telemetry. One snapshot is recorded per container-agent dispatch (per step
// attempt). It lives in the isolated telemetry store alongside `llm_call_metrics`
// (a separate D1 database on Cloudflare, a `telemetry` Postgres schema on Node) and
// rides the same retention window. The domain depends only on this interface; each
// runtime facade implements it.

/** One file injected into the agent's container as context, with its full body. */
export interface AgentContextFile {
  /** Sanitized basename the file is materialised under in the checkout (`.cat-context/<path>`). */
  path: string
  title: string
  url: string
  /** The full file body as written into the container. */
  content: string
}

/** One best-practice fragment folded into the agent's system prompt. */
export interface AgentContextFragment {
  id: string
  /** The fragment body that was appended to the system prompt. */
  body: string
}

/**
 * The complete, redacted context provided to one container-agent dispatch. A
 * deliberate allow-list projection of the dispatched job body + run context — it
 * NEVER carries credentials (the GitHub token, the proxy session token, a leased
 * subscription token, or the clone URL that embeds them).
 */
export interface AgentContextSnapshot {
  id: string
  workspaceId: string
  /** The run this dispatch belongs to. */
  executionId: string
  agentKind: string
  /** The step's index within the run's pipeline (keys the snapshot to a step). */
  stepIndex: number
  /** When the dispatch was captured (epoch ms). */
  createdAt: number
  /** The resolved model id the step ran on (`provider:model`), or null. */
  model: string | null
  /** The harness the job ran under (`pi` | `claude-code` | `codex`), or null. */
  harness: string | null
  /** The fully fragment-composed system prompt sent to the harness. */
  systemPrompt: string
  /** The assembled user prompt sent to the harness (with materialised context refs). */
  userPrompt: string
  /** The best-practice fragments folded into the system prompt (id + body). */
  fragments: AgentContextFragment[]
  /** The files injected into the container as context, with full content. */
  contextFiles: AgentContextFile[]
  /**
   * Redacted structural bits useful for debugging — repo owner/name/branches, the
   * web-search flag, the infra spec, the run's decisions and revision feedback.
   * Never any token, secret, or credential-bearing URL.
   */
  extras: Record<string, unknown>
}

/**
 * The fields the dispatch site hands to the recorder. The service assigns the `id`
 * and `createdAt`, so they are omitted here. `stepIndex` keys the snapshot to a step.
 */
export type RecordAgentContextInput = Omit<AgentContextSnapshot, 'id' | 'createdAt'>

/**
 * The recorder the container-agent dispatch site calls (best-effort, after dispatch).
 * The implementation gates on the deployment's prompt-recording switch AND the
 * workspace's `storeAgentContext` setting, then persists via the repository below.
 * Defined here so the server-layer executor depends only on this interface.
 */
export interface AgentContextRecorder {
  record(input: RecordAgentContextInput): Promise<void>
}

export interface AgentContextSnapshotRepository {
  /** Append one captured dispatch context. */
  record(snapshot: AgentContextSnapshot): Promise<void>
  /** Snapshots recorded for a run, newest first. */
  listByExecution(workspaceId: string, executionId: string): Promise<AgentContextSnapshot[]>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many were
   * removed. The full prompt + injected-file bodies make this heavy, so it is pruned
   * to the same window as the per-call LLM telemetry.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
