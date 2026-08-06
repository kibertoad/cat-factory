// The operational-metrics port: the counters and gauges that describe how the DEPLOYMENT is
// behaving, as opposed to how a run went.
//
// `PlatformMetricsRepository` already answers "how are the RUNS doing" by aggregating
// `agent_runs` per account. It structurally cannot answer the questions an operator asks
// during an incident — how often a container dispatch is failing, how many stale runs the
// sweeper is re-driving, whether the queue is draining, whether telemetry batches are being
// dropped — because none of those are rows in a table. They are EVENTS that happen and are
// gone. This port is where they are counted.
//
// Two shapes, because the two facts have different lifetimes:
//   - a COUNTER is a delta accumulated since the last flush (evictions, re-drives, cache
//     misses). Exported with delta temporality, so a partial flush from one process/isolate
//     still sums correctly with every other one.
//   - a GAUGE is read at export time from something that already knows the answer (queue
//     depth). It is never accumulated here; the sweep probes for it.
//
// The whole surface is fire-and-forget and MUST NOT throw, for the same reason `Logger` must
// not: instrumentation that can fail turns observability into a new failure class.

/**
 * The closed set of operational counters. A closed union rather than a free string, so
 * adding a signal is a typecheck-visible decision (with a metric name and a documented
 * meaning) instead of a name typo that reports zero forever.
 */
