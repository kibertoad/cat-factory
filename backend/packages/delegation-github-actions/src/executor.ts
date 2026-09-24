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
import {
  workflowAddressing,
  type GitHubActionsWorkflowLocation,
  type GitHubActionsWorkflowTarget,
} from './workflow.js'

// ---------------------------------------------------------------------------
// A {@link DelegatedExecutor} over GITHUB ACTIONS.
//
// It ships in the platform because every GitHub-hosted company plugging its own implement /
// review / test loop into a cat-factory step hits the same three problems, and none of them is
// about that company's workflow:
//
//   1. `start` must be idempotent, and a replay has only the brief to find its run by: the
//      dispatch's own answer (the run id on github.com, nothing on a server that replies 204) was
//      lost with the attempt that got it. Solved by the brief's correlation key plus a `run-name`
//      the caller workflow renders (see ./correlation).
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
 * external id, the branch pair, and the repository the WORK targeted, which is not necessarily the
 * one holding the workflow.
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
  /**
   * The workflow this executor dispatches: one location, or a function of the dispatch.
   *
   * A FUNCTION is what a multi-repo deployment needs, and it is the ordinary shape: a caller shim
   * committed to each onboarded repository means the workflow lives wherever the work does, so the
   * dispatch target varies per brief while the registration stays one. Everything else in this
   * helper is already per-call (`inputs`, the correlation scan, the result read out of
   * `handle.repo`); a fixed owner/repo made the dispatch the single part that could not follow.
   *
   * A LITERAL is right for the other shape, a central automation repo holding one workflow that
   * works on many product repositories, and then `ref` really is "a branch that holds the
   * workflow, not the work".
   */
  workflow: GitHubActionsWorkflowTarget
  /**
   * The `workflow_dispatch` inputs, built from the brief. The correlation input is added for you
   * under {@link CORRELATION_INPUT}. Supply it yourself only if your workflow names it something
   * else, in which case yours wins.
   *
   * Actions caps each input at 1 MiB and the whole set at 25 entries, and it REJECTS the dispatch
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
  /**
   * How many recent `workflow_dispatch` runs the correlation scan reads per look. Defaults to 50.
   *
   * A knob rather than a constant because the failure it prevents is the deadliest one in this
   * seam: a replayed dispatch finds its own run by scanning this page, and a repo that fires more
   * `workflow_dispatch` runs than fit between a dispatch and its replay pushes the run off the
   * end, so `start` queues a SECOND workflow and one task gets two pull requests. Raise it on a
   * high-volume repo. Bounded per look either way, so a miss reads as "not yet" and the caller
   * keeps asking.
   */
  correlationScanSize?: number
}

/**
 * Dispatch the workflow, answering the run it queued, or undefined when the server named none.
 *
 * github.com answers `200` with `workflow_run_id`, which settles the id without a scan. The
 * `html_url` is optional here because the id alone is enough to poll by; a start without a url
 * gains one on the first running poll.
 */
