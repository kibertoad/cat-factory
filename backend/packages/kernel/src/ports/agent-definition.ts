import type { AgentRunContext, AgentRunResult } from './agent-executor.js'
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
}

/** The optional LLM step of an agent definition. */
export interface AgentStepSpec {
  surface: AgentSurface
  output?: AgentOutputSpec
  /** Container surfaces only: what to clone. */
  clone?: AgentCloneSpec
  /** Container coding surface only: how to stand dependencies up (tester). */
  infra?: 'none' | 'compose' | 'ephemeral-url'
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

/** Context handed to a {@link RepoOp}. */
export interface RepoOpContext {
  /** Per-run, checkout-free repo access bound to the run's installation + repo. */
  repo: RepoFiles
  /** The run/block/task context (branch, block id, task description, prior outputs). */
  context: AgentRunContext
  /** The branch the op reads/writes (the engine resolves base/pr/work to a concrete name). */
  branch: string
  /**
   * The finished agent's structured result. Present for postOps (which consume it —
   * e.g. render `spec/` from `result.spec`); absent for preOps.
   */
  result?: AgentRunResult
}

/**
 * Deterministic backend logic run before/after an agent step, over a checkout-free
 * {@link RepoFiles}. A preOp prepares inputs (read a baseline artifact); a postOp
 * consumes the agent's structured output (render + commit artifact files). Pure of
 * container concerns; throwing fails the step.
 */
export type RepoOp = (ctx: RepoOpContext) => Promise<void>
