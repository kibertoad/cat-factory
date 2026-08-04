import type {
  AgentContextSnapshotRepository,
  AgentSearchQueryRepository,
  AgentToolCall,
  AgentToolCallRepository,
  AgentSearchQuery,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  ExecutionStatus,
  LlmCallMetricRepository,
  LlmCallOutcomeFilter,
  LlmRollupCell,
  ProvisioningLogRecord,
  ProvisioningLogRepository,
} from '@cat-factory/kernel'
import { priceRollupCells } from '@cat-factory/kernel'
import type {
  DebugAgentContextDetail,
  DebugAgentContextEntry,
  DebugLlmCall,
  DebugRunOverview,
  DebugRunSummary,
  ToolCallOrder,
} from '@cat-factory/contracts'
import {
  deriveSignals,
  foldLlmRollup,
  toDebugAgentContextDetail,
  toDebugAgentContextEntry,
  toDebugLlmCall,
  toDebugRunStep,
  toDebugRunSummary,
} from './debug.logic.js'
import { toDebugLlmCallMessagesView } from './promptMessages.js'

// The read service behind the remote debugging surface (`/api/v1/debug/*`). It owns exactly
// two responsibilities: issue BOUNDED reads against the run store and the three telemetry
// sinks, and hand the rows to the pure projections in `debug.logic.ts`.
//
// It deliberately owns no cursor ENCODING. A page in and out of this service carries a
// decoded `{ createdAt, id }` position; turning that into the opaque wire cursor is the HTTP
// layer's job, exactly as it already is for the public job/task lists — so the wire encoding
// can change without this service (or its tests) knowing.
//
// Every sink is optional and independently so. A deployment may retain LLM telemetry but no
// agent context, or run the whole surface with no provisioning log; each read degrades to an
// empty page and the overview reports the sink as `available: false`, which is a materially
// different statement from a count of zero (see `deriveSignals`).

/** A decoded keyset position: a row's chronological sort key plus its id (the tiebreaker). */
export interface DebugCursor {
  createdAt: number
  id: string
}

/** One bounded page plus the position to resume from, or null when the page was the last. */
export interface DebugPage<T> {
  items: T[]
  nextCursor: DebugCursor | null
}

export interface RunDebugServiceDependencies {
  executionRepository: ExecutionRepository
  clock: Clock
  /** Per-call model telemetry. Absent ⇒ the LLM reads return empty and the sink is unavailable. */
  llmCallMetricRepository?: LlmCallMetricRepository
  /** Per-dispatch agent context. Absent ⇒ the context reads return empty. */
  agentContextSnapshotRepository?: AgentContextSnapshotRepository
  /** Per-search telemetry. Absent ⇒ the search reads return empty. */
  agentSearchQueryRepository?: AgentSearchQueryRepository
  agentToolCallRepository?: AgentToolCallRepository
  /** The provisioning event log. Absent ⇒ the log reads return empty. */
  provisioningLogRepository?: ProvisioningLogRepository
  /**
   * Prices a run's rollup cells and collapses their model dimension — in practice
   * `LlmObservabilityService.summarizeByExecution`, bound.
   *
   * Taken as a FUNCTION rather than a rate table of its own so this surface and the board
   * rollup cannot report different money for one run: they run the same code over the same
   * cells. Absent ⇒ the raw store cells are used and every cost is null, which is what a
   * deployment with no pricing wired should read.
   */
  priceRollup?: (workspaceId: string, executionId: string) => Promise<LlmRollupCell[]>
  /**
   * ISO 4217 currency the priced costs are denominated in, or null when nothing prices them.
   * From the same service that supplies {@link RunDebugServiceDependencies.priceRollup}.
   */
  costCurrency?: string | null
}

/**
 * Take one row more than the caller asked for, so "is there another page?" is answered by the
 * query rather than by a second COUNT — and mint the next cursor from the LAST row actually
 * returned, which is the row the next page must resume strictly after.
 */
