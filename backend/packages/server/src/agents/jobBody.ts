import type { AgentRunContext, AgentStepSpec, RunnerDispatchKind } from '@cat-factory/kernel'
import {
  type AgentKindRegistry,
  bugFixGuidanceFor,
  composeBlockSystemPrompt,
  FOLLOW_UP_GUIDANCE,
  isContainerBackedCompanion,
  isReadOnlyAgentKind,
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
import { INITIATIVE_ANALYST_AGENT_KIND, INITIATIVE_PLANNER_AGENT_KIND } from '@cat-factory/kernel'
import {
  BLUEPRINT_SHAPE_HINT,
  BLUEPRINT_SYSTEM_PROMPT,
  blueprintUserPrompt,
  INITIATIVE_ANALYST_SYSTEM_PROMPT,
  initiativeAnalystUserPrompt,
  INITIATIVE_PLAN_SHAPE_HINT,
  INITIATIVE_PLANNER_SYSTEM_PROMPT,
  initiativePlannerUserPrompt,
  MERGE_ASSESSMENT_SHAPE_HINT,
  MERGER_SYSTEM_PROMPT,
  mergerMultiRepoUserPrompt,
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
  peerRepos?: { repo: Record<string, unknown>; frameId?: string; cloneBranch?: string }[]
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
  // `buildRegisteredAgentBody`/`buildMigratedBuiltInBody`, not directly here.
  const baseRoleSystemPrompt = composeBlockSystemPrompt(
    systemPromptFor(context.agentKind, registry),
    context.block,
  )
  // When the future-looking Follow-up companion is enabled for this (coder) step, append
  // the guidance that tells the Coder to stream loose-ends / side-tasks / questions to the
  // sentinel file the harness tails. Only when enabled, so a disabled companion (or any
  // other kind) never writes the file.
  const withFollowUp = context.followUpCompanion
    ? `${baseRoleSystemPrompt}\n\n${FOLLOW_UP_GUIDANCE}`
    : baseRoleSystemPrompt
  // Bug-triage (phase G): when a prior `repro-test` step ran, augment the CODER's prompt with
  // BUG_FIX_GUIDANCE — fix the reported issue, don't merely make the reproduction test pass.
  // `bugFixGuidanceFor` returns '' for every other kind / when no repro-test preceded, so this
  // is a no-op everywhere else.
  const bugFix = bugFixGuidanceFor(context)
  const roleSystemPrompt = bugFix ? `${withFollowUp}\n\n${bugFix}` : withFollowUp

  // A registered (custom or migrated) kind that declares an `agent` step dispatches
  // through the generic, manifest-driven `agent` harness kind — no per-kind case here.
  // Built-in kinds (below) still carry their bespoke bodies until they are migrated.
  const registeredStep = registry.agentStep(context.agentKind)
  if (registeredStep) {
    return buildRegisteredAgentBody(context, parts, registeredStep, roleSystemPrompt, registry)
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
  const migrated = buildMigratedBuiltInBody(context, parts, roleSystemPrompt, registry)
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
      registry,
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
      registry,
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
    registry,
  )
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
  registry: AgentKindRegistry,
  /**
   * The concrete task prompt. Defaults to the generic `userPromptFor` (block context +
   * prior outputs) — the same prompt a registered custom kind gets. A migrated built-in
   * (merger / on-call) overrides it with its bespoke, JSON-instructing prompt so its
   * body matches the old per-kind handler's.
   */
  userPrompt: string = userPromptFor(context, registry, { materialized: true }),
): { body: Record<string, unknown>; kind: RunnerDispatchKind } {
  const { common, webTools, repo, workBranch, workBranchReady } = parts
  const prBranch = context.block.pullRequest?.branch
  // Amend an EXISTING PR in place (fixer-like: push back, open no new PR) when the kind targets
  // the PR branch, OR targets `pr-or-work` and a PR already exists. A `pr-or-work` kind with no PR
  // yet falls back to the work-branch open-a-PR flow (coder-like) below — so one kind serves both
  // a BAU pipeline step (amend the coder's PR) and a standalone/initiative run (open its own PR).
  const onPr =
    step.clone?.branch === 'pr' || (step.clone?.branch === 'pr-or-work' && Boolean(prBranch))
  const wantsPr = step.clone?.branch === 'pr' || step.clone?.branch === 'pr-or-work'
  const exploreBranch =
    step.clone?.branch === 'base'
      ? repo.baseBranch
      : wantsPr
        ? (prBranch ?? repo.baseBranch)
        : workBranchReady
          ? workBranch
          : (prBranch ?? repo.baseBranch)

  if (step.surface === 'container-coding') {
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
    // Multi-repo fan-out (service-connections phases 3–4): clone each connected involved-service
    // repo as a sibling. A PR-opening implementer (`opensPr`) opens the SAME work branch + an
    // equivalent PR in each; the ci-fixer (`onPr`) RESUMES those same peer work branches to push
    // fixes onto the existing peer PRs, and a seed-only kind (`repro-test`) pushes the work branch
    // per repo with no PR — so a peer leg carries `pr` only when this kind opens PRs. The peer set
    // is gated upstream (see MULTI_REPO_FANOUT_KINDS / a registered kind's `fanOutMultiRepo`); the
    // conflict-resolver never reaches here with peers set (it stays single-repo).
    const peerRepos = parts.peerRepos?.length
      ? parts.peerRepos.map((p) => ({
          repo: p.repo,
          ...(p.frameId ? { frameId: p.frameId } : {}),
          newBranch: workBranch,
          ...(opensPr ? { pr } : {}),
        }))
      : undefined
    // Read-only reference repos (doc-writer): forwarded as-is — already `{ repo }`-shaped with NO
    // branch/PR fields (unlike the peer legs above, which add `newBranch`/`pr`), so the harness
    // clones each and skips it in the push phase. Kept as its own binding so the `undefined`-when-
    // empty spread below reads the same as `peerRepos`.
    const referenceRepos = parts.referenceRepos?.length ? parts.referenceRepos : undefined
    return {
      kind: 'agent',
      body: {
        ...common,
        mode: 'coding',
        systemPrompt: appendSections(roleSystemPrompt, [
          parts.multiRepoSection,
          parts.referenceReposSection,
        ]),
        userPrompt,
        branch: onPr ? (prBranch ?? repo.baseBranch) : repo.baseBranch,
        ...(onPr ? {} : { newBranch: workBranch }),
        pushBranch: onPr ? (prBranch ?? workBranch) : workBranch,
        ...(opensPr ? { pr } : {}),
        ...(noChangesIsError ? {} : { noChangesIsError: false }),
        ...(peerRepos ? { peerRepos } : {}),
        ...(referenceRepos ? { referenceRepos } : {}),
        ...(step.clone?.full ? { full: true } : {}),
        // A structured coding kind (repro-test) returns a JSON outcome alongside its pushed
        // commit; forward the output spec so the harness parses the final reply into `custom`
        // (same shape the explore branch sends). Absent for the plain coder/fixers.
        ...structuredOutputField(step.output),
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

  // container-explore (read-only): prose, or a structured JSON object as `custom`.
  // Multi-repo (service-connections phase 3, read-only): a fan-out kind (today the
  // `bug-investigator`) clones each connected involved-service repo as a SIBLING checkout so
  // it can read across every repo the bug touches. Unlike the coding path there is no
  // `newBranch`/`pr` — the peers are read, never pushed — so the harness's read-only
  // `runMultiRepoExplore` just clones them (`{ repo, frameId }`) and runs the agent at the
  // workspace root. The layout section names each repo/subdir + role.
  const explorePeers = parts.peerRepos?.length
    ? parts.peerRepos.map((p) => ({
        repo: p.repo,
        ...(p.frameId ? { frameId: p.frameId } : {}),
        // The merger pins each read-only peer to its PR branch so the combined diff sees the PR
        // change; the bug-investigator omits it (cloned at the repo's default branch).
        ...(p.cloneBranch ? { cloneBranch: p.cloneBranch } : {}),
      }))
    : undefined
  return {
    kind: 'agent',
    body: {
      ...common,
      mode: 'explore',
      systemPrompt: parts.multiRepoSection
        ? `${roleSystemPrompt}\n\n${parts.multiRepoSection}`
        : roleSystemPrompt,
      userPrompt,
      branch: exploreBranch,
      ...(explorePeers ? { peerRepos: explorePeers } : {}),
      ...(step.clone?.full ? { full: true } : {}),
      ...structuredOutputField(step.output),
      ...webTools,
    },
  }
}

/** Sanitise an owner/name segment for a sibling checkout directory. MUST match the harness's
 * `safeDirSegment` (executor-harness `coding-agent.ts`) — see {@link siblingCheckoutDir}. */
function safeDirSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-') || '_'
}

/**
 * The sibling checkout directory the harness creates for a repo under the multi-repo workspace
 * root. MUST stay byte-identical to the harness's `siblingDir` (`owner__name`, computed in
 * executor-harness `coding-agent.ts`): the two are independent, so a divergent rule would name a
 * directory in the agent's prompt that does not exist on disk (the agent would edit the wrong
 * repo). GitHub owners contain no `_`, so `owner__name` is collision-free across the deduped set.
 */
function siblingCheckoutDir(owner: string, name: string): string {
  return `${safeDirSegment(owner)}__${safeDirSegment(name)}`
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
 */
export function renderMergerMultiRepoSection(
  repos: { owner: string; name: string; baseBranch: string }[],
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
    'Repositories (run each diff inside that repository’s own directory):',
  ]
  for (const r of repos) {
    const dir = siblingCheckoutDir(r.owner, r.name)
    lines.push(
      `- \`${r.owner}/${r.name}\` → \`${dir}/\` (base \`${r.baseBranch}\`): ` +
        `\`cd ${dir} && git fetch origin ${r.baseBranch} && git diff origin/${r.baseBranch}...HEAD\``,
    )
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
  registry: AgentKindRegistry,
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
        registry,
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
        registry,
        specWriterUserPrompt(context),
      )
    // The initiative analyst explores the repository (read-only, base branch — an
    // initiative block has no PR) and returns a PROSE codebase-analysis report grounding
    // the plan (structure, hot spots, risks, likely touch points). Its output is folded
    // onto the `initiatives` entity by the engine's analyst post-completion resolver and
    // then into the planner's prompt. No structured output — it makes no commit and opens
    // no PR (an edit-free run is the expected outcome, exactly like the architect/analysis).
    case INITIATIVE_ANALYST_AGENT_KIND:
      return buildRegisteredAgentBody(
        context,
        parts,
        { surface: 'container-explore', clone: { branch: 'base' } },
        INITIATIVE_ANALYST_SYSTEM_PROMPT,
        registry,
        initiativeAnalystUserPrompt(context),
      )
    // The initiative planner explores the repository (read-only, base branch — an
    // initiative block has no PR) to ground its multi-phase plan in the actual code,
    // returning ONLY the plan as JSON. `toRunResult` coerces it into `initiativePlan`
    // for the engine's ingest (into the `initiatives` entity); the in-repo tracker is
    // committed later by the `initiative-committer` step, AFTER the human approves the
    // plan at the pipeline gate. `failOnUnusableFinal` because the plan is handed
    // onward — a truncated final answer must fail loudly, not be laundered into a
    // half-baked plan by the structured repair.
    case INITIATIVE_PLANNER_AGENT_KIND:
      return buildRegisteredAgentBody(
        context,
        parts,
        {
          surface: 'container-explore',
          clone: { branch: 'base' },
          output: {
            kind: 'structured',
            shapeHint: INITIATIVE_PLAN_SHAPE_HINT,
            failOnUnusableFinal: true,
          },
        },
        INITIATIVE_PLANNER_SYSTEM_PROMPT,
        registry,
        initiativePlannerUserPrompt(context),
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
        registry,
      )
    case FIXER_AGENT_KIND:
      if (!prBranch) throw new Error('Fixer needs the implementation PR branch to push fixes to')
      return buildRegisteredAgentBody(
        context,
        parts,
        { surface: 'container-coding', clone: { branch: 'pr' } },
        roleSystemPrompt,
        registry,
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
      // The branch to resolve on is the shared per-task work branch every repo's PR rides
      // (`cat-factory/<blockId>`, opened via `newBranch: workBranch` for the own service AND
      // every peer). The own PR's recorded branch equals it by construction; `parts.workBranch`
      // is the robust value when the OWN service had no change (no own `pullRequest`) but a
      // PEER repo did (the peer-conflict case — `parts.repo` was swapped to that peer upstream).
      const resolveBranch = prBranch ?? parts.workBranch
      if (!resolveBranch) {
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
        registry,
        `Task: ${context.block.title}${description ? `\n\n${description}` : ''}`,
      )
      // Pin the clone/push branch to the resolved work branch (the generic `pr`-clone path falls
      // back to the base branch when there is no own PR, which would clone the wrong ref for a
      // peer-only conflict) and merge THIS repo's base in to surface the conflicts.
      return {
        kind: built.kind,
        body: {
          ...built.body,
          branch: resolveBranch,
          pushBranch: resolveBranch,
          mergeBase: repo.baseBranch,
        },
      }
    }
    // The merger clones the PR head (full, to diff vs base) and returns ONLY the
    // complexity/risk/impact assessment JSON; the engine performs the real merge. On a MULTI-REPO
    // task (`parts.peerRepos` set) it clones each peer PR's repo as a read-only full sibling too
    // (the explore fan-out) and scores the COMBINED diff — the section naming the sibling
    // checkouts + per-repo diff commands is appended to the system prompt by the explore builder.
    case MERGER_AGENT_KIND: {
      const multiRepo = (parts.peerRepos?.length ?? 0) > 0
      return buildRegisteredAgentBody(
        context,
        parts,
        {
          surface: 'container-explore',
          clone: { branch: 'pr', full: true },
          output: { kind: 'structured', shapeHint: MERGE_ASSESSMENT_SHAPE_HINT },
        },
        MERGER_SYSTEM_PROMPT,
        registry,
        multiRepo ? mergerMultiRepoUserPrompt(context) : mergerUserPrompt(context, repo),
      )
    }
    // The on-call agent clones the BASE branch (full, to locate + diff the merged
    // release commit) and returns ONLY the regression assessment JSON. It is
    // `code-aware` (it reads the released code to correlate the diff with the
    // evidence), so the service's resolved best-practice fragments are folded into
    // its bespoke system prompt — the shared `roleSystemPrompt` is bypassed here.
    case ON_CALL_AGENT_KIND:
      return buildRegisteredAgentBody(
        context,
        parts,
        {
          surface: 'container-explore',
          clone: { branch: 'base', full: true },
          output: { kind: 'structured', shapeHint: ON_CALL_ASSESSMENT_SHAPE_HINT },
        },
        composeBlockSystemPrompt(ON_CALL_SYSTEM_PROMPT, context.block),
        registry,
        onCallUserPrompt(context, repo, registry),
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
        registry,
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
        registry,
      )
      return { kind: built.kind, body: { ...built.body, infra: testerInfraSpec(context) } }
    }
  }
  return undefined
}
