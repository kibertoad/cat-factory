import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runCapturedCommand } from './captured-command.js'
import type {
  ContextFileSpec,
  HarnessAuthFields,
  ImageManifestSpec,
  RepoSpec,
  SkillSpec,
  McpServerSpec,
} from './job.js'
import {
  branchAheadOfBase,
  changedFilesSinceBase,
  branchHasCommitsSince,
  cloneExistingBranch,
  cloneRepo,
  commitTrackedEdits,
  createBranch,
  excludeFromGit,
  fetchReferenceBranches,
  headCommit,
  listUntrackedFiles,
  prepareExistingCheckout,
  pushBranch,
  refreshFromBaseIfClean,
  remoteBranchExists,
  unpublishedWorkBranchTip,
  workBranchLease,
} from './git.js'
import { FOLLOW_UPS_FILENAME, FollowUpTailer } from './follow-ups.js'
import type { HarnessCallMetric } from './pi.js'
import type { PiRunStats } from './pi-reduction.js'
import { EFFORT_REPORT_FILE, type EffortReport } from './effort.js'
import {
  type AgentPrDescription,
  PR_DESCRIPTION_FILE,
  readPrDescription,
} from './pr-description.js'
import {
  acquireRepoCheckout,
  agentNeverActed,
  agentOutputTail,
  runAgentInWorkspace,
} from './pi-workspace.js'
import type { ProgressGuardLimits } from './progress-guard.js'
import type { RunOptions } from './runner.js'
import { log, type Logger } from './logger.js'
import {
  runValidationLoop,
  type ValidationChecksSpec,
  type ValidationReport,
} from './validation-checks.js'
import {
  runReproductionLoop,
  type ReproductionReport,
  type ReproductionSpec,
} from './reproduction-proof.js'
import {
  prepopulateDependencies,
  withDependencyNote,
  type DependencyInstallSpec,
} from './dependency-install.js'
import {
  resolvePrTemplateNote,
  withPrTemplateNote,
  type PrTemplateResolution,
} from './pr-template.js'
import { describeSalvage, salvageUntrackedWork, type SalvageReport } from './salvage.js'

// The shared skeleton for the container coding agents that clone a repo, run Pi
// against it and push the result on a branch. The implementation (`/run`) and
// CI-fixer (`/ci-fix`) agents are conceptually the same job — only what they clone
// onto and what they do with the outcome differ — so they share this whole flow
// rather than each re-deriving (and separately bug-fixing) it. Built on the thinner
// `withWorkspace`/{@link runAgentInWorkspace} base shared with the non-pushing
// agents (bootstrap/blueprint/merger). Mirrors their secret handling: the per-job
// GitHub + proxy tokens arrive in the spec and live only for the job's duration.

/** What a coding agent run needs: where to clone, what to run, where to push. */
export interface CodingAgentSpec extends HarnessAuthFields {
  /** Short label for the temp dir + log lines (e.g. 'impl', 'ci-fix'). */
  kind: string
  /** The job id, threaded into every log line for end-to-end tracing. */
  jobId: string
  repo: RepoSpec
  /** Branch to clone and check out as the starting point. */
  cloneBranch: string
  /** A fresh branch to create off the clone before running; omit to work directly on `cloneBranch`. */
  newBranch?: string
  /** Branch the produced change is pushed to. */
  pushBranch: string
  ghToken: string
  /** Composed role + best-practice fragments; written to Pi's global AGENTS.md context. */
  systemPrompt: string
  /** The concrete task prompt handed to Pi. */
  userPrompt: string
  model: string
  /** Commit message for any work the agent left uncommitted. */
  commitMessage: string
  /** Per-kind web-search guidance (backend-composed); surfaced only when web search is on. */
  webToolsGuidance?: string
  /** Enable proxy-backed web search for this run (see {@link AgentRunSpec.webSearchProxy}). */
  webSearchProxy?: boolean
  /** Backend serves the phase-tagged completions route (see {@link AgentRunSpec.proxyPhasePath}). */
  proxyPhasePath?: boolean
  /** Per-knob progress-guard overrides (loosen-only), set per agent kind by the backend. */
  guardLimits?: Partial<ProgressGuardLimits>
  /**
   * Reuse a stable per-repo checkout (clean-sweep + fetch + switch branch) instead of a
   * fresh clone into a throwaway temp dir. Set only by the local warm-pool transport
   * (its containers are reused across runs); absent everywhere else.
   */
  persistentCheckout?: boolean
  /**
   * Tail the Coder's follow-up sentinel file ({@link FOLLOW_UPS_FILENAME}) and stream the
   * forward-looking items it surfaces out on the job view (the Follow-up companion). Set
   * only for the implementer (`coder`) dispatch; absent ⇒ no tailing (e.g. the CI-fixer).
   */
  streamFollowUps?: boolean
  /**
   * Whether this dispatch OPENS a pull request (the caller passes `pr` to `openPullRequest`).
   * Set, the harness looks for the repo's own pull-request template and asks the agent to fill it
   * (see `pr-template.ts`). Absent for a dispatch that amends someone else's PR (the in-place
   * fixers) — a template filled for a pull request nothing opens is wasted prompt and, worse,
   * would have a CI-fixer rewrite the implementer's already-published description.
   */
  opensPr?: boolean
  /**
   * READ-ONLY reference branches of THIS repo (the apriori-branches reference mode): fetched
   * into `origin/<b>` after the checkout so the agent can inspect them but never commits to
   * them. Best-effort per branch. Absent/empty ⇒ none fetched.
   */
  referenceBranches?: string[]
  /**
   * Ralph loop: run this programmatic completion command in the checkout AFTER the agent
   * commits + pushes, capturing its exit code + a bounded output tail (the loop's exit
   * condition — computed by the harness, never the model). Absent for every non-`ralph` run.
   */
  validation?: { command: string; iteration?: number }
  /**
   * PRE-PR VALIDATION: the service's configured check commands + repair-round budget. When set,
   * the harness runs them against the checkout after the agent settles and, while they fail and
   * budget remains, re-runs the agent with the captured output as its instruction. A red checkout
   * at the end means the caller opens NO pull request and fails the job. Set only for a dispatch
   * that opens a PR and whose service configured checks; absent everywhere else. See
   * `docs/initiatives/pre-pr-validation.md`.
   */
  validationChecks?: ValidationChecksSpec
  /**
   * DEPENDENCY PREPOPULATION: the service's install command, run against the checkout BEFORE the
   * agent's first turn so it works against a tree whose dependencies are present. Best-effort —
   * a failure becomes a note in the agent's prompt, never a failed run. Absent ⇒ no install
   * phase. See `docs/initiatives/agent-dependency-prepopulation.md`.
   */
  dependencyInstall?: DependencyInstallSpec
  /**
   * BUGFIX REPRODUCTION PROOF: the run's declared reproduction command + test files. When set, the
   * harness runs that command against the pre-fix tree AND the tree the PR will open from, feeding
   * a failed verification back to the agent while budget remains, and attaches the verdict to the
   * outcome. Unlike {@link validationChecks} it NEVER gates the pull request — an unproven
   * reproduction is weak evidence, which is a reviewer's call, not a machine's. Set only for a
   * dispatch that opens a PR and whose run carries a declaration. See
   * `docs/initiatives/bugfix-reproduction-proof.md`.
   */
  reproduction?: ReproductionSpec
  /**
   * The run's LINKED CONTEXT documents (the task's attached brief, an RFC, a tracker issue body),
   * materialised into `.cat-context/<path>` in the checkout and enumerated for the agent in its
   * `AGENTS.md` context block. Absent ⇒ none.
   *
   * Carried here because the CODING agent is the one that needs them most and was the ONE path
   * that dropped them: every sibling caller of {@link runAgentInWorkspace} (the explore paths, the
   * conflict path, `multi-repo-coding.ts`) forwarded `job.contextFiles` and this one did not, so a
   * task whose brief was too long for `description` and therefore rode an attached document
   * reached the implementer as a prompt naming `.cat-context/<file>.md` and a checkout with no
   * such directory. The agent then rebuilt the brief from whatever summary the prompt carried and
   * reported the gap as a follow-up question, which is the most expensive way to discover a
   * missing field spread.
   */
  contextFiles?: ContextFileSpec[]
  /**
   * The skills to make available for this run — a `skill` step's pick and/or the running kind's
   * declared playbooks. Threaded into {@link runAgentInWorkspace}, which installs them
   * harness-aware: natively under the ISOLATED `CLAUDE_CONFIG_DIR` for a leased-credential
   * claude-code run, `.cat-context/skill/<name>/` for everything else (Pi, codex, and ambient
   * claude-code, which has no isolated config dir). Absent ⇒ no skills.
   */
  skills?: SkillSpec[]
  /**
   * Tool servers (MCP) to wire into the agent CLI for this run. Forwarded verbatim — the backend
   * has already dropped anything this harness cannot serve. Absent ⇒ built-in tools only.
   */
  mcpServers?: McpServerSpec[]
  /**
   * The task's reference design images, downloaded into `.cat-context/reference-screenshots/`
   * before the agent's first turn. Carried on the coding path as well as the explore one because
   * what earns a run its references is the KIND's declared `ui` image, and a deployment's own
   * UI-facing kind may well be a coding one, and nothing here switches on which built-in it is.
   * Absent ⇒ none (the normal case).
   */
  referenceScreenshots?: ImageManifestSpec
  /**
   * The PICTURES of the task's designs, downloaded into `.cat-context/design-renders/` before the
   * agent's first turn. Carried here for the same reason the capture set is: what earns a run its
   * pictures is the KIND's declared trait plus a harness that can read an image, and a coding kind
   * is the commonest holder of both. Absent ⇒ none (the normal case).
   */
  designImages?: ImageManifestSpec
}

