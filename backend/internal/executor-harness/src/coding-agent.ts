import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { killChildProcess, spawnDetached } from './process.js'
import { MAX_CAPTURED_OUTPUT_CHARS, redactSecrets } from './redact.js'
import type {
  AgentJob,
  AgentResult,
  HarnessAuthFields,
  PeerRepoSpec,
  ReferenceRepoSpec,
  RepoSpec,
  SkillSpec,
} from './job.js'
import {
  branchAheadOfBase,
  branchHasCommitsSince,
  cloneExistingBranch,
  cloneRepo,
  commitTrackedEdits,
  createBranch,
  excludeFromGit,
  fetchReferenceBranches,
  headCommit,
  listUntrackedFiles,
  openPullRequest,
  prepareExistingCheckout,
  pushBranch,
  refreshFromBaseIfClean,
  remoteBranchExists,
} from './git.js'
import { FOLLOW_UPS_FILENAME, FollowUpTailer } from './follow-ups.js'
import type { HarnessCallMetric, PiRunStats } from './pi.js'
import {
  acquireRepoCheckout,
  agentNeverActed,
  agentOutputTail,
  runAgentInWorkspace,
  withWorkspace,
} from './pi-workspace.js'
import type { ProgressGuardLimits } from './pi.js'
import type { RunOptions } from './runner.js'
import { log, type Logger } from './logger.js'

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
   * A repo-sourced Claude Skill to make available for this run (a `skill` step, slice 2). Threaded
   * into {@link runAgentInWorkspace}, which installs it harness-aware (native `~/.claude/skills`
   * for claude-code, `.cat-context/skill/` for Pi/codex). Absent ⇒ no skill.
   */
  skill?: SkillSpec
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
  }
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

      // Serialize all pushes to the work branch through a single in-flight promise.
      // A checkpoint tick and the final push (or two slow checkpoint ticks) must never
      // run `git push` to the same branch concurrently: overlapping pushes race on the
      // remote ref and can make a push fail with a ref-lock / non-fast-forward error —
      // which, on the FINAL push, would fail the whole run even though the work is
      // committed. `pushWorkOnce` coalesces concurrent callers onto one push and only
      // pushes once the branch has advanced past `baseSha` (see below).
      //
      // Only push once the branch has advanced past its pre-run tip: pushing while it
      // still sits at `baseSha` would create the work branch at the base commit (a
      // zero-diff branch), which a later retry would see via `remoteBranchExists` and
      // treat as resumable work — then fail to open a PR ("no commits between base and
      // head"). So a run that never commits leaves NO branch behind, preserving the
      // clean no-op outcome.
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

      // In a monorepo the service lives in a subdirectory: run Pi with its cwd set to
      // that subtree (git stays rooted at `dir` so commits/pushes still cover the whole
      // checkout). Created if missing so a coder scaffolding a brand-new service into an
      // existing monorepo has a cwd to start in. The agent is also TOLD it's in a
      // monorepo (and where) via the AGENTS.md context below.
      const serviceDirectory = spec.repo.serviceDirectory
      const workDir = serviceDirectory ? join(dir, serviceDirectory) : dir
      if (serviceDirectory) await mkdir(workDir, { recursive: true })

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

      let outcome: CodingAgentOutcome
      try {
        opts.onPhase?.('agent')
        logger.info('coding-agent: running agent', { serviceDirectory })
        const agentRun = await runAgentInWorkspace(
          {
            dir: workDir,
            systemPrompt: spec.systemPrompt,
            userPrompt: spec.userPrompt,
            model: spec.model,
            harness: spec.harness,
            subscriptionToken: spec.subscriptionToken,
            subscriptionBaseUrl: spec.subscriptionBaseUrl,
            ambientAuth: spec.ambientAuth,
            proxyBaseUrl: spec.proxyBaseUrl,
            sessionToken: spec.sessionToken,
            serviceDirectory,
            webToolsGuidance: spec.webToolsGuidance,
            webSearchProxy: spec.webSearchProxy,
            guardLimits: spec.guardLimits,
            ...(spec.skill ? { skill: spec.skill } : {}),
          },
          opts,
        )
        outcome = await finalizeCodingRun({
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
}): Promise<CodingAgentOutcome> {
  const {
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
  } = args
  const { signal } = opts
  const { summary, stats, stderrTail, usage, callMetrics } = agentRun
  let outcome: CodingAgentOutcome

  // Stop tailing the follow-up sentinel and flush any items written after the last
  // tick, so a fast final burst still reaches the job view before the run is recorded.
  if (followUpTick) clearInterval(followUpTick)
  if (followUpTailer) await followUpTailer.poll().catch(() => {})

  // Safety net for forgotten edits: commit changes to TRACKED files only (never
  // untracked scratch files/artifacts — the agent owns committing new files).
  await commitTrackedEdits(dir, spec.commitMessage, signal)

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
    }
  }

  // Ralph loop: run the programmatic completion command against the pushed/committed
  // state and attach its verdict (exit code = the loop's authoritative done signal).
  // Runs regardless of whether this pass pushed — a no-op iteration must still be able
  // to report that the criterion is (already) met. The harness runs it, never the model.
  if (spec.validation) {
    outcome.validation = await runRalphValidation(workDir, spec.validation, logger, opts)
  }
  return outcome
}

