// The pure CI verdict logic + the CI/conflicts gate + helper agent-kind constants now
// live in `@cat-factory/kernel` (`domain/gate-logic.ts`) so the built-in gate suite
// (`@cat-factory/gates`) can author the gates depending only on kernel. Re-exported here
// for the engine's existing internal call sites.
export {
  CI_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  FIXER_AGENT_KIND,
  HUMAN_REVIEW_AGENT_KIND,
  type CiVerdict,
  aggregateCi,
  isCiGreen,
  describeFailingChecks,
} from '@cat-factory/kernel'

// The inline reviewer / brainstorm gate-step kind ids are the single source of truth in
// `@cat-factory/agents` (`step-surface.ts`), co-located with the `isInlineModelStep`
// taxonomy that keys off them (agents can't import orchestration, so the classifier owns the
// ids). Re-exported here for the engine's existing internal call sites, exactly as the
// gate/helper kinds are re-exported from kernel above.
//
// - `requirements-review`: the engine runs the inline reviewer (requirements module), parks
//   the run for the review window, and drives answer → incorporate → re-review until it
//   converges (or the human resolves a hit iteration cap).
// - `clarity-review`: the inline clarity reviewer (clarity module) — triages a BUG REPORT
//   for fixability rather than reviewing requirements completeness — same park + loop.
// - `requirements-brainstorm` / `architecture-brainstorm`: the two inline brainstorm
//   (structured-dialogue) steps; propose → pick → incorporate → re-run until convergence.
//   The former explores options from a vague description (before the requirements review),
//   the latter approaches from the refined requirements (before the architect).
//
// All pass through when their module / reviewer model is not wired.
export {
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
} from '@cat-factory/agents'

/**
 * The agent kind of the read-only `bug-investigator` container agent. It clones the repo,
 * reads the codebase from the raw bug report, and returns a prose report: an enriched bug
 * report plus an OPTIONAL working hypothesis (omitted unless reasonably confident). It
 * makes no commits and opens no PR — it runs the shared read-only `/explore` harness path
 * (like `architect`/`analysis`). Its prose output feeds the downstream clarity reviewer
 * (as the triage subject) and the coder (via `priorOutputs`, as a non-binding lead).
 */
export const BUG_INVESTIGATOR_AGENT_KIND = 'bug-investigator'

/**
 * The agent kind of the `repro-test` container agent (bug-triage phase G). A structured
 * `container-coding` kind: it writes failing reproduction test(s) for the reported bug, commits
 * them onto the shared run branch (seeding it for the coder, which opens the PR), and returns a
 * `{ outcome, testPaths, notes }` assessment. Conceding (`not_reproducible`) never fails the run
 * — a post-completion resolver folds the outcome into `step.output` so the coder reads it via
 * `priorOutputs`. Registered in `@cat-factory/agents`; this is the engine-side id alias.
 */
export const REPRO_TEST_AGENT_KIND = 'repro-test'

// The `spec-writer` + `blueprints` container kinds are now real `registerAgentKind` entries in
// `@cat-factory/agents` (`agents/kinds/spec-blueprints.ts`, refactoring-candidates.md #5), so
// their ids are DEFINED there — next to the definition — and re-exported here for the engine's
// existing internal call sites, exactly as the gate/helper + inline-reviewer kinds are.
export { BLUEPRINTS_AGENT_KIND, SPEC_WRITER_AGENT_KIND } from '@cat-factory/agents'

