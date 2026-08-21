import type { InjectedContextFile, PullRequestRef } from '../domain/types.js'
import type { AgentRunContext, AgentRunResult } from './agent-executor.js'
import type { Logger } from './logging.js'
import type { RepoFiles } from './repo-files.js'

// ---------------------------------------------------------------------------
// The execution-surface + pre/post-op vocabulary an agent definition composes.
//
// Every agent decomposes into three stages, and the container runs only the middle
// one (see `backend/docs/custom-agents.md`):
//   1. preOps  — deterministic backend TypeScript run BEFORE the agent step. Reads a
//                targeted, known subset of the repo (no checkout) and may commit, via
//                the {@link RepoFiles} port.
//   2. agent   — an optional LLM step on one of three surfaces (inline / container
//                read-only explore / container coding).
//   3. postOps — deterministic backend TypeScript run AFTER the agent returns. Parses
//                the structured output, renders artifact files and commits them.
//
// preOps/postOps are plain functions (TS hooks), so a custom agent ships its mechanical
// logic as ordinary backend code — never a container rebuild, never a per-kind branch
// inside the harness.
// ---------------------------------------------------------------------------

/** Where an agent's LLM step runs. */
export type AgentSurface =
  /** A one-shot inline LLM call over the provided context — no repo, no container. */
  | 'inline'
  /** A read-only container run: clone + explore + return prose or structured JSON; no push. */
  | 'container-explore'
  /** A container run that edits a working tree and commits + pushes (optionally opens a PR). */
  | 'container-coding'

/** How an explore agent's reply is consumed. */
export interface AgentOutputSpec {
  /** `prose` keeps the reply as text; `structured` parses + (optionally) repairs it to JSON. */
  kind: 'prose' | 'structured'
  /**
   * Compact human description of the expected JSON shape, fed to the harness's one-shot
   * structured-output repair call when the first parse fails. Structured kind only.
   */
  shapeHint?: string
  /** Whether to attempt the one-shot structured-output repair on a malformed reply. */
  repair?: boolean
  /**
   * Fail the run LOUDLY when the agent's FINAL answer is unusable — cut off at the
   * output-token ceiling, or an empty completion — instead of letting the structured
   * repair launder a truncated reply into a half-baked document. Opt-in for the kinds
   * whose deliverable IS the JSON they return and is handed onward to be parsed +
   * committed (spec-writer, …): for them a truncated final turn means there is nothing
   * trustworthy to persist. Absent ⇒ off (a prose/side-effect kind never sets it).
   */
  failOnUnusableFinal?: boolean
}

