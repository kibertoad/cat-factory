import { isObject, numberOf } from './claude-stream.js'
import type { HarnessCallMetric } from './pi.js'

// How a subscription CLI's TWO token channels are reconciled into the per-call rows the backend
// stores: the per-turn usage the stream narrates, and the cumulative total the terminal `result`
// event reports. They disagree routinely and in a specific direction, so the reconciliation is a
// concern of its own rather than a helper beside the stream reader that happens to need it.
//
// Split out of `agent-runner.ts` when it hit its size budget.

/**
 * Read Claude Code's terminal cumulative usage.
 *
 * Counts every input bucket Anthropic bills: fresh input plus BOTH cache reads and cache writes
 * (`cache_creation_input_tokens`), which are real consumed tokens and are the dominant share on a
 * long agent run. Omitting them under-weights a token's true load in the usage-aware rotation
 * window. `undefined` when the event carried no usage at all, so a caller can tell that from a
 * genuine zero.
 */
export function claudeUsage(
  raw: unknown,
): { inputTokens: number; outputTokens: number } | undefined {
  if (!isObject(raw)) return undefined
  const input =
    numberOf(raw.input_tokens) +
    numberOf(raw.cache_read_input_tokens) +
    numberOf(raw.cache_creation_input_tokens)
  const output = numberOf(raw.output_tokens)
  if (input === 0 && output === 0) return undefined
  return { inputTokens: input, outputTokens: output }
}

/**
 * Pin whatever the per-turn channel did NOT account for onto the LAST call: the terminal
 * cumulative usage minus the sum of the turns already costed, computed PER SIDE.
 *
 * The per-side part is the whole point, and it replaced an all-or-nothing guard
 * (`calls.some(c => c.inputTokens > 0 || c.outputTokens > 0)` ⇒ return) that only ever fired for a
 * CLI reporting no per-turn usage at all. Claude Code reports plenty: its `assistant` envelopes
 * carry the message-START usage snapshot, whose INPUT and cache counts are final and whose
 * `output_tokens` is the 1-5 tokens produced when the message opened. So the guard saw costed
 * turns, returned, and the run's whole output side stayed at that snapshot. Measured on a real
 * board: a `coder` step recorded 198 output tokens across 34 calls against the 14,033 the terminal
 * `result` event reported, an `initiative-analyst` 531 against 30,471. Input matched the terminal
 * figure exactly, which is what made the shortfall invisible to a check that asked whether ANY
 * tokens had been reported.
 *
 * {@link claudeUsage} sums every billed input bucket, so the already-accounted input is the sum of
 * all THREE per-call input classes, not `inputTokens` (fresh) alone. A residual input shortfall
 * lands on `inputTokens` because nothing in the terminal event says which class it belonged to;
 * that is the same attribution the previous code made when it pinned an uncosted run's whole
 * total, so no run gets a worse answer than it had.
 *
 * Clamped at 0 per side: a CLI whose terminal figure is LOWER than its own per-turn sum has
 * reported the two inconsistently, and negative spend is not a thing to record. A run whose turns
 * already add up to the terminal total is left untouched, so nothing is double counted.
 *
 * The sibling rule on the inline path is `CliInlineLanguageModel.fileUnaccounted`, which files the
 * shortfall as its own step-level row because it has no last call to grow. Both exist so a
 * partially-costed run reports what it spent rather than what its narration happened to mention.
 */
export function attributeCumulativeUsage(
  calls: HarnessCallMetric[],
  usage: { inputTokens: number; outputTokens: number } | undefined,
): void {
  if (!usage || calls.length === 0) return
  let accountedInput = 0
  let accountedOutput = 0
  for (const call of calls) {
    accountedInput += call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens
    accountedOutput += call.outputTokens
  }
  const inputShort = Math.max(0, usage.inputTokens - accountedInput)
  const outputShort = Math.max(0, usage.outputTokens - accountedOutput)
  if (!inputShort && !outputShort) return
  const last = calls[calls.length - 1]!
  last.inputTokens += inputShort
  last.outputTokens += outputShort
}
