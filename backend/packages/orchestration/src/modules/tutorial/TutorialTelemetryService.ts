import type { TutorialEvent } from '@cat-factory/contracts'
import type { Logger, OperationalCounter, OperationalMetrics } from '@cat-factory/kernel'
import { noopLogger } from '@cat-factory/kernel'

/**
 * How many DISTINCT tour ids one process (one isolate, on the Worker) will report as its own
 * dimension value before folding the rest onto {@link OTHER_TOUR}.
 *
 * Sized well above any real catalog — the built-ins ship 13, and a deployment contributing its own
 * is still counted in tens — so a healthy deployment never reaches it and an overflow is a genuine
 * signal rather than a routine truncation.
 */
export const MAX_DISTINCT_TOURS = 64

/** The bucket every id past the cap is counted under. Visible in the data, never dropped. */
export const OTHER_TOUR = 'other'

const COUNTER: Record<TutorialEvent, OperationalCounter> = {
  started: 'tutorial.tour_started',
  completed: 'tutorial.tour_completed',
  abandoned: 'tutorial.tour_abandoned',
}

export interface TutorialTelemetryServiceDependencies {
  metrics: OperationalMetrics
  logger?: Logger
}

/**
 * Counts in-app tutorial funnel events, with the one thing a browser-supplied metric dimension
 * cannot be trusted to be: BOUNDED.
 *
 * Every distinct dimension value is its own time series in the operator's backend, so an
 * unbounded one costs them money and eventually gets the whole series dropped. The wire schema
 * already constrains an id's SHAPE, which stops junk but not volume: a buggy or hostile client can
 * still emit an unlimited number of well-formed ids. So this holds the set it has already reported
 * and folds everything past {@link MAX_DISTINCT_TOURS} onto {@link OTHER_TOUR}.
 *
 * The overflow is REPORTED, not silently absorbed, in both the ways that matter: the `other` series
 * exists in the data (so a reader can see that something was folded rather than concluding the tail
 * was never sent), and the first overflow logs once, naming the cap. A cap nobody can see reads
 * exactly like complete coverage.
 *
 * Per process rather than shared, matching the collector it feeds: a counter is accumulated and
 * flushed per process on Node and per ISOLATE on the Worker, so a cap held anywhere else would be
 * a different scope from the thing it is protecting.
 */
export class TutorialTelemetryService {
  private readonly log: Logger
  private readonly seen = new Set<string>()
  private overflowReported = false

  constructor(private readonly deps: TutorialTelemetryServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  record(event: TutorialEvent, tourId: string): void {
    this.deps.metrics.increment(COUNTER[event], { tour: this.dimension(tourId) })
  }

  /** The bounded dimension value for a tour id: itself, or the overflow bucket. */
  private dimension(tourId: string): string {
    if (this.seen.has(tourId)) return tourId
    if (this.seen.size < MAX_DISTINCT_TOURS) {
      this.seen.add(tourId)
      return tourId
    }
    if (!this.overflowReported) {
      this.overflowReported = true
      this.log.warn('Tutorial event dimension cap reached; further tours counted as "other"', {
        limit: MAX_DISTINCT_TOURS,
        tourId,
      })
    }
    return OTHER_TOUR
  }
}
