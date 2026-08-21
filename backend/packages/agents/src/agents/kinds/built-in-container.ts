import {
  CI_FIXER_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  FIXER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
} from '@cat-factory/kernel'
import { TESTER_AGENT_KIND, UI_TESTER_AGENT_KIND } from '@cat-factory/contracts'
import {
  conflictResolverUserPrompt,
  MERGE_ASSESSMENT_SHAPE_HINT,
  mergerUserPrompt,
  ON_CALL_ASSESSMENT_SHAPE_HINT,
  onCallUserPromptSuffix,
  TASK_REASSESSMENT_SHAPE_HINT,
  taskReassessorUserPrompt,
  TEST_REPORT_SHAPE_HINT,
  UI_TEST_REPORT_SHAPE_HINT,
} from '../prompts/built-in-container.js'
import { TASK_REASSESSOR_AGENT_KIND } from '../prompts/roles.js'
import { mergerResult, onCallResult, testerResult } from './built-in-results.js'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// The BUILT-IN container agent kinds, as ordinary `registerAgentKind` entries.
//
// This is the last slice of the agent-kind strangler (`docs/internal/refactoring-candidates.md`
// #5). Every one of these used to be rendered by a `switch (context.agentKind)` in
// `@cat-factory/server`'s job-body builder, plus a parallel `agentKind === …` chain coercing the
// reply: two hand-maintained switches a deployment could not reach. They are now the SAME kind of
// declaration a deployment writes, so what a built-in does is DATA the engine reads, and a
// deployment can register its own fixer / tester / assessor beside them with no fork.
//
// What each definition deliberately does NOT carry:
//
// - **`systemPrompt`.** Every kind here already has a prompt OWNER further up
//   `baseSystemPromptFor` (a standard-phase track, the tester/fixer track, the acceptance and
//   mock tracks, or the bespoke `{ role, directives }` split `merger` / `on-call` run under).
//   The track wins there regardless, so a copy on the definition would be a second source of
//   truth that is dead the day it drifts.
// - **`presentation`.** These are first-class built-ins in the SPA's own catalog already;
//   declaring it is what promotes a REGISTERED kind into the palette (`snapshotCustomAgentKinds`
//   filters on it), so declaring it here would list each built-in twice.
// - **`gatable` / `traits`.** Both fall back to the built-in catalogs (`BUILTIN_GATABLE_KINDS`,
//   `STANDARD_AGENT_TRAITS`) when a registration omits them, and those catalogs remain the
//   answer for these kinds. A `false` here would SHADOW them.
//
// The clone/PR/infra knobs each definition does carry are declarative on purpose: they are the
// vocabulary a deployment's own kind needs too (an in-place fixer wants `requirePr`, a bespoke
// tester wants `testInfra`, a resolver wants `mergeBase`), not per-kind escape hatches.
// ---------------------------------------------------------------------------

/**
 * The agent kind of the implementer: the container agent that writes the change, commits it to
 * the per-task work branch and opens the run's pull request.
 */
export const IMPLEMENTER_AGENT_KIND = 'coder'

/** The agent kind of the read-only container agent that proposes a design after reading the repo. */
export const ARCHITECT_AGENT_KIND = 'architect'

/** The agent kind of the read-only tech-debt auditor that reads the repo and emits a report. */
export const ANALYSIS_AGENT_KIND = 'analysis'

/** The agent kind of the container agent that scores a PR for the merge decision. */
export const MERGER_AGENT_KIND = 'merger'

/**
 * The agent kind of the general/API tester: it clones the PR branch, stands the service's test
 * dependencies up, runs the suite and returns a structured report. {@link UI_TESTER_AGENT_KIND}
 * is its browser-driven, screenshot-capturing sibling.
 *
 * Re-exported from `@cat-factory/contracts` for the same reason its UI sibling is: both slugs are
 * read by `isTesterKind`, the rule every reduction of a run's test evidence starts from, and that
 * rule has to be visible to the SPA as well as to the engine. The REGISTRATION stays here.
 */
export { TESTER_AGENT_KIND } from '@cat-factory/contracts'

/** The agent kind of the container agent that builds WireMock mocks for a service's upstreams. */
export const MOCKER_AGENT_KIND = 'mocker'

/** The agent kind of the container agent that authors Playwright end-to-end tests. */
export const PLAYWRIGHT_AGENT_KIND = 'playwright'

