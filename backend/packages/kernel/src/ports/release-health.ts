// Port for reading a deployed release's health from an observability provider
// (today Datadog) for the post-release-health gate. Modelled on `CiStatusProvider`:
// the gate polls `probe` between durable sleeps over a monitoring window and, on a
// regression, escalates to the `on-call` agent — handing it the bundle from
// `gatherEvidence`. Core stays free of Datadog specifics; the facade resolves the
// block's release-health config (which monitors/SLOs to read) and credentials.

/** The state of a single monitored signal (a Datadog monitor or SLO). */
export type ReleaseSignalState = 'ok' | 'warn' | 'alert' | 'no_data'

/** Whether a {@link ReleaseSignal} is a Datadog monitor or an SLO. */
export type ReleaseSignalKind = 'monitor' | 'slo'

/** One configured monitor/SLO, flattened to its current state. */
export interface ReleaseSignal {
  kind: ReleaseSignalKind
  /** The Datadog monitor or SLO id. */
  id: string
  name: string
  state: ReleaseSignalState
  /** Optional human detail (current value vs threshold, SLO budget burn, …). */
  detail?: string
}

/**
 * The provider's verdict on the configured signals (independent of the gate's
 * monitoring-window timing, which the engine layers on):
 *  - `healthy`   — nothing alerting / no SLO breached.
 *  - `pending`   — no verdict yet (e.g. `no_data` right after deploy).
 *  - `regressed` — at least one monitor alerting or SLO breached.
 */
export type ReleaseHealthStatus = 'healthy' | 'pending' | 'regressed'

export interface ReleaseHealthReport {
  status: ReleaseHealthStatus
  signals: ReleaseSignal[]
}

/** A recent error group / log sample gathered for the on-call investigation. */
export interface ReleaseErrorSample {
  /** Error class / log group title. */
  title: string
  /** Occurrences in the window, when known. */
  count?: number
  /** Epoch ms of first occurrence in the window, when known. */
  firstSeen?: number
  /** A representative message / sample line. */
  sampleMessage?: string
  /** Deep link to the source (Datadog log view / Bugsnag error), when known. */
  url?: string
}

/** The investigation bundle handed to the on-call agent on a regression. */
export interface ReleaseEvidence {
  /** The signals that are alerting / breached. */
  regressedSignals: ReleaseSignal[]
  /** Recent error groups / log samples from the observability + error sources. */
  errors: ReleaseErrorSample[]
  /** Free-form notes (query windows used, services inspected). */
  notes?: string
}

export interface ReleaseHealthProvider {
  /**
   * Read the configured monitors/SLOs for the block's release since `since`
   * (epoch ms of the release marker). The engine combines this verdict with the
   * monitoring-window timing to decide pass / keep-polling / escalate.
   */
  probe(workspaceId: string, blockId: string, since: number): Promise<ReleaseHealthReport>
  /** Gather the investigation evidence bundle for the on-call agent. */
  gatherEvidence(workspaceId: string, blockId: string, since: number): Promise<ReleaseEvidence>
}

/**
 * Optional secondary error-tracking source (e.g. Bugsnag) feeding the evidence
 * bundle. Wired only when configured; Datadog is the required source.
 */
export interface ErrorTrackingProvider {
  recentErrors(workspaceId: string, blockId: string, since: number): Promise<ReleaseErrorSample[]>
}
