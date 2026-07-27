import { redact } from './redact.js'

// Shared parsing of Claude Code's stream-json / session-transcript envelope. The parent
// runner (`agent-runner.ts`) reads these off the CLI's stdout; the subagent watcher
// (`subagents.ts`) reads the same shapes off the `subagents/*.jsonl` transcripts. Kept in
// one place so both read usage/content identically and the cycle between the two modules
// is broken.

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The tool names the Claude Code CLI dispatches a parallel subagent under. `Agent` is what the
 * shipped schema declares (`AgentInput` in `sdk-tools.d.ts`, carrying `description` / `prompt` /
 * `subagent_type`); `Task` is the older name for the same dispatch. Both are matched because the
 * harness runs against whatever CLI the image happens to bundle, and matching only the old name
 * is what left a CLI 2.1.x pr-review reporting no slices at all.
 *
 * Note the asymmetry: keeping the legacy `Task` here is the one place a CLI rename could produce a
 * FALSE signal rather than merely no signal — if a future build were to name a plain task-list
 * tool `Task`, its writes would be counted as in-flight slices. We accept that because no shipped
 * build does (the incremental plan tool is `TaskCreate`/`TaskUpdate`, tracked separately in
 * `progress.ts`), and dropping legacy coverage is the more likely regression.
 *
 * Lives here rather than in `subagents.ts` because BOTH the slice tracker and the no-progress
 * guard (`pi.ts`, which `subagents.ts` imports — so it cannot import back) must agree on what a
 * subagent dispatch looks like.
 */
export const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task'])

export function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Scrub any leased-credential occurrences from a telemetry body (no-op when none). */
export function redactBody(text: string, secrets: string[]): string {
  return secrets.length ? redact(text, secrets) : text
}

/** Pull the text + reasoning out of a Claude `assistant` message's content blocks. */
export function claudeAssistantContent(content: unknown[]): {
  text: string
  reasoning: string
  toolUses: number
} {
  let text = ''
  let reasoning = ''
  let toolUses = 0
  for (const block of content) {
    if (!isObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
    else if (block.type === 'thinking' && typeof block.thinking === 'string')
      reasoning += block.thinking
    else if (block.type === 'tool_use') toolUses += 1
  }
  return { text, reasoning, toolUses }
}

/**
 * Per-CALL token usage off a Claude `assistant` message's `usage` (this turn only, not
 * the cumulative `result` total). `inputTokens` counts every billed input bucket (fresh
 * + both cache buckets); `cachedInputTokens` is the cache share, surfaced separately.
 */
export function claudeCallUsage(raw: unknown): {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
} {
  if (!isObject(raw)) return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  const cached = numberOf(raw.cache_read_input_tokens) + numberOf(raw.cache_creation_input_tokens)
  return {
    inputTokens: numberOf(raw.input_tokens) + cached,
    cachedInputTokens: cached,
    outputTokens: numberOf(raw.output_tokens),
  }
}
