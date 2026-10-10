import type {
  BootstrapDelivery,
  BootstrapDeliveryPlan,
  BootstrapJobRecord,
} from '@cat-factory/kernel'
import {
  bootstrapWorkBranch,
  hostMarkdown,
  redactSecrets,
  renderAdoptionPrSection,
} from '@cat-factory/kernel'
import { bootstrapPrTitle } from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// How a bootstrap run's work LEAVES the container: the rule for a request that named no
// delivery, and the plan a dispatch acts on once one is recorded.
//
// A module of its own rather than three more members on `BootstrapService`, because all of it
// is a pure function of the stored run: nothing here reads a repository, a clock or a port, so
// keeping it beside the orchestration only made the delivery rule reachable exclusively through
// a run that had already been started, and put a PR BODY (a host-rendered, untrusted-text
// surface with its own escaping and scrubbing rules) in the middle of a 1,400-line service.
// ---------------------------------------------------------------------------

/**
 * The delivery a request that named none takes.
 *
 * The two targets want opposite answers and that is the whole reason the rule lives here rather
 * than as a schema default: a repository this run is creating has nobody to review its first
 * commit, and a monorepo's default branch is the branch every other service is built from.
 */
export function defaultDelivery(intoMonorepo: boolean): BootstrapDelivery {
  return intoMonorepo ? 'pull_request' : 'direct_push'
}

/**
 * Turn a run's recorded `delivery` into the plan a dispatch acts on: the work branch and
 * pull-request text, or nothing at all.
 *
 * One place, read by both targets, because the two dispatch sites otherwise each decide what a
 * `pull_request` run means and only one of them is ever exercised by the test you are writing.
 * `resolved` is the settled adoption review, present only on a monorepo apply; without one the
 * body is the new-repo fallback, since there is no reviewed decision to publish.
 */
export function deliveryPlanFor(
  record: BootstrapJobRecord,
  resolved?: NonNullable<BootstrapJobRecord['adoptionReview']>,
): BootstrapDeliveryPlan {
  if (record.delivery === 'direct_push') return { mode: 'direct_push' }
  const directory = record.monorepo?.directory
  return {
    mode: 'pull_request',
    // The branch the run RECORDED, which is what a retry carries forward: deriving it off
    // `record.id` here would mint a new one per attempt (a retry is a new row), so the harness's
    // resume would never fire and the previous attempt's pushed work would be abandoned on an
    // orphan branch. A row written before the field existed carries none, and this attempt then
    // claims one off its own id, exactly as that row's own dispatch did.
    branch: record.workBranch ?? bootstrapWorkBranch(record.id),
    pr: {
      title: bootstrapPrTitle(record.repoName, directory),
      // The HOST rendering (neutralised holes, scrubbed at compose time), never the agent brief:
      // this string lands on a pull request body, where a reviewer's note reading "fixes #412"
      // would close an unrelated issue on merge. It is the FALLBACK body; on a monorepo run the
      // engine also publishes the same decisions as its own marker region once the pull request
      // exists, because the harness lets an agent-authored description replace this one. BOTH
      // bodies are scrubbed: a PR body is strictly more exposed than the telemetry DB, and a
      // reference architecture's name is free text somebody typed.
      body:
        resolved && directory
          ? (redactSecrets(renderAdoptionPrSection(resolved, directory)) ?? '')
          : (redactSecrets(newRepoPrBody(record.repoName, record.referenceArchitectureName)) ?? ''),
    },
  }
}

/**
 * The pull-request body a run that has no adoption review to publish opens with.
 *
 * Only ever the FALLBACK: the harness lets the agent's own `.cat-pr-description.md` replace it
 * field-wise, and the PR-description guidance rides every agent pass, so a run whose agent wrote
 * a briefing publishes that instead. What this owes is one honest sentence for the run whose
 * agent wrote none, naming where the code came from rather than leaving a reviewer an empty body.
 *
 * Every hole goes through `hostMarkdown`, which is the rule for a host-rendered surface
 * regardless of how constrained the value looks from here. Both are rendered as CODE SPANS, so
 * they go through `inlineCode`, which sizes the backtick run around the value: hand-writing the
 * ticks around `inline` would be wrong twice over, because `inline` skips escaping whatever it
 * reads as an existing code span (a name holding `` `#42` `` would auto-link an issue on the new
 * repository's first pull request) and its numeric entities are not decoded inside a span (a name
 * holding `@ops` would reach the reader as `&#64;ops`).
 */
function newRepoPrBody(repoName: string, referenceName: string | null): string {
  const from = referenceName
    ? `the ${hostMarkdown.inlineCode(referenceName)} reference architecture`
    : 'a freeform brief'
  return (
    `Bootstrapped ${hostMarkdown.inlineCode(repoName)} from ${from}.\n\n` +
    `This is the repository's first content: review it before merging, because merging is what ` +
    `makes it the default branch every later run builds on.`
  )
}
