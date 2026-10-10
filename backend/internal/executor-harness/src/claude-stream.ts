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
 * The text a `tool_result` block carries. The CLI writes it either as a bare string or as an
 * array of content blocks (the shape a subagent's terminal report arrives in), so both are read
 * here rather than at each call site. Non-text blocks (an image a tool returned) contribute
 * nothing. Returns '' when the block carries no readable text.
 *
 * This is what makes a parallel subagent's work observable to the harness at all: the parent
 * stream shows a subagent's dispatch and its terminal `tool_result` and nothing in between, so
 * this text is the ONLY place its findings surface outside its own untailed transcript.
 */
export function claudeToolResultText(block: Record<string, unknown>): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (isObject(part) && part.type === 'text' && typeof part.text === 'string') text += part.text
  }
  return text
}

/**
 * Per-CALL token usage off a Claude `assistant` message's `usage` (this turn only, not
 * the cumulative `result` total).
 *
 * Anthropic reports all three input classes SEPARATELY and `input_tokens` is already
 * exclusive of both caches, so the three fields here are orthogonal and additive:
 * total input = `inputTokens + cacheReadTokens + cacheWriteTokens`. Do NOT re-lump the
 * reads and the writes — a cache write costs 1.25–2× base input while a read costs ~0.1×,
 * so a turn that keeps invalidating the prefix and one that rides a warm cache are
 * indistinguishable once they are summed.
 */
export function claudeCallUsage(raw: unknown): {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
} {
  if (!isObject(raw))
    return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  return {
    inputTokens: numberOf(raw.input_tokens),
    cacheReadTokens: numberOf(raw.cache_read_input_tokens),
    cacheWriteTokens: numberOf(raw.cache_creation_input_tokens),
    outputTokens: numberOf(raw.output_tokens),
  }
}