/**
 * The Ralph-loop validation watchdog: the longest a completion command may run before it is
 * killed and treated as a failure (a hung `pnpm test` must never block the loop forever).
 * Overridable via env for tests; defaults to 15 minutes.
 */
function ralphValidationTimeoutMs(): number {
  const n = Number(process.env.RALPH_VALIDATION_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15 * 60_000
}

/**
 * Ralph loop: run the programmatic completion command in the checkout and return its exit
 * code plus a bounded, redacted tail of its output. The EXIT CODE is the loop's authoritative
 * done signal (0 = the criterion is met) — computed here by the harness, never self-reported
 * by the model, which is the whole point of a programmatic exit condition. Runs
 * `sh -c <command>` in `cwd`; a watchdog kills the whole process tree on timeout (a hung
 * command counts as a failure so the loop is never blocked), and an aborted run resolves to a
 * non-zero code too. The command runs INSIDE the sandboxed run container (the same trust
 * boundary as the coding agent) — there is no host/backend execution.
 */
async function runRalphValidation(
  cwd: string,
  validation: { command: string; iteration?: number },
  logger: Logger,
  opts: RunOptions,
): Promise<{
  validationPassed: boolean
  exitCode: number
  validationOutputTail?: string
  iteration?: number
}> {
  const timeoutMs = ralphValidationTimeoutMs()
  logger.info('coding-agent(ralph): running validation command', {
    iteration: validation.iteration,
  })
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn('sh', ['-c', validation.command], {
      cwd,
      detached: spawnDetached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Keep only the tail; guard against unbounded buffering on a chatty command.
    const capture = (chunk: Buffer): void => {
      out = (out + chunk.toString('utf8')).slice(-MAX_CAPTURED_OUTPUT_CHARS)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      const trimmed = out.trim()
      const tail = trimmed ? redactSecrets(trimmed) : undefined
      logger.info('coding-agent(ralph): validation finished', {
        exitCode,
        iteration: validation.iteration,
      })
      resolve({
        validationPassed: exitCode === 0,
        exitCode,
        ...(tail ? { validationOutputTail: tail } : {}),
        ...(validation.iteration !== undefined ? { iteration: validation.iteration } : {}),
      })
    }
    const timer = setTimeout(() => {
      logger.warn('coding-agent(ralph): validation command timed out', { timeoutMs })
      killChildProcess(child, undefined, logger)
      finish(124) // conventional timeout exit code (a non-zero fail)
    }, timeoutMs)
    timer.unref?.()
    const onAbort = (): void => {
      killChildProcess(child, undefined, logger)
      finish(130) // aborted (a non-zero fail)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      logger.warn('coding-agent(ralph): validation command failed to spawn', {
        error: err instanceof Error ? err.message : String(err),
      })
      finish(127) // spawn error / command not found (a non-zero fail)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
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
    ...peers.map(
      (peer): RepoLeg => ({
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
      }),
    ),
    // Read-only reference repos (doc-writer): cloned as siblings the agent reads but never writes.
    // `workBranch` is set to the base only to satisfy the type — a read-only leg never branches or
    // pushes (guarded by `readOnly` in both the clone and push phases below).
    ...references.map(
      (reference): RepoLeg => ({
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
      }),
    ),
  ]

  return withWorkspace('multi', async (root) => {
    // Clone (or resume) every sibling checkout under the workspace root and fetch the primary's
    // reference branches. Mutates each leg's `dir`/`resumed`/`baseSha` in place.
    await prepareMultiRepoCheckouts(root, legs, job, logger, opts)

    // Run the agent ONCE with its cwd at the workspace root, so it sees every sibling checkout
    // and can change them coherently. No monorepo/service-directory scoping — the multi-repo
    // note + the backend system-prompt section explain the layout.
    opts.onPhase?.('agent')
    logger.info('multi-repo: running agent', { repos: legs.map((l) => l.dirName) })
    const { summary, stats, stderrTail, usage, callMetrics } = await runAgentInWorkspace(
      {
        dir: root,
        systemPrompt: job.systemPrompt,
        userPrompt: job.userPrompt,
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        ambientAuth: job.ambientAuth,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        webToolsGuidance: job.webToolsGuidance,
        webSearchProxy: job.webSearch,
        guardLimits: job.guardLimits,
        ...(job.contextFiles ? { contextFiles: job.contextFiles } : {}),
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
        pr: leg.pr,
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
