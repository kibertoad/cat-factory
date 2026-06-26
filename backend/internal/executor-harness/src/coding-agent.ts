import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessAuthFields, RepoSpec } from './job.js'
import {
  branchHasCommitsSince,
  cloneExistingBranch,
  cloneRepo,
  commitTrackedEdits,
  createBranch,
  headCommit,
  listUntrackedFiles,
  prepareExistingCheckout,
  pushBranch,
  refreshFromBaseIfClean,
  remoteBranchExists,
} from './git.js'
import type { PiRunStats } from './pi.js'
import {
  acquireRepoCheckout,
  agentNeverActed,
  agentOutputTail,
  runAgentInWorkspace,
} from './pi-workspace.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

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
  /**
   * Reuse a stable per-repo checkout (clean-sweep + fetch + switch branch) instead of a
   * fresh clone into a throwaway temp dir. Set only by the local warm-pool transport
   * (its containers are reused across runs); absent everywhere else.
   */
  persistentCheckout?: boolean
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
  const trace = {
    jobId: spec.jobId,
    kind: spec.kind,
    repo: `${spec.repo.owner}/${spec.repo.name}`,
    branch: spec.pushBranch,
  }
  return acquireRepoCheckout(
    { persistent: spec.persistentCheckout === true, prefix: spec.kind, repo: spec.repo },
    async (dir) => {
      // Resume an evicted earlier run when its work branch already exists on the
      // remote: clone THAT branch and continue on its commits, rather than branching
      // off base and redoing everything. Only the impl path (which creates a fresh
      // `newBranch`) can resume; the ci-fix/conflict paths already clone the PR branch.
      //
      // Resume safety relies on two invariants the dispatcher (worker) upholds, since
      // the harness can't see run/PR state from inside the container:
      //  - At most ONE active run per block at a time. The work branch is deterministic
      //    per block (`cat-factory/<blockId>`), so two concurrent runs would target the
      //    same branch; their pushes race. A plain (non-forced) push fails safely on a
      //    non-fast-forward rather than clobbering the other run's commits, so the worst
      //    case is one run failing — never lost work — but the dispatcher should not
      //    knowingly run two at once.
      //  - Re-dispatch only NON-terminal runs (failed / evicted / stale-running), whose
      //    branch is by definition unmerged. Resuming a branch whose PR already merged
      //    could re-introduce merged work; that is avoided two ways: the platform deletes
      //    the work branch when its PR merges (GitHubPullRequestMerger), so a re-run finds
      //    no branch and starts fresh, and a `done` block is never re-dispatched anyway.
      const resumed =
        spec.newBranch != null &&
        (await remoteBranchExists(spec.repo.cloneUrl, spec.newBranch, spec.ghToken, signal))
      if (spec.persistentCheckout) {
        // Reused checkout: clean-sweep + fetch + switch branch in place. A resumed branch
        // (or a run without `newBranch`, working directly on `cloneBranch`) already exists
        // on the remote, so check it out directly; otherwise (re)create `newBranch` off the
        // base tip — the same resume-vs-fresh decision the clone paths below make.
        const targetBranch = spec.newBranch ?? spec.cloneBranch
        log.info('coding-agent: preparing reused checkout', {
          ...trace,
          branch: targetBranch,
          resumed,
        })
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
        log.info('coding-agent: resuming existing branch', { ...trace, branch: spec.newBranch })
        await cloneExistingBranch({
          cloneUrl: spec.repo.cloneUrl,
          branch: spec.newBranch!,
          ghToken: spec.ghToken,
          dir,
          signal,
        })
      } else {
        log.info('coding-agent: cloning', { ...trace, cloneBranch: spec.cloneBranch })
        await cloneRepo({
          repo: { ...spec.repo, baseBranch: spec.cloneBranch },
          ghToken: spec.ghToken,
          dir,
          signal,
        })
        if (spec.newBranch) await createBranch(dir, spec.newBranch, signal)
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
          log.info('coding-agent: resume base refresh skipped (conflict or error)', {
            ...trace,
            base: spec.cloneBranch,
          })
        }
      }

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
      const checkpoint = setInterval(() => {
        pushWorkOnce().catch((err) => {
          log.info('coding-agent: checkpoint push skipped', {
            ...trace,
            reason: err instanceof Error ? err.message : String(err),
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

      let outcome: CodingAgentOutcome
      try {
        log.info('coding-agent: running agent', { ...trace, serviceDirectory })
        const { summary, stats, stderrTail, usage } = await runAgentInWorkspace(
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
          },
          opts,
        )

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
          log.warn('coding-agent: uncommitted new files left behind (not pushed)', {
            ...trace,
            count: leftover.length,
            files: leftover.slice(0, 20),
          })
        }

        const hasWork = resumed || (await branchHasCommitsSince(dir, baseSha, signal))
        if (!hasWork) {
          log.info('coding-agent: no changes produced', { ...trace, ...stats })
          outcome = {
            pushed: false,
            resumed,
            summary,
            stats,
            ...(stderrTail ? { stderrTail } : {}),
            ...(usage ? { usage } : {}),
          }
        } else {
          log.info('coding-agent: pushing', { ...trace, resumed, ...stats })
          await pushWorkOnce()
          outcome = {
            pushed: true,
            resumed,
            summary,
            stats,
            ...(stderrTail ? { stderrTail } : {}),
            ...(usage ? { usage } : {}),
          }
        }
      } finally {
        // Safety net for the throw path (the happy path already cleared it above).
        clearInterval(checkpoint)
      }
      return outcome
    },
  )
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