/** The outcome of a coding agent run, before each caller maps it to its own result shape. */
export interface CodingAgentOutcome {
  /** Whether the branch carries work and was therefore pushed (new commits, or resumed prior work). */
  pushed: boolean
  /** Whether the run resumed an existing remote branch (prior work already pushed). */
  resumed: boolean
  summary: string
  stats: PiRunStats
  stderrTail?: string
  /** Token usage from a subscription harness's CLI stream (absent for Pi). */
  usage?: { inputTokens: number; outputTokens: number }
  /** Per-model-call telemetry from a subscription harness's CLI stream (absent for Pi). */
  callMetrics?: HarnessCallMetric[]
  /** The agent's effort self-assessment, lifted from its sentinel file (absent when it wrote none). */
  effortReport?: EffortReport
  /**
   * The agent-authored PR description, lifted from its sentinel file (absent when it wrote none).
   * The PR-opening caller folds it over the dispatch-time title/body via `applyPrDescription`;
   * absent means the fallback text, unchanged.
   */
  prDescription?: AgentPrDescription
  /**
   * Ralph loop: the verdict of the post-commit validation command (whether it exited 0, the
   * exit code, and a bounded/redacted output tail). Present only when {@link CodingAgentSpec.validation}
   * was set. The exit code is the loop's authoritative completion signal.
   */
  validation?: {
    validationPassed: boolean
    exitCode: number
    validationOutputTail?: string
    iteration?: number
    /** The work-branch HEAD the command was judged against (absent when it could not be read). */
    headSha?: string
  }
  /**
   * The pre-PR validation loop's LAST attempt (present only when {@link CodingAgentSpec.validationChecks}
   * was set). `passed: false` means the attempt budget was spent with the checkout still red —
   * the caller must open no PR and fail the job with this as the evidence.
   */
  validationReport?: ValidationReport
  /**
   * The bugfix reproduction proof's LAST attempt (present only when
   * {@link CodingAgentSpec.reproduction} was set). Evidence, never a gate: `inconclusive` is
   * attached to a perfectly successful run and the PR still opens.
   */
  reproductionReport?: ReproductionReport
  /**
   * What became of the new files the agent created and never committed. Absent means there were
   * none to consider; `status: 'refused'` or `'failed'` means work was left behind and is NOT in
   * the push, which the backend must be able to tell a human rather than presenting the run as a
   * clean pass.
   */
  salvage?: SalvageReport
}

/**
 * How often the harness checkpoints the agent's work mid-run by pushing the branch.
 * A per-run container can be evicted at any moment; pushing the agent's commits
 * periodically means an evicted run's work survives on the branch, so a retry
 * RESUMES on top of it instead of starting over. Overridable via env for tests.
 */