function paginate<Row, Item>(
  rows: Row[],
  limit: number,
  key: (row: Row) => DebugCursor,
  project: (row: Row) => Item,
): DebugPage<Item> {
  const hasMore = rows.length > limit
  const kept = hasMore ? rows.slice(0, limit) : rows
  const last = kept[kept.length - 1]
  return {
    items: kept.map(project),
    // Never the PEEKED row: resuming strictly after it would skip it entirely.
    nextCursor: hasMore && last ? key(last) : null,
  }
}

export class RunDebugService {
  constructor(private readonly deps: RunDebugServiceDependencies) {}

  /**
   * One bounded page of the workspace's runs, newest first. The entry point for a client that
   * holds no run id — "which of my runs failed in the last hour" — and the only read here that
   * is not already scoped to a single run.
   */
  async listRuns(
    workspaceId: string,
    opts: { limit: number; cursor?: DebugCursor; status?: ExecutionStatus; since?: number },
  ): Promise<DebugPage<DebugRunSummary>> {
    const rows = await this.deps.executionRepository.listRecent(workspaceId, {
      limit: opts.limit + 1,
      cursor: opts.cursor,
      statuses: opts.status ? [opts.status] : undefined,
      since: opts.since,
    })
    return paginate(
      rows,
      opts.limit,
      (run) => ({ createdAt: run.createdAt ?? 0, id: run.id }),
      toDebugRunSummary,
    )
  }

  /** The run itself, or null when the workspace has no such run. */
  getRun(workspaceId: string, runId: string): Promise<ExecutionInstance | null> {
    return this.deps.executionRepository.get(workspaceId, runId)
  }

  /**
   * Whether the workspace has this run — the 404 guard the per-run detail lists apply on
   * every page. A probe rather than {@link RunDebugService.getRun}: the guard discards the
   * run, and `get` JSON-decodes the heaviest row in the request to answer a boolean.
   */
  runExists(workspaceId: string, runId: string): Promise<boolean> {
    return this.deps.executionRepository.exists(workspaceId, runId)
  }

  /**
   * The run's diagnostic map. Composed from AGGREGATES ONLY — four counts and one GROUP BY,
   * no prompt, response or context body — which is what makes it cheap enough to be the first
   * call a debugging client always issues, and what lets its `sinks` block stop the caller
   * issuing four detail requests to discover three of them are empty.
   *
   * Takes the already-loaded run rather than a run id: the caller has to load it anyway to
   * decide whether the key may see it, and re-reading it here would be a second decode of the
   * heaviest row in the request.
   */
  async overview(workspaceId: string, execution: ExecutionInstance): Promise<DebugRunOverview> {
    const runId = execution.id
    // Independent aggregates over five separate stores — issued together rather than in
    // sequence, since the overview's whole value proposition is that it is one cheap call.
    const [summaries, contextCount, searchCount, toolCallCount, logCounts] = await Promise.all([
      this.deps.priceRollup?.(workspaceId, runId) ?? this.unpricedRollup(workspaceId, runId),
      this.deps.agentContextSnapshotRepository?.countByExecution(workspaceId, runId) ?? 0,
      this.deps.agentSearchQueryRepository?.countByExecution(workspaceId, runId) ?? 0,
      this.deps.agentToolCallRepository?.countByExecution(workspaceId, runId) ?? 0,
      // Total + failures in one aggregate pass — the overview always wants both.
      this.deps.provisioningLogRepository?.countByExecution(workspaceId, runId) ?? {
        total: 0,
        failures: 0,
      },
    ])
    const { totals, byAgentKind, byPhase } = foldLlmRollup(summaries)
    const steps = execution.steps.map(toDebugRunStep)
    const sinks = {
      // The LLM call count is FOLDED from the per-kind rollup rather than counted separately:
      // the two would be the same COUNT over the same rows, and a second query could only
      // disagree with the breakdown it sits next to.
      llmCalls: { available: !!this.deps.llmCallMetricRepository, count: totals.calls },
      agentContext: {
        available: !!this.deps.agentContextSnapshotRepository,
        count: contextCount,
      },
      searchQueries: { available: !!this.deps.agentSearchQueryRepository, count: searchCount },
      toolCalls: { available: !!this.deps.agentToolCallRepository, count: toolCallCount },
      provisioningLog: { available: !!this.deps.provisioningLogRepository, count: logCounts.total },
    }
    return {
      kind: 'cat-factory.run-debug-overview',
      version: 1,
      generatedAt: this.deps.clock.now(),
      run: toDebugRunSummary(execution),
      steps,
      diagnostics: execution.diagnostics ?? null,
      sinks,
      llm: {
        totals,
        byAgentKind,
        byPhase,
        // Only stated where something priced the cells. Labelling a run whose every cost is
        // null with a currency would announce a denomination for numbers that are not there.
        costCurrency: this.deps.costCurrency ?? null,
      },
      signals: deriveSignals({
        execution,
        steps,
        totals,
        byAgentKind,
        sinks,
        provisioningFailures: logCounts.failures,
      }),
    }
  }

