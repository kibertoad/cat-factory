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
// ---------------------------------------------------------------------------

/**
 * Agent kinds that need a real checkout to operate on repo contents (clone,
 * edit/commit files, open a PR) and so run in a container rather than inline:
 * code implementation (`coder`), WireMock mock building (`mocker`), Playwright
 * end-to-end test authoring (`playwright`) and business-logic documentation
 * (`business-documenter`, which reads the code and commits the domain-rules docs).
 */
export const CONTAINER_AGENT_KINDS: ReadonlySet<AgentKind> = new Set([
  'coder',
  'mocker',
  'playwright',
  'business-documenter',
  // The architect explores the repository (read-only) before proposing a design, so
  // it needs a real checkout. Like `analysis` it makes no edits — the harness produces
  // no commit and opens no PR — and returns its proposal as prose `output`.
  'architect',
  // The CI-fixer clones the PR head branch, runs the failing build/tests, fixes
  // them and pushes back to the same branch — a real-checkout operation. (The `ci`
  // step itself is NOT here: it is a special, non-agent gate handled in the engine
  // that *dispatches* a `ci-fixer` job; only the fixer reaches this executor.)
  'ci-fixer',
  // The conflict-resolver clones the PR head branch, merges the base in and resolves
  // the conflicts on the same branch — a real-checkout operation. (The `conflicts`
  // gate itself is NOT here: like `ci` it is a non-agent engine gate that *dispatches*
  // a `conflict-resolver` job; only the resolver reaches this executor.)
  'conflict-resolver',
  // The merger clones the PR head branch to assess the diff (complexity/risk/impact)
  // before the engine decides whether to auto-merge — a real-checkout operation.
  'merger',
  // The tech-debt `analysis` agent clones the repo to inspect it and emit a report.
  // It is read-only (makes no edits) so the coding-agent harness produces no commit
  // and opens no PR — but it still needs a real checkout, so it runs in a container.
  'analysis',
  // The tester clones the PR branch, stands up infra (local docker-compose or an
  // ephemeral env), runs the suite and returns a structured report — a real-checkout
  // operation. (The tester step is also a special engine gate that loops a `fixer`
  // on a withheld greenlight, mirroring `ci`/`ci-fixer`; the engine dispatches both
  // jobs, which reach this executor.) `tester-api` is the general/API tester;
  // `tester-ui` is its browser-driven, screenshot-capturing sibling (UI-tester image).
  'tester-api',
  'tester-ui',
  // The fixer clones the PR head branch, applies fixes from the Tester's report and
  // pushes back to the same branch — a real-checkout operation, like `ci-fixer`.
  'fixer',
  // The on-call agent clones the released PR head to correlate its diff with the
  // Datadog regression evidence and returns a JSON assessment — a real-checkout
  // operation (makes no commits). (The `post-release-health` gate itself is NOT here:
  // like `ci` it is a non-agent engine gate that *dispatches* an `on-call` job; only
  // the on-call agent reaches this executor.)
  'on-call',
  // NOTE: `blueprints`, `spec-writer`, `initiative-analyst` and `initiative-planner` are NOT
  // listed here — they are registered agent kinds whose `container-explore` surface makes
  // `registry.requiresContainer()` return true, so `runsInContainer` covers them without a
  // hard-coded entry. (The `initiative-interviewer` / `initiative-committer` steps are
  // neither: they are non-container engine gates handled entirely in the engine.)
])

/**
 * Whether a KIND needs a real checkout: a built-in container kind, a registered custom kind
 * that declared `requiresContainer` (or a `container-*` agent surface), or a container-backed
 * companion (which clones the producer's PR branch to review the real repository).
 *
 * This is a property of the kind alone. Whether a given DISPATCH of that kind actually gets a
 * checkout is {@link dispatchDeliversCheckout}, which additionally accounts for consensus
 * diverting the step to an inline panel.
 */
export function runsInContainer(kind: AgentKind, registry: AgentKindRegistry): boolean {
  return (
    CONTAINER_AGENT_KINDS.has(kind) ||
    registry.requiresContainer(kind) ||
    isContainerBackedCompanion(kind, registry)
  )
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