/** What a container agent clones (resolved to a concrete branch by the engine at dispatch). */
export interface AgentCloneSpec {
  /**
   * Which branch to check out:
   *   - `base` — the repo default branch.
   *   - `pr`   — the block's PR branch, edited in place (a fixer: push back, open no new PR).
   *   - `work` — the per-block work branch off base (a coder: push it, open a PR).
   *   - `pr-or-work` — adaptive: behave like `pr` when the block already has a PR (amend it in
   *     place, no new PR), else fall back to the `work` flow (branch off base, open a PR). Lets a
   *     single kind serve both a BAU pipeline step (amend the coder's PR) and a standalone /
   *     initiative run (open its own PR) — the comments-writer's dual use.
   */
  branch: 'base' | 'pr' | 'work' | 'pr-or-work'
  /** A monorepo subtree to sparse-checkout (storage optimisation); absent ⇒ whole repo. */
  sparsePaths?: string[]
  /** Full history (needed to diff against base / merge); absent ⇒ shallow. */
  full?: boolean
  /**
   * Fetch a pull request's HEAD into the checkout as `origin/pr-head` before the agent runs (the
   * `pr-reviewer`, the `task-reassessor`). Such a kind clones the `base` branch, so files the
   * change ADDS are absent and modified files are only at their base version, and the container
   * agent has no git credential of its own, so it cannot fetch the head itself (the token lives
   * with the harness). When set, the engine resolves the PR number into the job's `reviewPrNumber`
   * and the harness fetches `pull/<n>/head` (GitHub) / `merge-requests/<n>/head` (GitLab) with its
   * token, so the agent can `git diff origin/<base>...origin/pr-head` and read full head file
   * bodies. Best-effort by default: a failed or unresolvable fetch just leaves the run on the base
   * checkout (see {@link requirePr} for the kinds that cannot work that way).
   *
   * That ref is also what makes this shape survive a MERGE: the branch a merge deletes takes a
   * `pr` clone with it, while `refs/pull/<n>/head` stays fetchable, so a kind reading the change
   * after it landed reads the same diff a kind reading it before the merge does.
   */
  prHead?: boolean
  /**
   * WHICH pull request {@link prHead} fetches, because two of them can be the subject and the
   * answer follows from the kind's job rather than from what happens to be on the block:
   *
   *   - `task` (the default) — the PR the TASK ITSELF names in its own fields (`prNumber`/`prUrl`),
   *     which is what the `pr-reviewer` was created to read. A run of a review task opens no pull
   *     request of its own, so there is nothing else this kind could mean.
   *   - `run` — the PR THIS RUN opened, recorded on the block, which is what a kind assessing the
   *     change the run just landed is looking at (the `task-reassessor`).
   *
   * Declared rather than resolved by precedence (`task ?? run`) because a precedence silently
   * widens every kind that already had one source: a review task whose run also opened a PR would
   * start prefetching a head its review state knows nothing about, and the prompt naming one PR
   * while the checkout carries the other is invisible until a score is attributed to the wrong
   * change. Ignored when {@link prHead} is unset.
   */
  prHeadSource?: 'task' | 'run'
  /**
   * The block has NO pull request to work on: state that this kind cannot proceed on the base
   * branch, instead of falling back to it (or to {@link prFallback}). What that COSTS depends on
   * whether the kind WRITES on the pull request or READS it, and the two are different
   * dispositions rather than one:
   *
   *   - a WRITER (the in-place fixers, the conflict-resolver: `branch: 'pr'`) REFUSES the dispatch.
   *     With no PR there is nothing to fix, and a silent fall back to base would push unrelated
   *     work onto it, so failing loudly is the only safe answer.
   *   - a READER (a {@link prHead} kind scoring or judging the change a PR carries) is SKIPPED
   *     before dispatch, with `skipReason: 'no_pull_request'` on the step. A base checkout holds
   *     nothing to judge and scoring it as though it were the change is the failure mode this flag
   *     exists to prevent, but the reader's product is a record nothing gates on, so failing the
   *     run would end one whose work has already shipped over a reading nobody asked for. The skip
   *     is taken in the run preamble (`runStepPreamble`), beside the estimate gate and the run
   *     condition, so it costs nothing and reads on the board as what it is.
   *
   * Absent ⇒ the fallback runs.
   */
  requirePr?: boolean
  /**
   * What a `pr` clone falls back to when the block carries no PR branch: the repo's base branch
   * (the default) or the per-block WORK branch. `work` is right for a kind that acts on the
   * shared per-task branch every repo's PR rides, which is the robust value when the OWN service
   * had no change but a PEER repo did (the peer-conflict case). Ignored for other clone targets.
   */
  prFallback?: 'base' | 'work'
  /**
   * Merge the repo's BASE branch into the checkout before the agent runs, so the conflict hunks
   * are present in the working tree for the agent to resolve (the conflict-resolver). The harness
   * completes the merge commit and pushes back onto the same branch, refusing a half-resolved
   * tree. Absent ⇒ nothing is merged in.
   */
  mergeBase?: boolean
}

