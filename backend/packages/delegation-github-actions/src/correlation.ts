import type { DelegatedFetch } from '@cat-factory/kernel'
import { apiGet } from './http.js'

// ---------------------------------------------------------------------------
// CORRELATION: finding the workflow run you just started.
//
// `POST /actions/workflows/{file}/dispatches` answers `204 No Content`. It returns no run id, no
// url, and nothing that identifies what it queued, and the run does not exist yet when it answers,
// so there is nothing to look up either. Every GitHub-hosted deployment plugging its own executor
// into a cat-factory step hits this on day one, which is why it is solved here rather than in each
// deployment's repo.
//
// The solution the platform makes possible: the brief carries a `correlationKey`, the caller
// workflow puts it in its own `run-name`, and the run is then FINDABLE by a string the platform
// chose. Nothing else about Actions offers a handle: `workflow_dispatch` inputs are not queryable,
// the `created` filter has one-second granularity, and two runs started in the same second by the
// same event are indistinguishable without a name.
// ---------------------------------------------------------------------------

/**
 * The `run-name` a caller workflow must produce for a dispatch to be findable.
 *
 * Exported so a deployment can render the exact string in its workflow's `run-name:` expression and
 * be sure the two agree. The marker is deliberately ugly and unlikely to occur in a hand-written
 * run name, because a substring match against a human-authored name is how one dispatch comes to be
 * correlated with another run entirely.
 */
export function correlationRunName(correlationKey: string): string {
  return `cat-factory[${correlationKey}]`
}

/** The subset of an Actions run this helper reads. */
export interface ActionsRunSummary {
  id: number
  /**
   * The WORKFLOW's own `name:`, which is NOT where a `run-name:` lands. Read only as a fallback
   * (see {@link runCarriesMarker}); the marker is what the platform correlates on.
   */
  name: string | null
  /**
   * The run's displayed title, which is where a workflow's evaluated `run-name:` actually lands.
   * The field the correlation depends on, and the reason it is spelled out here: `name` keeps the
   * workflow's title whatever `run-name:` renders, so matching the marker against `name` alone
   * finds nothing, ever.
   */
  display_title?: string | null
  html_url: string
  status: string | null
  conclusion: string | null
  created_at: string
}

/**
 * Whether this run is the one carrying the platform's marker.
 *
 * Both title fields are tested, and the order says which one is the contract: `display_title` is
 * where GitHub puts the evaluated `run-name:` a caller workflow renders, and `name` is read after
 * it only so a GitHub Enterprise release that predates `display_title` still correlates. Testing
 * both costs nothing in precision because the marker is deliberately ugly: a run whose author
 * typed `cat-factory[<key>]` into either field by accident is not a case worth designing around.
 */
function runCarriesMarker(run: ActionsRunSummary, marker: string): boolean {
  return (run.display_title ?? '').includes(marker) || (run.name ?? '').includes(marker)
}

/**
 * Find the workflow run carrying `correlationKey` in its name, or null when it has not appeared
 * yet.
 *
 * NULL IS NOT AN ERROR, and that distinction is the whole contract: a dispatch queues a run that
 * takes a moment to appear, so "not found" on the first look is the ordinary case and the caller
 * keeps polling. Throwing here would turn a normal race into a failed step, and returning a
 * fabricated id would settle the step against a run that does not exist.
 *
 * Scanned over the most recent page rather than filtered server-side because Actions offers no
 * filter this could use: `created` has one-second granularity and inputs are not queryable. The
 * page is bounded, so a deployment whose repo runs a very high volume of `workflow_dispatch` runs
 * may need a larger `perPage`, which is a knob rather than a silent truncation, because the
 * caller learns "not yet" either way and keeps asking.
 */
export async function findRunByCorrelation(
  fetchImpl: DelegatedFetch,
  input: {
    apiBase: string
    token: string
    owner: string
    repo: string
    workflowFile: string
    correlationKey: string
    perPage?: number
  },
): Promise<ActionsRunSummary | null> {
  const marker = correlationRunName(input.correlationKey)
  const perPage = input.perPage ?? 50
  const path =
    `/repos/${input.owner}/${input.repo}/actions/workflows/` +
    `${encodeURIComponent(input.workflowFile)}/runs` +
    `?event=workflow_dispatch&per_page=${perPage}`
  const body = await apiGet<{ workflow_runs?: ActionsRunSummary[] }>(fetchImpl, {
    apiBase: input.apiBase,
    token: input.token,
    path,
  })
  const runs = body.workflow_runs ?? []
  // The NEWEST match, because a re-run of the same step reuses the correlation key only when the
  // engine deliberately re-attaches (the dispatch epoch changes otherwise), and the newest is then
  // the one this dispatch queued.
  //
  // Chosen by `created_at` rather than by taking the first element. Newest-first is an
  // UNDOCUMENTED default of this endpoint: no `sort`/`direction` parameter is passed, nothing
  // promises it, and a deployment's proxy is free to re-order. Trusting element order, a
  // correlation that landed on an older completed run carrying the same marker would settle the
  // step on a workflow that finished hours earlier, which is the one outcome the marker exists to
  // make impossible.
  let newest: ActionsRunSummary | null = null
  for (const run of runs) {
    if (!runCarriesMarker(run, marker)) continue
    if (!newest || startedAfter(run, newest)) newest = run
  }
  return newest
}

/**
 * Whether `run` started after `other`, with the run ID as the tie-break.
 *
 * An unparseable or absent `created_at` sorts oldest rather than throwing: the field is an
 * external system's, and a run that cannot be dated is exactly the one not to prefer. Actions ids
 * are monotonic per repository, so they settle two runs created in the same second, which
 * `created_at`'s one-second granularity cannot.
 */
function startedAfter(run: ActionsRunSummary, other: ActionsRunSummary): boolean {
  const a = Date.parse(run.created_at ?? '')
  const b = Date.parse(other.created_at ?? '')
  if (Number.isNaN(a)) return false
  if (Number.isNaN(b)) return true
  return a === b ? run.id > other.id : a > b
}
