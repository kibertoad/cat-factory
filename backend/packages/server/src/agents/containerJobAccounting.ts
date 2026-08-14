import {
  type AgentJobHandle,
  type HarnessCallMetric,
  type RunnerJobResult,
  type SubscriptionQuotaTarget,
  isSubscriptionVendor,
} from '@cat-factory/kernel'
import type { HarnessCallsRecordInput } from '@cat-factory/orchestration'
import { providerOf } from './containerJobAddressing.js'

// What a SUBSCRIPTION-harness job's tokens are recorded against, once the job settles: the
// per-call telemetry rows (`llm_call_metrics`), the leased pool token's usage-aware rotation
// counters, and the modeled quota cycle.
//
// Extracted from `ContainerAgentExecutor` because the three are one concern with one hard
// requirement — each must land AT MOST ONCE per job — and satisfying it takes four in-memory
// dedupe guards that are nobody else's business. The durable driver polls a settled job inside a
// RETRIABLE step, so a poll that records and then throws replays; without the guards a token is
// penalised twice in the rotation it feeds and a quota cycle counts a job it never ran.
//
// Every method is best-effort by construction: an unwired recorder is a no-op, and the guards are
// bounded (cleared wholesale past a cap) so a long-lived process cannot grow them without limit.
// A cleared guard costs at most one benign re-record, never a lost one.

/** The one dedupe cap, shared by every guard here (see the header). */
const GUARD_CAP = 10_000

/** The recorders this accounting fans out to; each absent ⇒ that channel is unwired. */
export interface ContainerJobAccountingDeps {
  /** Record a settled subscription harness's per-call telemetry into `llm_call_metrics`. */
  recordHarnessCalls?: (input: HarnessCallsRecordInput) => Promise<void>
  /** Attribute usage to the leased POOL token (usage-aware rotation). */
  recordSubscriptionUsage?: (
    workspaceId: string,
    tokenId: string,
    usage: { inputTokens: number; outputTokens: number },
  ) => Promise<void>
  /** Fold usage into the modeled quota cycle, for pooled AND personal runs alike. */
  recordSubscriptionQuotaUsage?: (
    target: SubscriptionQuotaTarget,
    usage: { inputTokens: number; outputTokens: number },
  ) => Promise<void>
}

export class ContainerJobAccounting {
  /**
   * Job ids whose subscription usage has already been folded into the leased token.
   * `recordSubscriptionUsage` is additive, and the durable driver polls a finished
   * job inside a retriable step — so a poll that records usage and then throws (or
   * whose surrounding upsert/emit throws) would replay and double-count, unfairly
   * penalising the token in the usage-aware rotation. Recording once per job id
   * guards that. Best-effort + bounded: cleared wholesale past a cap, and it cannot
   * survive a cold isolate replay — a re-record there is the documented, benign
   * worst case (one extra job's tokens on one row), never silent over-counting.
   */
  private readonly recordedUsageJobs = new Set<string>()

  /**
   * Job ids whose per-call telemetry (`llm_call_metrics`) has already been recorded.
   * Separate from {@link recordedUsageJobs} because the two recorders are independently
   * wired and gated (telemetry records even for a personal subscription that leases no
   * pooled token id). Same replay-safety rationale + bound as the usage guard.
   */
  private readonly recordedCallMetricJobs = new Set<string>()

  /**
   * Per-job set of harness call `seq`s this process already recorded from the LIVE poll drain,
   * so the terminal write can skip them. Without it the terminal pass re-walks the job's WHOLE
   * list, and each already-stored call costs a chain-tip read plus an ignored insert — hundreds
   * of pointless round-trips at the end of a long run (and, on the Worker, hundreds of
   * subrequests inside one Workflow step).
   *
   * A set of the seqs actually recorded, not a high-water mark: a drained batch whose write
   * failed is swallowed (telemetry never fails a run), and those calls must still be picked up
   * by the terminal write rather than skipped as "already done". Dropped once the job records
   * terminally, and bounded by the same wholesale clear as {@link recordedCallMetricJobs} — a
   * lost entry only costs the redundant write it was there to avoid.
   */
  private readonly recordedCallSeqs = new Map<string, Set<number>>()

  /**
   * Job ids whose subscription usage has already been folded into the modeled quota
   * cycle. Separate from {@link recordedUsageJobs} because quota tracking counts BOTH
   * pooled and personal runs (not gated on a pooled token id). Same replay-safety
   * rationale + bound as the usage guard.
   */
  private readonly recordedQuotaJobs = new Set<string>()

  constructor(private readonly deps: ContainerJobAccountingDeps) {}

  /**
   * Record a batch of the subscription harness's per-call telemetry into `llm_call_metrics`
   * — the proxy-bypassing analogue of the rows the LLM proxy writes for Pi. NOT gated on a
   * pooled token id, so a personal (individual-usage) subscription run is observed too.
   *
   * Called from two places, deliberately: on EVERY poll for the calls the harness drained
   * since the last one (so a run's telemetry lands while it runs, and survives the run dying),
   * and once on the terminal state for the complete list (so a transport that forwards no live
   * drain, or a run whose last window never reached us, still records everything). The calls
   * carry a stable per-job `seq`, so the ids the recorder mints are the same in both channels
   * and the second write of an already-recorded call is a no-op at the store.
   *
   * Best-effort: an unwired recorder or an empty batch is a no-op, and a failure is swallowed
   * — telemetry is observability, never a reason to fail (or fail to complete) a run.
   */
  async recordCalls(handle: AgentJobHandle, calls: HarnessCallMetric[] | undefined): Promise<void> {
    if (!handle.workspaceId || !calls || calls.length === 0 || !this.deps.recordHarnessCalls) {
      return
    }
    try {
      await this.deps.recordHarnessCalls({
        workspaceId: handle.workspaceId,
        executionId: handle.runId ?? null,
        agentKind: handle.agentKind ?? 'agent',
        provider: handle.provider ?? providerOf(handle.model),
        model: handle.model ?? '',
        jobId: handle.jobId,
        calls,
      })
      this.markCallSeqsRecorded(handle.jobId, calls)
    } catch {
      // Swallowed: telemetry is observability, never a reason to fail (or fail to
      // complete) a run.
    }
  }

