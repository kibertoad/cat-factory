import type {
  AgentDispatchContext,
  AgentRunContext,
  AgentStepSpec,
  RunnerDispatchKind,
} from '@cat-factory/kernel'
import {
  type AgentKindRegistry,
  appendContainerDispatchDirectives,
  bugFixGuidanceFor,
  composeBlockSystemPrompt,
  toolServersSection,
  FOLLOW_UP_GUIDANCE,
  PR_DESCRIPTION_GUIDANCE,
  isContainerBackedCompanion,
  resolvePrNumber,
  standardsDeliveredAsFiles,
  standardsVerbosityFor,
  userPromptFor,
} from '@cat-factory/agents'
import { siblingCheckoutDir } from './harnessContract.js'
import { prBody, testerInfraSpec } from './prompts.js'
import { dispatchSystemPromptFor } from './promptOverrides.js'
import type { RepoTarget } from './ContainerAgentExecutor.js'
import type { RepoCheckout } from './resolveRepoTarget.js'

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
  /**
   * Peer repos to clone as siblings during a MULTI-REPO run (service-connections phase 3–4) —
   * each an origin-resolved harness `RepoSpec` plus the involved service frame it belongs to. The
   * coding body adds the shared work branch + the same PR shape as the primary (coder/ci-fixer);
   * the read-only explore body (bug-investigator, merger) forwards them for sibling cloning. A
   * `cloneBranch` (merger) pins which branch a read-only peer is checked out at — its PR branch,
   * so the combined diff sees the PR change — else the peer is cloned at its default branch.
   */
  /**
   * SENSITIVE test credentials for the tester kinds, as `{ key, value }` env pairs the harness
   * injects into the container environment (out of band). A dedicated top-level body field the
   * agent-context snapshot allow-list omits — the value never reaches a prompt or the telemetry
   * snapshot. Present only for the tester kinds when the service frame has secrets configured.
   */
  testSecretEnv?: { key: string; value: string }[]
  peerRepos?: { repo: Record<string, unknown>; frameIds?: string[]; cloneBranch?: string }[]
  /**
   * The backend-rendered "Multi-repo workspace" system-prompt section (which repo is primary,
   * where each involved service lives, how the checkouts are laid out). Appended to the coding
   * implementer's system prompt in a multi-service run; absent otherwise.
   */
  multiRepoSection?: string
  /**
   * READ-ONLY reference repos to clone as sibling checkouts for a document-authoring run — each
   * an origin-resolved harness `RepoSpec` with NO branch/PR fields (structurally unpushable). The
   * coding body forwards them so the harness clones each at its own default branch and skips it in
   * the push phase. Present only for the doc-writer on a task with reference repos attached.
   */
  referenceRepos?: { repo: Record<string, unknown> }[]
  /**
   * The backend-rendered "Reference repositories" system-prompt section (which repos are attached
   * as read-only references, where each sibling checkout lives, and that the agent must never edit
   * or commit them). Appended to the doc-writer's system prompt; absent otherwise.
   */
  referenceReposSection?: string
  /**
   * READ-ONLY reference BRANCH names of the PRIMARY repo (the apriori-branches reference mode) —
   * fetched by the harness into `origin/<b>` after checkout so the agent can inspect a prior-art
   * branch it must never commit to. Distinct from {@link referenceRepos} (separate sibling repos):
   * these are branches of the run's own repo, so they ride the primary checkout with no sibling
   * leg. Present only for the consumer kinds (coder / spec-writer / doc-writer / read-only design +
   * analysis) on a task with reference branches attached; forwarded on both the coding + explore
   * bodies.
   */
  referenceBranches?: string[]
  /**
   * The backend-rendered "Reference branches" system-prompt section (which branches are attached
   * as read-only references, how to read them via `origin/<b>`, and that the agent must never
   * commit to or push them). Appended to the consumer kind's system prompt; absent otherwise.
   */
  referenceBranchesSection?: string
  /**
   * The backend-rendered skill directive for a dispatch that applies skills — a `skill` step's
   * pick and/or the running kind's declared playbooks — appended to the kind's system prompt. For
   * the claude-code harness it is a short pointer to the natively-installed skills; for Pi/codex it
   * carries the folded-in instructions + a pointer to each skill's `.cat-context/skill/<name>/`
   * resources. Absent when the dispatch applies no skills.
   */
  skillSection?: string
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
  registry: AgentKindRegistry,
): { body: Record<string, unknown>; kind: RunnerDispatchKind } {
  // `parts` (common/webTools/workBranch/workBranchReady) is consumed by
  // `buildRegisteredAgentBody`, not directly here.
  const baseRoleSystemPrompt = composeBlockSystemPrompt(
    // The workspace's own prompt for this kind when it has one, else the shipped base — see
    // `dispatchSystemPromptFor`, which every container-dispatch prompt assembly rides.
    dispatchSystemPromptFor(context, registry),
    context.block,
    registry.standardsDelivery(context.agentKind),
    standardsDeliveredAsFiles(context.injectedContextFiles),
    // Implementer kinds (coder/fixer/…) fold the condensed `brief` standards; reviewer/planner
    // kinds get the full bodies. See `standardsVerbosityFor` / the `brief-standards` trait.
    standardsVerbosityFor(context.agentKind, registry),
  )
  // The two directives EVERY container job carries, whatever the kind: what the execution
  // environment can and cannot do (platform facts no agent can derive from the repository, absent
  // which a coder and its reviewer each rediscovered that the Dockerfile they were asked for could
  // not be built here) and the effort self-assessment the harness lifts onto the result. Appended
  // here — the single container-dispatch chokepoint — so they reach every container kind, built-in
  // and registered alike, exactly like the read-only/final-answer directives reach every kind via
  // `applySurfaceDirectives`. The pair is declared in `@cat-factory/agents`
  // (`CONTAINER_DISPATCH_DIRECTIVES`) because `appendedDirectivesFor` has to MEASURE it: the prompt
  // editor shows a workspace the rules its override cannot delete, and these are two of them.
  const withEffort = appendContainerDispatchDirectives(baseRoleSystemPrompt)
  // When the future-looking Follow-up companion is enabled for this (coder) step, append
  // the guidance that tells the Coder to stream loose-ends / side-tasks / questions to the
  // sentinel file the harness tails. Only when enabled, so a disabled companion (or any
  // other kind) never writes the file.
  const withFollowUp = context.followUpCompanion
    ? `${withEffort}\n\n${FOLLOW_UP_GUIDANCE}`
    : withEffort
  // Bug-triage (phase G): when a prior `repro-test` step ran, augment the CODER's prompt with
  // BUG_FIX_GUIDANCE — fix the reported issue, don't merely make the reproduction test pass.
  // `bugFixGuidanceFor` returns '' for every other kind / when no repro-test preceded, so this
  // is a no-op everywhere else.
  const bugFix = bugFixGuidanceFor(context)
  const withBugFix = bugFix ? `${withFollowUp}\n\n${bugFix}` : withFollowUp
  // A dispatch that applies skills folds their directive (harness-aware — a native-skill pointer
  // for claude-code, the full instructions for Pi/codex) into the system prompt. Present on a
  // `skill` step whose pick resolved AND on any kind that declares skills of its own; a no-op
  // for every other kind.
  const withSkills = parts.skillSection ? `${withBugFix}\n\n${parts.skillSection}` : withBugFix
  // The tool servers (MCP) wired for this dispatch, plus any the run could not wire. Appended
  // here — the single container-dispatch chokepoint, exactly like the effort-report guidance —
  // so it reaches EVERY container kind including a registered kind with its own `userPrompt`
  // builder, which would otherwise bypass any user-prompt fold. Empty for a kind that declares
  // no tool servers, so every built-in run's prompt is byte-for-byte unchanged.
  const tools = toolServersSection(context)
  const roleSystemPrompt = tools ? `${withSkills}\n\n${tools}` : withSkills

  // ONE dispatch path. Every kind the platform ships now DECLARES its container shape on the
  // agent-kind registry (see `@cat-factory/agents` → `kinds/built-in-container.ts`), so what a
  // built-in does is data the engine reads through the same seam a deployment's own kind uses:
  // there is no `switch (context.agentKind)` here, and no bespoke per-kind harness handler
  // behind it either. That is the end of the agent-kind strangler.
  return buildRegisteredAgentBody(
    context,
    parts,
    resolveDispatchStep(context.agentKind, registry),
    roleSystemPrompt,
    registry,
  )
}

