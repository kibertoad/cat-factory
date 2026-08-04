// The outbound PLATFORM-HEALTH seam: a push telling an on-call system that the deployment's own
// aggregate run health crossed an operator threshold, and later that it recovered.
//
// Three outbound families now share the workspace's one registered endpoint, and each exists
// because the others cannot carry it. `NotificationChannel` delivers the cards a HUMAN must
// resolve. `RunLifecycleSink` delivers the ordinary lifecycle of work an integration queued.
// This delivers the platform watching ITSELF: not a fact about one run, and not something a
// person is expected to go and act on in the board, but the signal a pager is wired to.
//
// It is a port rather than a `platform_health` notification type on the channel next door
// because the two answer different questions, and routing an alert through the card would make
// the answer depend on the card's lifecycle. A card is delivered on every content change and
// re-delivered when a human acts on it or dismisses it, so a dismissal in the inbox reaches a
// receiver as `status: 'dismissed'` — indistinguishable, on the wire, from the sweep clearing
// the card because the deployment recovered. An on-call integration would resolve its incident
// because somebody tidied their inbox. The edges here are produced by the sweep's own verdict:
// `platform_health.firing` when the firing condition set changes, `platform_health.resolved`
// only when the sweep itself observes recovery.
//
// The port takes an ALREADY-EVALUATED verdict rather than the observability projection, for the
// same reason `RunLifecycleSink` takes a projected event: the sweep owns what "unhealthy" means,
// and a transport must not be able to widen what leaves the deployment by reaching for another
// field. It also keeps kernel free of the orchestration + contracts types the evaluation uses.

/**
 * The platform-health transitions an external receiver can subscribe to. Deliberately only the
 * EDGES: the sweep runs every couple of minutes and a condition holds for the length of an
 * incident, so a per-pass feed would be a page every pass. A receiver that wants the live numbers
 * reads the operator dashboard the alert names.
 */
export const PLATFORM_ALERT_EVENTS = ['platform_health.firing', 'platform_health.resolved'] as const
export type PlatformAlertEventKind = (typeof PLATFORM_ALERT_EVENTS)[number]

/** Whether `value` is one of the known alert events (a lenient decode for a stored filter). */
export function isPlatformAlertEventKind(value: unknown): value is PlatformAlertEventKind {
  return typeof value === 'string' && (PLATFORM_ALERT_EVENTS as readonly string[]).includes(value)
}

/**
 * One condition that tripped, with the numbers behind it.
 *
 * `reason` is NOT narrowed to a union here, and that is deliberate rather than laziness. The
 * vocabulary is the contracts `PlatformAlertReason` picklist, which grows additively (three
 * members were added after the first alert shipped) and is defined a layer up from kernel. A
 * closed copy here would be a second list to keep in step, and narrowing it on the way out would
 * mean a deployment one release ahead of its receiver silently DROPS the very condition it is
 * paging about. Same rule the SDKs apply to the error envelope's `code`: pass the vocabulary
 * through verbatim and let the receiver treat an unknown member as an unknown member.
 */
export interface PlatformAlertCondition {
  /** The tripped condition, e.g. `failure_rate_high` (contracts' `PlatformAlertReason`). */
  reason: string
  /** The observed value that crossed the threshold (a rate 0..1, ms, or a count by reason). */
  value: number
  /** The configured threshold it crossed, in the same unit as {@link value}. */
  threshold: number
}

/** One failing run behind an alert, so a receiver can link to the evidence. */
export interface PlatformAlertFailingRun {
  executionId: string
  /** The board task the run belongs to; null when the run carries none. */
  blockId: string | null
  /** The run's `failure.kind` (or `unknown`): why this one is in the sample. */
  failureKind: string
  createdAt: number
}

/**
 * One platform-health transition, projected for delivery.
 *
 * Unlike the `platform_health` notification card — whose payload is its dedup identity, and
 * therefore deliberately carries no fluctuating numbers — this is an EVENT emitted only on a
 * transition and stored nowhere, so it carries the observed values that tripped each condition.
 * Those numbers are what an on-call receiver routes and pages on.
 */
export interface PlatformAlertEvent {
  event: PlatformAlertEventKind
  /**
   * The id of the platform's own `platform_health` card for this workspace — the row the sweep
   * keeps its alert state in, and therefore this incident's identity. It is reused while an
   * incident stays open and minted afresh for the next one, which makes it the INCIDENT half of
   * a receiver's dedupe key; {@link transition} is the TRANSITION half, since one incident emits
   * several edges under this same id.
   */
  cardId: string
  /**
   * The account whose aggregate health this describes. The condition is evaluated per ACCOUNT
   * while the endpoint is registered per WORKSPACE, so one account-level transition fans out to
   * every subscribed workspace in that account. A receiver watching several collapses the fan-out
   * by grouping on this id.
   */
  accountId: string
  /**
   * Which transition of this incident this edge is, counting from 1 at the edge that opened it.
   * With {@link cardId} it identifies one transition exactly, and each is needed because of what
   * the other cannot separate: the card id is reused for a whole incident, while the firing
   * REASON SET recurs within one ({A} escalating to {A,B} and subsiding back to {A} is three
   * transitions over two distinct sets), so a key built on the set alone would have a deduping
   * receiver drop the page saying the incident had subsided.
   *
   * A timestamp cannot do this job. Sweepers are per process and only guarded against overlap
   * WITHIN one, so a multi-node deployment can have two observe the same transition; they agree
   * on the prior card this counts from and therefore on the ordinal, but never on a clock read.
   * Deriving it keeps a genuine duplicate collapsible while keeping two real transitions apart.
   *
   * Always 1 on `platform_health.resolved`: an incident resolves once, so `cardId` alone already
   * identifies that edge.
   */
  transition: number
  /** The window the aggregate was computed over (`1h` / `24h` / `7d`). */
  window: string
  /**
   * The conditions firing at this transition, sorted by reason so successive deliveries are
   * comparable. EMPTY on `platform_health.resolved`, which is the whole content of that edge.
   */
  conditions: PlatformAlertCondition[]
  /**
   * Epoch-ms the SWEEP observed this transition, which is not any timestamp the card carries.
   * The card's `createdAt` is preserved across a re-raise (so an escalation would report the
   * moment the incident opened, not the moment it got worse) and its `resolvedAt` is nullable,
   * so the producer stamps the pass instead. Every edge one pass emits shares the value: an
   * account-level verdict fanned out to its workspaces is ONE observation.
   */
  occurredAt: number
  /**
   * A bounded sample of the runs behind a failure-driven alert, in the DELIVERED workspace only
   * (an alert reaching one workspace must never name another's runs). Empty when the firing set
   * has no run evidence behind it (a backlog or stall alert) or when the evidence read failed —
   * {@link failedTotal} is what tells those apart from "nothing failed".
   */
  failingRuns: PlatformAlertFailingRun[]
  /**
   * How many runs in the delivered workspace had failed in the window when the alert fired, so
   * the capped sample states what it left out. NULL when the platform could not read it, which is
   * a different fact from zero and is reported as one.
   */
  failedTotal: number | null
}

/**
 * Delivers platform-health transitions outward. Best-effort BY CONTRACT: an implementation must
 * never propagate a receiver's outage into the sweep, because the alternative is a broken pager
 * endpoint stopping the watcher that noticed the deployment was unhealthy in the first place.
 */
export interface PlatformAlertSink {
  platformHealthChanged(workspaceId: string, event: PlatformAlertEvent): Promise<void>
}