  /**
   * Remember which `seq`s of a job landed, so {@link recordCallsOnce} can skip them.
   * Only called after the batch was written. A call with no `seq` (an older harness image,
   * which streams nothing) is not tracked: there the terminal list is the only channel.
   */
  private markCallSeqsRecorded(jobId: string, calls: HarnessCallMetric[]): void {
    const seqs = calls.map((c) => c.seq).filter((seq): seq is number => seq !== undefined)
    if (seqs.length === 0) return
    if (this.recordedCallSeqs.size >= GUARD_CAP) this.recordedCallSeqs.clear()
    const known = this.recordedCallSeqs.get(jobId) ?? new Set<number>()
    for (const seq of seqs) known.add(seq)
    this.recordedCallSeqs.set(jobId, known)
  }

  /**
   * The TERMINAL record of a job's full call list (see {@link recordCalls}). An
   * in-memory once-per-job guard skips the redundant walk within this process; the recorder
   * additionally mints deterministic per-call ids, so even a durable-driver replay in a fresh
   * isolate (empty guard) re-records idempotently rather than duplicating rows.
   *
   * Calls this process already recorded from the live drain are filtered out first: the store
   * would ignore them anyway, but only after a chain-tip read + an insert each, which on a long
   * run is hundreds of round-trips for no new rows. Anything the drain never delivered (a lost
   * poll response, a transport that forwards no drain, a replay in a fresh isolate) still goes
   * through.
   */
  async recordCallsOnce(
    handle: AgentJobHandle,
    result: { callMetrics?: HarnessCallMetric[] },
  ): Promise<void> {
    if (this.recordedCallMetricJobs.has(handle.jobId)) return
    const recorded = this.recordedCallSeqs.get(handle.jobId)
    const pending = recorded
      ? result.callMetrics?.filter((c) => c.seq === undefined || !recorded.has(c.seq))
      : result.callMetrics
    await this.recordCalls(handle, pending)
    if (this.recordedCallMetricJobs.size >= GUARD_CAP) this.recordedCallMetricJobs.clear()
    this.recordedCallMetricJobs.add(handle.jobId)
    // The job is settled: its per-seq bookkeeping can go (the once-per-job guard covers a
    // repeat poll of the same terminal state from here on).
    this.recordedCallSeqs.delete(handle.jobId)
  }

  /**
   * Attribute a subscription harness's reported usage to its leased pool token
   * (usage-aware rotation) and the telemetry sink. Best-effort: a missing usage
   * signal or unconfigured recorder is a no-op; recorded at most once per job id
   * so a retried/replayed poll can't double-count (see `recordedUsageJobs`).
   */
  async recordPooledUsageOnce(handle: AgentJobHandle, result: RunnerJobResult): Promise<void> {
    if (
      handle.subscriptionTokenId &&
      handle.workspaceId &&
      result.usage &&
      this.deps.recordSubscriptionUsage &&
      !this.recordedUsageJobs.has(handle.jobId)
    ) {
      await this.deps.recordSubscriptionUsage(
        handle.workspaceId,
        handle.subscriptionTokenId,
        result.usage,
      )
      // Mark only AFTER a successful write: a failed record is left to retry rather
      // than silently dropped. Bound the set so a long-lived process can't grow it
      // unboundedly (clearing only risks a benign re-record on a later retry).
      if (this.recordedUsageJobs.size >= GUARD_CAP) this.recordedUsageJobs.clear()
      this.recordedUsageJobs.add(handle.jobId)
    }
  }

  /**
   * Fold the SAME subscription usage into the modeled quota-cycle counters (Part B), for
   * BOTH pooled and personal runs. A subscription run is the one reporting per-call
   * metrics (Pi is proxy-metered and has none), and the handle's provider is the vendor
   * slug. Scope = the leased pool token when present, else the run initiator (personal).
   * Best-effort, once per job id so a replayed poll can't double-count.
   */
  async recordQuotaUsageOnce(handle: AgentJobHandle, result: RunnerJobResult): Promise<void> {
    const quotaVendor = handle.provider ?? providerOf(handle.model)
    if (
      result.callMetrics &&
      result.callMetrics.length > 0 &&
      result.usage &&
      this.deps.recordSubscriptionQuotaUsage &&
      isSubscriptionVendor(quotaVendor) &&
      !this.recordedQuotaJobs.has(handle.jobId)
    ) {
      const target: SubscriptionQuotaTarget | null = handle.subscriptionTokenId
        ? { scope: 'pooled', scopeId: handle.subscriptionTokenId, vendor: quotaVendor }
        : handle.initiatedByUserId
          ? { scope: 'user', scopeId: handle.initiatedByUserId, vendor: quotaVendor }
          : null
      if (target) {
        await this.deps.recordSubscriptionQuotaUsage(target, result.usage)
        if (this.recordedQuotaJobs.size >= GUARD_CAP) this.recordedQuotaJobs.clear()
        this.recordedQuotaJobs.add(handle.jobId)
      }
    }
  }
}