/** The agent kind of the container agent that reads the code and commits the domain-rules docs. */
export const BUSINESS_DOCUMENTER_AGENT_KIND = 'business-documenter'

/**
 * The implementer's dispatch shape, shared by every built-in that WRITES a change and opens the
 * run's pull request: branch off base onto the deterministic per-task work branch
 * (`cat-factory/<blockId>` — per BLOCK, not per dispatch, so a retry resumes the same branch and
 * an evicted run's checkpointed commits survive), push it, open a PR.
 */
const WORK_BRANCH_CODING: AgentKindDefinition['agent'] = {
  surface: 'container-coding',
  clone: { branch: 'work' },
}

/**
 * The in-place fixer's dispatch shape: clone the PR head branch, push the fixes back onto it and
 * open NO new pull request, so the gate that dispatched the fixer re-checks the real signal on
 * the same PR. `requirePr` because a fixer with no PR has nothing to fix, and the generic
 * `pr`-clone fallback would push unrelated work onto the base branch.
 */
const IN_PLACE_CODING: AgentKindDefinition['agent'] = {
  surface: 'container-coding',
  clone: { branch: 'pr', requirePr: true },
}

/** Every built-in container kind, in one list so `defaultAgentKindRegistry` installs them once. */
export const BUILT_IN_CONTAINER_AGENT_KINDS: AgentKindDefinition[] = [
  // --- Producers: write a change, push the work branch, open the run's PR -------------------
  {
    kind: IMPLEMENTER_AGENT_KIND,
    agent: WORK_BRANCH_CODING,
    // The implementer fans out across the task's connected involved-service repos: it clones
    // each as a sibling checkout, opens the SAME work branch in every one and opens a PR per
    // repo, so a change that spans services lands as one coordinated set.
    fanOutMultiRepo: true,
  },
  { kind: MOCKER_AGENT_KIND, agent: WORK_BRANCH_CODING },
  { kind: PLAYWRIGHT_AGENT_KIND, agent: WORK_BRANCH_CODING },
  { kind: BUSINESS_DOCUMENTER_AGENT_KIND, agent: WORK_BRANCH_CODING },

  // --- Read-only explorers: clone, read, report; no commit, no PR ---------------------------
  // No `clone` target, deliberately: the generic explore resolution then prefers the per-block
  // WORK branch when one is ready, so the architect reads the spec-writer's committed `spec/`
  // and any in-progress implementation, falling back to the PR branch and then base.
  { kind: ARCHITECT_AGENT_KIND, agent: { surface: 'container-explore' } },
  { kind: ANALYSIS_AGENT_KIND, agent: { surface: 'container-explore' } },

  // --- In-place fixers: clone the PR head, push back onto it, open no new PR ----------------
  {
    kind: CI_FIXER_AGENT_KIND,
    agent: IN_PLACE_CODING,
    // Red CI on a multi-repo task is routinely a cross-repo contract break, which a single-repo
    // fixer structurally cannot fix: it resumes the SAME work branches the implementer opened,
    // in one container.
    fanOutMultiRepo: true,
  },
  { kind: FIXER_AGENT_KIND, agent: IN_PLACE_CODING },
  {
    // The conflict-resolver clones the PR head with FULL history, the harness merges the repo's
    // base branch in to surface the conflicts, the agent resolves them, and the harness completes
    // the merge commit and pushes back onto the SAME branch (refusing a half-resolved tree) so
    // the PR becomes mergeable and CI re-runs.
    //
    // `prFallback: 'work'` is the peer-conflict case: the branch to resolve on is the shared
    // per-task work branch every repo's PR rides, and the OWN service may have had no change (so
    // no own `pullRequest`) while a PEER repo did. It stays SINGLE-repo — a git conflict is
    // per-repo textual, handled by targeting the conflicted repo rather than by fanning out.
    kind: CONFLICT_RESOLVER_AGENT_KIND,
    agent: {
      surface: 'container-coding',
      clone: { branch: 'pr', full: true, requirePr: true, prFallback: 'work', mergeBase: true },
    },
    userPrompt: conflictResolverUserPrompt,
  },

  // --- Assessors: read-only structured explore whose JSON the engine acts on ----------------
  {
    // The merger clones the PR head (full, to diff against base) and returns ONLY the
    // complexity / risk / impact assessment; the ENGINE performs the real merge from those
    // scores against the task's merge threshold preset.
    //
    // `standardsDelivery: 'none'` because it JUDGES rather than produces: a house coding
    // standard has no bearing on how risky a diff is, and folding the service's standards into
    // every assessment charges each one for text it never applies.
    kind: MERGER_AGENT_KIND,
    agent: {
      surface: 'container-explore',
      clone: { branch: 'pr', full: true },
      output: { kind: 'structured', shapeHint: MERGE_ASSESSMENT_SHAPE_HINT },
    },
    userPrompt: mergerUserPrompt,
    standardsDelivery: 'none',
    mapStructuredResult: mergerResult,
  },
  {
    // The on-call agent clones the BASE branch (full, to locate + diff the merged release
    // commit) and returns ONLY the regression assessment. It never auto-reverts: the engine
    // raises a card and best-effort enriches any open incident.
    //
    // A prompt SUFFIX rather than its own user prompt: the generic block-context prompt carries
    // the regression evidence and the prior steps' output, which is the input it reasons over.
    kind: ON_CALL_AGENT_KIND,
    agent: {
      surface: 'container-explore',
      clone: { branch: 'base', full: true },
      output: { kind: 'structured', shapeHint: ON_CALL_ASSESSMENT_SHAPE_HINT },
    },
    userPromptSuffix: onCallUserPromptSuffix,
    mapStructuredResult: onCallResult,
  },
  {
    // The task re-assessor measures the three triage axes against the change that LANDED, and the
    // engine persists the result as the task's `observed` estimate (see
    // backend/docs/task-assessment.md). The estimator's retrospective twin, and the reason it is a
    // kind of its own rather than a mode of that inline kind.
    //
    // The pr-reviewer's checkout, not the merger's: base + the pull request's head fetched as
    // `origin/pr-head`. `refs/pull/<n>/head` outlives the branch a merge deletes, so one step
    // reads the same change whether it runs before the merge or after it.
    //
    // No `mapStructuredResult`, unlike its two neighbours here. Their channels exist because the
    // ENGINE acts on the reply (a merge, a page), which makes a garbage score something to default
    // conservatively; this one only RECORDS, and the cautious reading of an unreadable assessment
    // is to record nothing rather than to invent a maximally severe task. Its resolver reads the
    // raw `custom` and leaves the estimate untouched when it cannot read scores off it.
    //
    // `standardsDelivery: 'none'` for the merger's reason: it judges rather than produces, so a
    // house coding standard has no bearing on how complex the diff it is holding turned out to be.
    kind: TASK_REASSESSOR_AGENT_KIND,
    agent: {
      surface: 'container-explore',
      clone: { branch: 'base', full: true, prHead: true, requirePr: true },
      output: { kind: 'structured', shapeHint: TASK_REASSESSMENT_SHAPE_HINT },
    },
    userPrompt: taskReassessorUserPrompt,
    standardsDelivery: 'none',
  },

  // --- Testers: read-only structured explore with the service's test dependencies stood up --
  // `localWrites` because an explore surface means "never pushes", not "never writes": a tester
  // installs dependencies and runs a suite, which creates build output, so the read-only
  // guardrail's wording would read to it as a refusal to run the suite at all.
  {
    kind: TESTER_AGENT_KIND,
    agent: {
      surface: 'container-explore',
      clone: { branch: 'pr' },
      output: { kind: 'structured', shapeHint: TEST_REPORT_SHAPE_HINT },
      testInfra: true,
      localWrites: true,
    },
    mapStructuredResult: testerResult,
  },
  {
    // The UI tester is the Tester's browser-driven sibling: same read-only structured explore +
    // infra stand-up, but it drives Playwright (from the heavier UI image) to capture a
    // non-redundant screenshot of each distinct view, uploads them to the artifact store and
    // reports them under `screenshots[]`.
    kind: UI_TESTER_AGENT_KIND,
    agent: {
      surface: 'container-explore',
      clone: { branch: 'pr' },
      output: { kind: 'structured', shapeHint: UI_TEST_REPORT_SHAPE_HINT },
      testInfra: true,
      localWrites: true,
      image: 'ui',
    },
    mapStructuredResult: testerResult,
  },
]

/**
 * Register the built-in container kinds on the given registry. Called by
 * `defaultAgentKindRegistry()`; idempotent (the registry replaces by kind).
 */
export function registerBuiltInContainerAgents(registry: AgentKindRegistry): void {
  registry.registerAll(BUILT_IN_CONTAINER_AGENT_KINDS)
}
