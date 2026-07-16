import * as v from 'valibot'
import { webSearchProviderSchema } from './entities.js'

// Wire contracts for LLM observability — the per-call detail behind the board's
// step rollups (see `stepMetricsSchema` in entities). The proxy records one of
// these per model call (full prompt + response, output-limit headroom, the
// transport-vs-execution latency split); the drill-down panel lists them and the
// export endpoint returns an LLM-analysable bundle.

/** One proxied LLM call, with its full prompt/response and timing breakdown. */
export const llmCallMetricSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  executionId: v.nullable(v.string()),
  agentKind: v.string(),
  provider: v.string(),
  model: v.string(),
  /** When the call completed (epoch ms). */
  createdAt: v.number(),
  streaming: v.boolean(),
  messageCount: v.number(),
  /** Tools offered to the model (0 = the agent could not edit anything). */
  toolCount: v.number(),
  /** The `max_tokens` the request asked for (the output ceiling), or null. */
  requestMaxTokens: v.nullable(v.number()),
  promptTokens: v.number(),
  /** Prompt tokens served from the prefix cache (subset on OpenAI/DeepSeek; may exceed promptTokens on Anthropic, which reports cache reads separately). */
  cachedPromptTokens: v.optional(v.number(), 0),
  completionTokens: v.number(),
  totalTokens: v.number(),
  /** Upstream finish reason (`stop` | `length` | `tool_calls` | `content_filter` | …). */
  finishReason: v.nullable(v.string()),
  /** Time waiting on the model (ms) — the actual execution. */
  upstreamMs: v.number(),
  /** Transport/proxy overhead (ms). */
  overheadMs: v.number(),
  /** End-to-end time the proxy spent on the call (ms). */
  totalMs: v.number(),
  ok: v.boolean(),
  httpStatus: v.nullable(v.number()),
  errorMessage: v.nullable(v.string()),
  /**
   * The request messages serialised as JSON, stored as a DELTA — only the messages
   * this call appended beyond `promptPrefixCount` (the full array when that is 0).
   * The export rebuilds the full prompt from a chain's deltas.
   */
  promptText: v.string(),
  /**
   * Leading messages elided from `promptText` (stored by an earlier call in the same
   * conversation). 0 ⇒ `promptText` is the full array. Optional/defaulted so exports
   * predating delta storage still parse.
   */
  promptPrefixCount: v.optional(v.number(), 0),
  /** Hash of the call's full messages array (chain key for the next call's delta). */
  promptHash: v.optional(v.string(), ''),
  /** The full assistant response text. */
  responseText: v.string(),
  /**
   * The model's reasoning / "thinking" trace on a separate channel, when emitted
   * (empty for non-reasoning models). Optional/defaulted so exports predating reasoning
   * capture still parse.
   */
  reasoningText: v.optional(v.string(), ''),
})
export type LlmCallMetric = v.InferOutput<typeof llmCallMetricSchema>

/**
 * The compact per-call summary pushed live over the workspace event stream (the
 * `llmCall` {@link WorkspaceEvent}). It is {@link llmCallMetricSchema} WITHOUT the
 * heavy text bodies (`promptText`/`responseText`) and the delta bookkeeping
 * (`promptPrefixCount`/`promptHash`), so a stalled-driver "is the agent still
 * calling the model?" view updates in real time without shipping prompt bytes over
 * the socket. The drill-down panel lazy-loads the full bodies for an expanded row
 * from `GET /executions/:id/llm-metrics` (the persisted store), keyed by the shared
 * call `id`.
 */
export const llmCallActivitySchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  executionId: v.nullable(v.string()),
  agentKind: v.string(),
  provider: v.string(),
  model: v.string(),
  createdAt: v.number(),
  streaming: v.boolean(),
  messageCount: v.number(),
  toolCount: v.number(),
  requestMaxTokens: v.nullable(v.number()),
  promptTokens: v.number(),
  // Always supplied by the proxy emit (unlike the persisted metric, which defaults it
  // for rows that predate delta storage), so it is required here — matching the SPA's
  // `LlmCallActivity` type, which derives it as a required field from `LlmCallMetric`.
  cachedPromptTokens: v.number(),
  completionTokens: v.number(),
  totalTokens: v.number(),
  finishReason: v.nullable(v.string()),
  upstreamMs: v.number(),
  overheadMs: v.number(),
  totalMs: v.number(),
  ok: v.boolean(),
  httpStatus: v.nullable(v.number()),
  errorMessage: v.nullable(v.string()),
})
export type LlmCallActivity = v.InferOutput<typeof llmCallActivitySchema>

/** Response of `GET /workspaces/:ws/executions/:id/llm-metrics` (drill-down panel). */
export const llmMetricsResponseSchema = v.object({
  executionId: v.string(),
  calls: v.array(llmCallMetricSchema),
})
export type LlmMetricsResponse = v.InferOutput<typeof llmMetricsResponseSchema>