/**
 * The default dispatch shape for a container kind that declared none: the implementer's. Branch
 * off base onto the deterministic per-task work branch, push it, open a PR.
 *
 * No built-in reaches it any more — this is what a deployment gets for a kind it routed to the
 * container executor without an `agent` spec, and it is the behaviour that path always had.
 */
const DEFAULT_CONTAINER_STEP: AgentStepSpec = {
  surface: 'container-coding',
  clone: { branch: 'work' },
}

/**
 * A container-backed COMPANION's dispatch shape: a read-only explore that clones the producer's
 * PR branch and reads the ACTUAL repository (the changed files, the committed document) before
 * rating it, returning the verdict as structured JSON.
 *
 * Synthesized rather than registered because a companion is a PAIRING (`registerCompanion`)
 * rather than an agent kind: it never appears in `registry.all()`, and giving it a registration
 * would put it in the palette as a placeable block, which it is not. `CompanionController`
 * parses the verdict back out of `result.custom`.
 *
 * `full: true` for the same reason the `merger` declares it: this kind's whole job is to judge a
 * CHANGE, and a change is a diff against the base branch. A default explore clone is
 * `--depth 1 --single-branch`, which has neither `origin/<base>` nor a merge base, so the
 * three-dot diff its prompt asks for cannot run at all and a later `git fetch` of a shallow base
 * still has no common ancestor. The reviewer then discovers the change file by file instead, which
 * is where a measured ~40 exploratory calls per review went. Paying for the history once is
 * cheaper than paying for the exploration on every turn that follows it.
 */
const CONTAINER_COMPANION_STEP: AgentStepSpec = {
  surface: 'container-explore',
  clone: { branch: 'pr', full: true },
  output: { kind: 'structured' },
}

