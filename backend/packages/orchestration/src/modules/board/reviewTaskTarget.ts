import type { ReviewTargetReason } from '@cat-factory/contracts'
import type { Block, Logger, ResolveRunRepoContext } from '@cat-factory/kernel'
import { runBestEffort, ValidationError } from '@cat-factory/kernel'
import { resolvePrNumber } from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// The `review` task's TARGET: the existing pull request the read-only `pr-reviewer` is pointed
// at. Split out of `BoardService` as a cohesive collaborator (the file-size ratchet: split, never
// grow) — creation-time resolution of that target is a concern of its own, with its own VCS read.
//
// Two things happen here, in this order, and the order is load-bearing:
//   1. VALIDATE — a reference the provider positively reports as absent is refused, so a typo'd
//      PR number fails at the create form instead of as a run that dispatches a container, clones
//      a repo and discovers there is nothing to review.
//   2. CANONICALISE — the reference is rewritten to the provider's own `url` for the PR, so the
//      task records a real link (the inspector's "under review" panel reads exactly this) without
//      anyone reconstructing a provider-specific URL.
// ---------------------------------------------------------------------------

/** What `resolveReviewTaskTarget` needs: the run-repo seam every facade wires, plus a logger. */
export interface ReviewTaskTargetDependencies {
  /**
   * Resolves the repo a block's run targets, bound checkout-free. The SAME seam the review run
   * itself uses to reach the PR — so what is validated here is precisely what the reviewer will
   * read. Absent (GitHub/GitLab not connected, or a facade that doesn't wire it) ⇒ pass-through.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  logger: Logger
}

/** `owner`/`repo` parsed out of a PR/MR web URL, or null when it isn't one we recognise. */
export function parsePrUrlRepo(url: string): { owner: string; repo: string } | null {
  // Everything before the provider's PR marker is the project path: `owner/repo` on GitHub,
  // `group/subgroup/repo` on a nested GitLab namespace. Take the last segment as the repo and
  // the rest as the owner, so both shapes parse with one rule.
  const match =
    /^https?:\/\/[^/]+\/(.+?)\/(?:-\/merge_requests|pull|pulls|merge_requests)\/\d+/.exec(
      url.trim(),
    )
  const segments = match?.[1]?.split('/').filter(Boolean) ?? []
  if (segments.length < 2) return null
  const repo = segments[segments.length - 1]!.replace(/\.git$/, '')
  return { owner: segments.slice(0, -1).join('/'), repo }
}

/** Refuse with a code the SPA maps to translated copy — never only a prose message. */
function refuse(
  message: string,
  reason: ReviewTargetReason,
  details: Record<string, unknown> = {},
): never {
  throw new ValidationError(message, { reason, ...details })
}

/** Case-insensitive repo-identity compare (hosts differ in case-folding; owners/names don't). */
function sameRepo(a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

/**
 * Refuse a `prUrl` that names a DIFFERENT repository than the one this task's reviews run
 * against. The reviewer clones the service's linked repo and fetches the PR by NUMBER from it
 * (ADR 0023 — a cross-repo `prUrl` is not resolved to another repo), so such a reference would
 * silently review whatever PR happens to carry that number on the linked repo. Refusing names
 * the mismatch instead. A URL we can't parse is left alone: we cannot claim a mismatch we
 * cannot see.
 */
function assertRepoMatches(prUrl: string | undefined, owner?: string, name?: string): void {
  if (!prUrl || !owner || !name) return
  const target = parsePrUrlRepo(prUrl)
  if (!target || sameRepo(target, { owner, repo: name })) return
  refuse(
    `That pull request belongs to ${target.owner}/${target.repo}, but this service reviews ` +
      `${owner}/${name}. Create the review task under the service linked to ${target.owner}/${target.repo}.`,
    'review_pr_repo_mismatch',
    { expected: `${owner}/${name}` },
  )
}

/**
 * Validate a `review` task's target pull request and canonicalise its reference, returning the
 * fields to persist on the new block.
 *
 * Pass-through — the fields unchanged — for a non-review task, a reference with no resolvable
 * number, a workspace whose repo can't be resolved (unconnected, or a frame with no repo linked),
 * and a provider that can't read a PR: none of those is evidence the PR is missing, and refusing
 * on them would block a legitimate create.
 *
 * The same goes for a probe that FAILS: an outage, a revoked token or a rate limit answers
 * "unknown", not "absent", and turning that into a refusal would make task creation depend on the
 * provider being up. Only a positive "no such pull request" (the provider's own 404, which the
 * port's `getPullRequest` reports as `null` while every other failure throws) refuses.
 */
export async function resolveReviewTaskTarget(
  deps: ReviewTaskTargetDependencies,
  workspaceId: string,
  containerId: string,
  taskType: Block['taskType'],
  fields: Block['taskTypeFields'],
): Promise<Block['taskTypeFields']> {
  if (taskType !== 'review' || !fields) return fields
  const number = resolvePrNumber(fields)
  if (number == null) return fields

  // Best-effort like the probe below, and for the same reason: the resolver THROWS for a block
  // under no repo-linked service, and turning that into a refusal here would make this validation
  // reject creates it was never asked to judge (with a message about repo linkage, not the PR).
  const context = await runBestEffort(
    deps.logger,
    'board.resolveReviewRepoContext',
    () => deps.resolveRunRepoContext?.(workspaceId, containerId) ?? null,
    { workspaceId, containerId },
  )
  const getPullRequest = context?.repo.getPullRequest
  if (!context || !getPullRequest) return fields

  assertRepoMatches(fields.prUrl, context.owner, context.name)

  const pr = await runBestEffort(
    deps.logger,
    'board.validateReviewPullRequest',
    () => getPullRequest(number),
    { workspaceId, containerId, prNumber: number },
  )
  // `undefined` — the probe itself failed and was logged; create the task unvalidated.
  if (pr === undefined) return fields
  if (pr === null) {
    const repo = context.owner && context.name ? ` in ${context.owner}/${context.name}` : ''
    refuse(`Pull request #${number} was not found${repo}.`, 'review_pr_not_found', {
      prNumber: number,
    })
  }
  // Canonical from here on: the number the provider confirmed, and its own link for it.
  return { ...fields, prNumber: pr.number, ...(pr.url ? { prUrl: pr.url } : {}) }
}

/**
 * The paragraph a review task's target PR reference (URL / #number) and focus fold down to, or
 * the empty string when there is nothing to say. Pure and TOTAL over the fields, which is what
 * lets {@link refoldReviewDescription} recompute a description's existing preamble rather than
 * needing a marker to have been stored beside it.
 */
function reviewPreamble(fields: Block['taskTypeFields']): string {
  const ref = fields?.prUrl?.trim() || (fields?.prNumber ? `#${fields.prNumber}` : '')
  const focus = fields?.reviewFocus?.trim()
  return [ref ? `Review pull request ${ref}.` : '', focus ? `Review focus: ${focus}` : '']
    .filter(Boolean)
    .join(' ')
}

/** Join a (possibly empty) preamble to a (possibly empty) body the way creation always has. */
function withPreamble(preamble: string, body: string): string {
  return [preamble, body].filter(Boolean).join('\n\n')
}

/**
 * The body under `prior`, or `null` when `prior` is not this description's prefix (so what of the
 * description was the fold can no longer be told). An empty `prior` is nothing to strip, so the
 * whole description is the body.
 */
function bodyUnder(prior: string, description: string): string | null {
  if (!prior) return description
  return description.startsWith(prior) ? description.slice(prior.length).trimStart() : null
}

/**
 * For a REVIEW task, fold the target PR reference (URL / #number) and any review focus into the
 * description so the read-only `pr-reviewer` (which clones the base branch and fetches the PR
 * head by number) knows WHICH PR to review from its prompt. Returns the description unchanged
 * for non-review tasks or when there is nothing to prepend.
 */
export function buildReviewDescription(
  taskType: Block['taskType'],
  fields: Block['taskTypeFields'],
  description: string,
): string {
  if (taskType !== 'review') return description
  return withPreamble(reviewPreamble(fields), description)
}

/**
 * Re-fold the preamble when a review task's target or focus is EDITED after creation, returning
 * the description to store.
 *
 * The fold is a prepend, so repeating it would leave the description naming two pull requests
 * and the reviewer reading whichever it met first. The old paragraph is therefore removed before
 * the new one goes on, and it is identified by RECOMPUTING it from the fields as they stand now
 * (idempotency by content, not by a marker: no review task in any database carries one, and a
 * marker added today would still be absent from every task this exists to repair).
 *
 * Three outcomes, and the third is the reason this returns a discriminated result rather than a
 * string. Nothing folded before (the `review_target_missing` repair this whole path exists for)
 * ⇒ the new preamble is prepended, exactly as creation would have. The recomputed old paragraph
 * IS the description's prefix ⇒ it is swapped for the new one. It is NOT ⇒ somebody has since
 * rewritten the description, so the platform cannot tell what of it was the fold: refusing names
 * that, where prepending anyway would state a second, contradicting target and stripping a guess
 * would eat prose a human wrote.
 */
export function refoldReviewDescription(
  taskType: Block['taskType'],
  previous: Block['taskTypeFields'],
  next: Block['taskTypeFields'],
  description: string,
): { ok: true; description: string } | { ok: false; problem: string } {
  if (taskType !== 'review') return { ok: true, description }
  const prior = reviewPreamble(previous)
  const updated = reviewPreamble(next)
  if (prior === updated) return { ok: true, description }
  const body = bodyUnder(prior, description)
  if (body === null) {
    return {
      ok: false,
      problem:
        'The review target cannot be changed: this task’s description no longer starts with the ' +
        'reference folded into it at creation, so replacing that reference would leave the ' +
        'description naming a pull request the run does not review. Edit the description instead.',
    }
  }
  return { ok: true, description: withPreamble(updated, body) }
}

/**
 * Fold the target reference into a description the caller is authoring in THIS request, replacing
 * any fold the text already carries.
 *
 * The sibling of {@link refoldReviewDescription} for the other case, and the difference is only
 * what happens when the recomputed prior preamble is NOT the text's prefix. There it is a stored
 * description somebody has since rewritten, so the platform refuses rather than rewrite prose it
 * cannot account for. Here the text arrived in the request, so there is no prose at risk: whatever
 * the caller sent is the body, and the current preamble goes on the front of it.
 *
 * Stripping first is what this adds over a plain {@link buildReviewDescription}, and a
 * READ-MODIFY-WRITE caller is why it is needed: `GET /api/v1/tasks/:taskId` serves the FOLDED
 * description, so a client that reads a task, edits a field and sends the whole thing back returns
 * the preamble to a prepend that would then state it twice. When the target moved in the same
 * request, the two paragraphs name DIFFERENT pull requests and the reviewer reads whichever it
 * meets first, which is the exact failure the refold exists to prevent.
 */
export function foldReviewDescriptionOnto(
  taskType: Block['taskType'],
  previous: Block['taskTypeFields'],
  next: Block['taskTypeFields'],
  description: string,
): string {
  if (taskType !== 'review') return description
  return withPreamble(
    reviewPreamble(next),
    bodyUnder(reviewPreamble(previous), description) ?? description,
  )
}
