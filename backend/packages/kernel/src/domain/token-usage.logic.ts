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
 * Shares that OVERSHOOT the total are clamped in order (read, then write) rather than allowed
 * to mint a negative fresh count: the two channels disagreed, and a negative class would carry
 * that disagreement into the money.
 */
export function partitionInputTokens(
  inputTokens: number,
  cache: { cacheReadTokens: number; cacheWriteTokens: number },
): InputTokenClassCounts {
  const total = Math.max(0, inputTokens)
  const cacheReadTokens = Math.min(Math.max(0, cache.cacheReadTokens), total)
  const cacheWriteTokens = Math.min(Math.max(0, cache.cacheWriteTokens), total - cacheReadTokens)
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
 * The aggregate carries a split only when BOTH parts reported one. Folding an unsplit part in
 * as all-fresh would price it the same way the lump fallback does, but it would also make the
 * result CLAIM that part had no cache reads, and the whole point of keeping the split optional
 * is that "nothing was cached" and "the producer could not see what was cached" are different
 * facts. Both parts of any real aggregate come from the same producer, so this costs accuracy
 * only where the producer is already inconsistent with itself.
 */
export function sumAgentTokenUsage(
  a: AgentTokenUsage | undefined,
  b: AgentTokenUsage | undefined,
): AgentTokenUsage | undefined {
  if (!a) return b
  if (!b) return a
  const classes =
    a.inputClasses && b.inputClasses
      ? {
          promptTokens: a.inputClasses.promptTokens + b.inputClasses.promptTokens,
          cacheReadTokens: a.inputClasses.cacheReadTokens + b.inputClasses.cacheReadTokens,
          cacheWriteTokens: a.inputClasses.cacheWriteTokens + b.inputClasses.cacheWriteTokens,
        }
      : undefined
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(classes ? { inputClasses: classes } : {}),
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
