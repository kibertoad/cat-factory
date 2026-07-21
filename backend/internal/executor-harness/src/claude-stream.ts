import { redact } from './redact.js'

// Shared parsing of Claude Code's stream-json / session-transcript envelope. The parent
// runner (`agent-runner.ts`) reads these off the CLI's stdout; the subagent watcher
// (`subagents.ts`) reads the same shapes off the `subagents/*.jsonl` transcripts. Kept in
// one place so both read usage/content identically and the cycle between the two modules
// is broken.

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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