/**
 * A single per-agent-kind insight in the LLM-friendly export: the same rollup the
 * board step shows, plus derived ratios so an analysing model needs no arithmetic.
 */
export const llmExportInsightSchema = v.object({
  agentKind: v.string(),
  calls: v.number(),
  promptTokens: v.number(),
  /** Prompt tokens served from the prefix cache (subset on OpenAI/DeepSeek; may exceed promptTokens on Anthropic, which reports cache reads separately). */
  cachedPromptTokens: v.number(),
  /** cachedPromptTokens / promptTokens, 0..1; null when there were no prompt tokens. */
  cacheHitRate: v.nullable(v.number()),
  completionTokens: v.number(),
  peakCompletionTokens: v.number(),
  maxOutputTokens: v.nullable(v.number()),
  /** peakCompletionTokens / maxOutputTokens, 0..1; null when the ceiling is unknown. */
  outputHeadroomRatio: v.nullable(v.number()),
  truncatedCalls: v.number(),
  upstreamMs: v.number(),
  overheadMs: v.number(),
  /** overheadMs / (upstreamMs + overheadMs), 0..1; the share spent in transport. */
  transportOverheadRatio: v.nullable(v.number()),
  errors: v.number(),
  warnings: v.number(),
})
export type LlmExportInsight = v.InferOutput<typeof llmExportInsightSchema>

/**
 * LLM-friendly export of a run's model activity: a self-describing, structured JSON
 * bundle (totals + per-agent insights + every call) intended to be handed straight
 * to a model for analysis ("why did this run truncate / spend / stall?"). Field
 * names and derived ratios are explicit so no external context is needed.
 */
export const llmMetricsExportSchema = v.object({
  /** Schema marker so a consuming model knows the shape. */
  kind: v.literal('cat-factory.llm-metrics-export'),
  version: v.literal(1),
  executionId: v.string(),
  generatedAt: v.number(),
  totals: v.object({
    calls: v.number(),
    promptTokens: v.number(),
    /** Prompt tokens served from the prefix cache (subset on OpenAI/DeepSeek; may exceed promptTokens on Anthropic, which reports cache reads separately). */
    cachedPromptTokens: v.number(),
    /** cachedPromptTokens / promptTokens, 0..1; null when there were no prompt tokens. */
    cacheHitRate: v.nullable(v.number()),
    completionTokens: v.number(),
    upstreamMs: v.number(),
    overheadMs: v.number(),
    /** Share of total latency spent in transport/proxy (0..1), or null with no timing. */
    transportOverheadRatio: v.nullable(v.number()),
    errors: v.number(),
    warnings: v.number(),
    truncatedCalls: v.number(),
  }),
  insights: v.array(llmExportInsightSchema),
  calls: v.array(llmCallMetricSchema),
})
export type LlmMetricsExport = v.InferOutput<typeof llmMetricsExportSchema>

// ---------------------------------------------------------------------------
// Agent-context observability: the complete, redacted context one container-agent
// dispatch was *provided* (composed prompts + folded fragments + injected files).
// These schemas are the single source of truth for the shape: the kernel
// `agent-context` port derives its types from them, and the execution route
// contract reuses them as its response body, so the wire shape and the port can't
// drift.
// ---------------------------------------------------------------------------

/** One file injected into the agent's container as context, with its full body. */
export const agentContextFileSchema = v.object({
  /** Sanitized basename the file is materialised under (`.cat-context/<path>`). */
  path: v.string(),
  title: v.string(),
  url: v.string(),
  /** The full file body as written into the container. */
  content: v.string(),
})
export type AgentContextFile = v.InferOutput<typeof agentContextFileSchema>

/** One best-practice fragment folded into the agent's system prompt. */
export const agentContextFragmentSchema = v.object({
  id: v.string(),
  /** The fragment body that was appended to the system prompt. */
  body: v.string(),
})
export type AgentContextFragment = v.InferOutput<typeof agentContextFragmentSchema>

/**
 * The complete, redacted context provided to one container-agent dispatch. A
 * deliberate allow-list projection of the dispatched job body + run context — it
 * NEVER carries credentials.
 */
export const agentContextSnapshotSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  /** The run this dispatch belongs to. */
  executionId: v.string(),
  agentKind: v.string(),
  /** The step's index within the run's pipeline (keys the snapshot to a step). */
  stepIndex: v.number(),
  /** When the dispatch was captured (epoch ms). */
  createdAt: v.number(),
  /** The resolved model id the step ran on (`provider:model`), or null. */
  model: v.nullable(v.string()),
  /** The harness the job ran under (`pi` | `claude-code` | `codex`), or null. */
  harness: v.nullable(v.string()),
  /** The fully fragment-composed system prompt sent to the harness. */
  systemPrompt: v.string(),
  /** The assembled user prompt sent to the harness (with materialised context refs). */
  userPrompt: v.string(),
  /** The best-practice fragments folded into the system prompt (id + body). */
  fragments: v.array(agentContextFragmentSchema),
  /** The files injected into the container as context, with full content. */
  contextFiles: v.array(agentContextFileSchema),
  /**
   * Redacted structural bits useful for debugging — repo owner/name/branches, the
   * web-search flag, the infra spec, the run's decisions and revision feedback.
   * Never any token, secret, or credential-bearing URL.
   */
  extras: v.record(v.string(), v.unknown()),
})
export type AgentContextSnapshot = v.InferOutput<typeof agentContextSnapshotSchema>