/** The optional LLM step of an agent definition. */
export interface AgentStepSpec {
  surface: AgentSurface
  output?: AgentOutputSpec
  /** Container surfaces only: what to clone. */
  clone?: AgentCloneSpec
  /**
   * Stand the service's declared TEST DEPENDENCIES up around this run (the tester family). The
   * concrete spec is DERIVED per run from the frame's capability profile plus whatever the run
   * actually provisioned — a kind declares only that it needs one — and the step's resolved test
   * secrets ride along with it. Absent ⇒ nothing is stood up.
   */
  testInfra?: boolean
  /**
   * The container IMAGE VARIANT this kind's job needs, by NAME. Absent ⇒ the default harness
   * image, so nothing else bloats every other kind's cold start.
   *
   * `ui` selects the platform's heavier Playwright + browser image (the UI tester drives a real
   * browser and captures screenshots). Any other name is the DEPLOYMENT's own variant, which its
   * runner backend maps to an image and which gets a container of its own for the run
   * (`containerKeyForRef`), so a kind needing a tool the harness has no reason to carry neither
   * installs it per run nor puts it in every other kind's cold start.
   *
   * `default` is spelled by omission and `deploy` is not selectable: that one is the environment
   * provisioner's image, dispatched by the platform rather than by a kind, and a kind naming it
   * would be asking for `kubectl` in an agent container through a door built for something else.
   * Both are refused at boot (`validateRegistrations`), as is a name that is not a slug.
   *
   * A backend with no image for the variant REFUSES the dispatch rather than falling back
   * (`RUNNER_IMAGE_UNWIRED_REASON`).
   */
  image?: string
  /**
   * `container-explore` only: suppress the READ-ONLY guardrail the surface otherwise appends to
   * the kind's prompt. An explore kind never PUSHES, but a few legitimately write inside their
   * own working tree while running: a tester installs dependencies and runs a suite, which
   * creates build output. Telling those they must not create files reads to the agent as a
   * refusal to run the suite at all. Absent ⇒ the guardrail is appended, which is right for
   * every reporting/reviewing kind.
   */
  localWrites?: boolean
  /**
   * Container-coding surface only: whether a run that produced NO file changes is a
   * failure. The implementer (coder) fails a no-op; a kind that may legitimately produce
   * nothing (e.g. `repro-test` conceding `not_reproducible`) sets this false so the run
   * advances instead of failing. Default true (a coding no-op is a failure), matching the
   * implementer. Ignored for non-coding surfaces.
   */
  noChangesTolerated?: boolean
  /**
   * Container-coding surface only: whether to OPEN a pull request after pushing the work
   * branch. The implementer opens the run's PR; a kind that only SEEDS the shared work
   * branch for a LATER step to open the PR on (e.g. `repro-test`, the first committing
   * step — the coder then resumes the branch and opens the PR containing both the
   * reproduction test and the fix) sets this false. Default true for a work-branch coding
   * kind. Ignored for an in-place (PR-branch) coding kind, which never opens a new PR.
   */
  opensPr?: boolean
}

/**
 * The resolved DISPATCH facts a container kind's prompt builder needs beyond its
 * {@link AgentRunContext}.
 *
 * The run context describes the WORK (the block, the pipeline, the prior outputs); it does not
 * carry the checkout the engine is about to create, because that is resolved per dispatch from
 * the service↔repo projection. A prompt that has to name a branch ("diff `HEAD` against
 * `origin/main`") needs both, and before this seam existed the built-in kinds that needed it
 * were exactly the ones that could not be registry entries.
 *
 * OPTIONAL at the call site: an inline caller (the consensus panel) has no checkout to describe,
 * so a builder that receives none must phrase itself without naming branches rather than invent
 * one.
 */
export interface AgentDispatchContext {
  /** The repo's base (default) branch: what a diff targets and what a work branch forks from. */
  baseBranch: string
  /**
   * The concrete branch this dispatch actually CHECKS OUT, resolved from the step's `clone` spec.
   *
   * Distinct from {@link workBranch} and from {@link baseBranch} because a step's declared target
   * FALLS BACK: a `clone.branch: 'pr'` dispatch on a block whose producer opened no pull request
   * (a coder that changed nothing, an `opensPr: false` chain, a companion after a direct-commit
   * producer) is checked out on the base branch itself. A prompt that names a diff has to read this
   * rather than assume the declaration held, or it states a change where `<base>...HEAD` is empty
   * and the agent grades nothing as if it were something.
   */
  checkoutBranch: string
  /** The deterministic per-block work branch this dispatch pushes or resumes. */
  workBranch: string
  /** Whether this dispatch fans out across peer repos (one sibling checkout + PR per service). */
  multiRepo: boolean
}

