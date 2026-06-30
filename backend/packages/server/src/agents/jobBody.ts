import type { AgentRunContext, AgentStepSpec, RunnerDispatchKind } from '@cat-factory/kernel'
import {
  composeBlockSystemPrompt,
  FOLLOW_UP_GUIDANCE,
  isContainerBackedCompanion,
  isReadOnlyAgentKind,
  registeredAgentStep,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
import {
  BLUEPRINTS_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  FIXER_AGENT_KIND,
  MERGER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
  TESTER_AGENT_KIND,
  UI_TESTER_AGENT_KIND,
} from '@cat-factory/orchestration'
import {
  BLUEPRINT_SHAPE_HINT,
  BLUEPRINT_SYSTEM_PROMPT,
  blueprintUserPrompt,
  MERGE_ASSESSMENT_SHAPE_HINT,
  MERGER_SYSTEM_PROMPT,
  mergerUserPrompt,
  ON_CALL_ASSESSMENT_SHAPE_HINT,
  ON_CALL_SYSTEM_PROMPT,
  onCallUserPrompt,
  prBody,
  SPEC_SHAPE_HINT,
  SPEC_WRITER_SYSTEM_PROMPT,
  specWriterUserPrompt,
  TEST_REPORT_SHAPE_HINT,
  testerInfraSpec,
  UI_TEST_REPORT_SHAPE_HINT,
} from './prompts.js'
import type { RepoTarget } from './ContainerAgentExecutor.js'

/**
 * The pieces a per-kind job body is assembled from, computed once per dispatch in
 * `ContainerAgentExecutor.buildJobBody` and threaded into every builder so the kinds
 * can't drift on which shared fields they forward:
 *   - `common` — the fields EVERY harness job body carries (jobId/model/auth/repo/proxy/…).
 *   - `webTools` — the proxy-backed web-tools nudge + switch, shared by the kinds that
 *     allow web access.
 *   - `repo` — the resolved repo target (owner/name/baseBranch + optional serviceDirectory).
 *   - `workBranch` / `workBranchReady` — the deterministic per-task work branch and whether
 *     it exists on the remote yet (a read-only agent falls back to base when it doesn't).
 */
export interface KindBodyParts {
  common: Record<string, unknown>
  webTools: Record<string, unknown>
  repo: RepoTarget
  workBranch: string
  workBranchReady: boolean
}

/**
 * Build the per-kind harness job body: the shared `common` fields plus ONLY the delta
 * specific to this kind's harness endpoint (its prompts, the branch it runs on, and
 * any per-kind extras), and the matching dispatch `kind`. The web-search fields live
 * in `webTools` (shared by the kinds that allow web access). The dispatch precedence
 * matches the original if-ladder exactly: the specific kinds first, then any read-only
 * kind, then the default coder body.
 */
export function buildKindBody(
  context: AgentRunContext,
  parts: KindBodyParts,
): { body: Record<string, unknown>; kind: RunnerDispatchKind } {
  // `parts` (common/webTools/workBranch/workBranchReady) is consumed by
  // `buildRegisteredAgentBody`/`buildMigratedBuiltInBody`, not directly here.
  const baseRoleSystemPrompt = composeBlockSystemPrompt(
    systemPromptFor(context.agentKind),
    context.block,
  )
  // When the future-looking Follow-up companion is enabled for this (coder) step, append
  // the guidance that tells the Coder to stream loose-ends / side-tasks / questions to the
  // sentinel file the harness tails. Only when enabled, so a disabled companion (or any
  // other kind) never writes the file.
  const roleSystemPrompt = context.followUpCompanion
    ? `${baseRoleSystemPrompt}\n\n${FOLLOW_UP_GUIDANCE}`
    : baseRoleSystemPrompt

  // A registered (custom or migrated) kind that declares an `agent` step dispatches
  // through the generic, manifest-driven `agent` harness kind — no per-kind case here.
  // Built-in kinds (below) still carry their bespoke bodies until they are migrated.
  const registeredStep = registeredAgentStep(context.agentKind)
  if (registeredStep) {
    return buildRegisteredAgentBody(context, parts, registeredStep, roleSystemPrompt)
  }

  // Built-in container kinds migrated onto the generic, manifest-driven `agent` harness
  // kind (they dispatch `kind:'agent'` through `buildRegisteredAgentBody`, exactly like a
  // registered custom kind, with NO bespoke per-kind harness handler) — the Task-5
  // strangler. Today: blueprints/spec-writer (structured explore + render post-op), the
  // in-place fixers (`ci-fixer` / `fixer`, coding-on-PR), the JSON-assessment producers
  // (`merger` / `on-call`, read-only structured explore whose assessment is coerced
  // backend-side in `toRunResult`), the `tester` (read-only structured explore with
  // docker-compose infra stand-up), and the conflict-resolver (coding with a `mergeBase`).
  // The default coder dispatches the generic coding agent at the end of this method.
  const migrated = buildMigratedBuiltInBody(context, parts, roleSystemPrompt)
  if (migrated) return migrated

  // Container-backed companions (reviewer / doc-reviewer): a read-only explore that clones
  // the producer's PR branch and reads the ACTUAL repository (changed files / committed
  // document) before rating it, returning the verdict as structured JSON. Surfaced to the
  // engine as `result.custom` (the default `toRunResult` branch) and parsed back into a
  // CompanionAssessment by `CompanionController.resolveContainerVerdict`. The companion
  // review system prompt (which already instructs the JSON shape and, for these kinds, to
  // read the checkout) wins in `systemPromptFor`, so no per-kind prompt wiring is needed.
  if (isContainerBackedCompanion(context.agentKind)) {
    return buildRegisteredAgentBody(
      context,
      parts,
      { surface: 'container-explore', clone: { branch: 'pr' }, output: { kind: 'structured' } },
      roleSystemPrompt,
    )
  }

  // Read-only agents (architect, analysis) explore a real checkout but never edit it:
  // they clone a branch, produce a prose report/proposal and return it as `output`,
  // making no commit and opening no PR (and — unlike a coding run — an edit-free run is
  // the expected, correct outcome, not a failure). They dispatch through the generic,
  // manifest-driven `agent` kind in `explore` mode — the SAME path a registered
  // `container-explore` kind takes — instead of a bespoke per-kind harness handler. A
  // synthesized read-only step (no clone target ⇒ the shared work-branch fallback, so
  // e.g. the architect reads the spec-writer's committed `spec/` and any in-progress
  // implementation, falling back to base when no work/PR branch exists) yields a body
  // byte-identical to the old `/explore` job, minus only the harness-internal temp-dir
  // label. This is the first built-in migrated onto the generic agent surface (the
  // Task-5 strangler); the now-dead `/explore` harness handler is deleted in a
  // follow-up once parity is confirmed on CI.
  if (isReadOnlyAgentKind(context.agentKind)) {
    return buildRegisteredAgentBody(
      context,
      parts,
      { surface: 'container-explore' },
      roleSystemPrompt,
    )
  }

  // The default coder (and any other write-and-PR kind): the build-phase role plus the
  // block's selected best-practice fragments. Dispatches the generic `container-coding`
  // agent onto the deterministic per-task work branch (`clone: 'work'` ⇒ branch off base,
  // push the work branch, open a PR). The work-branch name is deterministic per task
  // (block), NOT per dispatch — a retry mints a fresh executionId but keeps the blockId —
  // so every re-dispatch targets the SAME branch; `runCodingAgent` checkpoints commits to
  // it and RESUMES on it if it already exists, so an evicted/failed run's work survives.
  // This is behaviour-equivalent to the old bespoke `/run` body (handleAgent coding mode
  // is built on the same `runCodingAgent` primitive); the dead `/run` handler is removed
  // in the harness-cleanup step.
  return buildRegisteredAgentBody(
    context,
    parts,
    { surface: 'container-coding', clone: { branch: 'work' } },
    roleSystemPrompt,
  )
}

/**
 * Build the generic `agent` job body for a registered kind from its declarative
 * {@link AgentStepSpec} — the single dispatch path that replaces the per-kind cases as
 * built-ins migrate. `container-explore` clones a branch read-only and returns prose
 * (or, for `output.kind==='structured'`, a parsed `custom` JSON object the kind's
 * post-op renders from); `container-coding` clones, edits, pushes and (off the work
 * branch) opens a PR. The clone target maps `base`/`pr`/`work` to a concrete branch
 * exactly as the built-in bodies do.
 */
export function buildRegisteredAgentBody(
  context: AgentRunContext,
  parts: KindBodyParts,
  step: AgentStepSpec,
  roleSystemPrompt: string,
  /**
   * The concrete task prompt. Defaults to the generic `userPromptFor` (block context +
   * prior outputs) — the same prompt a registered custom kind gets. A migrated built-in
   * (merger / on-call) overrides it with its bespoke, JSON-instructing prompt so its
   * body matches the old per-kind handler's.
   */
  userPrompt: string = userPromptFor(context, { materialized: true }),
): { body: Record<string, unknown>; kind: RunnerDispatchKind } {
  const { common, webTools, repo, workBranch, workBranchReady } = parts
  const prBranch = context.block.pullRequest?.branch
  const onPr = step.clone?.branch === 'pr'
  const exploreBranch =
    step.clone?.branch === 'base'
      ? repo.baseBranch
      : onPr
        ? (prBranch ?? repo.baseBranch)
        : workBranchReady
          ? workBranch
          : (prBranch ?? repo.baseBranch)

  if (step.surface === 'container-coding') {
    // `pr` clone ⇒ work in place on the PR branch and push back (fixer-like, no new PR);
    // otherwise branch off base onto the work branch, push it and open a PR (coder-like).
    return {
      kind: 'agent',
      body: {
        ...common,
        mode: 'coding',
        systemPrompt: roleSystemPrompt,
        userPrompt,
        branch: onPr ? (prBranch ?? repo.baseBranch) : repo.baseBranch,
        ...(onPr ? {} : { newBranch: workBranch }),
        pushBranch: onPr ? (prBranch ?? workBranch) : workBranch,
        ...(onPr
          ? { noChangesIsError: false }
          : {
              pr: {
                title: `${context.block.title} (${context.pipelineName})`,
                body: prBody(context),
              },
            }),
        ...(step.clone?.full ? { full: true } : {}),
        // The Coder (follow-up companion enabled) streams forward-looking items out via
        // the sentinel file; tell the harness to tail it. Only on the implementer path.
        ...(context.followUpCompanion && !onPr ? { streamFollowUps: true } : {}),
        ...webTools,
      },
    }
  }

  // container-explore (read-only): prose, or a structured JSON object as `custom`.
  return {
    kind: 'agent',
    body: {
      ...common,
      mode: 'explore',
      systemPrompt: roleSystemPrompt,
      userPrompt,
      branch: exploreBranch,
      ...(step.clone?.full ? { full: true } : {}),
      ...(step.output?.kind === 'structured'
        ? {
            output: {
              kind: 'structured',
              ...(step.output.shapeHint ? { shapeHint: step.output.shapeHint } : {}),
              ...(step.output.repair === false ? { repair: false } : {}),
              ...(step.output.failOnUnusableFinal ? { failOnUnusableFinal: true } : {}),
            },
          }
        : {}),
      ...webTools,
    },
  }
}

/**
 * Build the generic `agent` body for a BUILT-IN container kind being migrated onto the
 * manifest-driven path (the Task-5 strangler), or undefined when `context.agentKind` is
 * not a migrated built-in (the caller falls through to the remaining bespoke switch). Each
 * migrated kind is expressed as a synthesized {@link AgentStepSpec} routed through
 * {@link buildRegisteredAgentBody} — the SAME dispatch a registered custom kind takes — so
 * there is no bespoke harness handler:
 *   - `ci-fixer` / `fixer`: coding-on-PR (clone the PR branch, push back, no new PR; a
 *     no-op is non-fatal). Requires the implementation PR branch.
 *   - `merger` / `on-call`: read-only structured explore (full clone) that returns ONLY a
 *     JSON assessment; the conservative coercion that used to live in the harness runs
 *     backend-side in {@link toRunResult}.
 *   - `conflict-resolver`: coding (full clone of the PR branch) with a `mergeBase` — the
 *     harness merges the base in to surface the conflicts, the agent resolves them, and the
 *     harness completes the merge commit + pushes back onto the same branch (no new PR).
 */
export function buildMigratedBuiltInBody(
  context: AgentRunContext,
  parts: KindBodyParts,
  roleSystemPrompt: string,
): { body: Record<string, unknown>; kind: RunnerDispatchKind } | undefined {
  const { repo } = parts
  const prBranch = context.block.pullRequest?.branch
  switch (context.agentKind) {
    // The Blueprinter maps the repo into the service → modules tree. It now runs as a
    // read-only structured explore (clone the PR branch when present, else the default
    // branch — exactly its old `prBranch ?? baseBranch` clone), returning ONLY the tree
    // as JSON; the deterministic render + commit of the `blueprints/` artifact that used
    // to live in the harness `/blueprint` handler is the backend `blueprintPostOp` (run
    // from ExecutionService), and `toRunResult` coerces the JSON into `blueprintService`
    // for the board reconcile + that post-op.
    case BLUEPRINTS_AGENT_KIND:
      return buildRegisteredAgentBody(
        context,
        parts,
        {
          surface: 'container-explore',
          clone: { branch: 'pr' },
          output: { kind: 'structured', shapeHint: BLUEPRINT_SHAPE_HINT },
        },
        BLUEPRINT_SYSTEM_PROMPT,
        blueprintUserPrompt(),
      )
    // The spec-writer maintains the prescriptive `spec/` document. It now runs as a
    // read-only structured explore on the per-block WORK branch (clone `work` — the
    // deterministic `cat-factory/<blockId>` the coder resumes, created from base when
    // absent; it runs BEFORE the coder, so it SEEDS that branch). The agent READS the
    // baseline spec from its own checkout (`spec/`), applies this ONE task as an increment,
    // and returns the COMPLETE tree as JSON; the deterministic SHARD + commit of the
    // `spec/` artifact that used to live in the harness `/spec` handler is the backend
    // `specPostOp` (run from ExecutionService), and `toRunResult` coerces the JSON into the
    // `spec` channel the engine strict-validates + that post-op renders/commits from. It
    // NEVER targets base: the spec is prescriptive for not-yet-landed work, so it merges
    // WITH the feature, never reaching `main` ahead of it.
    case SPEC_WRITER_AGENT_KIND:
      return buildRegisteredAgentBody(
        context,
        parts,
        {
          surface: 'container-explore',
          clone: { branch: 'work' },
          // The spec doc is handed onward to be sharded + committed by `specPostOp`, so a
          // final answer cut off at the output ceiling must FAIL LOUDLY (the bespoke `/spec`
          // handler's `unusableFinalAnswerCause` gate) rather than be laundered into a
          // half-baked spec by the structured repair — exactly what drove the old
          // spec-writer ⇄ companion rework loop.
          output: { kind: 'structured', shapeHint: SPEC_SHAPE_HINT, failOnUnusableFinal: true },
        },
        SPEC_WRITER_SYSTEM_PROMPT,
        specWriterUserPrompt(context),
      )
    // In-place fixers: clone the PR head branch, push fixes back onto it (no new PR);
    // a no-op run is a clean non-event (the gate/loop re-checks the real signal).
    case CI_FIXER_AGENT_KIND:
      if (!prBranch) throw new Error('CI-fixer needs the implementation PR branch to push fixes to')
      return buildRegisteredAgentBody(
        context,
        parts,
        { surface: 'container-coding', clone: { branch: 'pr' } },
        roleSystemPrompt,
      )
    case FIXER_AGENT_KIND:
      if (!prBranch) throw new Error('Fixer needs the implementation PR branch to push fixes to')
      return buildRegisteredAgentBody(
        context,
        parts,
        { surface: 'container-coding', clone: { branch: 'pr' } },
        roleSystemPrompt,
      )
    // The conflict-resolver clones the PR head branch (full history), merges the base in
    // to surface the conflicts, resolves them and pushes back onto the SAME branch (no new
    // branch / PR) so the PR becomes mergeable and CI re-runs. It dispatches the generic
    // coding agent with a `mergeBase` (the harness merges `origin/<mergeBase>` in before the
    // agent runs); the harness leads the prompt with the actual conflict hunks it discovers.
    //
    // Unlike the CI-fixer it is deliberately NOT given `userPromptFor(context)`: that renders
    // the full task brief + every prior agent's output (the spec-writer's whole spec, etc.),
    // which buries the one-line "resolve a conflict" role and drifts the model onto
    // re-implementing the feature (observed in prod: a resolver that returned a "test report
    // is ready" answer and never touched the markers). The backend supplies only a compact
    // task reference for intent.
    case CONFLICT_RESOLVER_AGENT_KIND: {
      if (!prBranch) {
        throw new Error(
          'Conflict-resolver needs the implementation PR branch to resolve conflicts on',
        )
      }
      const description = context.block.description?.trim()
      const built = buildRegisteredAgentBody(
        context,
        parts,
        { surface: 'container-coding', clone: { branch: 'pr', full: true } },
        roleSystemPrompt,
        `Task: ${context.block.title}${description ? `\n\n${description}` : ''}`,
      )
      return { kind: built.kind, body: { ...built.body, mergeBase: repo.baseBranch } }
    }
    // The merger clones the PR head (full, to diff vs base) and returns ONLY the
    // complexity/risk/impact assessment JSON; the engine performs the real merge.
    case MERGER_AGENT_KIND:
      return buildRegisteredAgentBody(
        context,
        parts,
        {
          surface: 'container-explore',
          clone: { branch: 'pr', full: true },
          output: { kind: 'structured', shapeHint: MERGE_ASSESSMENT_SHAPE_HINT },
        },
        MERGER_SYSTEM_PROMPT,
        mergerUserPrompt(context, repo),
      )
    // The on-call agent clones the BASE branch (full, to locate + diff the merged
    // release commit) and returns ONLY the regression assessment JSON.
    case ON_CALL_AGENT_KIND:
      return buildRegisteredAgentBody(
        context,
        parts,
        {
          surface: 'container-explore',
          clone: { branch: 'base', full: true },
          output: { kind: 'structured', shapeHint: ON_CALL_ASSESSMENT_SHAPE_HINT },
        },
        ON_CALL_SYSTEM_PROMPT,
        onCallUserPrompt(context, repo),
      )
    // The tester clones the PR head branch (read-only — it makes NO commits), stands up
    // its dependencies (locally via the service's docker-compose, or against the
    // provisioned ephemeral env — the service's declared provision type picks which) and
    // returns ONLY a structured JSON report. It runs as a generic structured explore with
    // an `infra` spec the harness uses to stand the docker-compose dependencies up for the
    // run; `toRunResult` coerces the JSON into `testReport` (the conservative greenlight /
    // blocking-concern rule the harness applied now runs backend-side, and the engine's
    // TesterController re-applies it). The role prompt + the run-mode/ephemeral-URL guidance
    // come from the standard `roleSystemPrompt` + `userPromptFor` (which already carry them),
    // so the harness adds none. The engine loops the `fixer` on a withheld greenlight.
    case TESTER_AGENT_KIND: {
      const built = buildRegisteredAgentBody(
        context,
        parts,
        {
          surface: 'container-explore',
          clone: { branch: 'pr' },
          output: { kind: 'structured', shapeHint: TEST_REPORT_SHAPE_HINT },
        },
        roleSystemPrompt,
      )
      return { kind: built.kind, body: { ...built.body, infra: testerInfraSpec(context) } }
    }
    // The UI tester is the Tester's browser-driven sibling: same read-only structured
    // explore + infra stand-up, but it drives Playwright (supplied by the UI-tester
    // image, routed via the `image:'ui'` dispatch option) to capture a non-redundant
    // screenshot of each distinct view, uploads them to the artifact store, and reports
    // them under `screenshots[]`. The role prompt carries the capture guidance.
    case UI_TESTER_AGENT_KIND: {
      const built = buildRegisteredAgentBody(
        context,
        parts,
        {
          surface: 'container-explore',
          clone: { branch: 'pr' },
          output: { kind: 'structured', shapeHint: UI_TEST_REPORT_SHAPE_HINT },
        },
        roleSystemPrompt,
      )
      return { kind: built.kind, body: { ...built.body, infra: testerInfraSpec(context) } }
    }
  }
  return undefined
}
