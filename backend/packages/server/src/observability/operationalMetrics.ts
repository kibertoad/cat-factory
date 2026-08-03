import {
  type OperationalMetricsCollector,
  createOperationalMetricsCollector,
} from '@cat-factory/kernel'

// The process-wide operational-metrics collector — the counter half of the observability seam
// `logger` is the line half of, exported the same way and from the same layer for the same
// reason: every facade, sweeper and service must count into ONE instance, and the way to
// guarantee that is for there to be exactly one to reach.
//
// "Process-wide" means something different per runtime, and the difference is the whole reason
// the counters are exported as DELTAS rather than totals:
//
//   - Node/local: one collector for the life of the process. The platform-metrics sweep drains
//     it on its interval, so nothing is lost between flushes.
//   - Cloudflare: one collector per ISOLATE, because a module-level value is per-isolate there.
//     An isolate is discarded whenever the runtime decides, taking anything unflushed with it,
//     so the Worker flushes at the end of every invocation that recorded something rather than
//     waiting for its cron (which runs in a different isolate that saw none of it).
//
// Neither shape can report a cumulative total honestly, and both report a delta honestly: the
// backend sums whatever arrives, from however many flushers.
//
// A deployment that exports no metrics still increments — the collector is a Map and an add, and
// the samples are simply dropped by `drain()` never being called with anywhere to send them.
// That is deliberately cheaper to reason about than a conditional counter, and it is what lets a
// counter live on a hot path (a cache read) without a wiring question at every call site.

/**
 * The process-wide (Node) / per-isolate (Worker) collector. Services reach it through the
 * injected kernel {@link import('@cat-factory/kernel').OperationalMetrics} port —
 * `CoreDependencies.operationalMetrics`, which both facades wire from HERE — never by importing
 * this module directly from a domain package.
 */
export const operationalMetrics: OperationalMetricsCollector = createOperationalMetricsCollector()
