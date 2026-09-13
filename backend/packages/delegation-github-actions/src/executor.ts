import type {
  DelegatedExecutor,
  DelegatedExecutorDeps,
  DelegationBrief,
  DelegationHandle,
  DelegationResult,
  DelegationStart,
  DelegationUpdate,
} from '@cat-factory/kernel'
import { getErrorMessage } from '@cat-factory/kernel'
import { findRunByCorrelation, type ActionsRunSummary } from './correlation.js'
import { apiGet, apiPost } from './http.js'
import { pullRequestForBranch } from './result.js'

// ---------------------------------------------------------------------------
// A {@link DelegatedExecutor} over GITHUB ACTIONS.
//
// It ships in the platform because every GitHub-hosted company plugging its own implement /
// review / test loop into a cat-factory step hits the same three problems, and none of them is
// about that company's workflow:
//
//   1. `workflow_dispatch` returns 204 and no run id, so there is nothing to poll. Solved by the
//      brief's correlation key plus a `run-name` the caller workflow renders (see ./correlation).
//   2. The run's own conclusion vocabulary is not the platform's. Mapped here, once, including the
//      three conclusions that are neither success nor an ordinary failure.
//   3. A `workflow_dispatch` workflow declares no outputs, so what it PRODUCED has to be recovered
//      from the repository (see ./result).
//
// It names NO specific executor and holds no company's workflow knowledge: a deployment describes
// its own workflow and result reading, and the definition it registers is a few lines.
// ---------------------------------------------------------------------------

/** The Actions run fields this executor reads, re-exported for a deployment's `resultFrom`. */
export type GitHubActionsRunView = ActionsRunSummary

/**
 * How a deployment reads what its finished workflow produced.
 *
 * It is handed the HANDLE rather than the brief, and that is the honest shape: a poll can run hours
 * after the dispatch, in a different process, and the brief exists only at dispatch. What the
 * handle carries is what the platform persisted for exactly this purpose: the correlation key, the
 * external id and the branch pair.
 */
export type GitHubActionsResultReader = (input: {
  handle: DelegationHandle
  run: GitHubActionsRunView
  /** The token this call resolved, so a reader can make its own API calls with it. */
  token: string
  fetchImpl: DelegatedExecutorDeps['fetchImpl']
}) => Promise<DelegationResult>

/** What a deployment states about its own workflow. */
export interface GitHubActionsExecutorDescription {
  owner: string
  repo: string
  /** The workflow file name (`implement.yml`) or its numeric id, as the REST path takes it. */
  workflowFile: string
  /** The git ref the workflow is dispatched on (a branch that HOLDS the workflow, not the work). */
  ref: string
  /**
   * The `workflow_dispatch` inputs, built from the brief. The correlation input is added for you
   * under {@link CORRELATION_INPUT}. Supply it yourself only if your workflow names it something
   * else, in which case yours wins.
   *
   * Actions caps each input at 1 MiB and the whole set at ten entries, and it REJECTS the dispatch
   * rather than truncating: a deployment folding a large brief in has to decide what it sends,
   * which is why this is a function of the brief rather than a fixed mapping.
   */
  inputs: (brief: DelegationBrief) => Record<string, string>
  /**
   * What the finished run produced. Defaults to the open pull request whose head is the run's work
   * branch, which is what a workflow that pushed and opened one leaves behind.
   */
  resultFrom?: GitHubActionsResultReader
  /**
   * The credential key holding the token, as the executor's own `credentials` declaration names it.
   * Defaults to `GITHUB_TOKEN`.
   */
  tokenKey?: string
  /** The API base, for GitHub Enterprise. Defaults to `https://api.github.com`. */
  apiBase?: string
}

/** The `workflow_dispatch` input this helper adds, carrying the platform's correlation key. */
export const CORRELATION_INPUT = 'correlation'

const DEFAULT_API_BASE = 'https://api.github.com'

/**
 * Build a {@link DelegatedExecutor} for one GitHub Actions workflow.
 *
 * `start` is IDEMPOTENT per correlation key, which the port requires and which is not automatic
 * here: it looks for the run first and only dispatches when there is none. Without that, a replayed
 * dispatch queues a second workflow, and two workflows working the same branch open two pull
 * requests for one task: the single deadliest failure in this whole seam.
 */