// The remaining built-in CONTAINER kinds are real `registerAgentKind` entries too now (the last
// slice of the agent-kind strangler, `docs/internal/refactoring-candidates.md` #5), so their ids
// are DEFINED beside those definitions in `@cat-factory/agents`
// (`kinds/built-in-container.ts`) — agents can't import orchestration, so the definition owns the
// id — and re-exported here for the engine's existing internal call sites:
//
// - `merger` scores a PR's complexity/risk/impact for the merge decision; the ENGINE merges.
// - `tester-api` is the API/general tester gate step: it runs the project's tests (local
//   docker-compose infra or an ephemeral env) and returns a structured report. On a withheld
//   greenlight the engine loops the `fixer` with the report and re-tests, mirroring the CI gate /
//   ci-fixer loop. `tester-ui` ({@link UI_TESTER_AGENT_KIND}) is its browser-driven sibling.
// - `analysis` is the read-only agent that opens the tech-debt recurring pipeline: it inspects
//   the repo and emits a prioritized markdown report (no commits).
export { ANALYSIS_AGENT_KIND, MERGER_AGENT_KIND, TESTER_AGENT_KIND } from '@cat-factory/agents'
import { TESTER_AGENT_KIND } from '@cat-factory/agents'

/**
 * The agent kind of the UI tester gate step: like {@link TESTER_AGENT_KIND} but it drives
 * a real browser (Playwright/Chromium — supplied by a dedicated UI-tester container image)
 * against the running app, captures a non-redundant screenshot of each distinct view, and
 * uploads them to the binary-artifact store. Its report carries `screenshots[]`, which the
 * visual-confirmation gate reviews against the supplied reference designs. Shares the
 * Tester→Fixer loop and the service's provision-type-driven infra; always needs a running app.
 *
 * Re-exported from `@cat-factory/contracts` (the single source of truth for the slug, which the
 * SPA also uses to surface visual pipelines) so the wire value can't drift between the two.
 */
export { UI_TESTER_AGENT_KIND } from '@cat-factory/contracts'
import { UI_TESTER_AGENT_KIND } from '@cat-factory/contracts'

/** Both tester gate kinds (API + UI). They share the Tester→Fixer loop + infra choice. */
export const TESTER_KINDS: readonly string[] = [TESTER_AGENT_KIND, UI_TESTER_AGENT_KIND]

/**
 * Whether an agent kind is one of the tester gate kinds (API or UI).
 *
 * Re-exported from `@cat-factory/contracts` rather than restated: it is the first question every
 * reduction of a run's test evidence asks, and the SPA has to ask it too, which is exactly how
 * the engine's copy and a hand-written frontend one came to be two spellings of one rule.
 */
export { isTesterKind } from '@cat-factory/contracts'

/**
 * The agent kind of the special `tracker` step: a non-LLM step that files a GitHub
 * issue / Jira ticket from the preceding `analysis` output before implementation,
 * mirroring the special handling of the `ci` gate. Passes through when no tracker
 * is configured for the workspace.
 */
export const TRACKER_AGENT_KIND = 'tracker'

/**
 * The agent kind of the special `human-test` gate: a non-LLM engine step that spins up an
 * ephemeral environment, PARKS for a human to validate the change in the live URL, and on
 * demand dispatches the Tester's `fixer` (from the human's findings) or the
 * `conflict-resolver` (when a "pull latest main" hits a conflict). Confirming tears the env
 * down and advances. Handled by the {@link HumanTestController}; passes through to a manual
 * (no-env) mode when no ephemeral-environment provider is wired.
 */
export const HUMAN_TEST_AGENT_KIND = 'human-test'

/**
 * The agent kind of the special `visual-confirmation` gate: a non-LLM engine step that
 * PARKS for a human to review the UI tester's screenshots against the uploaded reference
 * designs, then on demand dispatches the Tester's `fixer` (from the human's findings) and
 * re-captures via the UI tester. Approving advances the run. Handled by the
 * {@link VisualConfirmationController}; passes through (auto-advances) when no binary-artifact
 * store is wired (nowhere to read screenshots from).
 *
 * Re-exported from `@cat-factory/contracts` (the single source of truth) so the wire value
 * can't drift between the engine and the SPA's visual-pipeline surface.
 */
export { VISUAL_CONFIRM_AGENT_KIND } from '@cat-factory/contracts'