export type OperationalCounter =
  /** A stale run whose durable instance was lost and was re-created by a sweeper. */
  | 'sweep.run_redriven'
  /** A stale run whose durable instance was terminal, so the sweeper settled it instead. */
  | 'sweep.run_finalized'
  /** A run failed `stalled`: re-driving never resurrected it past the hard deadline. */
  | 'sweep.run_stalled'
  /** A sweeper pass threw. Dimensioned by `sweep`, so one sick sweeper is identifiable. */
  | 'sweep.failed'
  /** A container job dispatch threw — the job never existed, so no poll can report it. */
  | 'container.dispatch_failed'
  /** A container job settled as evicted/crashed. Dimensioned by the eviction kind. */
  | 'container.evicted'
  /**
   * A container dispatch was REFUSED because the runner image told us it does not parse a
   * capability field the job body carried (`domain/harness-capabilities.ts`). Dimensioned by
   * `capability`, which is a closed union, so the cardinality is the vocabulary's size.
   *
   * The refusal is per RUN and the cause is per POOL, so a single lagging runner pool produces
   * one of these for every dispatch until someone updates it. That standing rate is the point:
   * the log line names the run, and only the rate says the deployment has a fleet problem.
   */
  | 'container.capability_unsupported'
  /**
   * A container dispatch carried a capability and the backend could not tell whether the image
   * serves it: an image older than the handshake, or a transport that does not forward the
   * harness's own dispatch response. The run proceeds, because refusing on an absent answer
   * would fail every dispatch on every image predating the handshake.
   *
   * Counted rather than only logged because it is the BLIND SPOT's own metric: it should decay
   * to zero as pools update, and a rate that does not is how an operator learns the handshake is
   * not actually reaching them. Dimensioned by `capability`, same closed union as above.
   */
  | 'container.capability_unknown'
  /**
   * A container dispatch was refused as blind AND the backend could not confirm the job it had
   * already started was stopped. Dimensioned by `outcome` (`requested` | `unsupported` |
   * `failed`), a closed union of three, each naming a different operator action: verify at the
   * pool, give the backend a cancel path, investigate a fault.
   *
   * Counted separately from the refusal itself because they are different severities. A refusal
   * that stopped its job cost one step; one that did not left an agent running unsupervised
   * against a repository, able to push a branch and open a pull request for a step the engine
   * already failed, and nothing else in the system will notice.
   */
  | 'container.blind_job_not_stopped'
  /** An observability export was dropped (a trace sink, a metrics POST). */
  | 'telemetry.export_dropped'
  /** An outbound notification delivery failed after its retries. */
  | 'notification.delivery_failed'
  /** An app-cache read served from memory. Dimensioned by cache name. */
  | 'cache.hit'
  /** An app-cache read that had to run its loader. Dimensioned by cache name. */
  | 'cache.miss'
  /**
   * A password-endpoint attempt was refused by the throttle (SEC-4). The log line names the
   * bucket; only this answers whether refusals are climbing, which is the difference between
   * one forgetful user and a credential-stuffing sweep.
   */
  | 'auth.throttle.limited'
  /**
   * The durable attempt ledger was unreachable, so the throttle fell back to its per-process
   * window. Silent otherwise, and it degrades every replica's view of an attack at once.
   */
  | 'auth.throttle.store_unavailable'
  /**
   * An in-app tutorial walkthrough was started / finished / broken off. Dimensioned by `tour`.
   *
   * The one PRODUCT signal on an otherwise operational surface, and it is here rather than on a
   * second seam because there is no second seam: the rule is one counter port, and adding a
   * parallel one to keep this tidy would be two places to get delta temporality wrong. What it
   * buys is the question the in-app-tutorial initiative could not answer about itself — the
   * catalogue made every walkthrough reachable, but whether any is REACHED was unmeasured, so
   * each further slice was chosen on a guess. Started-vs-completed separates "nobody opens it"
   * from "everybody drops it halfway", which need opposite fixes.
   *
   * The `tour` dimension is bounded in TWO places, because neither alone is enough: the wire
   * schema constrains the SHAPE of an id, and `TutorialTelemetryService` caps how many DISTINCT
   * ids one process will ever report, folding the rest onto `other` and logging that it did.
   * A dimension whose values come from a browser is otherwise an unbounded-cardinality hole in
   * the operator's own backend.
   */
  | 'tutorial.tour_started'
  | 'tutorial.tour_completed'
  | 'tutorial.tour_abandoned'
  /**
   * A run MATERIALISED a catalog pipeline its workspace was never seeded with
   * (`pipelineAdoption.adoptForRun`). Once per workspace+pipeline, so a standing rate is the
   * operator's answer to a question the log line cannot reach: the line says WHICH board caught
   * up, and only the rate says how many are still behind a catalog the deployment already
   * shipped. A quiet counter after a release means the rollout landed; a long tail means boards
   * are discovering it one first-run at a time.
   *
   * UNDIMENSIONED on purpose. The interesting split would be by pipeline id, and a registered
   * pipeline's id is whatever a deployment named it, so it is exactly the unbounded dimension
   * the rule above bans. The id rides the log line at the increment site.
   */
  | 'pipeline.adopted'
  /**
   * A container dispatch's job token was minted INSTALLATION-WIDE after the run named a repo
   * scope that could not be expressed as provider repo ids (`buildDispatchTokenMint`). The
   * dispatch still runs, deliberately: a scope that dropped a leg would mint a token unable to
   * clone a repo the job body still names. So the widening is invisible in every run-level
   * signal, and only a standing rate says a repo projection is carrying ids the provider would
   * not recognise, which is a security property quietly degrading rather than a run failing.
   *
   * UNDIMENSIONED: the interesting split would be by installation or repo, both unbounded. The
   * ids and the run ride the log line at the increment site.
   */
  | 'dispatch.token_scope_widened'
  /**
   * A run's standing-context fragment ids resolved against nothing, so the guidance they name
   * never reached the agent (`FragmentLibraryService.resolveBodiesForRun`).
   *
   * Counted because the failure is invisible per run and only visible as a rate: the run still
   * succeeds, the agent still answers, and a reviewer's adherence report reads exactly like a
   * deployment that never wrote the standard down. The shapes that produce it are all standing
   * conditions rather than incidents (a deployment resolving two physical copies of the fragment
   * package, so the whole registered pool is empty; a task type pinning a typo'd id; a node
   * whose mothership build moved underneath it), which is precisely what a log line cannot say
   * and a rate can.
   *
   * UNDIMENSIONED: the split worth having is the CAUSE, and the drop site cannot tell a typo
   * from a deliberate tier suppression without a read it does not have (see the comment there).
   * A dimension carrying the fragment id would be unbounded, being whatever a deployment named
   * its own standards. The ids and the workspace ride the log line at the increment site.
   */
  | 'fragments.dropped_from_run'
  /**
   * A linked context document could NOT be confirmed against its source at dispatch, so the run
   * read the copy stored at import time. Dimensioned by `reason` (the `DocumentFreshnessGap`
   * union) and `source` (the `DocumentSourceKind` union), both closed, so the cardinality is the
   * product of two small vocabularies.
   *
   * Counted because the log line structurally cannot answer the operator's question. Every one of
   * these conditions is per-DISPATCH and most of them are PERMANENT while they last (a revoked
   * credential, a mothership node that cannot read the connection at all, a source returning 403),
   * so the individual line repeats with no remedy anyone intends to apply and gets tuned out. Only
   * a rate says whether agents across the deployment are being handed stale designs more than they
   * were, and the `reason` split is what separates the three different fixes.
   */
  | 'document.freshness_gap'

