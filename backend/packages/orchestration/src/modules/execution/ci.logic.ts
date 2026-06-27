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
  listFailingChecks,
  describeFailingChecks,
} from '@cat-factory/kernel'

/**
 * The agent kind of the special requirements-review gate step. It is NOT a container /
 * prose agent: the engine runs the inline reviewer (via the requirements module), parks
 * the run for the dedicated review window, and drives the iterative answer → incorporate →
 * re-review loop until it converges (or the human resolves a hit iteration cap). Passes
 * through when the requirements module / reviewer model is not wired.
 */
export const REQUIREMENTS_REVIEW_AGENT_KIND = 'requirements-review'

/**
 * The agent kind of the special clarity-review gate step. Like the requirements reviewer
 * it is an INLINE engine step (not a container/prose agent): the engine runs the inline
 * clarity reviewer (via the clarity module), parks the run for the dedicated review
 * window, and drives the iterative answer → incorporate → re-review loop until it
 * converges. It triages a BUG REPORT for fixability rather than reviewing requirements
 * completeness. Passes through when the clarity module / reviewer model is not wired.
 */
export const CLARITY_REVIEW_AGENT_KIND = 'clarity-review'

/**
 * The agent kinds of the two brainstorm (structured-dialogue) gate steps. Like the
 * requirements / clarity reviewers they are INLINE engine steps (not container/prose
 * agents): the engine runs the inline brainstorm agent (via the brainstorm module), parks
 * the run for the dedicated brainstorm window, and drives the iterative propose → pick →
 * incorporate → re-run loop until it converges. `requirements-brainstorm` explores options
 * from a vague description (before the requirements review); `architecture-brainstorm`
 * explores approaches from the refined requirements (before the architect). Both pass
 * through when the brainstorm module / model is not wired.
 */
export const REQUIREMENTS_BRAINSTORM_AGENT_KIND = 'requirements-brainstorm'
export const ARCHITECTURE_BRAINSTORM_AGENT_KIND = 'architecture-brainstorm'

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
 * The agent kind of the container agent that writes the service's unified, in-repo
 * specification (`spec.json`). It runs BEFORE the coder and aggregates the collected
 * requirements of every task under the service frame — including their acceptance
 * scenarios — onto the implementation branch.
 */
export const SPEC_WRITER_AGENT_KIND = 'spec-writer'

/**
 * The agent kind of the container agent that maps a repository into the canonical
 * service → modules blueprint and (re)generates the in-repo `blueprints/` artifact. It
 * runs as a read-only `container-explore` structured agent; the deterministic render +
 * commit of the artifact is a BACKEND post-op (`blueprintPostOp`), not harness code.
 */
export const BLUEPRINTS_AGENT_KIND = 'blueprints'

/** The agent kind of the container agent that scores a PR for the merge decision. */
export const MERGER_AGENT_KIND = 'merger'

/**
 * The agent kind of the API/general tester gate step (formerly `tester`): a container
 * agent that runs the project's tests (local docker-compose infra or an ephemeral env)
 * and returns a structured report. On a withheld greenlight the engine loops the `fixer`
 * agent with the report and re-tests — mirroring the CI gate / ci-fixer loop. The UI
 * tester ({@link UI_TESTER_AGENT_KIND}) is its browser-driven, screenshot-capturing sibling.
 */
export const TESTER_AGENT_KIND = 'tester-api'

/**
 * The agent kind of the UI tester gate step: like {@link TESTER_AGENT_KIND} but it drives
 * a real browser (Playwright/Chromium — supplied by a dedicated UI-tester container image)
 * against the running app, captures a non-redundant screenshot of each distinct view, and
 * uploads them to the binary-artifact store. Its report carries `screenshots[]`, which the
 * visual-confirmation gate reviews against the supplied reference designs. Shares the
 * Tester→Fixer loop and the `tester.environment` infra choice; always needs a running app.
 */
export const UI_TESTER_AGENT_KIND = 'tester-ui'

/** Both tester gate kinds (API + UI). They share the Tester→Fixer loop + infra choice. */
export const TESTER_KINDS: readonly string[] = [TESTER_AGENT_KIND, UI_TESTER_AGENT_KIND]

/** Whether an agent kind is one of the tester gate kinds (API or UI). */
export function isTesterKind(kind: string): boolean {
  return kind === TESTER_AGENT_KIND || kind === UI_TESTER_AGENT_KIND
}

/**
 * The agent kind of the read-only code-analysis agent that opens the tech-debt
 * recurring pipeline: it inspects the repo and emits a prioritized markdown report
 * (no commits). Reuses the generic container run path — no special engine handling.
 */
export const ANALYSIS_AGENT_KIND = 'analysis'

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