export function githubActionsDelegatedExecutor(
  description: GitHubActionsExecutorDescription,
  deps: DelegatedExecutorDeps,
): DelegatedExecutor {
  const apiBase = description.apiBase ?? DEFAULT_API_BASE
  const tokenKey = description.tokenKey ?? 'GITHUB_TOKEN'
  const log = deps.logger.child({
    executor: 'github-actions',
    repo: `${description.owner}/${description.repo}`,
  })

  const tokenOf = (credentials: Record<string, string>): string => {
    const token = credentials[tokenKey]
    if (!token) {
      // Thrown rather than attempted: an unauthenticated call to a private repo answers 404, which
      // reads to an operator as "no such workflow" and sends them to look at the wrong thing.
      throw new Error(
        `No GitHub token resolved under "${tokenKey}". Declare it on the executor's ` +
          '`credentials` and make sure the workspace (or the deployment environment) holds a value.',
      )
    }
    return token
  }

  const locate = (correlationKey: string, token: string): Promise<GitHubActionsRunView | null> =>
    findRunByCorrelation(deps.fetchImpl, {
      apiBase,
      token,
      owner: description.owner,
      repo: description.repo,
      workflowFile: description.workflowFile,
      correlationKey,
    })

  return {
    async start(brief, credentials): Promise<DelegationStart> {
      const token = tokenOf(credentials)
      // IDEMPOTENCY, first. A replayed dispatch must find the run it already started rather than
      // queue another; the engine commits its claim before calling this, so a replay reaching here
      // at all means the previous attempt may have got as far as the dispatch.
      const existing = await locate(brief.correlationKey, token)
      if (existing) {
        log.info('re-attached to an existing workflow run', { runId: existing.id })
        return {
          externalId: String(existing.id),
          url: existing.html_url,
          note: 'Re-attached to the run this dispatch had already started.',
        }
      }
      await apiPost(deps.fetchImpl, {
        apiBase,
        token,
        path:
          `/repos/${description.owner}/${description.repo}/actions/workflows/` +
          `${encodeURIComponent(description.workflowFile)}/dispatches`,
        body: {
          ref: description.ref,
          inputs: { [CORRELATION_INPUT]: brief.correlationKey, ...description.inputs(brief) },
        },
      })
      // The dispatch answered 204 and the run does not exist yet. Look once (it usually does by
      // now) and, failing that, answer with the correlation key as the external id so the step is
      // recorded and the FIRST POLL recovers the real one. Refusing here instead would fail a step
      // whose workflow is queued and about to run.
      const started = await locate(brief.correlationKey, token)
      if (started) return { externalId: String(started.id), url: started.html_url }
      return {
        externalId: brief.correlationKey,
        note: 'Dispatched; the workflow run had not appeared yet, so it is correlated on the first poll.',
      }
    },

    async poll(handle, credentials): Promise<DelegationUpdate> {
      const token = tokenOf(credentials)
      const run = await resolveRun(handle, token)
      if (!run) {
        // The run has still not appeared. `running` rather than a failure: the poll budget is what
        // bounds this, and a workflow queued behind a busy runner pool is the ordinary case.
        return { state: 'running', phase: 'queued' }
      }
      if (run.status !== 'completed') {
        return { state: 'running', url: run.html_url, phase: run.status ?? 'in_progress' }
      }
      if (run.conclusion !== 'success') {
        return {
          state: 'failed',
          error: `The workflow run finished as "${run.conclusion ?? 'unknown'}".`,
          url: run.html_url,
          // The three conclusions a fresh attempt could plausibly survive, named rather than
          // treated as one failure class: everything else is a verdict the workflow itself
          // reached, and re-running it burns the budget to reach the same one.
          ...(run.conclusion === 'cancelled' ||
          run.conclusion === 'timed_out' ||
          run.conclusion === 'stale'
            ? { retryable: true }
            : {}),
        }
      }
      return { state: 'done', result: await readResult(handle, run, token) }
    },

    async cancel(handle, credentials): Promise<void> {
      const token = tokenOf(credentials)
      const run = await resolveRun(handle, token)
      // Nothing to cancel is a clean outcome, not a failure: the run may have finished between the
      // teardown deciding to stop it and this call.
      if (!run || run.status === 'completed') return
      await apiPost(deps.fetchImpl, {
        apiBase,
        token,
        path: `/repos/${description.owner}/${description.repo}/actions/runs/${run.id}/cancel`,
        body: {},
      })
    },
  }

  /**
   * The run this handle addresses: the recorded id when it is one, else a fresh correlation.
   *
   * The fallback is the `start` path above answering with the correlation key, which happens
   * whenever the dispatch's run had not appeared yet, so this is ordinary rather than exceptional.
   */
  async function resolveRun(
    handle: DelegationHandle,
    token: string,
  ): Promise<GitHubActionsRunView | null> {
    const id = handle.externalId
    if (id && /^\d+$/.test(id)) {
      return apiGet<GitHubActionsRunView>(deps.fetchImpl, {
        apiBase,
        token,
        path: `/repos/${description.owner}/${description.repo}/actions/runs/${id}`,
      })
    }
    return locate(handle.correlationKey, token)
  }

  /**
   * What the finished run produced.
   *
   * A reader that THROWS costs the result and not the run: the workflow succeeded, and reporting
   * that as a failed step would hide a change that is already pushed. The summary says what could
   * not be read, which is the "degrade loudly" disposition rather than a silent empty result.
   */
  async function readResult(
    handle: DelegationHandle,
    run: GitHubActionsRunView,
    token: string,
  ): Promise<DelegationResult> {
    try {
      if (description.resultFrom) {
        return await description.resultFrom({ handle, run, token, fetchImpl: deps.fetchImpl })
      }
      return await defaultResult(handle, token)
    } catch (error) {
      log.warn('the workflow succeeded and its result could not be read', {
        runId: run.id,
        err: getErrorMessage(error),
      })
      return {
        summary:
          `The workflow run completed. Reading what it produced failed ` +
          `(${getErrorMessage(error)}), so no pull request is recorded here: open the run to see.`,
      }
    }
  }

  /**
   * The default reading: the open pull request whose head is the run's work branch.
   *
   * It REFUSES to guess when the handle carries no branches, which is a record written before they
   * were persisted. Searching without one would have to pick a pull request by some other rule, and
   * every such rule can pick somebody else's, which then becomes the block's pull request, the
   * `ci` gate's checks and the merger's diff.
   */
  async function defaultResult(handle: DelegationHandle, token: string): Promise<DelegationResult> {
    const work = handle.branches?.work
    if (!work) {
      return {
        summary:
          'The workflow run completed. This run records no work branch, so the pull request it ' +
          'may have opened could not be identified: open the run to see.',
      }
    }
    const pullRequest = await pullRequestForBranch(deps.fetchImpl, {
      apiBase,
      token,
      owner: description.owner,
      repo: description.repo,
      branch: work,
    })
    return {
      summary: pullRequest
        ? `The workflow run completed and opened ${pullRequest.url}.`
        : 'The workflow run completed and opened no pull request.',
      ...(pullRequest ? { pullRequest } : {}),
      branch: work,
    }
  }
}
