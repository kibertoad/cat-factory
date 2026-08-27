import type { InputTokenClassCounts } from './llm-rollup.js'
import type { AgentTokenUsage } from '../ports/agent-executor.js'

// How an agent's reported token usage is split into the classes that PRICE it.
//
// Every producer of an {@link AgentTokenUsage} reports one lumped `inputTokens` (the total
// across every billed input class — the figure the ledger stores as the call's volume and the
// key-rotation window weights). The classes behind that total are what a cost is actually a
// function of, and they differ in rate by more than an order of magnitude, so a producer that
// can see the split reports it beside the total and the meter prices per class.

/**
 * Partition a KNOWN total input count across the three classes, from the cache shares a
 * producer reported beside it.
 *
 * The total stays authoritative: it is the volume figure the ledger stores, so the classes it
 * is priced by must sum to exactly it, or the row's cost and its token count describe two
 * different calls. Whatever the cache shares do not claim is therefore FRESH, which is also
 * the conservative reading of a remainder no channel attributed — a producer whose cache
 * shares fall short of its own total has under-reported the cache side, and pricing the gap
 * at the fresh rate over-states rather than under-states it.
 *
 * Shares that OVERSHOOT the total are clamped rather than allowed to mint a negative fresh
 * count: the two channels disagreed, and a negative class would carry that disagreement into
 * the money. Which class absorbs the clamp decides WHICH WAY the disagreement is resolved, so
 * it is settled by RATE, not by argument order: the classes run cache write (~1.25x fresh) >
 * fresh (1x) > cache read (~0.1x), so the write share is honoured whole and the read share
 * takes only what is left. Clamping the dear class first is the same over-state-never-
 * under-state direction the unclaimed remainder is priced in; keeping the cheap class whole
 * instead would resolve a channel disagreement by charging a tenth of the rate, and on
 * `total=1000, read=900, write=400` that is 215 rate-units of input against 560.
 */
export function partitionInputTokens(
  inputTokens: number,
  cache: { cacheReadTokens: number; cacheWriteTokens: number },
): InputTokenClassCounts {
  const total = Math.max(0, inputTokens)
  const cacheWriteTokens = Math.min(Math.max(0, cache.cacheWriteTokens), total)
  const cacheReadTokens = Math.min(Math.max(0, cache.cacheReadTokens), total - cacheWriteTokens)
  return {
    promptTokens: total - cacheReadTokens - cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

/**
 * Sum the usage of two model calls into one, for a producer whose step spends across several
 * calls (a companion's repair retry, a consensus strategy's rounds).
 *
 * The fallback is applied PER PART, never to the aggregate: a part that reported no split
 * contributes its whole input as fresh, which is byte-for-byte the money the lump fallback
 * would charge for that part on its own, and the parts that DID report one keep their classes.
 * So the aggregate carries a split whenever ANY part did.
 *
 * Dropping the split for the whole aggregate as soon as one part lacked it was the earlier
 * rule, on the reasoning that both parts of a real aggregate come from the same producer and
 * so cannot disagree about whether the split is visible. A CONSENSUS PANEL is the aggregate
 * that reasoning does not describe: it is multi-model BY DESIGN, and a provider that reports no
 * cache details at all (`workers-ai-provider` is one) sits happily beside Anthropic
 * participants that report theirs. One such participant re-priced the panel's whole input at
 * the fresh rate, which is the several-fold over-charge classed pricing exists to remove, on
 * the shape whose input is most nearly all cache reads.
 *
 * What the per-part fold gives up is the ability to say WHICH share of the aggregate's fresh
 * count was known-fresh rather than merely unattributed. Nothing reads these counts except the
 * price, which is identical either way for the unattributed part, and the classes still sum to
 * `inputTokens`. `undefined` therefore keeps its meaning at the only grain that can still
 * carry it: no part of this aggregate could see its split.
 */
export function sumAgentTokenUsage(
  a: AgentTokenUsage | undefined,
  b: AgentTokenUsage | undefined,
): AgentTokenUsage | undefined {
  if (!a) return b
  if (!b) return a
  const anyPartSplit = a.inputClasses !== undefined || b.inputClasses !== undefined
  const classes = anyPartSplit ? addClasses(classesOfPart(a), classesOfPart(b)) : undefined
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(classes ? { inputClasses: classes } : {}),
  }
}

/**
 * One part's classes as the fold needs them: its own split, or the lump fallback stated in
 * class terms. Built through {@link partitionInputTokens} with no cache shares rather than by
 * hand, so an unsplit part's whole input lands on the fresh class through the same clamping the
 * split path uses and cannot contribute a negative count.
 */
function classesOfPart(usage: AgentTokenUsage): InputTokenClassCounts {
  return (
    usage.inputClasses ??
    partitionInputTokens(usage.inputTokens, { cacheReadTokens: 0, cacheWriteTokens: 0 })
  )
}

function addClasses(a: InputTokenClassCounts, b: InputTokenClassCounts): InputTokenClassCounts {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}

/**
 * A container job's usage as the meter needs it: the harness's own total input, split by the
 * cache shares its per-call telemetry reported.
 *
 * The two channels answer different questions and only one of them is authoritative about the
 * TOTAL. `usage` is the coarse figure the harness folds for the key-rotation window, counting
 * every billed input bucket; `callMetrics` is the only channel that kept the classes apart, and
 * on some CLIs its per-turn rows do not add up to the terminal cumulative. So the total is taken
 * from `usage` and only the CACHE shares are folded from the calls, leaving any turn the CLI
 * narrated no per-call usage for priced as fresh — under-counting the total would under-charge a
 * budget, which is the one direction a spend gate may not be wrong in.
 *
 * No calls at all (the proxy-metered harness, or a CLI build that streams nothing) ⇒ no split,
 * and the lump is priced entirely at the fresh rate. That is the honest reading: nothing is
 * KNOWN to have been cached.
 */
export function agentUsageFromHarnessCalls(
  usage: { inputTokens: number; outputTokens: number },
  calls: readonly { cacheReadTokens: number; cacheWriteTokens: number }[] | undefined,
): AgentTokenUsage {
  if (!calls?.length) return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  for (const call of calls) {
    cacheReadTokens += call.cacheReadTokens
    cacheWriteTokens += call.cacheWriteTokens
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    inputClasses: partitionInputTokens(usage.inputTokens, { cacheReadTokens, cacheWriteTokens }),
  }
}
