import {
  applyInfraSetupTransition,
  type ConnectionTestResult,
  INFRA_SETUP_PROBED_AREAS,
  type InfraSetup,
  type InfraSetupArea,
  type Notification,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Pure logic for the infrastructure REACHABILITY watcher: the sweep decides which
// configured areas answer their connection probe, and this module turns "what we observed"
// plus "what we last recorded" into the transitions to announce and the projection the
// board renders. No clock, no IO, no repositories — so every rule below is table-tested.
//
// The last-observed state lives on the workspace's open `infra_unreachable` notification
// (its `payload.unreachableAreas`), the same way the platform-health sweep uses its card's
// `platformAlerts` set. That card is durable, already runtime-symmetric, already routed for
// mothership mode and already read by the board snapshot, which is what lets the watcher
// publish on TRANSITION only without a store of its own. Two consequences the callers rely on:
//   - the sweep's decision is derivable from ONE batched `listOpenByType` read, not a
//     per-workspace point-read (see the N+1 rule), and
//   - a mid-outage reload still renders the banner, because the projection folds the same
//     recorded set rather than re-probing on the hot board-load path.
// ---------------------------------------------------------------------------

/** What one area's live probe reported. `indeterminate` is NOT a verdict — see {@link ProbeOutcome}. */
export type ProbeVerdict = 'reachable' | 'unreachable' | 'indeterminate' | 'not_configured'

/**
 * One area's probe result.
 *
 * `indeterminate` is deliberately distinct from `unreachable`: it means the probe never got to
 * ask (the connection could not be resolved, its secret bundle would not decrypt, the provider
 * exposes no connection test). Reporting that as an outage would turn a LOCAL fault — the
 * classic one being a node with no access to the sealing key — into a banner blaming the
 * operator's cluster. An indeterminate area is left exactly as it was recorded, so a genuine
 * outage already on the card survives and a healthy area is never falsely accused.
 *
 * `not_configured` is distinct from BOTH, and the distinction is what stops an outage card
 * outliving the thing it reports on: nothing is registered for the area any more, which is
 * knowably NOT an outage. Collapsing it into `indeterminate` (as "there was nothing to probe"
 * once did) meant an operator who fixed a dead runner pool by UN-REGISTERING it kept the open
 * `infra_unreachable` card forever — no probe could ever clear a record that only a probe
 * clears, and the staleness sweep escalated it red. So it drops the recorded area while
 * announcing NOTHING: the honest live state is the `not_defined` setup gap the snapshot
 * recomputes, never a "recovered" push for a connection that no longer exists.
 */
export interface ProbeOutcome {
  area: InfraSetupArea
  verdict: ProbeVerdict
  /** The probe's operator-facing reason, when it reported one. Never persisted; see {@link InfraSetupTransition}. */
  detail?: string
}

/**
 * What probing a workspace's SAVED connection found, as the connection services report it.
 *
 * Three states, not "a result or null", because the three need three different dispositions and
 * only one of them is an outage. `absent` is a deployment/operator FACT (nothing is registered);
 * `unprobeable` is our own inability to ask (a de-registered backend kind, an unparseable config
 * blob, a provider with no connection test); `answered` carries the provider's verdict. Collapsing
 * the first two — which the `ConnectionTestResult | null` shape forced — is what let an outage card
 * outlive the connection it reported on.
 */
export type SavedConnectionProbe =
  | { state: 'absent' }
  | { state: 'unprobeable'; reason: string }
  | { state: 'answered'; result: ConnectionTestResult }

/** One area's reachability transition, as published on the `infraSetup` realtime event. */
export interface InfraSetupTransition {
  area: InfraSetupArea
  /** `unreachable` when the area just started failing; `configured` when it recovered. */
  status: 'unreachable' | 'configured'
  detail?: string
}

/** What one sweep pass concluded for a workspace. */
export interface ReachabilityDecision {
  /** The areas to record on the card, sorted — the card's dedup identity. Empty ⇒ clear the card. */
  unreachableAreas: InfraSetupArea[]
  /** The transitions to publish. Empty ⇒ nothing changed, so nothing is announced. */
  transitions: InfraSetupTransition[]
  /**
   * Whether the recorded set differs from `previous`, i.e. whether the card needs writing.
   *
   * Deliberately NOT derivable from `transitions.length`: a `not_configured` area drops out of the
   * record while announcing nothing, so a pass that short-circuits on "no transitions" would leave
   * the stale card in place — exactly the bug that verdict exists to fix.
   */
  recordChanged: boolean
}

/**
 * The areas recorded as unreachable on a workspace's open `infra_unreachable` card, or an empty
 * list when there is none. Filtered to the known probed areas so a card written by a newer
 * deployment (or a hand-edited payload) can never inject an area this build does not model.
 */
export function recordedUnreachableAreas(card: Notification | null | undefined): InfraSetupArea[] {
  const raw = card?.payload?.unreachableAreas
  if (!raw) return []
  const probed: readonly string[] = INFRA_SETUP_PROBED_AREAS
  return raw.filter((area) => probed.includes(area))
}

/**
 * Decide one workspace's reachability outcome: the set to record and the transitions to announce.
 *
 * `previous` is what the card recorded; `observed` is this pass's probes. An area with no probe in
 * `observed` — or an `indeterminate` one — keeps its previous state, so a pass that could only
 * reach half the areas neither invents a recovery nor drops an ongoing outage.
 */
export function decideReachability(
  previous: readonly InfraSetupArea[],
  observed: readonly ProbeOutcome[],
): ReachabilityDecision {
  const was = new Set(previous)
  const next = new Set(previous)
  const transitions: InfraSetupTransition[] = []
  for (const probe of observed) {
    if (probe.verdict === 'indeterminate') continue
    // Nothing is registered for the area any more: forget any recorded outage (so the card clears
    // instead of outliving the connection) but announce NOTHING — see {@link ProbeOutcome}.
    if (probe.verdict === 'not_configured') {
      next.delete(probe.area)
      continue
    }
    const failing = probe.verdict === 'unreachable'
    if (failing === was.has(probe.area)) continue
    if (failing) next.add(probe.area)
    else next.delete(probe.area)
    transitions.push({
      area: probe.area,
      status: failing ? 'unreachable' : 'configured',
      ...(failing && probe.detail ? { detail: probe.detail } : {}),
    })
  }
  return {
    // Sorted so the recorded set is a STABLE identity: two passes that observe the same outage in
    // a different probe order must not read as a content change and re-deliver the card.
    unreachableAreas: [...next].sort(),
    transitions,
    recordChanged: next.size !== was.size || [...next].some((area) => !was.has(area)),
  }
}

/**
 * Fold the recorded unreachable areas into a setup projection, for the board snapshot.
 *
 * A pure fold over contracts' `applyInfraSetupTransition`, which owns the rule about which prior
 * state a probe verdict may overwrite (only a `configured` area may become `unreachable`). Sharing
 * it with the SPA's live event patch is the point: the two paths render the same banner, so a rule
 * implemented twice is a rule that eventually disagrees with itself.
 */
export function applyInfraReachability(
  projection: InfraSetup,
  unreachableAreas: readonly InfraSetupArea[],
): InfraSetup {
  return unreachableAreas.reduce(
    (folded, area) => applyInfraSetupTransition(folded, area, 'unreachable'),
    projection,
  )
}
