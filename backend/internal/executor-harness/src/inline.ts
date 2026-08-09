import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSubscriptionHarness, type SubscriptionHarness } from './agent-runner.js'
import type { HarnessCallMetric } from './pi.js'
import type { InlineJob, InlineResult } from './job.js'
import type { RunOptions } from './runner.js'

// The `inline` job handler: one-shot LLM completion through a subscription harness CLI
// (Claude Code / Codex) with NO checkout. It is the container analogue of the local
// host-CLI inline runner (runtimes/local `harnessInline.ts`) — it exists so the inline
// LLM steps (requirements reviewer, brainstorm, task-estimator, inline document kinds) can
// run on a subscription model even when the host has no `claude`/`codex` binary (and in
// mothership mode without touching the host), at warm-pool latency. It reuses
// `runSubscriptionHarness`'s credential-env setup verbatim (the single site that turns a
// leased subscription token into `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_*` / a Codex
// `auth.json`), so the container and coding paths can never disagree on how a credential
// is injected.

/**
 * Map the harness CLI's terminal stop reason (lifted onto the last call metric) to the
 * inline `finishReason` the reviewer keys off. Only Claude Code reports it (`max_tokens` on
 * a `--output-format stream-json` result); Codex's thinner stream exposes none, so it reads
 * as `stop` — the same one-shot limitation the host-CLI runner has.
 */
function deriveFinishReason(calls: HarnessCallMetric[] | undefined): 'stop' | 'length' {
  const last = calls?.[calls.length - 1]
  const reason = last?.finishReason?.toLowerCase() ?? ''
  return reason === 'max_tokens' || reason === 'length' ? 'length' : 'stop'
}

/**
 * Run one inline completion in a throwaway temp cwd and return the reply text + lifted
 * usage/telemetry. The CLI clones/pushes nothing — the empty cwd only gives it a working
 * directory. The job's watchdog (inactivity + max-duration, see {@link JobRegistry}) bounds
 * it through `opts.signal`; `opts.onActivity` keeps the inactivity timer alive while the CLI
 * streams. The temp cwd is always removed.
 *
 * `opts.beginToolWindow` is deliberately NOT forwarded. An inline completion is a one-shot
 * answer with no checkout and no tool loop, so the tool-silence watchdog would arm a window this
 * run could never beat and could only ever expire — force-failing a healthy completion under a
 * cause ("kept talking, completed no tool call") that misdescribes what it is. The inactivity and
 * max-duration watchdogs still bound it, which is the whole bound this work ever had.
 */
export async function handleInline(job: InlineJob, opts: RunOptions): Promise<InlineResult> {
  opts.onPhase?.('agent')
  const cwd = await mkdtemp(join(tmpdir(), 'cf-inline-'))
  try {
    const outcome = await runSubscriptionHarness(job.harness as SubscriptionHarness, {
      cwd,
      model: job.model,
      systemPrompt: job.systemPrompt,
      userPrompt: job.userPrompt,
      ...(job.subscriptionToken ? { subscriptionToken: job.subscriptionToken } : {}),
      ...(job.subscriptionBaseUrl ? { subscriptionBaseUrl: job.subscriptionBaseUrl } : {}),
      ...(job.ambientAuth ? { ambientAuth: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
    })
    return {
      text: outcome.summary,
      finishReason: deriveFinishReason(outcome.callMetrics),
      ...(outcome.usage ? { usage: inlineUsage(outcome.usage, outcome.callMetrics) } : {}),
      ...(outcome.callMetrics ? { callMetrics: outcome.callMetrics } : {}),
    }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Split the run's coarse usage into the three orthogonal input classes an {@link InlineResult}
 * carries. `outcome.usage` is the ROTATION-window weight — every billed input bucket summed —
 * so the split has to come from the per-call metrics, the only channel that kept the classes
 * apart. Fresh input is likewise taken from the calls rather than derived by subtraction, so a
 * CLI whose per-call and cumulative counts disagree can never produce a negative class.
 *
 * With no per-call telemetry (an older CLI build that streams nothing) the coarse total is
 * reported as fresh with both cache classes 0. That is the honest reading: nothing is KNOWN to
 * have been cached, and inventing a split would be worse than admitting the channel is silent.
 */
function inlineUsage(
  usage: { inputTokens: number; outputTokens: number },
  calls: HarnessCallMetric[] | undefined,
): NonNullable<InlineResult['usage']> {
  if (!calls?.length) {
    return {
      inputTokens: usage.inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: usage.outputTokens,
    }
  }
  const sum = (pick: (call: HarnessCallMetric) => number): number =>
    calls.reduce((total, call) => total + pick(call), 0)
  return {
    inputTokens: sum((call) => call.inputTokens),
    cacheReadTokens: sum((call) => call.cacheReadTokens),
    cacheWriteTokens: sum((call) => call.cacheWriteTokens),
    outputTokens: usage.outputTokens,
  }
}
