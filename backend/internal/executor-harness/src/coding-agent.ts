import type { RepoSpec } from './job.js'
import {
  branchHasCommitsSince,
  cloneExistingBranch,
  cloneRepo,
  commitTrackedEdits,
  createBranch,
  headCommit,
  pushBranch,
  remoteBranchExists,
} from './git.js'
import type { PiRunStats } from './pi.js'
import {
  agentNeverActed,
  agentOutputTail,
  runAgentInWorkspace,
  withWorkspace,
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
export interface CodingAgentSpec {
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
  /** Composed role + best-practice fragments; written to AGENTS.md for Pi. */
  systemPrompt: string
  /** The concrete task prompt handed to Pi. */
  userPrompt: string
  model: string
  proxyBaseUrl: string
  sessionToken: string
  /** Commit message for any work the agent left uncommitted. */
  commitMessage: string
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
  return withWorkspace(spec.kind, async (dir) => {
    // Resume an evicted earlier run when its work branch already exists on the
    // remote: clone THAT branch and continue on its commits, rather than branching
    // off base and redoing everything. Only the impl path (which creates a fresh
    // `newBranch`) can resume; the ci-fix/conflict paths already clone the PR branch.
    const resumed =
      spec.newBranch != null &&
      (await remoteBranchExists(spec.repo.cloneUrl, spec.newBranch, spec.ghToken, signal))
    if (resumed) {
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
    // never a no-op regardless of what this pass adds.
    const baseSha = await headCommit(dir, signal)

    // Checkpoint the agent's committed work to the branch periodically so an eviction
    // mid-run doesn't lose it (a retry then resumes from the pushed commits). The
    // agent commits its own work; this only PUSHES already-committed commits, so it
    // never races the agent's staging. Best-effort: a failed checkpoint is skipped.
    const checkpoint = setInterval(() => {
      void pushBranch(dir, spec.pushBranch, spec.ghToken, signal).catch((err) => {
        log.info('coding-agent: checkpoint push skipped', {
          ...trace,
          reason: err instanceof Error ? err.message : String(err),
        })
      })
    }, checkpointIntervalMs())
    checkpoint.unref?.()

    let outcome: CodingAgentOutcome
    try {
      log.info('coding-agent: running agent', trace)
      const { summary, stats, stderrTail } = await runAgentInWorkspace(
        {
          dir,
          systemPrompt: spec.systemPrompt,
          userPrompt: spec.userPrompt,
          model: spec.model,
          proxyBaseUrl: spec.proxyBaseUrl,
          sessionToken: spec.sessionToken,
        },
        opts,
      )

      // Safety net for forgotten edits: commit changes to TRACKED files only (never
      // untracked scratch files/artifacts — the agent owns committing new files).
      await commitTrackedEdits(dir, spec.commitMessage, signal)

      const hasWork = resumed || (await branchHasCommitsSince(dir, baseSha, signal))
      if (!hasWork) {
        log.info('coding-agent: no changes produced', { ...trace, ...stats })
        outcome = { pushed: false, resumed, summary, stats, ...(stderrTail ? { stderrTail } : {}) }
      } else {
        log.info('coding-agent: pushing', { ...trace, resumed, ...stats })
        await pushBranch(dir, spec.pushBranch, spec.ghToken, signal)
        outcome = { pushed: true, resumed, summary, stats, ...(stderrTail ? { stderrTail } : {}) }
      }
    } finally {
      clearInterval(checkpoint)
    }
    return outcome
  })
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