/** The dispatch shape for this kind: its own declaration, the companion shape, else the default. */
function resolveDispatchStep(kind: string, registry: AgentKindRegistry): AgentStepSpec {
  const declared = registry.agentStep(kind)
  if (declared) return declared
  if (isContainerBackedCompanion(kind, registry)) return CONTAINER_COMPANION_STEP
  return DEFAULT_CONTAINER_STEP
}

/**
 * Forward a kind's structured-output spec into the harness job body as a spreadable
 * `{ output: {...} }` (or `{}` when the kind isn't structured). Shared by BOTH coding-surface
 * kinds (a structured `container-coding` kind like `repro-test`, whose deliverable is a JSON
 * outcome alongside its pushed commit) and explore-surface kinds — both parse the final reply the
 * same way, so both forward the identical spec (the derived `shapeHint` plus the repair /
 * fail-on-unusable flags). One source of truth so the two surfaces can't drift.
 */
function structuredOutputField(output: AgentStepSpec['output']): Record<string, unknown> {
  if (output?.kind !== 'structured') return {}
  return {
    output: {
      kind: 'structured',
      ...(output.shapeHint ? { shapeHint: output.shapeHint } : {}),
      ...(output.repair === false ? { repair: false } : {}),
      ...(output.failOnUnusableFinal ? { failOnUnusableFinal: true } : {}),
    },
  }
}

/**
 * The resolved checkout facts a kind's own prompt builder may name — see kernel's
 * {@link AgentDispatchContext}. Built here, at the one dispatch chokepoint, so a builder can
 * never be handed a branch that differs from the one the job body asks the harness to clone.
 */
function dispatchContextFor(parts: KindBodyParts): AgentDispatchContext {
  return {
    baseBranch: parts.repo.baseBranch,
    workBranch: parts.workBranch,
    multiRepo: (parts.peerRepos?.length ?? 0) > 0,
  }
}

/**
 * Build the generic `agent` job body for a kind from its declarative {@link AgentStepSpec} —
 * the single dispatch path, taken by every built-in and every deployment-registered kind alike.
 * `container-explore` clones a branch read-only and returns prose (or, for
 * `output.kind==='structured'`, a parsed `custom` JSON object the kind's post-op renders from);
 * `container-coding` clones, edits, pushes and (off the work branch) opens a PR. The clone target
 * maps `base`/`pr`/`work` to a concrete branch.
 */
function buildRegisteredAgentBody(
  context: AgentRunContext,
  parts: KindBodyParts,
  step: AgentStepSpec,
  roleSystemPrompt: string,
  registry: AgentKindRegistry,
): { body: Record<string, unknown>; kind: RunnerDispatchKind } {
  // The kind's own prompt when it declared one (the merger's diff instructions, the
  // conflict-resolver's compact task reference), else the generic block-context prompt. Both
  // resolve inside `userPromptFor`, so this layer names no kind.
  const userPrompt = userPromptFor(context, registry, {
    materialized: true,
    dispatch: dispatchContextFor(parts),
  })
  // Two mutually-exclusive surfaces, split into their own builders so each stays within the
  // cyclomatic-complexity budget (the shared branch prelude is cheap enough to recompute in each).
  return step.surface === 'container-coding'
    ? buildCodingAgentBody(context, parts, step, roleSystemPrompt, userPrompt)
    : buildExploreAgentBody(context, parts, step, roleSystemPrompt, userPrompt)
}

/**
 * Resolve an in-place (`pr`-targeting) coding dispatch to its concrete clone + push branches,
 * honouring the step's declared preconditions.
 *
 * `requirePr` WITHDRAWS the base-branch fallback: a kind that works in place on an existing pull
 * request has nothing to do without one, and quietly cloning base would push its commits onto the
 * default branch. The dispatch fails loudly instead. `prFallback: 'work'` keeps one narrower
 * fallback for that case — the shared per-task work branch every repo's PR rides, which is the
 * right target when the OWN service had no change (so no own `pullRequest`) but a PEER repo did.
 */
function resolveInPlaceBranches(
  context: AgentRunContext,
  parts: KindBodyParts,
  step: AgentStepSpec,
): { clone: string; push: string } {
  const prBranch = context.block.pullRequest?.branch
  const toWorkBranch = step.clone?.prFallback === 'work'
  if (!step.clone?.requirePr) {
    // No precondition declared: clone whatever exists (base when there is no PR yet) and push to
    // the work branch, so a kind that reaches this path without a PR still lands its commits on
    // a branch of its own rather than on base.
    return { clone: prBranch ?? parts.repo.baseBranch, push: prBranch ?? parts.workBranch }
  }
  const resolved = prBranch ?? (toWorkBranch ? parts.workBranch : undefined)
  if (!resolved) {
    throw new Error(
      `The \`${context.agentKind}\` step needs the implementation pull request's branch to ` +
        'work on, and this block has none.',
    )
  }
  return { clone: resolved, push: resolved }
}

/**
 * The optional sibling-checkout legs of a coding job: the multi-repo peer repos (each opening the
 * SAME work branch + an equivalent PR when this kind opens PRs, otherwise resumed in place / seeded
 * with no PR), the read-only reference repos (forwarded as-is — `{ repo }`-shaped, no branch/PR, so
 * the harness clones and skips them in the push phase), and the read-only reference branches. Each
 * is `undefined` when empty so the body spreads read cleanly. Extracted from
 * {@link buildCodingAgentBody} to keep it under the complexity ceiling — behaviour is byte-identical.
 */