// Deliberately NOT a counter here: "jobs sitting in a dead-letter queue". It is a LEVEL, and
// the only thing that can read it is a periodic `SELECT` over the queue tables — which returns
// the standing total, not what arrived since the last look. Incrementing a delta counter by
// that total re-reports the same jobs on every sweep (an hourly sweep turns five dead-lettered
// jobs into ~120/day), and deriving a delta from it in memory reproduces the same lie after
// every restart, since the previous total is gone. It rides `queue.depth` under
// `state: 'dead_letter'` instead, where a level is exactly what a gauge means.

/** The closed set of operational gauges — point-in-time readings, never accumulated. */
export type OperationalGauge =
  /** Jobs waiting in a durable queue right now. Dimensioned by `queue`. */
  'queue.depth'

/**
 * The split dimensions of one sample. Values MUST be bounded — a queue name, a cache name,
 * an eviction kind — never a run/workspace/job id: every distinct value is its own metric
 * time series in the operator's backend, so an unbounded dimension is a cardinality
 * explosion that costs money and eventually gets the series dropped. The correlation ids
 * belong on the LOG line (which is why every increment site also logs), not here.
 */
export type OperationalDimensions = Readonly<Record<string, string>>

/** One accumulated counter delta, ready to export. */
export interface OperationalCounterSample {
  counter: OperationalCounter
  dimensions: OperationalDimensions
  /** The delta accumulated since the previous drain (always > 0 — empty keys aren't emitted). */
  value: number
}

/** One point-in-time gauge reading. */
export interface OperationalGaugeSample {
  gauge: OperationalGauge
  dimensions: OperationalDimensions
  value: number
}

/**
 * Where operational events are counted. Injected the same way `Logger` is, so a domain
 * service can count an event without knowing whether the deployment exports metrics at all.
 */
export interface OperationalMetrics {
  /**
   * Add `value` (default 1) to `counter` under `dimensions`. Never throws, never awaits —
   * a call site on a hot path (a cache read) pays a Map lookup and an add.
   */
  increment(counter: OperationalCounter, dimensions?: OperationalDimensions, value?: number): void
}

/**
 * An {@link OperationalMetrics} that accumulates in memory until drained. The accumulate/drain
 * split is what makes delta export correct: whoever drains owns a set of deltas nobody else
 * will report, so two processes (or two Worker isolates) can flush independently and the
 * backend's sum is still right.
 */
export interface OperationalMetricsCollector extends OperationalMetrics {
  /**
   * Take everything accumulated since the last call and RESET. Returns `[]` when nothing
   * happened, which a caller should treat as "nothing to flush" — never as a reason to
   * publish zeroes (an unflushed zero and a genuine zero are different facts, and only the
   * absence of a data point states the first one honestly).
   */
  drain(): OperationalCounterSample[]
}

/** The disposition for a deployment that exports nothing: count into the void, cheaply. */
export const noopOperationalMetrics: OperationalMetrics = { increment: () => {} }

/**
 * A dimension map's stable identity, so `{a:'1',b:'2'}` and `{b:'2',a:'1'}` accumulate onto
 * the same counter rather than two. Keys are sorted; the separators are control characters
 * that cannot appear in a metric dimension value.
 */
function dimensionKey(dimensions: OperationalDimensions): string {
  const keys = Object.keys(dimensions).sort()
  return keys.map((k) => `${k}${dimensions[k]}`).join('')
}

/**
 * Build an in-memory {@link OperationalMetricsCollector}. One per process (Node/local, drained
 * by the platform-metrics sweep) or one per isolate (the Worker, drained at the end of each
 * invocation — an isolate can be discarded at any moment, so anything it holds unflushed is
 * simply lost).
 */
export function createOperationalMetricsCollector(): OperationalMetricsCollector {
  // Keyed by `counter` then by the dimension identity, so a drain can rebuild both halves
  // without parsing the composite key back apart.
  const counters = new Map<
    OperationalCounter,
    Map<string, { dims: OperationalDimensions; value: number }>
  >()
  return {
    increment(counter, dimensions = {}, value = 1) {
      let byDimensions = counters.get(counter)
      if (!byDimensions) {
        byDimensions = new Map()
        counters.set(counter, byDimensions)
      }
      const key = dimensionKey(dimensions)
      const existing = byDimensions.get(key)
      if (existing) existing.value += value
      else byDimensions.set(key, { dims: dimensions, value })
    },
    drain() {
      const samples: OperationalCounterSample[] = []
      for (const [counter, byDimensions] of counters) {
        for (const { dims, value } of byDimensions.values()) {
          samples.push({ counter, dimensions: dims, value })
        }
      }
      counters.clear()
      return samples
    },
  }
}
