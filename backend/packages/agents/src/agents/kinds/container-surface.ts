import type { AgentKind } from '@cat-factory/kernel'
import { isContainerBackedCompanion } from './companions.js'
import type { AgentKindRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// The ONE definition of "does this dispatch hand the agent a real checkout?".
//
// Two consumers need the same answer and must never disagree about it: the
// `CompositeAgentExecutor`, which ROUTES a dispatch to the container or the inline
// executor, and the engine, which tells a kind's preOps what shape of context to prepare
// (a manifest telling the agent to run `git diff` is worse than useless to an agent with
// no git). Stated once here, in the agent CATALOG, because "which kinds need a checkout"
// is catalog knowledge rather than HTTP-layer knowledge — the composite executor imported
// `isContainerBackedCompanion` from here already.
//
// There is no built-in allow-list left. Every container kind the platform ships is a real
// registration declaring a `container-*` surface (see ./built-in-container), so the answer is
// DERIVED from the same declaration a deployment's own kind makes: adding a container kind can
// no longer mean remembering a second hard-coded Set.
// ---------------------------------------------------------------------------

/**
 * Whether a KIND needs a real checkout: a registered kind that declared `requiresContainer` (or
 * a `container-*` agent surface), or a container-backed companion (which clones the producer's
 * PR branch to review the real repository).
 *
 * This is a property of the kind alone. Whether a given DISPATCH of that kind actually gets a
 * checkout is {@link dispatchDeliversCheckout}, which additionally accounts for consensus
 * diverting the step to an inline panel.
 */
export function runsInContainer(kind: AgentKind, registry: AgentKindRegistry): boolean {
  return registry.requiresContainer(kind) || isContainerBackedCompanion(kind, registry)
}

/**
 * Whether THIS dispatch hands the agent a real checkout — i.e. whether it may be told to read
 * files or run `git`. A container kind normally does; a consensus-enabled step does NOT, because
 * consensus runs its participants as inline model calls with no filesystem and no tools.
 *
 * A kind's preOps use this to choose what shape of context to prepare. The `pr-reviewer` diff is
 * the motivating case: past its inline budget it renders a MANIFEST plus `git diff` instructions,
 * which is the right answer for a container reviewer that slices the diff itself and an
 * unreviewable file list for an inline panel.
 *
 * DELIBERATELY FAIL-SAFE, and the asymmetry matters. A consensus-enabled step is treated as
 * checkout-less even though the executor may still fall through to the standard container agent
 * (an ineligible kind, fewer than two participants, an un-cleared gate). Being wrong that way
 * hands a container agent an inlined diff it did not need — it still has the checkout, so nothing
 * is lost. Being wrong the other way hands an inline panel a file list and tells it to run git,
 * which it cannot, and the panel reviews from filenames while sounding confident. Only one of
 * those two errors is recoverable, so the prediction leans at it.
 */
export function dispatchDeliversCheckout(
  kind: AgentKind,
  registry: AgentKindRegistry,
  opts: { consensusEnabled?: boolean } = {},
): boolean {
  if (opts.consensusEnabled) return false
  return runsInContainer(kind, registry)
}