function buildCodingRepoLegs(
  parts: KindBodyParts,
  args: { opensPr: boolean; workBranch: string; pr: { title: string; body: string } },
): {
  peerRepos?: Record<string, unknown>[]
  referenceRepos?: { repo: Record<string, unknown> }[]
  referenceBranches?: string[]
} {
  const { opensPr, workBranch, pr } = args
  // The peer set is gated upstream (see MULTI_REPO_FANOUT_KINDS / a registered kind's
  // `fanOutMultiRepo`); the conflict-resolver never reaches here with peers set (it stays
  // single-repo). A peer leg carries `pr` only when this kind opens PRs.
  const peerRepos = parts.peerRepos?.length
    ? parts.peerRepos.map((p) => ({
        repo: p.repo,
        ...(p.frameIds?.length ? { frameIds: p.frameIds } : {}),
        newBranch: workBranch,
        ...(opensPr ? { pr } : {}),
      }))
    : undefined
  const referenceRepos = parts.referenceRepos?.length ? parts.referenceRepos : undefined
  const referenceBranches = parts.referenceBranches?.length ? parts.referenceBranches : undefined
  return { peerRepos, referenceRepos, referenceBranches }
}

/**
 * The PRE-PR verification payloads a coding job body carries: the service's configured validation
 * check commands, and the run's declared bugfix reproduction. Extracted together because they
 * share one gate and one rationale — see
 * [pre-PR validation](../../../../docs/initiatives/pre-pr-validation.md) and
 * [reproduction proof](../../../../docs/adr/0033-bugfix-reproduction-proof.md).
 *
 * Both are forwarded ONLY when this dispatch actually OPENS a PR: that is the whole point of
 * "pre-PR" for the checks (an in-place fixer pushing onto an existing PR head is already covered
 * by the `ci` gate), and the proof is published on the PR this dispatch opens. Both are dropped
 * on a multi-repo fan-out too, because both run in the PRIMARY checkout only — with one PR per
 * repo, they would speak for just one of them.
 *
 * Extracted from {@link buildCodingAgentBody} to keep it under the complexity ceiling — behaviour
 * is byte-identical, and an absent field (never an empty object) is what preserves the harness's
 * pre-feature code path.
 */
function buildPrePrVerification(
  context: AgentRunContext,
  gate: { opensPr: boolean; multiRepo: boolean },
): { validationChecks?: Record<string, unknown>; reproduction?: Record<string, unknown> } {
  if (!gate.opensPr || gate.multiRepo) return {}
  const checks = context.validationChecks
  const reproduction = context.reproduction
  return {
    ...(checks?.checks.length
      ? {
          validationChecks: {
            checks: checks.checks.map((c) => ({ label: c.label, command: c.command })),
            maxAttempts: checks.maxAttempts,
          },
        }
      : {}),
    ...(reproduction?.command
      ? {
          reproduction: {
            command: reproduction.command,
            testPaths: [...reproduction.testPaths],
            // Non-zero ⇒ the pre-fix tree will be rebuilt from an INCOMPLETE reproduction, which
            // the harness must be able to say in its report rather than let a green base read as
            // "the test does not capture the defect".
            ...(reproduction.omittedTestPaths
              ? { omittedTestPaths: reproduction.omittedTestPaths }
              : {}),
            ...(reproduction.setupCommand ? { setupCommand: reproduction.setupCommand } : {}),
            maxAttempts: reproduction.maxAttempts,
          },
        }
      : {}),
  }
}

/**
 * The `container-coding` job body: branch off base onto the deterministic work branch, push it and
 * open a PR (coder-like); or, when the kind targets the PR branch, work in place and push back with
 * no new PR (fixer-like). Extracted verbatim from {@link buildRegisteredAgentBody} so each function
 * stays within the complexity budget — behaviour is byte-identical.
 */