  /**
   * The run's rollup with the model dimension collapsed but nothing priced — what this surface
   * reads when no pricing function is wired.
   *
   * It still goes through `priceRollupCells` rather than returning the store's cells raw, so
   * both paths hand `foldLlmRollup` the SAME `(agentKind, phase)` grain. Returning the finer
   * store grain here would produce two cells per kind on a mixed-model run: the folds happen to
   * absorb that today, and any future reader that indexes the list by kind would silently see
   * one model's slice.
   */
  private async unpricedRollup(workspaceId: string, runId: string): Promise<LlmRollupCell[]> {
    const cells = await this.deps.llmCallMetricRepository?.summarizeByExecution(workspaceId, runId)
    return cells ? priceRollupCells(cells) : []
  }

  /** One bounded page of the run's recorded model calls. */
  async listLlmCalls(
    workspaceId: string,
    runId: string,
    opts: {
      limit: number
      cursor?: DebugCursor
      agentKind?: string
      /** Narrow to one phase's calls; `''` selects the unattributed slice (applied in SQL). */
      phase?: string
      outcome?: LlmCallOutcomeFilter
      order?: 'newest' | 'oldest'
      bodyChars: number
      /** Narrow to calls whose bodies contain this literal substring (matched in SQL). */
      contains?: string
    },
  ): Promise<DebugPage<DebugLlmCall>> {
    const repo = this.deps.llmCallMetricRepository
    if (!repo) return { items: [], nextCursor: null }
    const rows = await repo.listPage(workspaceId, {
      executionId: runId,
      limit: opts.limit + 1,
      cursor: opts.cursor,
      agentKind: opts.agentKind,
      phase: opts.phase,
      outcome: opts.outcome,
      order: opts.order,
      bodyChars: opts.bodyChars,
      contains: opts.contains,
    })
    return paginate(
      rows,
      opts.limit,
      (call) => ({ createdAt: call.createdAt, id: call.id }),
      (call) => toDebugLlmCall(call),
    )
  }

  /** One recorded call with its bodies windowed, or null when the workspace has no such call. */
  async getLlmCall(
    workspaceId: string,
    callId: string,
    opts: { bodyChars?: number; bodyOffset?: number; view?: 'raw' | 'messages' } = {},
  ): Promise<DebugLlmCall | null> {
    const repo = this.deps.llmCallMetricRepository
    if (!repo) return null
    if (opts.view === 'messages') {
      // The parse needs the COMPLETE delta (a truncated JSON array parses as nothing), so this
      // view reads the row whole and windows in the projection instead of in SQL. That trades
      // one whole-row transfer from the store — bounded by the store's own per-body cap — for a
      // response whose messages are budgeted independently; the HTTP payload stays bounded
      // either way.
      const row = await repo.get(workspaceId, callId)
      return row ? toDebugLlmCallMessagesView(row, opts.bodyChars ?? 0, opts.bodyOffset ?? 0) : null
    }
    const row = await repo.get(workspaceId, callId, {
      chars: opts.bodyChars,
      offset: opts.bodyOffset,
    })
    return row ? toDebugLlmCall(row, opts.bodyOffset ?? 0) : null
  }