function checkpointIntervalMs(): number {
  const n = Number(process.env.JOB_CHECKPOINT_INTERVAL_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000
}

/**
 * How often the harness tails the Coder's follow-up sentinel file to surface new items.
 * Short (a few seconds) so the Follow-up companion lights up promptly while the Coder is
 * still running. Overridable via env for tests.
 */
function followUpPollIntervalMs(): number {
  const n = Number(process.env.JOB_FOLLOWUP_POLL_INTERVAL_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3_000
}

/**
 * Clone (or RESUME an existing branch) → write context → run Pi → push the branch
 * iff it carries work. The agent commits its OWN work (it alone knows which files
 * belong vs scratch/artifacts it created), so the harness never blanket-stages:
 * {@link commitTrackedEdits} is only a safety net for forgotten edits to ALREADY
 * tracked files, and the run is judged a no-op only when the branch never advanced
 * past its pre-run tip ({@link branchHasCommitsSince}). The harness owns push + PR;
 * it checkpoints (pushes) periodically so an evicted run's commits survive and a
 * retry resumes on them. Returns the run's summary/stats, whether it pushed, and
 * whether it resumed; callers decide what to do after a push (open a PR, or nothing).
 */
/**
 * The work-branch push machinery for one coding run: a single coalesced push plus the periodic
 * checkpoint that keeps mid-run commits durable. Split out of {@link runCodingAgent} for the
 * per-function line budget; the caller owns the interval's lifetime (it clears `checkpoint`).
 *
 * Serialize all pushes to the work branch through a single in-flight promise. A checkpoint tick
 * and the final push (or two slow checkpoint ticks) must never run `git push` to the same branch
 * concurrently: overlapping pushes race on the remote ref and can make a push fail with a
 * ref-lock / non-fast-forward error — which, on the FINAL push, would fail the whole run even
 * though the work is committed. `pushWorkOnce` coalesces concurrent callers onto one push and only
 * pushes what is UNPUBLISHED ({@link unpublishedWorkBranchTip}: past `baseSha`, and not already the
 * tip the last push published).
 *
 * Every push after the first LEASES against the sha this pass published (see
 * {@link pushBranch}), because the checkpoint makes the harness its own competing writer: it
 * publishes a commit within a minute of the agent making it, and the agent is then free to amend,
 * reset or rebase that commit, which is perfectly ordinary git hygiene, and the delivery contract
 * asks it to validate AFTER committing, exactly the sequence that produces an amend. Without the
 * lease the final push is refused as a non-fast-forward and the whole run fails with its work
 * already on the branch. The lease is what keeps that recovery from becoming a blanket `--force`:
 * a SECOND writer (a concurrent dispatch for the same block) still refuses the push, which is the
 * "never clobber another run's commits" property the resume design leans on.
 *
 * The lease alone does not bound the force to THIS pass's own commits, and that is the property
 * the design promises, so it is checked rather than assumed: once one checkpoint has landed, a
 * rewrite that drops `baseSha` (the tip the pass started from, which on a RESUMED branch is an
 * earlier run's published work) would lease successfully against our own checkpoint and take the
 * earlier commits with it. So the lease is armed only while the branch still CONTAINS `baseSha`;
 * withheld, the push goes out plain, git refuses it, and the engine re-dispatches onto the branch
 * as it stands. A rewrite this pass cannot prove is its own is never forced away.
 *
 * What is pushable is {@link unpublishedWorkBranchTip}'s question, and both of its answers matter
 * here. A branch still at `baseSha` must not be pushed at all, or a later retry resumes a zero-diff
 * branch and cannot open a PR for it. A branch already at the published tip has nothing to add, and
 * skipping it is what keeps the interval a LOSS WINDOW rather than a push rate: an hour-long run
 * that commits eight times pushes eight times, not sixty. That skip is invisible to the outcome by
 * construction: `finalizeCodingRun` decides `pushed` from the BRANCH (advanced this pass, or
 * resumed), never from whether the final call issued a `git push`, because a tip the checkpoint
 * already published is published.
 */
function createWorkBranchPusher(args: {
  dir: string
  spec: CodingAgentSpec
  baseSha: string
  logger: Logger
  signal: AbortSignal | undefined
}): {
  pushWorkOnce: () => Promise<void>
  inFlightPush: () => Promise<void> | null
  checkpoint: ReturnType<typeof setInterval>
} {
  const { dir, spec, baseSha, logger, signal } = args
  let pushInFlight: Promise<void> | null = null
  // The sha THIS pass last published to the work branch, and the only value it will ever lease a
  // force push against. Starts unset even on a RESUMED branch: the tip we merely cloned is an
  // earlier run's work, so a rewrite of it is refused (and re-driven) rather than forced away.
  let publishedSha: string | undefined
  const pushWorkOnce = (): Promise<void> => {
    if (pushInFlight) return pushInFlight
    pushInFlight = (async () => {
      if (!(await unpublishedWorkBranchTip({ dir, baseSha, publishedSha, signal }))) return
      // The rule the lease is entitled to lives beside the push ({@link workBranchLease}); the
      // warn is here, because a withheld lease is how a rewrite this pass cannot claim fails the
      // push it is about to make, and the run's log is where that is read.
      const lease = await workBranchLease({
        dir,
        branch: spec.pushBranch,
        baseSha,
        publishedSha,
        signal,
        onWithheld: (probe) =>
          logger.warn('coding-agent: push lease withheld, the branch dropped its pre-run tip', {
            baseSha,
            publishedSha,
            probe,
          }),
      })
      publishedSha = await pushBranch(dir, spec.pushBranch, spec.ghToken, signal, lease)
    })().finally(() => {
      pushInFlight = null
    })
    return pushInFlight
  }
  // Read the in-flight push, if any. A function (with an explicit return type) so the
  // value isn't subject to the caller's straight-line narrowing — `pushInFlight` is
  // only ever assigned inside closures, which flow analysis can't observe.
  const inFlightPush = (): Promise<void> | null => pushInFlight

  // Checkpoint the agent's committed work to the branch periodically so an eviction
  // mid-run doesn't lose it (a retry then resumes from the pushed commits). The
  // agent commits its own work; this only PUSHES already-committed commits, so it
  // never races the agent's staging. Best-effort: a failed checkpoint is skipped.
  // Surface checkpoint-push failures at warn with a running count: a checkpoint losing
  // a race is harmless once, but a steadily-climbing count means mid-run work is NOT
  // being durably checkpointed, so an eviction would lose it — previously invisible at
  // info level. Still best-effort: a failed checkpoint never fails the run.
  let checkpointFailures = 0
  const checkpoint = setInterval(() => {
    pushWorkOnce().catch((err) => {
      checkpointFailures++
      logger.warn('coding-agent: checkpoint push failed', {
        reason: err instanceof Error ? err.message : String(err),
        checkpointFailures,
      })
    })
  }, checkpointIntervalMs())
  checkpoint.unref?.()

  return { pushWorkOnce, inFlightPush, checkpoint }
}

/**
 * Exclude the harness's own sentinel files from this checkout's git, and start tailing the
 * follow-up one when the run streams follow-ups.
 *
 * Each sentinel is a file the PLATFORM writes into the agent's cwd (its effort self-assessment,
 * its PR briefing, its follow-up items), so a `git add -A` by the agent would commit the
 * platform's own bookkeeping into a customer's pull request. The exclude goes in
 * `.git/info/exclude`, which is per-clone and never lands in the repo. `readEffortReport` also
 * removes its file after the run, but that cannot un-stage a mid-run commit; only the exclude
 * prevents one. A bare filename pattern matches at any depth, so a monorepo `workDir` is covered.
 *
 * The caller owns the returned interval's lifetime (it clears `followUpTick`). Extracted from
 * {@link runCodingAgent} for the per-function line budget.
 */
async function armCheckoutSentinels(args: {
  dir: string
  workDir: string
  spec: CodingAgentSpec
  logger: Logger
  opts: RunOptions
}): Promise<{
  followUpTailer: FollowUpTailer | undefined
  followUpTick: ReturnType<typeof setInterval> | undefined
}> {
  const { dir, workDir, spec, logger, opts } = args
  const { signal } = opts
  await excludeFromGit(dir, EFFORT_REPORT_FILE, signal)
  await excludeFromGit(dir, PR_DESCRIPTION_FILE, signal)

  // The follow-up sentinel lives in the agent's working directory (its cwd), where the prompt
  // tells it to write; the other two are read from both the checkout root and the cwd.
  const followUpTailer =
    spec.streamFollowUps && opts.onFollowUp
      ? new FollowUpTailer(join(workDir, FOLLOW_UPS_FILENAME), opts.onFollowUp, logger)
      : undefined
  if (!followUpTailer) return { followUpTailer: undefined, followUpTick: undefined }
  await excludeFromGit(dir, FOLLOW_UPS_FILENAME, signal)
  const followUpTick = setInterval(() => {
    void followUpTailer.poll()
  }, followUpPollIntervalMs())
  followUpTick.unref?.()
  return { followUpTailer, followUpTick }
}

export async function runCodingAgent(
  spec: CodingAgentSpec,
  opts: RunOptions = {},
): Promise<CodingAgentOutcome> {
  const { signal } = opts
  // The registry already binds jobId/repo/branch; add the coding kind + the push branch
  // (which differs from the cloned branch the registry bound).
  const logger = (opts.log ?? log).child({ kind: spec.kind, branch: spec.pushBranch })
  return acquireRepoCheckout(
    { persistent: spec.persistentCheckout === true, prefix: spec.kind, repo: spec.repo },
    async (dir) => {
      // Clone (or resume) the checkout, fetch any read-only reference branches, and capture the
      // pre-run branch tip. See {@link prepareCodingCheckout} for the resume-safety invariants.
      const { resumed, baseSha } = await prepareCodingCheckout(dir, spec, logger, opts)

      // The work-branch push machinery: one coalesced in-flight push plus the periodic
      // checkpoint that keeps mid-run commits durable across an eviction. Lifted into
      // {@link createWorkBranchPusher} so this callback stays within the per-function line budget;
      // the invariants it upholds are documented there.
      const { pushWorkOnce, inFlightPush, checkpoint } = createWorkBranchPusher({
        dir,
        spec,
        baseSha,
        logger,
        signal,
      })

      // In a monorepo the service lives in a subdirectory: run Pi with its cwd set to
      // that subtree (git stays rooted at `dir` so commits/pushes still cover the whole
      // checkout). Created if missing so a coder scaffolding a brand-new service into an
      // existing monorepo has a cwd to start in. The agent is also TOLD it's in a
      // monorepo (and where) via the AGENTS.md context below.
      const serviceDirectory = spec.repo.serviceDirectory
      const workDir = serviceDirectory ? join(dir, serviceDirectory) : dir
      if (serviceDirectory) await mkdir(workDir, { recursive: true })

      // The harness's own side-channel files in this checkout: excluded from git so the agent's
      // `git add` can never stage one into the PR, and the follow-up one tailed while the agent
      // works. See {@link armCheckoutSentinels}.
      const { followUpTailer, followUpTick } = await armCheckoutSentinels({
        dir,
        workDir,
        spec,
        logger,
        opts,
      })

      // DEPENDENCY PREPOPULATION: install the service's dependencies into the checkout BEFORE the
      // agent's first turn, so it reads real packages instead of inferring capabilities from a
      // manifest. Runs in `workDir` (a monorepo service installs from its own subtree, exactly
      // where its manifest and lockfile live), and its outcome is STATED to the agent either way —
      // a silent absence of dependencies reads to an agent as "this environment is offline".
      // Best-effort by construction: a failed install never fails the run. Keyed purely off the
      // job body (no agent-kind switch); absent ⇒ this is a no-op.
      const dependencyNote = await prepopulateDependencies({
        spec: spec.dependencyInstall,
        installDir: workDir,
        repoDir: dir,
        agentDir: workDir,
        logger,
        opts,
      })

      // THE REPO'S OWN PR TEMPLATE: when this dispatch opens a pull request and the repo ships a
      // template, the agent is asked to write its briefing AS that template rather than free-form
      // (see `pr-template.ts` for why neither host applies it to an API-created PR for us).
      // Discovered at the CHECKOUT ROOT, never `workDir`: a template is a fact about the
      // repository, so a monorepo service dispatch reads the same one as any other.
      const prTemplate = await resolvePrTemplateNote({
        targets: spec.opensPr
          ? [{ repoDir: dir, ...(spec.repo.provider ? { provider: spec.repo.provider } : {}) }]
          : [],
        logger,
      })

      // One agent pass over this checkout, parameterised only by the prompt — so the pre-PR
      // validation loop below can re-run the agent with a repair instruction without
      // re-deriving (or drifting from) the dispatch's own settings.
      //
      // The dependency note rides EVERY pass, not just the first: a repair round starts a fresh
      // agent, and one that is not told the tree is already installed spends the round it was
      // given to fix something reinstalling it instead. The PR-template note rides every pass for
      // the mirror-image reason: a repair-round agent still carries the description guidance, so
      // one that is not told about the template would replace the filled template with a
      // free-form briefing.
      const runAgentPass = (
        userPrompt: string,
      ): Promise<Awaited<ReturnType<typeof runAgentInWorkspace>>> =>
        runAgentInWorkspace(
          {
            dir: workDir,
            systemPrompt: spec.systemPrompt,
            userPrompt: withDependencyNote(
              withPrTemplateNote(userPrompt, prTemplate.note),
              dependencyNote,
            ),
            model: spec.model,
            harness: spec.harness,
            subscriptionToken: spec.subscriptionToken,
            subscriptionBaseUrl: spec.subscriptionBaseUrl,
            ambientAuth: spec.ambientAuth,
            proxyBaseUrl: spec.proxyBaseUrl,
            proxyPhasePath: spec.proxyPhasePath,
            sessionToken: spec.sessionToken,
            serviceDirectory,
            webToolsGuidance: spec.webToolsGuidance,
            webSearchProxy: spec.webSearchProxy,
            guardLimits: spec.guardLimits,
            // Materialised into `.cat-context/` and enumerated in the agent's AGENTS.md block.
            ...(spec.contextFiles?.length ? { contextFiles: spec.contextFiles } : {}),
            ...(spec.skills?.length ? { skills: spec.skills } : {}),
            ...(spec.mcpServers?.length ? { mcpServers: spec.mcpServers } : {}),
            ...(spec.referenceScreenshots
              ? { referenceScreenshots: spec.referenceScreenshots }
              : {}),
            ...(spec.designImages ? { designImages: spec.designImages } : {}),
          },
          opts,
        )

      let outcome: CodingAgentOutcome
      try {
        opts.onPhase?.('agent')
        logger.info('coding-agent: running agent', { serviceDirectory })
        let agentRun = await runAgentPass(spec.userPrompt)
        const foldPass = (run: typeof agentRun): void => {
          agentRun = mergeAgentPasses(agentRun, run)
        }
        // The new files the agent left unadded, folded into either loop's repair prompt. Both
        // loops judge state the push will NOT carry unless it is committed — the checks run
        // against the working tree, the proof against committed trees — so an unadded file is
        // exactly the thing to name. A throw degrades to "no warning" inside each loop.
        const listUncommittedNewFiles = (): Promise<string[]> =>
          listUntrackedFiles(workDir, opts.signal)

        // BUGFIX REPRODUCTION PROOF: run the run's declared reproduction command against the
        // pre-fix tree and the tree the PR will open from, and record whether it was red then
        // green. Runs BEFORE the validation loop below, deliberately: validation is the GATE
        // ("only a green checkout opens a PR"), so it has to stay the last thing that touches the
        // tree — otherwise a reproduction repair round could leave the checkout red behind it and
        // the PR would open anyway. Keyed purely off the job body carrying a spec (no agent-kind
        // switch); absent ⇒ a no-op and the flow below is byte-for-byte what it was.
        const reproduction = spec.reproduction
        let reproductionReport: ReproductionReport | undefined
        if (reproduction && (await producedWork(dir, spec, baseSha, resumed, opts))) {
          opts.onPhase?.('reproduction')
          reproductionReport = await runReproductionLoop({
            dir,
            baseSha,
            // Re-read per attempt: a repair pass commits, so the final tree moves under the loop.
            // `producedWork` has already committed forgotten tracked edits, and each repair round
            // re-commits before the next read.
            resolveFinalSha: async () => {
              await commitTrackedEdits(dir, spec.commitMessage, signal)
              return headCommit(dir, signal)
            },
            ...(serviceDirectory ? { serviceDirectory } : {}),
            spec: reproduction,
            logger,
            opts,
            runAgentPass,
            onAgentPass: foldPass,
            listUncommittedNewFiles,
            // Only a RESUMED run can have a pre-fix tree that already carries work: a fresh run
            // branched off base, so `baseSha` IS base. Wiring the probe unconditionally would buy
            // an always-empty answer for the price of a fetch — and a fresh clone is shallow, so
            // it could not resolve a merge base to answer with anyway. Lazy inside the loop: it
            // only runs if a tree comes back green.
            ...(resumed
              ? {
                  listBaseTreeChanges: () =>
                    changedFilesSinceBase(
                      dir,
                      spec.repo.baseBranch,
                      spec.ghToken,
                      baseSha,
                      opts.signal,
                    ),
                }
              : {}),
          })
          opts.onPhase?.('agent')
        }
        // PRE-PR VALIDATION: run the service's configured checks against the checkout and, while
        // they fail and budget remains, hand the captured output back to the agent and run it
        // again. Sits BETWEEN the agent and the finalize/push/PR step so a red checkout never
        // reaches `openPullRequest` — the whole point of the feature. Keyed purely off the job
        // body carrying checks (no agent-kind switch); absent ⇒ this is a no-op and the flow
        // below is byte-for-byte what it was.
        const validationChecks = spec.validationChecks
        let validationReport: ValidationReport | undefined
        if (validationChecks && (await producedWork(dir, spec, baseSha, resumed, opts))) {
          validationReport = await runValidationLoop({
            workDir,
            spec: validationChecks,
            logger,
            opts,
            runAgentPass,
            onAgentPass: foldPass,
            // The checks run against the WORKING TREE, but only tracked edits are staged for the
            // push — so a repair round can go green on a new file the PR would never contain.
            // Name those files in the next repair prompt so the agent adds them.
            listUncommittedNewFiles,
          })
        }
        outcome = await finalizeCodingRun({
          validationReport,
          reproductionReport,
          dir,
          spec,
          logger,
          opts,
          baseSha,
          resumed,
          workDir,
          checkpoint,
          followUpTick,
          followUpTailer,
          pushWorkOnce,
          inFlightPush,
          agentRun,
          prTemplate,
        })
      } catch (error) {
        // The run was killed mid-flight: the progress guard tripped, a watchdog fired, or the
        // container is going away. Everything the agent had not committed dies with the checkout,
        // and on a greenfield task that is all of it. Salvage it onto the work branch and push,
        // so a retry resumes on top of the work instead of starting over.
        //
        // Best-effort and non-masking: the ORIGINAL failure is what the run reports, so a salvage
        // that itself fails may not replace it. What the salvage found is joined onto that
        // failure's message instead, because "the run was aborted" and "its work is on the branch,
        // reviewed by nobody" are one fact a person needs together.
        throw await withSalvagedWork(error, { dir, logger, pushWorkOnce, signal })
      } finally {
        // Safety net for the throw path (the happy path already cleared these above).
        clearInterval(checkpoint)
        if (followUpTick) clearInterval(followUpTick)
      }
      return outcome
    },
  )
}

/**
 * Prefix a run's summary with the salvage note, when there is one worth a human's attention.
 *
 * Only a refused or failed salvage earns one: those are the states where the agent produced work
 * that the push does NOT carry, and nothing else on a passing run would say so.
 */
function withSalvageNote(summary: string, salvage: SalvageReport): string {
  if (salvage.status !== 'refused' && salvage.status !== 'failed') return summary
  const note = describeSalvage(salvage)
  return note ? `${note}\n\n${summary}` : summary
}

/**
 * Salvage what an aborted run left uncommitted, push it, and return the error to rethrow with the
 * salvage stated on it.
 *
 * Returns rather than throws so the caller's `throw` stays visible at the call site, and so this
 * can never REPLACE the failure being reported: a salvage that throws is swallowed, because the
 * reason the run died is strictly more useful than the reason its rescue did.
 *
 * The push is what makes the salvage worth anything — the commit lives in a container that is
 * about to be reclaimed — and it is the same coalesced push the periodic checkpoint uses, so it
 * cannot race one still in flight.
 */
async function withSalvagedWork(
  error: unknown,
  args: {
    dir: string
    logger: Logger
    pushWorkOnce: () => Promise<void>
    signal?: AbortSignal
  },
): Promise<unknown> {
  const cause = error instanceof Error ? error.message : String(error)
  const note = await salvageUntrackedWork({
    dir: args.dir,
    occasion: { kind: 'aborted', cause },
    logger: args.logger,
    ...(args.signal ? { signal: args.signal } : {}),
  })
    .then(async (report) => {
      if (report.status === 'committed') await args.pushWorkOnce()
      return describeSalvage(report)
    })
    .catch((salvageError: unknown) => {
      args.logger.error('coding-agent: salvage of an aborted run failed', {
        reason: salvageError instanceof Error ? salvageError.message : String(salvageError),
      })
      return undefined
    })
  if (!note) return error
  if (error instanceof Error) {
    error.message = `${error.message} ${note}`
    return error
  }
  return new Error(`${cause} ${note}`)
}

/**
 * Clone (or RESUME an existing branch) into `dir`, fetch any read-only reference branches, and
 * capture the pre-run branch tip. Extracted from {@link runCodingAgent} so its body stays small;
 * returns `{ resumed, baseSha }` for the run to judge no-op vs work against.
 *
 * Resume an evicted earlier run when its work branch already exists on the remote: clone THAT
 * branch and continue on its commits, rather than branching off base and redoing everything. Only
 * the impl path (which creates a fresh `newBranch`) can resume; the ci-fix/conflict paths already
 * clone the PR branch.
 *
 * Resume safety relies on two invariants the dispatcher (worker) upholds, since the harness can't
 * see run/PR state from inside the container:
 *  - At most ONE active run per block at a time. The work branch is deterministic per block
 *    (`cat-factory/<blockId>`), so two concurrent runs would target the same branch; their pushes
 *    race. A plain (non-forced) push fails safely on a non-fast-forward rather than clobbering the
 *    other run's commits, so the worst case is one run failing — never lost work — but the
 *    dispatcher should not knowingly run two at once.
 *  - Re-dispatch only NON-terminal runs (failed / evicted / stale-running), whose branch is by
 *    definition unmerged. Resuming a branch whose PR already merged could re-introduce merged work;
 *    that is avoided two ways: the platform deletes the work branch when its PR merges
 *    (GitHubPullRequestMerger), so a re-run finds no branch and starts fresh, and a `done` block is
 *    never re-dispatched anyway.
 */
async function prepareCodingCheckout(
  dir: string,
  spec: CodingAgentSpec,
  logger: Logger,
  opts: RunOptions,
): Promise<{ resumed: boolean; baseSha: string }> {
  const { signal } = opts
  const resumed =
    spec.newBranch != null &&
    (await remoteBranchExists(spec.repo.cloneUrl, spec.newBranch, spec.ghToken, signal))
  opts.onPhase?.('clone')
  if (spec.persistentCheckout) {
    // Reused checkout: clean-sweep + fetch + switch branch in place. A resumed branch
    // (or a run without `newBranch`, working directly on `cloneBranch`) already exists
    // on the remote, so check it out directly; otherwise (re)create `newBranch` off the
    // base tip — the same resume-vs-fresh decision the clone paths below make.
    const targetBranch = spec.newBranch ?? spec.cloneBranch
    logger.info('coding-agent: preparing reused checkout', { branch: targetBranch, resumed })
    await prepareExistingCheckout({
      dir,
      repo: spec.repo,
      ghToken: spec.ghToken,
      branch: targetBranch,
      baseBranch: spec.cloneBranch,
      existing: resumed || spec.newBranch == null,
      signal,
    })
  } else if (resumed) {
    logger.info('coding-agent: resuming existing branch', { branch: spec.newBranch })
    await cloneExistingBranch({
      cloneUrl: spec.repo.cloneUrl,
      branch: spec.newBranch!,
      ghToken: spec.ghToken,
      dir,
      signal,
    })
  } else {
    logger.info('coding-agent: cloning', { cloneBranch: spec.cloneBranch })
    await cloneRepo({
      repo: { ...spec.repo, baseBranch: spec.cloneBranch },
      ghToken: spec.ghToken,
      dir,
      signal,
    })
    if (spec.newBranch) await createBranch(dir, spec.newBranch, signal)
  }

  // Fetch any read-only reference branches into their `origin/<b>` refs so the agent can
  // inspect them (log/diff/show) without git network credentials of its own. Best-effort per
  // branch: a vanished branch is warned + skipped, never fatal. The work branch above is the
  // agent's HEAD; these are only readable siblings it never commits to.
  if (spec.referenceBranches?.length) {
    const fetched = await fetchReferenceBranches({
      dir,
      branches: spec.referenceBranches,
      ghToken: spec.ghToken,
      signal,
      onSkip: (branch, reason) =>
        logger.warn('coding-agent: reference branch fetch skipped', { branch, reason }),
    })
    logger.info('coding-agent: fetched reference branches', {
      requested: spec.referenceBranches.length,
      fetched: fetched.length,
    })
  }

  // The branch tip before the agent runs this time. A FRESH run produced work iff
  // the branch advances past it; a RESUMED run already carries prior work, so it is
  // never a no-op regardless of what this pass adds. Captured BEFORE the resume base
  // refresh below so that refresh's merge commit counts as advancement and is pushed.
  const baseSha = await headCommit(dir, signal)

  // A resumed branch was cut from an OLDER base; merge the latest base in when the
  // two merge cleanly, so the agent works against current base and the PR stays
  // current. On a conflict this is a no-op (the run continues on the stale base — the
  // merge gate handles a conflicting PR downstream, as before), so it never blocks a
  // resume. Best-effort: any error is treated as "continue without refreshing".
  if (resumed) {
    const refreshed = await refreshFromBaseIfClean(
      dir,
      spec.cloneBranch,
      spec.ghToken,
      signal,
    ).catch(() => false)
    if (!refreshed) {
      logger.info('coding-agent: resume base refresh skipped (conflict or error)', {
        base: spec.cloneBranch,
      })
    }
  }

  return { resumed, baseSha }
}

/**
 * Finalize a coding run after the agent has finished: flush the follow-up tailer, safety-net commit
 * forgotten tracked edits, settle any in-flight checkpoint push, decide whether the branch carries
 * work, push it iff so, and (for a Ralph run) attach the validation verdict. Extracted from
 * {@link runCodingAgent} so its body stays small; returns the built {@link CodingAgentOutcome}.
 */
async function finalizeCodingRun(args: {
  /** The pre-PR validation loop's last attempt, attached to the outcome (absent when unconfigured). */
  validationReport?: ValidationReport
  /** The reproduction proof's last attempt, attached to the outcome (absent when unconfigured). */
  reproductionReport?: ReproductionReport
  dir: string
  spec: CodingAgentSpec
  logger: Logger
  opts: RunOptions
  baseSha: string
  resumed: boolean
  workDir: string
  checkpoint: ReturnType<typeof setInterval>
  followUpTick: ReturnType<typeof setInterval> | undefined
  followUpTailer: FollowUpTailer | undefined
  pushWorkOnce: () => Promise<void>
  inFlightPush: () => Promise<void> | null
  agentRun: Awaited<ReturnType<typeof runAgentInWorkspace>>
  /** The repo's PR template, if it ships one — see the `titleFromHeading` read below. */
  prTemplate: PrTemplateResolution
}): Promise<CodingAgentOutcome> {
  const {
    validationReport,
    reproductionReport,
    dir,
    spec,
    logger,
    opts,
    baseSha,
    resumed,
    workDir,
    checkpoint,
    followUpTick,
    followUpTailer,
    pushWorkOnce,
    inFlightPush,
    agentRun,
    prTemplate,
  } = args
  const { signal } = opts
  const { stats, stderrTail, usage, callMetrics, effortReport } = agentRun
  let outcome: CodingAgentOutcome

  // Stop tailing the follow-up sentinel and flush any items written after the last
  // tick, so a fast final burst still reaches the job view before the run is recorded.
  if (followUpTick) clearInterval(followUpTick)
  if (followUpTailer) await followUpTailer.poll().catch(() => {})

  // Safety net for forgotten edits: commit changes to TRACKED files only (never
  // untracked scratch files/artifacts — the agent owns committing new files).
  await commitTrackedEdits(dir, spec.commitMessage, signal)

  // The agent-authored PR description, read AFTER the validation loop (a repair round may have
  // changed what the briefing should say) and removed so it never lingers in the checkout. The
  // prompt asks for it at the top level of the checkout; a monorepo agent working in a service
  // subdirectory may drop it in its cwd instead, so probe the checkout root first, then the cwd.
  //
  // When the repo ships a template the briefing IS that template filled in, so its headings are
  // the REPO's: a leading `# …` there is the template's own top heading, not the title line the
  // description guidance asks a free-form briefing for, and lifting it would retitle the PR after
  // the template and delete the heading from the body.
  const readDescription = (from: string): Promise<AgentPrDescription | undefined> =>
    readPrDescription(from, { titleFromHeading: !prTemplate.templated.has(dir) })
  const prDescription =
    (await readDescription(dir)) ?? (workDir !== dir ? await readDescription(workDir) : undefined)

  // Stop periodic checkpoints and let any in-flight one settle BEFORE the final
  // push, so the two never run a concurrent `git push` to the same branch (the
  // final push below is then a fresh attempt whose failure is the real signal).
  clearInterval(checkpoint)
  const inflight = inFlightPush()
  if (inflight) await inflight.catch(() => {})

  // Recover the untracked, non-ignored files the agent left behind. `commitTrackedEdits` above
  // only captures edits to ALREADY tracked files, so a NEW file the agent created and forgot to
  // commit used to be listed, warned about and dropped — and on a greenfield task EVERY file is
  // new, which made that warning the whole deliverable going in the bin. Observable is not
  // recovered, so commit them. Guardrails (a dependency/build deny-list, a file-count and byte
  // bound, an all-or-nothing refusal over it) live in `salvage.ts`; this path is coding mode by
  // construction, which is the other rule it must obey.
  const salvage = await salvageUntrackedWork({
    dir,
    occasion: { kind: 'settled' },
    logger,
    ...(signal ? { signal } : {}),
  })
  // A salvage that COMMITTED needs no announcement: its files are in the push and its commit
  // message says where they came from. A refused or failed one means work the agent produced is
  // NOT in the pull request, on a run that otherwise reads as a clean pass — so say it in the
  // summary, which is the harness's own account of the run and already reaches the step a human
  // reads. The agent's text follows it, unchanged.
  const summary = withSalvageNote(agentRun.summary, salvage)

  // A fresh run produced work iff the branch advanced past its pre-run tip. A RESUMED
  // run already carries prior work — UNLESS that branch turns out to have nothing ahead
  // of the PR base (e.g. its earlier PR was merged with a merge commit, leaving the
  // branch reachable from base and its best-effort delete skipped). Opening a PR for such
  // a branch fails with GitHub's opaque 422 "No commits between ...", so a CONFIRMED-empty
  // resumed branch is a no-op, not work. `undefined` (couldn't determine) keeps the prior
  // resume-is-work behaviour; the PR-open path then no-ops on the 422 as a backstop.
  const advancedThisPass = await branchHasCommitsSince(dir, baseSha, signal)
  let hasWork = advancedThisPass || resumed
  if (resumed && !advancedThisPass) {
    const ahead = await branchAheadOfBase(dir, spec.repo.baseBranch, spec.ghToken, signal)
    if (ahead === false) {
      logger.info('coding-agent: resumed branch has no commits ahead of base — no-op', {
        base: spec.repo.baseBranch,
      })
      hasWork = false
    }
  }
  if (!hasWork) {
    logger.info('coding-agent: no changes produced', { ...stats })
    outcome = {
      pushed: false,
      resumed,
      summary,
      stats,
      ...(stderrTail ? { stderrTail } : {}),
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
      ...(effortReport ? { effortReport } : {}),
      ...(salvage.status === 'none' ? {} : { salvage }),
    }
  } else {
    opts.onPhase?.('push')
    logger.info('coding-agent: pushing', { resumed, ...stats })
    await pushWorkOnce()
    outcome = {
      pushed: true,
      resumed,
      summary,
      stats,
      ...(stderrTail ? { stderrTail } : {}),
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
      ...(effortReport ? { effortReport } : {}),
      ...(prDescription ? { prDescription } : {}),
      ...(salvage.status === 'none' ? {} : { salvage }),
    }
  }

  // Ralph loop: run the programmatic completion command against the pushed/committed
  // state and attach its verdict (exit code = the loop's authoritative done signal).
  // Runs regardless of whether this pass pushed — a no-op iteration must still be able
  // to report that the criterion is (already) met. The harness runs it, never the model.
  if (spec.validation) {
    outcome.validation = await runRalphValidation(dir, workDir, spec.validation, logger, opts)
  }
  // Pre-PR validation: the loop already ran (before this finalize, so a red checkout never
  // reaches the PR-opening caller); attach its verdict for the caller to gate on and for the
  // backend to record on the step.
  if (validationReport) outcome.validationReport = validationReport
  // The reproduction proof: attached to EVERY outcome, including a no-op or an `inconclusive`
  // verdict. It is evidence about the change, not a gate on it — see the loop's D6 note.
  if (reproductionReport) outcome.reproductionReport = reproductionReport
  return outcome
}

/**
 * Whether this pass produced anything worth VALIDATING — i.e. the branch advanced past its
 * pre-run tip (or the run resumed an earlier one's pushed work). Gates the pre-PR validation
 * loop, for two reasons: a run that changed nothing has nothing to check, and its real failure
 * is "the agent produced no file changes" — reporting a red BASE branch instead would blame the
 * run for a pre-existing condition it never touched (and burn the whole repair budget re-running
 * an agent that already declined to act).
 *
 * Commits forgotten edits to tracked files first, exactly as {@link finalizeCodingRun} does, so
 * an agent that edited-but-didn't-commit still counts as work. That call is idempotent, so
 * finalize repeating it later is a no-op. Uncommitted NEW files are invisible here — but they
 * are equally invisible to finalize, so a run whose only product is an uncommitted new file is
 * a no-op on both paths, and the checks would have nothing to gate anyway.
 */
async function producedWork(
  dir: string,
  spec: CodingAgentSpec,
  baseSha: string,
  resumed: boolean,
  opts: RunOptions,
): Promise<boolean> {
  await commitTrackedEdits(dir, spec.commitMessage, opts.signal)
  return resumed || (await branchHasCommitsSince(dir, baseSha, opts.signal))
}

/**
 * Fold a pre-PR validation REPAIR pass's run into the accumulated agent outcome, so a looped run
 * reports what every round actually spent rather than only the first. Counts and telemetry are
 * summed/concatenated; the single-valued fields (the summary the backend renders, the effort
 * report, the diagnostics that judge the FINAL answer) take the LATEST pass, which is the one
 * whose state the PR is opened from.
 */
function mergeAgentPasses<T extends Awaited<ReturnType<typeof runAgentInWorkspace>>>(
  previous: T,
  next: T,
): T {
  return {
    ...next,
    stats: {
      toolCalls: (previous.stats?.toolCalls ?? 0) + (next.stats?.toolCalls ?? 0),
      assistantChars: (previous.stats?.assistantChars ?? 0) + (next.stats?.assistantChars ?? 0),
    },
    ...(previous.usage || next.usage
      ? {
          usage: {
            inputTokens: (previous.usage?.inputTokens ?? 0) + (next.usage?.inputTokens ?? 0),
            outputTokens: (previous.usage?.outputTokens ?? 0) + (next.usage?.outputTokens ?? 0),
          },
        }
      : {}),
    ...(previous.callMetrics || next.callMetrics
      ? { callMetrics: [...(previous.callMetrics ?? []), ...(next.callMetrics ?? [])] }
      : {}),
    // The repair pass's own effort report wins when it wrote one; otherwise keep the first
    // pass's rather than losing the assessment entirely.
    ...((next.effortReport ?? previous.effortReport)
      ? { effortReport: next.effortReport ?? previous.effortReport }
      : {}),
  }
}

/**
 * The Ralph-loop validation watchdog: the longest a completion command may run before it is
 * killed and treated as a failure (a hung `pnpm test` must never block the loop forever).
 * Overridable via env for tests; defaults to 15 minutes.
 */
export function ralphValidationTimeoutMs(): number {
  const n = Number(process.env.RALPH_VALIDATION_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15 * 60_000
}

/**
 * How often the Ralph validation feeds the run's inactivity watchdog while its command runs.
 * The command is exactly the activity-SILENT kind — a full `pnpm test`, a cold install-then-build
 * — and the harness spawns it ITSELF rather than through the agent, so it emits no activity
 * events of its own. `JOB_INACTIVITY_MS` (default 10 min) is TIGHTER than the command's own
 * watchdog ({@link ralphValidationTimeoutMs}, default 15 min), so without this heartbeat any
 * validation running past 10 minutes aborted the whole iteration as "inactivity" — mislabelling
 * a healthy test suite as a wedge, and making the 15-minute watchdog unreachable at stock
 * settings. The two sibling harness-run phases (pre-PR validation, reproduction proof) have
 * always fed it; this one did not. Overridable via env for tests.
 */
export function ralphHeartbeatMs(): number {
  const n = Number(process.env.RALPH_VALIDATION_HEARTBEAT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30_000
}

/**
 * Bound on the validation output tail that crosses the wire. Deliberately smaller than
 * `MAX_CAPTURED_OUTPUT_CHARS` (`redact.ts`) and equal to the two sibling phases' budgets, for
 * the same reason: this tail is persisted on the step (and on EVERY iteration of the attempt
 * log) inside the run's `detail` JSON blob, which is re-serialized on every step-progress write.
 */
export const RALPH_VALIDATION_TAIL_CHARS = 4_000

/**
 * Ralph loop: run the programmatic completion command in the checkout and return its exit
 * code, a bounded + redacted tail of its output, and the work branch's HEAD it ran against.
 * The EXIT CODE is the loop's authoritative done signal (0 = the criterion is met) — computed
 * here by the harness, never self-reported by the model, which is the whole point of a
 * programmatic exit condition. The command runs INSIDE the sandboxed run container (the same
 * trust boundary as the coding agent) — there is no host/backend execution.
 *
 * The spawn itself goes through {@link runCapturedCommand}, the ONE seam for a harness-run
 * command, rather than the near-verbatim copy this used to be. That copy had drifted in two
 * ways the seam exists to prevent: it scrubbed secrets AFTER the rolling truncation with no
 * margin (so a credential straddling the cut lost its `KEY=` prefix and survived redaction as
 * an unrecognised partial, on a tail that reaches the step, the notification and the SPA), and
 * it published the full 16k capture where both siblings deliberately bound the wire tail.
 *
 * `headSha` is what lets the engine tell a loop that is iterating from one that is merely
 * repeating: two consecutive failing iterations against an unchanged head means the agent
 * committed nothing, and the loop is ended early instead of spending the rest of its budget.
 * Best-effort — a head that cannot be read is simply omitted, and the engine's check fails open.
 */
export async function runRalphValidation(
  repoDir: string,
  cwd: string,
  validation: { command: string; iteration?: number },
  logger: Logger,
  opts: RunOptions,
): Promise<{
  validationPassed: boolean
  exitCode: number
  validationOutputTail?: string
  iteration?: number
  headSha?: string
}> {
  logger.info('coding-agent(ralph): running validation command', {
    iteration: validation.iteration,
  })
  // Keep the run's inactivity watchdog fed for the whole command — see `ralphHeartbeatMs`.
  const heartbeat = setInterval(() => opts.onActivity?.(), ralphHeartbeatMs())
  heartbeat.unref?.()
  let captured
  try {
    captured = await runCapturedCommand({
      cwd,
      command: validation.command,
      timeoutMs: ralphValidationTimeoutMs(),
      reportTailChars: RALPH_VALIDATION_TAIL_CHARS,
      logLabel: 'coding-agent(ralph): validation',
      logFields: { iteration: validation.iteration },
      logger,
      opts,
    })
  } finally {
    clearInterval(heartbeat)
  }
  // The commit the criterion was judged against. Read AFTER the command so a validation that
  // itself commits (a formatter check that rewrites files, say) is attributed to what it left.
  // Best-effort: an unreadable head only costs the engine's no-progress guard, never the
  // verdict — but it is REPORTED, or a guard that quietly stopped firing leaves no trace.
  const headSha = await headCommit(repoDir, opts.signal).catch((err: unknown) => {
    logger.warn('coding-agent(ralph): could not read the work-branch head', {
      error: err instanceof Error ? err.message : String(err),
    })
    return ''
  })
  logger.info('coding-agent(ralph): validation finished', {
    exitCode: captured.exitCode,
    iteration: validation.iteration,
  })
  return {
    validationPassed: captured.passed,
    exitCode: captured.exitCode,
    ...(captured.outputTail ? { validationOutputTail: captured.outputTail } : {}),
    ...(validation.iteration !== undefined ? { iteration: validation.iteration } : {}),
    ...(headSha ? { headSha } : {}),
  }
}

/**
 * The "no changes" reason both coding agents report: a caller-supplied lead phrase
 * plus the shared "never acted" cause and a credential-scrubbed tail of Pi's stderr.
 */
export function noChangesReason(
  lead: string,
  stats: PiRunStats,
  stderrTail: string | undefined,
): string {
  const cause = agentNeverActed(stats)
    ? ' (the agent never acted — it most likely could not reach the model)'
    : ''
  return `${lead}${cause}.${agentOutputTail(stderrTail)}`
}