function buildCodingAgentBody(
  context: AgentRunContext,
  parts: KindBodyParts,
  step: AgentStepSpec,
  roleSystemPrompt: string,
  userPrompt: string,
): { body: Record<string, unknown>; kind: RunnerDispatchKind } {
  const { common, webTools, repo, workBranch } = parts
  const prBranch = context.block.pullRequest?.branch
  // Amend an EXISTING PR in place (fixer-like: push back, open no new PR) when the kind targets
  // the PR branch, OR targets `pr-or-work` and a PR already exists. A `pr-or-work` kind with no PR
  // yet falls back to the work-branch open-a-PR flow (coder-like) below — so one kind serves both
  // a BAU pipeline step (amend the coder's PR) and a standalone/initiative run (open its own PR).
  const onPr =
    step.clone?.branch === 'pr' || (step.clone?.branch === 'pr-or-work' && Boolean(prBranch))
  // The concrete in-place branches, honouring the step's `requirePr` / `prFallback` declarations.
  // Resolved once here so the clone, the push target and the refusal cannot disagree.
  const inPlace = onPr ? resolveInPlaceBranches(context, parts, step) : undefined
  {
    // `pr` clone ⇒ work in place on the PR branch and push back (fixer-like, no new PR);
    // otherwise branch off base onto the work branch, push it and open a PR (coder-like).
    const pr = {
      title: `${context.block.title} (${context.pipelineName})`,
      body: prBody(context),
    }
    // Whether this coding kind OPENS a PR: a work-branch coder does (unless it declares
    // `opensPr: false` — a seed-only kind like `repro-test`, which pushes the failing test onto
    // the work branch and lets the LATER coder open the one PR); an in-place fixer (`onPr`) never
    // opens a new PR. Whether a no-op run is an ERROR: the implementer fails on a no-op, but an
    // in-place fixer OR a kind that declares `noChangesTolerated` (repro-test conceding
    // `not_reproducible`) treats it as a clean non-event.
    const opensPr = !onPr && step.opensPr !== false
    const noChangesIsError = !onPr && step.noChangesTolerated !== true
    const { peerRepos, referenceRepos, referenceBranches } = buildCodingRepoLegs(parts, {
      opensPr,
      workBranch,
      pr,
    })
    return {
      kind: 'agent',
      body: {
        ...common,
        mode: 'coding',
        systemPrompt: appendSections(roleSystemPrompt, [
          parts.multiRepoSection,
          parts.referenceReposSection,
          parts.referenceBranchesSection,
          // Only a dispatch that OPENS a PR is asked for the reviewer briefing: an in-place
          // fixer amends an existing PR (whose description it doesn't own) and a seed-only
          // kind opens none, so prompting either for one would spend tokens on a file the
          // harness reads for no PR.
          opensPr ? PR_DESCRIPTION_GUIDANCE : undefined,
        ]),
        userPrompt,
        branch: inPlace ? inPlace.clone : repo.baseBranch,
        ...(onPr ? {} : { newBranch: workBranch }),
        pushBranch: inPlace ? inPlace.push : workBranch,
        // Merge the repo's base branch in before the agent runs, so the conflict hunks are in the
        // working tree for it to resolve; the harness completes the merge commit and pushes back
        // onto the same branch, refusing a half-resolved tree (the conflict-resolver).
        ...(step.clone?.mergeBase ? { mergeBase: repo.baseBranch } : {}),
        ...(opensPr ? { pr } : {}),
        ...(noChangesIsError ? {} : { noChangesIsError: false }),
        ...(peerRepos ? { peerRepos } : {}),
        ...(referenceRepos ? { referenceRepos } : {}),
        ...(referenceBranches ? { referenceBranches } : {}),
        ...(step.clone?.full ? { full: true } : {}),
        // A structured coding kind (repro-test) returns a JSON outcome alongside its pushed
        // commit; forward the output spec so the harness parses the final reply into `custom`
        // (same shape the explore branch sends). Absent for the plain coder/fixers.
        ...structuredOutputField(step.output),
        // Ralph loop: after the coding agent commits, the harness runs this programmatic
        // completion command in the checkout, records the outcome to the progress log, and
        // reports the exit code back on `result.ralphVerdict` (never the model). Present only
        // for a `ralph` iteration (the engine folds it in from `step.ralph`).
        ...(context.ralphValidation
          ? {
              validation: {
                command: context.ralphValidation.command,
                progressPath: context.ralphValidation.progressPath,
                iteration: context.ralphValidation.iteration,
              },
            }
          : {}),
        // The PRE-PR verification payloads (validation checks + bugfix reproduction proof), both
        // gated on this dispatch actually opening a PR in the primary checkout.
        ...buildPrePrVerification(context, { opensPr, multiRepo: !!peerRepos || !!referenceRepos }),
        // The Coder (follow-up companion enabled) streams forward-looking items out via the
        // sentinel file; tell the harness to tail it. Only on the SINGLE-REPO implementer path:
        // the multi-repo flow (`peerRepos`) runs `runMultiRepoCoding`, which does NOT tail the
        // sentinel, so advertising it there would spend prompt tokens on items that are silently
        // discarded. The co-located-only case has no `peerRepos`, so it keeps follow-ups on.
        ...(context.followUpCompanion && !onPr && !peerRepos && !referenceRepos
          ? { streamFollowUps: true }
          : {}),
        ...webTools,
      },
    }
  }
}

/**
 * The `container-explore` job body: a read-only clone returning prose, or a structured JSON object
 * as `custom`. Extracted verbatim from {@link buildRegisteredAgentBody} so each function stays
 * within the complexity budget — behaviour is byte-identical.
 */
