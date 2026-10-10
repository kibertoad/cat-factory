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
 * The row standing for whatever the per-turn channel did NOT account for: the terminal cumulative
 * usage minus the sum of the turns already costed, computed PER SIDE. `undefined` when the turns
 * add up, so nothing is double counted.
 *
 * The per-side part is why this exists at all, and it replaced an all-or-nothing guard
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
 * **It is its OWN row rather than tokens added to the last captured call.** Growing a real turn by
 * thousands of output tokens it did not produce makes a fabricated number indistinguishable from a
 * measured one everywhere a per-call figure is read (`/api/v1/debug/*`, the observability panel, a
 * step's per-call breakdown), and there is nothing on the row to mark it. The sibling rule on the
 * inline path (`CliInlineLanguageModel.fileUnaccounted`) reached that conclusion first and files a
 * step-level row; this is the same answer for the channel that has a call list. {@link
 * HarnessCallMetric.standsForJob} is what keeps it from reading as a turn.
 *
 * **`calls` must be the PARENT loop's alone.** The terminal `result` event's cumulative covers the
 * parent conversation only — a subagent's tokens live in its own transcript — so subtracting a
 * subagent turn's tokens from it understates the shortfall, and pinning the remainder near one
 * would bill a conversation for spend it never saw. Both were live in `ambientAuth` mode, where the
 * CLI streams subagent turns onto the parent's stdout and no transcript watcher runs, so those
 * turns are captured through the same publisher as the parent's.
 *
 * {@link claudeUsage} sums every billed input bucket, so the already-accounted input is the sum of
 * all THREE per-call input classes, not `inputTokens` (fresh) alone. A residual input shortfall
 * lands on `inputTokens` because nothing in the terminal event says which class it belonged to.
 *
 * Clamped at 0 per side: a CLI whose terminal figure is LOWER than its own per-turn sum has
 * reported the two inconsistently, and negative spend is not a thing to record.
 *
 * {@link HarnessCallMetric.spendOnly} is decided HERE, and it is not the same question as
 * `standsForJob`. The row never occupies a turn, but whether it is a CALL depends on whether any
 * turn was narrated beside it: with costed turns present this only corrects THEIR under-reporting
 * (counting it would report one phantom call per dispatch), while with none it is the job's ONLY
 * record and excluding it would report a step that spent tokens across zero calls. Only this
 * function can answer that — the backend records a job's calls in BATCHES as the live drain
 * delivers them, so a batch holding just this row cannot tell the two cases apart.
 */
export function unaccountedUsageCall(
  parentCalls: readonly HarnessCallMetric[],
  usage: { inputTokens: number; outputTokens: number } | undefined,
): HarnessCallMetric | undefined {
  if (!usage) return undefined
  let accountedInput = 0
  let accountedOutput = 0
  for (const call of parentCalls) {
    accountedInput += call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens
    accountedOutput += call.outputTokens
  }
  const inputTokens = Math.max(0, usage.inputTokens - accountedInput)
  const outputTokens = Math.max(0, usage.outputTokens - accountedOutput)
  if (!inputTokens && !outputTokens) return undefined
  return {
    // No `model`: the terminal event names none, and the recorder then files the row under the
    // model the step DISPATCHED, which is the same answer without this claiming to have observed
    // it. (Claude Code serves some turns with a different model, so a guess here misprices.)
    promptText: '',
    messageCount: 0,
    responseText: '',
    reasoningText: '',
    inputTokens,
    // Both 0 rather than a split of `inputTokens`: the terminal figure is one number and says
    // nothing about which input class the remainder belonged to.
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
    finishReason: null,
    standsForJob: true,
    spendOnly: parentCalls.length > 0,
  }
}
