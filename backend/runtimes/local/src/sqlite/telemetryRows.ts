import {
  type AgentContextFile,
  type AgentContextFragment,
  type AgentContextSnapshot,
  type AgentSearchQuery,
  type AgentToolCall,
  type LlmCallMetric,
} from '@cat-factory/kernel'
import { isWebSearchProvider } from '@cat-factory/contracts'

// The stored ROW shapes of the four run-scoped telemetry sinks, and the mappers that turn each
// back into its kernel entity.
//
// Extracted from `telemetryStore.ts` so both readers of these tables can share them without one
// importing the other: the store's own repositories, and `telemetryIngestReader.ts`, which walks
// the same tables for the mothership-mode upstream sync. Keeping them here is what stops that
// pairing becoming an import cycle.
//
// Each row shape mirrors the D1 telemetry database column-for-column (D1 IS SQLite), so a
// mothership-mode node reads its local telemetry exactly as a Cloudflare deployment reads its own.

export interface MetricRow {
  id: string
  workspace_id: string
  execution_id: string | null
  agent_kind: string
  provider: string
  model: string
  created_at: number
  streaming: number
  message_count: number
  tool_count: number
  request_max_tokens: number | null
  prompt_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  completion_tokens: number
  total_tokens: number
  finish_reason: string | null
  upstream_ms: number
  overhead_ms: number
  total_ms: number
  ok: number
  http_status: number | null
  error_message: string | null
  prompt_text: string
  prompt_prefix_count: number
  prompt_hash: string
  response_text: string
  reasoning_text: string
  phase: string
  turn_index: number | null
}

export function rowToMetric(row: MetricRow): LlmCallMetric {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    streaming: row.streaming === 1,
    messageCount: row.message_count,
    toolCount: row.tool_count,
    requestMaxTokens: row.request_max_tokens,
    promptTokens: row.prompt_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    finishReason: row.finish_reason,
    upstreamMs: row.upstream_ms,
    overheadMs: row.overhead_ms,
    totalMs: row.total_ms,
    ok: row.ok === 1,
    httpStatus: row.http_status,
    errorMessage: row.error_message,
    promptText: row.prompt_text,
    promptPrefixCount: row.prompt_prefix_count,
    promptHash: row.prompt_hash,
    responseText: row.response_text,
    reasoningText: row.reasoning_text,
    phase: row.phase,
    turnIndex: row.turn_index,
  }
}

function parseArray<T>(text: string): T[] {
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export interface SnapshotRow {
  id: string
  workspace_id: string
  execution_id: string
  agent_kind: string
  step_index: number
  created_at: number
  model: string | null
  harness: string | null
  system_prompt: string
  user_prompt: string
  fragments: string
  context_files: string
  extras: string
}

export function rowToSnapshot(row: SnapshotRow): AgentContextSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    stepIndex: row.step_index,
    createdAt: row.created_at,
    model: row.model,
    harness: row.harness,
    systemPrompt: row.system_prompt,
    userPrompt: row.user_prompt,
    fragments: parseArray<AgentContextFragment>(row.fragments),
    contextFiles: parseArray<AgentContextFile>(row.context_files),
    extras: parseObject(row.extras),
  }
}

export interface SearchQueryRow {
  id: string
  workspace_id: string
  execution_id: string
  agent_kind: string
  provider: string | null
  query: string
  result_count: number
  created_at: number
}

export interface ToolCallRow {
  id: string
  workspace_id: string
  execution_id: string
  agent_kind: string
  job_id: string
  seq: number
  tool: string
  started_at: number
  ended_at: number
  ok: number
  bodies: string
  args: string
  result: string
  args_dropped: number
  result_dropped: number
  created_at: number
}

export function rowToToolCall(row: ToolCallRow): AgentToolCall {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    jobId: row.job_id,
    seq: row.seq,
    tool: row.tool,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ok: row.ok === 1,
    // The stored column is free-text; narrow it back to the wire union. Anything else reads as
    // `withheld`, the answer that claims nothing about a body we cannot account for.
    bodies: row.bodies === 'stored' ? 'stored' : 'withheld',
    args: row.args,
    result: row.result,
    argsDropped: row.args_dropped,
    resultDropped: row.result_dropped,
    createdAt: row.created_at,
  }
}

export function rowToQuery(row: SearchQueryRow): AgentSearchQuery {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    // The stored provider column is free-text TEXT; narrow it back to the wire union.
    provider: isWebSearchProvider(row.provider) ? row.provider : null,
    query: row.query,
    resultCount: row.result_count,
    createdAt: row.created_at,
  }
}