function buildExploreAgentBody(
  context: AgentRunContext,
  parts: KindBodyParts,
  step: AgentStepSpec,
  roleSystemPrompt: string,
  userPrompt: string,
): { body: Record<string, unknown>; kind: RunnerDispatchKind } {
  const { common, webTools, repo, workBranch, workBranchReady } = parts
  const prBranch = context.block.pullRequest?.branch
  const wantsPr = step.clone?.branch === 'pr' || step.clone?.branch === 'pr-or-work'
  const exploreBranch =
    step.clone?.branch === 'base'
      ? repo.baseBranch
      : wantsPr
        ? (prBranch ?? repo.baseBranch)
        : workBranchReady
          ? workBranch
          : (prBranch ?? repo.baseBranch)

  // container-explore (read-only): prose, or a structured JSON object as `custom`.
  // Multi-repo (service-connections phase 3, read-only): a fan-out kind (today the
  // `bug-investigator`) clones each connected involved-service repo as a SIBLING checkout so
  // it can read across every repo the bug touches. Unlike the coding path there is no
  // `newBranch`/`pr` — the peers are read, never pushed — so the harness's read-only
  // `runMultiRepoExplore` just clones them (`{ repo, frameIds }`) and runs the agent at the
  // workspace root. The layout section names each repo/subdir + role.
  const explorePeers = parts.peerRepos?.length
    ? parts.peerRepos.map((p) => ({
        repo: p.repo,
        ...(p.frameIds?.length ? { frameIds: p.frameIds } : {}),
        // The merger pins each read-only peer to its PR branch so the combined diff sees the PR
        // change; the bug-investigator omits it (cloned at the repo's default branch).
        ...(p.cloneBranch ? { cloneBranch: p.cloneBranch } : {}),
      }))
    : undefined
  const exploreReferenceBranches = parts.referenceBranches?.length
    ? parts.referenceBranches
    : undefined
  // The pr-reviewer (`clone.prHead`) reviews an EXISTING PR: resolve its number so the harness can
  // prefetch the PR head into `origin/pr-head`. Without it the review clones only the base branch,
  // and — since the container agent has no git credential to fetch the head itself — files the PR
  // ADDS and the head version of modified files are unreachable, silently limiting the review to
  // the injected diff. The number comes from the task's PR fields (`prNumber`/`prUrl`), the same
  // source the diff preOp uses; absent (unresolvable) ⇒ no prefetch (the review degrades cleanly).
  const reviewPrNumber = step.clone?.prHead
    ? (resolvePrNumber(context.block.taskTypeFields) ?? undefined)
    : undefined
  return {
    kind: 'agent',
    body: {
      ...common,
      mode: 'explore',
      systemPrompt: appendSections(roleSystemPrompt, [
        parts.multiRepoSection,
        parts.referenceBranchesSection,
      ]),
      userPrompt,
      branch: exploreBranch,
      ...(explorePeers ? { peerRepos: explorePeers } : {}),
      ...(exploreReferenceBranches ? { referenceBranches: exploreReferenceBranches } : {}),
      ...(step.clone?.full ? { full: true } : {}),
      ...(reviewPrNumber !== undefined ? { reviewPrNumber } : {}),
      ...structuredOutputField(step.output),
      // The tester family: stand the service's declared test dependencies up around the run
      // (locally via docker-compose, or against the environment this run provisioned — the
      // frame's capability profile decides which) and hand the step's resolved test secrets to
      // the suite. Derived per run, so a kind declares only that it needs one.
      ...(step.testInfra
        ? {
            infra: testerInfraSpec(context),
            ...(parts.testSecretEnv?.length ? { testSecrets: parts.testSecretEnv } : {}),
          }
        : {}),
      ...webTools,
    },
  }
}

/**
 * The `` `owner/name` → `owner__name/` `` fragment naming a repo and its sibling checkout
 * directory. Shared by every multi-repo prompt section (the involved-services workspace section
 * AND the doc-writer reference section) so the repo→directory mapping is written ONE way — a
 * divergent format in any renderer would point the agent at a directory the harness names
 * differently.
 */
function siblingRepoLabel(owner: string, name: string): string {
  return `\`${owner}/${name}\` → \`${siblingCheckoutDir(owner, name)}/\``
}

/**
 * Render the "Multi-repo workspace" system-prompt section for a multi-service coding run
 * (service-connections phase 3). Names the primary repo (the task's own service) and, for
 * every involved connected service, WHICH repo + subdirectory it lives in and its role (the
 * connection `description`, carried on `involvedServices`). Two involved services sharing a
 * monorepo appear under the one repo with their distinct subdirectories; a service co-located
 * in the primary's own repo is noted under the primary.
 *
 * Two shapes, because the runtime layout genuinely differs:
 *  - **Distinct peers** (≥1 non-primary checkout): the harness (`runMultiRepoCoding`) clones each
 *    repo as a SIBLING under the workspace root (the cwd), so the section names each repo's sibling
 *    directory (matching the harness's `siblingDir`) and tells the agent to commit inside each.
 *  - **Co-located only** (all involved services live in the primary's own repo): there is a SINGLE
 *    checkout (the harness takes the ordinary single-repo path with cwd at the repo root), so the
 *    section must NOT claim sibling directories — it describes the shared repo's subdirectories and
 *    a single PR instead.
 */
