import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runCapturedCommand } from './captured-command.js'
import type {
  AgentJob,
  AgentResult,
  HarnessAuthFields,
  PeerRepoSpec,
  ReferenceRepoSpec,
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
} from './git.js'
import { openPullRequest } from './vcs-api.js'
import { FOLLOW_UPS_FILENAME, FollowUpTailer } from './follow-ups.js'
import type { HarnessCallMetric } from './pi.js'
import type { PiRunStats } from './pi-reduction.js'
import { EFFORT_REPORT_FILE, type EffortReport } from './effort.js'
import {
  type AgentPrDescription,
  applyPrDescription,
  PR_DESCRIPTION_FILE,
  readPrDescription,
} from './pr-description.js'
import {
  acquireRepoCheckout,
  agentNeverActed,
  agentOutputTail,
  runAgentInWorkspace,
  withWorkspace,
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

// The shared skeleton for the container coding agents that clone a repo, run Pi
// against it and push the result on a branch. The implementation (`/run`) and
// CI-fixer (`/ci-fix`) agents are conceptually the same job — only what they clone
// onto and what they do with the outcome differ — so they share this whole flow
// rather than each re-deriving (and separately bug-fixing) it. Built on the thinner
// {@link withWorkspace}/{@link runAgentInWorkspace} base shared with the non-pushing
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
   * The PR-opening caller folds it over the dispatch-time title/body via {@link applyPrDescription};
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
 * pushes once the branch has advanced past `baseSha`.
 *
 * Only push once the branch has advanced past its pre-run tip: pushing while it still sits at
 * `baseSha` would create the work branch at the base commit (a zero-diff branch), which a later
 * retry would see via `remoteBranchExists` and treat as resumable work — then fail to open a PR
 * ("no commits between base and head"). So a run that never commits leaves NO branch behind,
 * preserving the clean no-op outcome.
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
  const pushWorkOnce = (): Promise<void> => {
    if (pushInFlight) return pushInFlight
    pushInFlight = (async () => {
      if (!(await branchHasCommitsSince(dir, baseSha, signal))) return
      await pushBranch(dir, spec.pushBranch, spec.ghToken, signal)
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

      // Every container agent is asked to write its effort self-assessment to `.cat-effort.json`
      // in its cwd (the backend appends EFFORT_REPORT_GUIDANCE to every container prompt). Locally
      // exclude it from git — exactly like the follow-ups sentinel below — so the agent's own
      // `git add` can never stage it into the PR. `readEffortReport` also removes it after the run,
      // but that cannot un-stage a mid-run commit; the per-clone exclude is what prevents it. A bare
      // filename pattern matches the file in any subdirectory, so it covers a monorepo `workDir` too.
      await excludeFromGit(dir, EFFORT_REPORT_FILE, signal)
      // Same treatment for the agent-authored PR-description sentinel: excluded locally so the
      // agent's own `git add` can never stage the briefing into the PR it describes.
      await excludeFromGit(dir, PR_DESCRIPTION_FILE, signal)

      // Follow-up companion: tail the Coder's sentinel file and stream new items out on the
      // job view. Locally exclude it from git first so the agent's own `git add` can never
      // stage it and it never surfaces as an untracked leftover or in the PR. The sentinel
      // lives in the agent's working directory (its cwd), where the prompt tells it to write.
      const followUpTailer =
        spec.streamFollowUps && opts.onFollowUp
          ? new FollowUpTailer(join(workDir, FOLLOW_UPS_FILENAME), opts.onFollowUp, logger)
          : undefined
      let followUpTick: ReturnType<typeof setInterval> | undefined
      if (followUpTailer) {
        await excludeFromGit(dir, FOLLOW_UPS_FILENAME, signal)
        followUpTick = setInterval(() => {
          void followUpTailer.poll()
        }, followUpPollIntervalMs())
        followUpTick.unref?.()
      }

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
            ...(spec.skills?.length ? { skills: spec.skills } : {}),
            ...(spec.mcpServers?.length ? { mcpServers: spec.mcpServers } : {}),
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
  const { summary, stats, stderrTail, usage, callMetrics, effortReport } = agentRun
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

  // Surface (don't fail on) untracked, non-ignored files the agent left behind:
  // `commitTrackedEdits` only captures edits to ALREADY tracked files, so a NEW
  // file the agent created but forgot to commit is silently dropped. Logging it
  // makes that loss observable when a PR turns out to be missing a file.
  const leftover = await listUntrackedFiles(dir, signal)
  if (leftover.length > 0) {
    logger.warn('coding-agent: uncommitted new files left behind (not pushed)', {
      count: leftover.length,
      files: leftover.slice(0, 20),
    })
  }

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

/** Sanitise an owner/name into a safe single path segment for a sibling checkout directory. */
export function safeDirSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-') || '_'
}

/**
 * A sibling-directory allocator for a multi-repo run: returns the checkout directory name for a
 * repo under the workspace root. Deterministic (`owner__name`) and collision-free by construction
 * — the checkout set is deduped by `owner/name` upstream and GitHub owners contain no `_`, so the
 * `owner__name` join is unique per repo without a stateful collision dance. Kept as a factory so
 * the coding + read-only explore fan-outs share ONE scheme, and it MUST stay byte-identical to the
 * backend's `siblingCheckoutDir` / `renderMultiRepoWorkspaceSection` in `@cat-factory/server`
 * (jobBody.ts), which names this exact directory in the agent's prompt — the two are computed
 * independently, so a divergent rule would point the agent at a directory that does not exist.
 */
export function makeDirClaimer(): (repo: Pick<RepoSpec, 'name' | 'owner'>) => string {
  return (repo) => `${safeDirSegment(repo.owner)}__${safeDirSegment(repo.name)}`
}

/** One repository participating in a multi-repo run: where to clone it + what to do after. */
interface RepoLeg {
  repo: RepoSpec
  /** Sibling directory name under the workspace root. */
  dirName: string
  /** Absolute checkout directory (filled during the clone phase). */
  dir: string
  /** Branch to clone (the repo's base). */
  cloneBranch: string
  /** Branch to create off the clone and push the work to (the shared `cat-factory/<block>`). */
  workBranch: string
  ghToken: string
  pr?: { title: string; body: string }
  frameId?: string
  primary: boolean
  /**
   * A READ-ONLY reference checkout (doc-writer's `referenceRepos`): cloned at its base branch for
   * the agent to read, but NEVER given a work branch, committed, or pushed. Skipped entirely in the
   * push phase, so it is structurally impossible for the run to write to it. Absent ⇒ a writable leg.
   */
  readOnly?: boolean
  /** The branch tip before the run — work iff the branch advances past it. */
  baseSha: string
  /** Whether an existing remote work branch was resumed (already carries prior work). */
  resumed: boolean
}

/**
 * Multi-repo coding (service-connections phase 3): clone the primary repo AND every connected
 * peer repo as SIBLING checkouts under one workspace root, run the agent ONCE with its cwd at
 * that root (so it makes the cross-service change coherently across all of them), then commit +
 * push each repo that actually changed and open one PR per dirty repo. The task's own-service PR
 * is reported as `prUrl`/`branch`; the peer PRs as `peerPullRequests`.
 *
 * Deliberately simpler than the single-repo {@link runCodingAgent} for the first cut: NO mid-run
 * checkpoint pushes (an evicted multi-repo run re-clones on retry — the deterministic work branch
 * still lets it resume any commits it managed to push at the end), NO warm-pool persistent
 * checkout (always ephemeral), and NO follow-up sentinel streaming. It reuses the SAME dir-scoped
 * git helpers, so the per-repo clone/commit/push/PR mechanics match the single-repo path exactly.
 */
export async function runMultiRepoCoding(
  job: AgentJob,
  opts: RunOptions = {},
): Promise<AgentResult> {
  const logger = (opts.log ?? log).child({ kind: 'multi-repo', jobId: job.jobId })
  const peers: PeerRepoSpec[] = job.peerRepos ?? []
  const references: ReferenceRepoSpec[] = job.referenceRepos ?? []
  const primaryWorkBranch = job.pushBranch ?? job.newBranch ?? job.branch

  // Assign the sibling directory per repo via the shared deterministic allocator (`owner__name`,
  // matching the backend prompt's `siblingCheckoutDir`), shared with the read-only explore fan-out.
  const claimDir = makeDirClaimer()
  const legs: RepoLeg[] = [
    {
      repo: job.repo,
      dirName: claimDir(job.repo),
      dir: '',
      cloneBranch: job.branch,
      workBranch: primaryWorkBranch,
      ghToken: job.ghToken,
      ...(job.pr ? { pr: job.pr } : {}),
      primary: true,
      baseSha: '',
      resumed: false,
    },
    ...peers.map((peer): RepoLeg => ({
      repo: peer.repo,
      dirName: claimDir(peer.repo),
      dir: '',
      cloneBranch: peer.repo.baseBranch,
      // Coding peers always carry `newBranch` (the backend sets the shared work branch);
      // fall back to the primary's for the type (read-only peers never reach this path).
      workBranch: peer.newBranch ?? primaryWorkBranch,
      ghToken: peer.ghToken ?? job.ghToken,
      ...(peer.pr ? { pr: peer.pr } : {}),
      ...(peer.frameId ? { frameId: peer.frameId } : {}),
      primary: false,
      baseSha: '',
      resumed: false,
    })),
    // Read-only reference repos (doc-writer): cloned as siblings the agent reads but never writes.
    // `workBranch` is set to the base only to satisfy the type — a read-only leg never branches or
    // pushes (guarded by `readOnly` in both the clone and push phases below).
    ...references.map((reference): RepoLeg => ({
      repo: reference.repo,
      dirName: claimDir(reference.repo),
      dir: '',
      cloneBranch: reference.repo.baseBranch,
      workBranch: reference.repo.baseBranch,
      ghToken: reference.ghToken ?? job.ghToken,
      primary: false,
      readOnly: true,
      baseSha: '',
      resumed: false,
    })),
  ]

  return withWorkspace('multi', async (root) => {
    // Clone (or resume) every sibling checkout under the workspace root and fetch the primary's
    // reference branches. Mutates each leg's `dir`/`resumed`/`baseSha` in place.
    await prepareMultiRepoCheckouts(root, legs, job, logger, opts)

    // DEPENDENCY PREPOPULATION for the PRIMARY leg, exactly as the read-only multi-repo fan-out
    // does it. The install is declared on ONE service frame (the primary repo's), so it runs in
    // that leg's checkout and is never fanned out across peers, whose own frames declare configs
    // this dispatch never resolved — running a `pnpm install` inside a Go checkout is not a
    // degraded outcome, it is a wrong one. A cross-repo implementer needs its dependencies for
    // the same reason a cross-repo investigator does; the note names the sibling directory
    // because the agent itself stands at the workspace root.
    //
    // At the leg's checkout ROOT, not a `serviceDirectory` subtree: this layout applies no
    // service-directory scoping anywhere (the agent runs at the root and the prompt explains the
    // sibling checkouts), and a root install is the one that resolves a monorepo workspace whole.
    const primaryLeg = legs.find((leg) => leg.primary)
    const dependencyNote = primaryLeg
      ? await prepopulateDependencies({
          spec: job.dependencyInstall,
          installDir: primaryLeg.dir,
          repoDir: primaryLeg.dir,
          agentDir: root,
          logger,
          opts,
        })
      : undefined

    // THE REPOS' OWN PR TEMPLATES: one per leg that will actually open a pull request, each named
    // by its sibling directory so the agent knows which checkout's briefing takes which shape —
    // the repos in a workspace need not share a template, or ship one at all. A read-only
    // reference leg is excluded by construction: it carries no `pr`, so nothing publishes for it.
    const prTemplate = await resolvePrTemplateNote({
      targets: legs
        .filter((leg) => leg.pr)
        .map((leg) => ({
          repoDir: leg.dir,
          repoLabel: leg.dirName,
          ...(leg.repo.provider ? { provider: leg.repo.provider } : {}),
        })),
      logger,
    })

    // Run the agent ONCE with its cwd at the workspace root, so it sees every sibling checkout
    // and can change them coherently. No monorepo/service-directory scoping — the multi-repo
    // note + the backend system-prompt section explain the layout.
    opts.onPhase?.('agent')
    logger.info('multi-repo: running agent', { repos: legs.map((l) => l.dirName) })
    const { summary, stats, stderrTail, usage, callMetrics, effortReport } =
      await runAgentInWorkspace(
        {
          dir: root,
          systemPrompt: job.systemPrompt,
          userPrompt: withDependencyNote(
            withPrTemplateNote(job.userPrompt, prTemplate.note),
            dependencyNote,
          ),
          model: job.model,
          harness: job.harness,
          subscriptionToken: job.subscriptionToken,
          subscriptionBaseUrl: job.subscriptionBaseUrl,
          ambientAuth: job.ambientAuth,
          proxyBaseUrl: job.proxyBaseUrl,
          proxyPhasePath: job.proxyPhasePath,
          sessionToken: job.sessionToken,
          webToolsGuidance: job.webToolsGuidance,
          webSearchProxy: job.webSearch,
          guardLimits: job.guardLimits,
          ...(job.contextFiles ? { contextFiles: job.contextFiles } : {}),
          // Skills + tool servers apply to a multi-repo run exactly as to a single-repo one: they
          // are properties of the AGENT KIND, not of the checkout layout.
          ...(job.skills?.length ? { skills: job.skills } : {}),
          ...(job.mcpServers?.length ? { mcpServers: job.mcpServers } : {}),
          multiRepo: true,
        },
        opts,
      )

    // Commit forgotten tracked edits, then push + open a PR for each repo the run actually changed.
    const { primaryPushed, primaryPrUrl, peerPullRequests } = await pushMultiRepoLegs(
      legs,
      job,
      logger,
      opts,
      root,
      prTemplate,
    )

    const anyWork = primaryPushed || peerPullRequests.length > 0
    if (!anyWork) {
      // Nothing changed in ANY repo. For the implementer this is a failure (as in the
      // single-repo path); a caller that tolerates a no-op (never the implementer today)
      // gets a clean non-event.
      if (job.noChangesIsError === false) {
        return {
          pushed: false,
          branch: primaryWorkBranch,
          summary,
          stats,
          ...(usage ? { usage } : {}),
          ...(callMetrics ? { callMetrics } : {}),
          ...(effortReport ? { effortReport } : {}),
        }
      }
      return {
        pushed: false,
        branch: primaryWorkBranch,
        summary,
        stats,
        error: noChangesReason(
          'the agent produced no file changes in any repository',
          stats,
          stderrTail,
        ),
        failureCause: 'no-changes',
        ...(usage ? { usage } : {}),
        ...(callMetrics ? { callMetrics } : {}),
        ...(effortReport ? { effortReport } : {}),
      }
    }
    logger.info('multi-repo: complete', {
      primaryPushed,
      primaryPrUrl: primaryPrUrl ?? null,
      peers: peerPullRequests.length,
    })
    return {
      pushed: primaryPushed,
      ...(primaryPrUrl ? { prUrl: primaryPrUrl } : {}),
      branch: primaryWorkBranch,
      ...(peerPullRequests.length ? { peerPullRequests } : {}),
      summary,
      stats,
      ...(usage ? { usage } : {}),
      ...(callMetrics ? { callMetrics } : {}),
      ...(effortReport ? { effortReport } : {}),
    }
  })
}

/**
 * Clone phase for {@link runMultiRepoCoding}: every repo into its sibling dir under the workspace
 * root. Resume an existing remote work branch (an evicted retry) rather than branching off base
 * again, then fetch the primary repo's reference branches. Mutates each leg's `dir`/`resumed`/
 * `baseSha` in place. Extracted so the multi-repo body stays small.
 */
async function prepareMultiRepoCheckouts(
  root: string,
  legs: RepoLeg[],
  job: AgentJob,
  logger: Logger,
  opts: RunOptions,
): Promise<void> {
  const { signal } = opts
  opts.onPhase?.('clone')
  for (const leg of legs) {
    const dir = join(root, leg.dirName)
    await mkdir(dir, { recursive: true })
    // A read-only reference leg: clone its base branch for the agent to read, and stop there —
    // no work branch, no resume, no base-refresh. It is skipped in the push phase, so it can
    // never be written to. (Kept in the loop so it lands in the same workspace root as siblings.)
    if (leg.readOnly) {
      logger.info('multi-repo: cloning read-only reference', {
        repo: leg.dirName,
        cloneBranch: leg.cloneBranch,
      })
      await cloneRepo({
        repo: { ...leg.repo, baseBranch: leg.cloneBranch },
        ghToken: leg.ghToken,
        dir,
        signal,
      })
      leg.dir = dir
      continue
    }
    leg.resumed = await remoteBranchExists(leg.repo.cloneUrl, leg.workBranch, leg.ghToken, signal)
    if (leg.resumed) {
      logger.info('multi-repo: resuming existing branch', {
        repo: leg.dirName,
        branch: leg.workBranch,
      })
      await cloneExistingBranch({
        cloneUrl: leg.repo.cloneUrl,
        branch: leg.workBranch,
        ghToken: leg.ghToken,
        dir,
        signal,
      })
    } else {
      logger.info('multi-repo: cloning', { repo: leg.dirName, cloneBranch: leg.cloneBranch })
      await cloneRepo({
        repo: { ...leg.repo, baseBranch: leg.cloneBranch },
        ghToken: leg.ghToken,
        dir,
        signal,
      })
      await createBranch(dir, leg.workBranch, signal)
    }
    leg.dir = dir
    // Exclude the agent-authored PR-description sentinel locally (as the single-repo path does)
    // so the agent's own `git add` can never stage the briefing into the PR it describes.
    await excludeFromGit(dir, PR_DESCRIPTION_FILE, signal)
    // The branch tip before the agent runs. Captured BEFORE the resume base refresh below so
    // that refresh's merge commit counts as advancement and is pushed (as in the single-repo
    // path). A fresh leg produced work iff its branch advances past this; a resumed leg already
    // carries prior work.
    leg.baseSha = await headCommit(dir, signal)
    // A resumed branch was cut from an OLDER base; merge the latest base in when the two merge
    // cleanly so the agent works against current base and the peer/own PRs stay current. On a
    // conflict this is a best-effort no-op (the merge gate handles a conflicting PR downstream),
    // mirroring the single-repo {@link runCodingAgent} resume refresh.
    if (leg.resumed) {
      const refreshed = await refreshFromBaseIfClean(
        dir,
        leg.cloneBranch,
        leg.ghToken,
        signal,
      ).catch(() => false)
      if (!refreshed) {
        logger.info('multi-repo: resume base refresh skipped (conflict or error)', {
          repo: leg.dirName,
          base: leg.cloneBranch,
        })
      }
    }
  }

  // Reference branches attach to the PRIMARY repo, so fetch them into the primary sibling
  // checkout's `origin/<b>` refs (best-effort per branch). The backend's reference-branches
  // prompt section names the primary repo's directory to run the read commands in.
  if (job.referenceBranches?.length) {
    const primaryLeg = legs.find((l) => l.primary)
    if (primaryLeg?.dir) {
      const fetched = await fetchReferenceBranches({
        dir: primaryLeg.dir,
        branches: job.referenceBranches,
        ghToken: primaryLeg.ghToken,
        signal,
        onSkip: (branch, reason) =>
          logger.warn('multi-repo: reference branch fetch skipped', { branch, reason }),
      })
      logger.info('multi-repo: fetched reference branches', {
        requested: job.referenceBranches.length,
        fetched: fetched.length,
      })
    }
  }
}

/**
 * Push phase for {@link runMultiRepoCoding}: commit forgotten tracked edits, then push + open a PR
 * for each repo the run actually changed (a repo the agent left untouched is skipped — no branch,
 * no PR; a read-only reference leg is never committed or pushed). Extracted so the multi-repo body
 * stays small; returns the primary's push/PR state plus the peer PRs.
 */
async function pushMultiRepoLegs(
  legs: RepoLeg[],
  job: AgentJob,
  logger: Logger,
  opts: RunOptions,
  /** The workspace root the agent ran in — the fallback probe for the primary's briefing. */
  root: string,
  /** Which legs' briefings are filled templates — see the `titleFromHeading` read below. */
  prTemplate: PrTemplateResolution,
): Promise<{
  primaryPushed: boolean
  primaryPrUrl: string | undefined
  peerPullRequests: NonNullable<AgentResult['peerPullRequests']>
}> {
  const { signal } = opts
  opts.onPhase?.('push')
  let primaryPushed = false
  let primaryPrUrl: string | undefined
  const peerPullRequests: NonNullable<AgentResult['peerPullRequests']> = []
  for (const leg of legs) {
    // A read-only reference leg is never committed or pushed — the third layer of the read-only
    // guarantee (the spec carries no branch/PR, and the clone phase gave it no work branch).
    if (leg.readOnly) continue
    // Lift (and remove) the agent-authored PR description for THIS repo's PR before anything
    // else touches the checkout — each sibling checkout carries its own briefing for its own PR.
    // The agent's cwd here is the WORKSPACE ROOT rather than any one checkout, so an agent that
    // read the prompt loosely may well have written a single briefing there instead. Fall back
    // to it for the PRIMARY leg only: at the root there is nothing to say which repo it
    // describes, and the primary is the one the run is actually about.
    //
    // Per-leg `titleFromHeading`: only a leg whose OWN repo ships a template has repo-authored
    // headings in its sentinel, and the legs of a workspace need not agree about that — so this
    // is keyed on the leg, never on whether the run found any template at all.
    const readOptions = { titleFromHeading: !prTemplate.templated.has(leg.dir) }
    const agentPrDescription =
      (await readPrDescription(leg.dir, readOptions)) ??
      (leg.primary ? await readPrDescription(root, readOptions) : undefined)
    await commitTrackedEdits(leg.dir, job.commitMessage ?? leg.pr?.title ?? 'Agent changes', signal)
    const advanced = await branchHasCommitsSince(leg.dir, leg.baseSha, signal)
    let hasWork = advanced || leg.resumed
    if (leg.resumed && !advanced) {
      const ahead = await branchAheadOfBase(leg.dir, leg.repo.baseBranch, leg.ghToken, signal)
      if (ahead === false) hasWork = false
    }
    const leftover = await listUntrackedFiles(leg.dir, signal)
    if (leftover.length > 0) {
      logger.warn('multi-repo: uncommitted new files left behind (not pushed)', {
        repo: leg.dirName,
        count: leftover.length,
        files: leftover.slice(0, 20),
      })
    }
    if (!hasWork) {
      logger.info('multi-repo: no changes for repo', { repo: leg.dirName })
      continue
    }
    await pushBranch(leg.dir, leg.workBranch, leg.ghToken, signal)
    let prUrl: string | null = null
    if (leg.pr) {
      prUrl = await openPullRequest({
        owner: leg.repo.owner,
        name: leg.repo.name,
        ghToken: leg.ghToken,
        head: leg.workBranch,
        base: leg.repo.baseBranch,
        pr: applyPrDescription(leg.pr, agentPrDescription),
        // See the single-repo call site: refresh a resumed leg's already-open PR, but only
        // when the text is the agent's own briefing rather than the dispatch-time fallback.
        ...(agentPrDescription ? { refreshExisting: true } : {}),
        apiBase: job.githubApiBase,
        cloneUrl: leg.repo.cloneUrl,
        ...(leg.repo.provider ? { provider: leg.repo.provider } : {}),
        signal,
      })
    }
    if (leg.primary) {
      primaryPushed = true
      if (prUrl) primaryPrUrl = prUrl
    } else if (prUrl) {
      peerPullRequests.push({
        repo: `${leg.repo.owner}/${leg.repo.name}`,
        ...(leg.frameId ? { frameId: leg.frameId } : {}),
        prUrl,
        branch: leg.workBranch,
      })
    }
  }
  return { primaryPushed, primaryPrUrl, peerPullRequests }
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