  /** One bounded page of the run's captured dispatches — identity and sizes, never bodies. */
  async listAgentContext(
    workspaceId: string,
    runId: string,
    opts: { limit: number; cursor?: DebugCursor; stepIndex?: number },
  ): Promise<DebugPage<DebugAgentContextEntry>> {
    const repo = this.deps.agentContextSnapshotRepository
    if (!repo) return { items: [], nextCursor: null }
    const rows = await repo.listIndex(workspaceId, {
      executionId: runId,
      limit: opts.limit + 1,
      cursor: opts.cursor,
      stepIndex: opts.stepIndex,
    })
    return paginate(
      rows,
      opts.limit,
      (row) => ({ createdAt: row.createdAt, id: row.id }),
      toDebugAgentContextEntry,
    )
  }

  /** One captured dispatch with every body budgeted independently. */
  async getAgentContext(
    workspaceId: string,
    snapshotId: string,
    bodyChars: number,
    bodyOffset = 0,
  ): Promise<DebugAgentContextDetail | null> {
    const repo = this.deps.agentContextSnapshotRepository
    if (!repo) return null
    const snapshot = await repo.get(workspaceId, snapshotId)
    return snapshot ? toDebugAgentContextDetail(snapshot, bodyChars, bodyOffset) : null
  }

  /** One bounded page of the web searches the run's agents performed. */
  async listSearchQueries(
    workspaceId: string,
    runId: string,
    opts: { limit: number; cursor?: DebugCursor },
  ): Promise<DebugPage<AgentSearchQuery>> {
    const repo = this.deps.agentSearchQueryRepository
    if (!repo) return { items: [], nextCursor: null }
    const rows = await repo.listPage(workspaceId, {
      executionId: runId,
      limit: opts.limit + 1,
      cursor: opts.cursor,
    })
    return paginate(
      rows,
      opts.limit,
      (row) => ({ createdAt: row.createdAt, id: row.id }),
      (row) => row,
    )
  }

  /**
   * The run's tool calls, in one of two orders.
   *
   * `recent` is the keyset page every other fan-out list here serves: newest first on
   * `(createdAt, id)`, resumable, for sweeping a long run. `trajectory` is the ORDERED read the
   * sink exists for — oldest first by when each call actually started — and it answers a
   * question about a bounded PREFIX, so it returns no cursor: an operator asking "what did this
   * run do" wants the beginning, and a resumable walk of the same rows is what `recent` is.
   *
   * The ordering is computed HERE rather than left to the caller. A consumer holding a page of
   * rows can see `jobId` and `seq` on each, and sorting by them is wrong in a way that looks
   * right: `seq` restarts at zero on every dispatch, and a job id sorts a run's dispatches by
   * agent-kind spelling and its re-runs `-10` before `-2`.
   */
  async listToolCalls(
    workspaceId: string,
    runId: string,
    opts: { limit: number; cursor?: DebugCursor; jobId?: string; order?: ToolCallOrder },
  ): Promise<DebugPage<AgentToolCall>> {
    const repo = this.deps.agentToolCallRepository
    if (!repo) return { items: [], nextCursor: null }
    if (opts.order === 'trajectory') {
      const items = await repo.listByExecution(workspaceId, {
        executionId: runId,
        limit: opts.limit,
        ...(opts.jobId ? { jobId: opts.jobId } : {}),
      })
      return { items, nextCursor: null }
    }
    const rows = await repo.listPage(workspaceId, {
      executionId: runId,
      limit: opts.limit + 1,
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
    })
    return paginate(
      rows,
      opts.limit,
      (row) => ({ createdAt: row.createdAt, id: row.id }),
      (row) => row,
    )
  }

  /** One bounded page of the run's provisioning event log. */
  async listProvisioningLog(
    workspaceId: string,
    runId: string,
    opts: { limit: number; cursor?: DebugCursor },
  ): Promise<DebugPage<ProvisioningLogRecord>> {
    const repo = this.deps.provisioningLogRepository
    if (!repo) return { items: [], nextCursor: null }
    const rows = await repo.list(workspaceId, {
      executionId: runId,
      limit: opts.limit + 1,
      cursor: opts.cursor,
    })
    return paginate(
      rows,
      opts.limit,
      (row) => ({ createdAt: row.createdAt, id: row.id }),
      (row) => row,
    )
  }
}