/**
 * A kind's own user-prompt builder. Receives the run context and, on a container dispatch, the
 * resolved {@link AgentDispatchContext}.
 */
export type AgentUserPromptBuilder = (
  context: AgentRunContext,
  dispatch?: AgentDispatchContext,
) => string

/** Context handed to a {@link RepoOp}. */
export interface RepoOpContext {
  /** Per-run, checkout-free repo access bound to the run's installation + repo. */
  repo: RepoFiles
  /** The run/block/task context (branch, block id, task description, prior outputs). */
  context: AgentRunContext
  /** The branch the op reads/writes (the engine resolves base/pr/work to a concrete name). */
  branch: string
  /**
   * Whether this run delivers its committed artifact through a PULL REQUEST rather than a
   * direct commit — true when the pipeline carries a merge tail (a `merger` step) to merge
   * that PR. A committing post-op uses this to decide between committing straight to the base
   * branch (no PR) and committing to a work branch + opening a PR (returned via
   * {@link RepoOpResult.pullRequest} for the engine to record on the block). Derived by the
   * engine from the run's steps, so the delivery mode follows the chosen pipeline with no
   * separate per-task flag to drift.
   */
  opensPr: boolean
  /**
   * Whether the agent this op prepares for will have a real CHECKOUT — a filesystem it can read
   * and run `git` in. True for a container dispatch; false when the step runs as an inline model
   * call, which today means a consensus panel (its participants have no filesystem and no tools).
   *
   * A preOp that prepares context must branch on this rather than assume a checkout. The
   * `pr-reviewer` diff is the motivating case: past its inline budget it renders a MANIFEST plus
   * `git diff` instructions, which is correct for a container reviewer that slices the diff
   * itself and an unreviewable file list for an inline panel — the panel would review from
   * filenames while sounding confident.
   *
   * Derived by the engine from the SAME predicate the executor routes on
   * (`dispatchDeliversCheckout`), so the preparation and the routing cannot disagree. REQUIRED,
   * not optional: an op that forgets to consider it is the failure this field exists to prevent,
   * and a defaulted `true` would reintroduce it silently.
   */
  deliversCheckout: boolean
  /**
   * The finished agent's structured result. Present for postOps (which consume it —
   * e.g. render `spec/` from `result.spec`); absent for preOps.
   */
  result?: AgentRunResult
  /**
   * Where an op reports work it declined to do. A post-op is BEST-EFFORT by contract (a
   * bookkeeping commit must never turn a green step red), which means every early return and
   * every swallowed throw is otherwise indistinguishable from success — the spec-promotion
   * hole this port field exists to close (`docs/initiatives/observability-logging-gaps.md`, D3).
   *
   * REQUIRED, not optional: an absent optional logger is silent by definition, which is exactly
   * the failure mode. A test or a harness passes `noopLogger` explicitly.
   */
  logger: Logger
}

/**
 * What a {@link RepoOp} may report back to the engine. A committing post-op that opened a
 * pull request returns its {@link PullRequestRef} here so the engine records it on the block
 * (`block.pullRequest`) — the SAME linkage a container-coding step's `result.pullRequest`
 * produces — so the downstream conflicts/CI/human-review/merge tail acts on it unchanged.
 */
export interface RepoOpResult {
  /** A pull request the op opened, for the engine to record as the block's `pullRequest`. */
  pullRequest?: PullRequestRef
  /**
   * Files a preOp prepared for the agent to read UP FRONT — the engine materialises them into
   * the container's `.cat-context/` (the same seam linked docs use) before dispatch, so the
   * agent needn't reconstruct them itself. The `pr-reviewer` preOp returns the PR diff +
   * changed-file list this way. Ignored for postOps (the agent has already run).
   */
  contextFiles?: InjectedContextFile[]
}

/**
 * Deterministic backend logic run before/after an agent step, over a checkout-free
 * {@link RepoFiles}. A preOp prepares inputs (read a baseline artifact); a postOp
 * consumes the agent's structured output (render + commit artifact files). Pure of
 * container concerns; throwing fails the step.
 */
export type RepoOp = (ctx: RepoOpContext) => Promise<RepoOpResult | void>