async function dispatch(
  fetchImpl: DelegatedExecutorDeps['fetchImpl'],
  input: {
    apiBase: string
    token: string
    workflow: GitHubActionsWorkflowLocation
    inputs: Record<string, string>
  },
): Promise<DelegationStart | undefined> {
  const { workflow } = input
  const answer = await apiPost(fetchImpl, {
    apiBase: input.apiBase,
    token: input.token,
    path:
      `/repos/${workflow.owner}/${workflow.repo}/actions/workflows/` +
      `${encodeURIComponent(workflow.workflowFile)}/dispatches`,
    body: { ref: workflow.ref, inputs: input.inputs },
  })
  if (typeof answer !== 'object' || answer === null) return undefined
  const { workflow_run_id: id, html_url: url } = answer as Record<string, unknown>
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return undefined
  return { externalId: String(id), ...(typeof url === 'string' ? { url } : {}) }
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
  const baseLog = deps.logger.child({ executor: 'github-actions' })
  const workflows = workflowAddressing(description.workflow)

  /**
   * The logger every line of one call goes through, naming the workflow it addressed.
   *
   * Bound per call rather than once at build, because the location is per call as soon as a
   * deployment resolves it: on a deployment onboarding fifty repositories, "the workflow
   * succeeded and its result could not be read" with only a run id on it cannot tell one
   * misconfigured repository from a token that is wrong everywhere.
   */
  const logFor = (workflow: GitHubActionsWorkflowLocation) =>
    baseLog.child({ repo: `${workflow.owner}/${workflow.repo}`, workflow: workflow.workflowFile })

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

  const locate = (
    workflow: GitHubActionsWorkflowLocation,
    correlationKey: string,
    token: string,
  ): Promise<GitHubActionsRunView | null> =>
    findRunByCorrelation(deps.fetchImpl, {
      apiBase,
      token,
      owner: workflow.owner,
      repo: workflow.repo,
      workflowFile: workflow.workflowFile,
      correlationKey,
      ...(description.correlationScanSize ? { perPage: description.correlationScanSize } : {}),
    })

  return {
    async start(brief, credentials): Promise<DelegationStart> {
      const token = tokenOf(credentials)
      const workflow = workflows.forBrief(brief)
      // IDEMPOTENCY, first. A replayed dispatch must find the run it already started rather than
      // queue another; the engine commits its claim before calling this, so a replay reaching here
      // at all means the previous attempt may have got as far as the dispatch.
      const existing = await locate(workflow, brief.correlationKey, token)
      if (existing) {
        logFor(workflow).info('re-attached to an existing workflow run', { runId: existing.id })
        return {
          externalId: String(existing.id),
          url: existing.html_url,
          note: 'Re-attached to the run this dispatch had already started.',
        }
      }
      const inputs = { [CORRELATION_INPUT]: brief.correlationKey, ...description.inputs(brief) }
      const dispatched = await dispatch(deps.fetchImpl, { apiBase, token, workflow, inputs })
      if (dispatched) return dispatched
      // A server that answers 204 queued a run that may not exist yet. Look once (it usually does
      // by now) and, failing that, answer with the correlation key as the external id so the step
      // is recorded and the FIRST POLL recovers the real one. Refusing here instead would fail a
      // step whose workflow is queued and about to run.
      const started = await locate(workflow, brief.correlationKey, token)
      if (started) return { externalId: String(started.id), url: started.html_url }
      return {
        externalId: brief.correlationKey,
        note: 'Dispatched; the workflow run had not appeared yet, so it is correlated on the first poll.',
      }
    },

    async poll(handle, credentials): Promise<DelegationUpdate> {
      const token = tokenOf(credentials)
      // ONCE per call, then threaded down. A deployment's resolver is its own code with no purity
      // requirement: one that reads a per-repo config map, logs, or counts a metric must see one
      // addressing decision per call, not the two or three that asking again at each use makes.
      const workflow = workflows.forHandle(handle)
      const run = await resolveRun(workflow, handle, token)
      if (!run) {
        // The run has still not appeared. `running` rather than a failure: the poll budget is what
        // bounds this, and a workflow queued behind a busy runner pool is the ordinary case.
        return { state: 'running', phase: 'queued' }
      }
      if (run.status !== 'completed') {
        // The id travels back on EVERY running poll, not only the one that recovered it. `start`
        // answers with the correlation key when the run had not appeared yet, and without this the
        // record keeps that key for the life of the run: `resolveRun` then re-runs the bounded
        // page scan on every poll, and on a repository busy enough to need
        // `correlationScanSize` the run scrolls off it mid-flight. The engine folds it once and
        // ignores it thereafter, so repeating it costs nothing.
        return {
          state: 'running',
          externalId: String(run.id),
          url: run.html_url,
          phase: run.status ?? 'in_progress',
        }
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
      return { state: 'done', result: await readResult(workflow, handle, run, token) }
    },

    async cancel(handle, credentials): Promise<void> {
      const token = tokenOf(credentials)
      const workflow = workflows.forHandle(handle)
      const run = await resolveRun(workflow, handle, token)
      // Nothing to cancel is a clean outcome, not a failure: the run may have finished between the
      // teardown deciding to stop it and this call.
      if (!run || run.status === 'completed') return
      await apiPost(deps.fetchImpl, {
        apiBase,
        token,
        path: `/repos/${workflow.owner}/${workflow.repo}/actions/runs/${run.id}/cancel`,
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
    workflow: GitHubActionsWorkflowLocation,
    handle: DelegationHandle,
    token: string,
  ): Promise<GitHubActionsRunView | null> {
    const id = handle.externalId
    if (id && /^\d+$/.test(id)) {
      return apiGet<GitHubActionsRunView>(deps.fetchImpl, {
        apiBase,
        token,
        path: `/repos/${workflow.owner}/${workflow.repo}/actions/runs/${id}`,
      })
    }
    return locate(workflow, handle.correlationKey, token)
  }

  /**
   * What the finished run produced.
   *
   * A reader that THROWS costs the result and not the run: the workflow succeeded, and reporting
   * that as a failed step would hide a change that is already pushed. The summary says what could
   * not be read, which is the "degrade loudly" disposition rather than a silent empty result.
   */
  async function readResult(
    workflow: GitHubActionsWorkflowLocation,
    handle: DelegationHandle,
    run: GitHubActionsRunView,
    token: string,
  ): Promise<DelegationResult> {
    try {
      if (description.resultFrom) {
        return await description.resultFrom({ handle, run, token, fetchImpl: deps.fetchImpl })
      }
      return await defaultResult(workflow, handle, token)
    } catch (error) {
      logFor(workflow).warn('the workflow succeeded and its result could not be read', {
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
   * The default reading: the open pull request whose head is the run's work branch, in the repo
   * the WORK targeted.
   *
   * Two facts have to come off the handle, and neither is derivable here. The BRANCH, because a
   * handle carries the run and the work branch is named from the block. And the REPO, because the
   * resolved workflow's own `owner/repo` is where the WORKFLOW lives, which is routinely not where
   * the work goes: its `ref` is documented as a branch that holds the workflow, so a central
   * automation repo dispatching against many product repos is the ordinary shape, and reading the
   * result out of the automation repo finds nothing on every run.
   *
   * It REFUSES to guess when the handle carries no branches, which is a record written before they
   * were persisted. Searching without one would have to pick a pull request by some other rule, and
   * every such rule can pick somebody else's, which then becomes the block's pull request, the
   * `ci` gate's checks and the merger's diff. A missing REPO falls back to the workflow's own,
   * which is not a guess of the same kind: it is the right answer for the single-repo deployment,
   * and the branch match still has to hold. That fallback is reachable only for a LITERAL
   * `workflow`, because a resolver is refused a handle that names no work repository.
   */
  async function defaultResult(
    workflow: GitHubActionsWorkflowLocation,
    handle: DelegationHandle,
    token: string,
  ): Promise<DelegationResult> {
    const work = handle.branches?.work
    if (!work) {
      return {
        summary:
          'The workflow run completed. This run records no work branch, so the pull request it ' +
          'may have opened could not be identified: open the run to see.',
      }
    }
    const target = handle.repo ?? { owner: workflow.owner, name: workflow.repo }
    const pullRequest = await pullRequestForBranch(deps.fetchImpl, {
      apiBase,
      token,
      owner: target.owner,
      repo: target.name,
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