export function renderMultiRepoWorkspaceSection(
  checkouts: RepoCheckout[],
  involvedServices: NonNullable<AgentRunContext['involvedServices']>,
): string {
  const roleByFrame = new Map(involvedServices.map((s) => [s.frameId, s]))
  const primary = checkouts.find((c) => c.primary)
  const hasPeers = checkouts.some((c) => !c.primary)

  const involvedLines = (checkout: RepoCheckout): string =>
    checkout.involved
      .map((inv) => {
        const role = roleByFrame.get(inv.frameId)
        const title = role?.title ?? inv.frameId
        const where = inv.serviceDirectory ? ` in \`${inv.serviceDirectory}/\`` : ''
        const why = role?.description ? ` — ${role.description}` : ''
        return `    - involved: ${title}${where}${why}`
      })
      .join('\n')

  // Co-located-only: one repo, many services in subdirectories. No sibling checkouts, one PR.
  if (!hasPeers) {
    const lines = [
      '## Multi-service repository',
      '',
      'This task spans MORE THAN ONE service, but they all live in the SAME repository. Your',
      'working directory is that repository root. Make the cross-service change coherently across',
      'the subdirectories below and commit it yourself (stage any new files too — anything left',
      'untracked is lost); it ships as a SINGLE pull request.',
      '',
      'Services in this repository:',
    ]
    if (primary) {
      const { owner, name } = primary.target
      const own = primary.target.serviceDirectory
        ? ` — the task's own service lives in \`${primary.target.serviceDirectory}/\``
        : ''
      lines.push(`- \`${owner}/${name}\`${own}`)
      const involved = involvedLines(primary)
      if (involved) lines.push(involved)
    }
    return lines.join('\n')
  }

  const lines = [
    '## Multi-repo workspace',
    '',
    'This task spans MORE THAN ONE repository. Each repository below is checked out as a SIBLING',
    'directory under your working directory (the workspace root); the root itself is NOT a git',
    'repository. Make the cross-service change coherently across the repositories that need it.',
    "Commit your own changes INSIDE each repository's directory (stage new files too — the",
    'platform will not add untracked files for you, so anything left untracked is lost), and run',
    "each repository's own build/test commands inside that repository's directory. Each repository",
    'you change is opened as a SEPARATE pull request; leave a repository untouched if the task does',
    'not require changing it.',
    '',
    'Repositories:',
  ]
  const describe = (checkout: RepoCheckout): string => {
    const { owner, name } = checkout.target
    const own =
      checkout.primary && checkout.target.serviceDirectory
        ? ` (this service lives in \`${checkout.target.serviceDirectory}/\` within it)`
        : ''
    const coLocated = involvedLines(checkout)
    const head = `- ${siblingRepoLabel(owner, name)}${
      checkout.primary ? " (PRIMARY — the task's own service)" : ''
    }${own}`
    return coLocated ? `${head}\n${coLocated}` : head
  }
  if (primary) lines.push(describe(primary))
  for (const checkout of checkouts) {
    if (checkout.primary) continue
    lines.push(describe(checkout))
  }
  return lines.join('\n')
}

/**
 * Render the "Multi-repo pull request" system-prompt section for a `merger` scoring a multi-repo
 * task (service-connections phase 4): the task opened one PR per changed repo, and the merger
 * assesses the COMBINED change. Each repo is a READ-ONLY sibling checkout (own-service first, then
 * peers) already on its PR branch, so the section names each repo's sibling directory (matching the
 * harness's `siblingDir`) and the exact per-repo diff command, and instructs the agent to weigh the
 * whole cross-repo change as ONE assessment. Distinct from {@link renderMultiRepoWorkspaceSection}
 * (which is for a coding fan-out — "commit inside each, one PR per repo"); the merger writes nothing.
 *
 * `unaddressable` names the repos of recorded pull requests the platform could NOT resolve to a
 * checkout, so none of their diff is in front of the agent. It is stated rather than dropped
 * because the alternative is a merger scoring a partial change while reading its evidence as
 * whole, which is the one way this section can produce a confident merge of something nobody
 * looked at.
 */
export function renderMergerMultiRepoSection(
  repos: { owner: string; name: string; baseBranch: string }[],
  unaddressable: string[] = [],
): string {
  const lines = [
    '## Multi-repo pull request',
    '',
    'This pull request spans MORE THAN ONE repository (one PR per changed repo). Each repository',
    'below is checked out as a SIBLING directory under your working directory (the workspace root,',
    'which is NOT a git repository), already on its pull-request branch (HEAD). Assess the COMBINED',
    "change: inspect EACH repository's diff against its base, weigh the whole cross-repo change",
    'together, and return ONE assessment covering all of them — NOT one assessment per repo.',
    '',
    "Repositories (run each diff inside that repository's own directory):",
  ]
  for (const r of repos) {
    const dir = siblingCheckoutDir(r.owner, r.name)
    lines.push(
      `- \`${r.owner}/${r.name}\` → \`${dir}/\` (base \`${r.baseBranch}\`): ` +
        `\`cd ${dir} && git fetch origin ${r.baseBranch} && git diff origin/${r.baseBranch}...HEAD\``,
    )
  }
  if (unaddressable.length) {
    lines.push(
      '',
      'NOT CHECKED OUT: this task also opened a pull request in the repositories below, and the',
      'platform could not resolve them, so NONE of their changes are in front of you. Treat the',
      'combined change as INCOMPLETE and say so in your assessment rather than scoring it as whole.',
    )
    for (const repo of unaddressable) lines.push(`- \`${repo}\``)
  }
  return lines.join('\n')
}

