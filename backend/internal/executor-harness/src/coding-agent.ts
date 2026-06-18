import type { RepoSpec } from './job.js'
import {
  branchHasChanges,
  cloneRepo,
  commitAll,
  createBranch,
  headCommit,
  pushBranch,
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
  /** Whether the run produced any change and was therefore pushed (see branchHasChanges). */
  pushed: boolean
  summary: string
  stats: PiRunStats
  stderrTail?: string
}

/**
 * Clone → write context → run Pi → push the branch iff the run produced a real
 * change. A run is a no-op only when nothing at all changed across the WHOLE run:
 * the build/ci-fix roles commit their work themselves, so by the end the working
 * tree is often clean and a trailing {@link commitAll} would find nothing even
 * though the branch advanced — so the change is judged against the branch's pre-run
 * tip (counting the agent's own commits), not the commitAll result. Returns the
 * run's summary/stats and whether it pushed; callers decide what a no-op means and
 * what to do after a push (open a PR, or nothing).
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
    log.info('coding-agent: cloning', { ...trace, cloneBranch: spec.cloneBranch })
    await cloneRepo({
      repo: { ...spec.repo, baseBranch: spec.cloneBranch },
      ghToken: spec.ghToken,
      dir,
      signal,
    })
    if (spec.newBranch) await createBranch(dir, spec.newBranch, signal)
    // The branch tip before the agent runs — the run produced changes iff the
    // branch advances past it (counting the agent's own commits; see branchHasChanges).
    const baseSha = await headCommit(dir, signal)

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

    if (!(await branchHasChanges(dir, baseSha, signal))) {
      log.info('coding-agent: no changes produced', { ...trace, ...stats })
      return { pushed: false, summary, stats, ...(stderrTail ? { stderrTail } : {}) }
    }
    // Commit anything the agent left uncommitted (it may have committed some or
    // all of it itself); either way the branch now carries the change, so push it.
    await commitAll(dir, spec.commitMessage, signal)
    log.info('coding-agent: pushing', { ...trace, ...stats })
    await pushBranch(dir, spec.pushBranch, spec.ghToken, signal)
    return { pushed: true, summary, stats, ...(stderrTail ? { stderrTail } : {}) }
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
