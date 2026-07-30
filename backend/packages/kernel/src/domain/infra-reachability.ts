import {
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
export type ProbeVerdict = 'reachable' | 'unreachable' | 'indeterminate'

/**
 * One area's probe result.
 *
 * `indeterminate` is deliberately distinct from `unreachable`: it means the probe never got to
 * ask (the connection could not be resolved, its secret bundle would not decrypt, the area is not
 * configured on this deployment). Reporting that as an outage would turn a LOCAL fault — the
 * classic one being a node with no access to the sealing key — into a banner blaming the
 * operator's cluster. An indeterminate area is left exactly as it was recorded, so a genuine
 * outage already on the card survives and a healthy area is never falsely accused.
 */
export interface ProbeOutcome {
  area: InfraSetupArea
  verdict: ProbeVerdict
  /** The probe's operator-facing reason, when it reported one. Never persisted; see {@link InfraSetupTransition}. */
  detail?: string
}

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
  }
}

/**
 * Fold the recorded unreachable areas into a setup projection, for the board snapshot.
 *
 * Only an area the projection already calls `configured` can become `unreachable`: the other
 * three states out-rank a stale probe result. `not_defined` means the connection is gone — the
 * operator un-registered it, so the "set it up" nag is the correct and more actionable one, and a
 * lingering card would otherwise report an outage for something that no longer exists.
 */
export function applyInfraReachability(
  projection: InfraSetup,
  unreachableAreas: readonly InfraSetupArea[],
): InfraSetup {
  if (unreachableAreas.length === 0) return projection
  const folded = { ...projection }
  for (const area of unreachableAreas) {
    if (folded[area] === 'configured') folded[area] = 'unreachable'
  }
  return folded
}