// ---------------------------------------------------------------------------
// Agent-search-query observability: one row per web search a container agent
// performed through the backend search proxy. Recorded best-effort, gated by the
// same double switch as agent-context snapshots (the deployment `LLM_RECORD_PROMPTS`
// AND the per-workspace `storeAgentContext` setting), and pruned on the same
// telemetry retention window. Surfaced on demand in the observability drill-down.
// ---------------------------------------------------------------------------

/** One web search a container agent performed during a run, via the search proxy. */
export const agentSearchQuerySchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  /** The run this search belongs to. */
  executionId: v.string(),
  /** The agent kind that issued the search (`coder`, `ci-fixer`, …). */
  agentKind: v.string(),
  /** The upstream backend that served the search, or null when it couldn't be resolved. */
  provider: v.nullable(webSearchProviderSchema),
  /** The search query text as issued to the upstream. */
  query: v.string(),
  /** How many results the upstream returned (0 on an upstream failure). */
  resultCount: v.number(),
  /** When the search was performed (epoch ms). */
  createdAt: v.number(),
})
export type AgentSearchQuery = v.InferOutput<typeof agentSearchQuerySchema>

// ---------------------------------------------------------------------------
// Platform-operator observability: deployment-level aggregate health, the dual of
// the per-run detail above. Where the schemas above describe ONE run, these describe
// the WHOLE deployment (scoped to an account) over a time window — run outcomes,
// failure taxonomy, live/parked depth, duration stats + a bucketed trend. Every
// number is a SQL rollup over `agent_runs` behind the kernel `PlatformMetricsRepository`
// port; this schema is the wire projection the admin dashboard renders.
// ---------------------------------------------------------------------------

/** The time window the dashboard aggregates over. */
export const platformObservabilityWindowSchema = v.picklist(['1h', '24h', '7d'])
export type PlatformObservabilityWindow = v.InferOutput<typeof platformObservabilityWindowSchema>

/** Run-outcome totals over the window (each a status bucket, plus the derived success rate). */
export const platformOutcomeTotalsSchema = v.object({
  /** All runs created in the window. */
  total: v.number(),
  done: v.number(),
  failed: v.number(),
  running: v.number(),
  blocked: v.number(),
  paused: v.number(),
  /** Anything not one of the above (e.g. `pending`). */
  other: v.number(),
  /** `done / (done + failed)`, 0..1; null when no run reached a terminal outcome. */
  successRate: v.nullable(v.number()),
})
export type PlatformOutcomeTotals = v.InferOutput<typeof platformOutcomeTotalsSchema>

/** One contiguous time bucket of the outcome trend (zero-filled, oldest first). */
export const platformTrendPointSchema = v.object({
  /** Epoch-ms start of the bucket. */
  start: v.number(),
  done: v.number(),
  failed: v.number(),
  /** Every other status in the bucket (running/blocked/paused/pending). */
  other: v.number(),
})
export type PlatformTrendPoint = v.InferOutput<typeof platformTrendPointSchema>

/** One failure-kind slice of the failed-run taxonomy. */
export const platformFailureSliceSchema = v.object({
  /** The `agentFailureKind` (or `unknown`); kept as a string so an out-of-enum value still renders. */
  kind: v.string(),
  count: v.number(),
})
export type PlatformFailureSlice = v.InferOutput<typeof platformFailureSliceSchema>

/** The complete deployment-health projection the admin dashboard renders. */
export const platformObservabilitySchema = v.object({
  window: platformObservabilityWindowSchema,
  /** When the projection was computed (epoch ms). */
  generatedAt: v.number(),
  /** Start of the window (epoch ms) — `generatedAt - window`. */
  since: v.number(),
  outcomes: platformOutcomeTotalsSchema,
  trend: v.object({
    /** Width of each trend bucket (ms). */
    bucketMs: v.number(),
    points: v.array(platformTrendPointSchema),
  }),
  /** Failure taxonomy over the window, most frequent first. */
  failures: v.array(platformFailureSliceSchema),
  /** Live/parked run depth right now (a snapshot, not windowed). */
  live: v.object({
    running: v.number(),
    blocked: v.number(),
    paused: v.number(),
    pending: v.number(),
  }),
  /** Wall-clock duration over terminal runs in the window (ms). */
  durations: v.object({
    count: v.number(),
    avgMs: v.nullable(v.number()),
    minMs: v.nullable(v.number()),
    maxMs: v.nullable(v.number()),
  }),
})
export type PlatformObservability = v.InferOutput<typeof platformObservabilitySchema>