/** Append the present (non-empty) system-prompt sections to a base prompt, blank-line separated. */
function appendSections(base: string, sections: (string | undefined)[]): string {
  const present = sections.filter((s): s is string => !!s)
  return present.length ? [base, ...present].join('\n\n') : base
}

/**
 * Render the "Reference repositories" system-prompt section for a document-authoring run. Attaching
 * reference repos turns a doc-writer run into a multi-repo layout: the harness checks out the doc
 * repo AND each reference repo as SIBLING directories under the workspace root (the cwd), so the
 * section must name WHERE the writer's OWN repo lives (write the document there) and which sibling
 * dirs are READ-ONLY references (read them to reuse existing solutions, never edit/commit/push).
 * Directory names match the harness's `siblingDir` (`owner__name`), computed independently, so this
 * MUST stay byte-identical to {@link siblingCheckoutDir}.
 */
export function renderReferenceReposSection(primary: RepoTarget, references: RepoTarget[]): string {
  const own = primary.serviceDirectory
    ? ` (write the document under \`${primary.serviceDirectory}/\` within it)`
    : ''
  const lines = [
    '## Reference repositories',
    '',
    'This task has reference repositories attached, so MORE THAN ONE repository is checked out. Each',
    'is a SIBLING directory under your working directory (the workspace root); the root itself is NOT',
    'a git repository. Write the document in YOUR repository below.',
    '',
    // The doc-writer's base prompt assumes a single-repo run where the platform commits for it. With
    // reference repos the run is multi-repo (the platform stages only ALREADY-TRACKED files), so the
    // agent MUST commit the new document itself — restated here to override the base prompt and match
    // the harness's own multi-repo guidance. Any file path in your instructions is relative to your
    // repository's directory below, NOT the workspace root.
    'IMPORTANT — this overrides any earlier instruction that the platform commits your file for you:',
    'because more than one repository is checked out, you must stage and commit the document YOURSELF',
    "inside your repository's directory (`cd` into it, `git add` the new file, then commit). The",
    'platform still opens the pull request. Any target path in your instructions is relative to your',
    "repository's directory below, not the workspace root.",
    '',
    'The other repositories are READ-ONLY reference material: read them to reuse existing solutions,',
    'conventions, and structure while drafting, but you must NEVER edit, commit, or push anything in',
    'them — they are inputs to read, not code to change.',
    '',
    `Your repository (write the document here): ${siblingRepoLabel(primary.owner, primary.name)}${own}`,
    '',
    'Read-only reference checkouts:',
  ]
  for (const ref of references) {
    lines.push(`- ${siblingRepoLabel(ref.owner, ref.name)}`)
  }
  return lines.join('\n')
}

/** A safe, short slug for a branch name, for the suggested `git worktree` directory. MUST NOT
 * collide with the harness's checkout dirs (`.cat-reference/` is a dedicated prefix). */
function referenceBranchSlug(branch: string): string {
  return (
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'ref'
  )
}

/**
 * Render the "Reference branches" system-prompt section for the apriori-branches reference mode.
 * The named branches are pre-existing branches of the SAME repo the agent is working in, fetched
 * by the harness into `origin/<b>` refs BEFORE the agent runs. They are prior-art / spike /
 * prototype branches: the agent reads them to learn from them, but must NEVER commit to, push, or
 * base its work on them (its work branch is its HEAD). The read commands use TWO-dot diffs
 * (`git diff origin/<b>`) because the primary clone is shallow — a three-dot diff needs the merge
 * base, which isn't present. A `multiRepo` layout means the checkout root is not itself a git repo,
 * so the commands are run inside the agent's own repository directory (named in the multi-repo
 * section). Byte-identical rendering is not shared with the harness (the harness only fetches the
 * refs; this text is the sole guidance), so there is no cross-module invariant here.
 */
export function renderReferenceBranchesSection(
  branches: string[],
  opts: { multiRepo?: boolean } = {},
): string {
  const cwdNote = opts.multiRepo
    ? " Run these commands inside YOUR repository's directory (named in the multi-repo section " +
      'above), since more than one repository is checked out and the workspace root is not a git ' +
      'repository.'
    : ''
  const lines = [
    '## Reference branches',
    '',
    'This task has pre-existing branches of THIS repository attached as READ-ONLY reference points',
    '(a spike, a prototype, or prior-art work). They are already fetched into their `origin/<branch>`',
    `tracking refs.${cwdNote}`,
    '',
    'Inspect them to learn from or continue their ideas — but you must NEVER commit to, push, or',
    'reset your work onto them. Keep building on your own work branch (your current HEAD); these',
    'branches are inputs to read, not branches to write.',
    '',
    'Attached reference branches:',
  ]
  for (const branch of branches) {
    const slug = referenceBranchSlug(branch)
    lines.push(
      `- \`${branch}\` — read it via \`git log origin/${branch}\`, ` +
        `\`git diff origin/${branch}\` (two-dot; the clone is shallow, so avoid three-dot \`...\`), ` +
        `\`git show origin/${branch}:<path>\`, or check it out alongside your work with ` +
        `\`git worktree add .cat-reference/${slug} origin/${branch}\`.`,
    )
  }
  return lines.join('\n')
}
