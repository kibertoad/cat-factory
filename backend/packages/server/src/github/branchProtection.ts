import type {
  BranchProtectionDetail,
  BranchProtectionSummary,
  BranchProtectionUnknownReason,
  GitHubRepoRef,
} from '@cat-factory/kernel'

// The branch-protection probe, extracted out of `FetchGitHubClient` (which is at its size
// budget) along the same seam as `reviewPosting.ts`: a cohesive concern taking the client's
// bound `request` rather than the client itself, so it stays independently testable and the
// client keeps a thin delegate.
//
// Why this read exists at all: branch protection on the HOST is the only control over a stolen
// `Contents: write` token — it covers a direct push to the default branch and a merge-API call
// alike — and it is the operator's to configure, not something the platform can enforce
// (`backend/docs/security-model.md`, checklist item 1). Nothing in-product used to tell an
// operator when it was missing.

/** The client's authenticated GET, bound to an installation by the caller. */
export type ProtectionRequest = (path: string) => Promise<{ json: unknown }>

/** Reads the HTTP status off whatever error shape the caller's request threw. */
export type ProtectionErrorStatus = (error: unknown) => number | undefined

/**
 * Probe a branch's protection posture with TWO reads, because they need different permissions:
 * the branch object's `protected` flag comes with ordinary repo read, while the rule's contents
 * need admin — and a minimally-scoped App installation is exactly the case this has to serve.
 *
 * Never throws. Every failure becomes an explicit `unknown` (or a `protected` with
 * `detailUnavailable`), because the caller is a SECURITY report: a thrown probe would either
 * blank a row — which reads as "fine" — or fail the whole preflight over one unreachable repo.
 */
export async function probeBranchProtection(
  request: ProtectionRequest,
  statusOf: ProtectionErrorStatus,
  ref: GitHubRepoRef,
  branch: string,
): Promise<BranchProtectionSummary> {
  const base = `/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(branch)}`
  let isProtected: boolean
  try {
    const { json } = await request(base)
    isProtected = (json as { protected?: boolean }).protected === true
  } catch (error) {
    return { state: 'unknown', reason: unknownProtectionReason(statusOf(error)) }
  }
  if (!isProtected) return { state: 'unprotected' }

  try {
    const { json } = await request(`${base}/protection`)
    return { state: 'protected', detail: readProtectionDetail(json) }
  } catch (error) {
    // The branch IS protected; we just cannot read the rule. Saying so is the point — a
    // protected branch whose rule we cannot see may still permit direct pushes, so reporting
    // it as a plain "protected" would overstate what was actually verified.
    const reason = unknownProtectionReason(statusOf(error))
    return {
      state: 'protected',
      detailUnavailable: reason === 'forbidden' ? 'forbidden' : 'error',
    }
  }
}

/**
 * Classify a failed probe into the reason an operator would act on differently: a missing
 * branch is a stale projection, a refusal is a credential problem, anything else is transient.
 */
export function unknownProtectionReason(status: number | undefined): BranchProtectionUnknownReason {
  if (status === 404) return 'branch_not_found'
  if (status === 403 || status === 401) return 'forbidden'
  return 'error'
}

/**
 * Project GitHub's branch-protection payload onto the four facts the preflight reports. Every
 * block is read defensively: a rule can omit any of them (no required reviews, no required
 * checks), and an absent block means "not required" — which is a real answer, not a gap.
 */
export function readProtectionDetail(json: unknown): BranchProtectionDetail {
  const rule = (json ?? {}) as {
    required_pull_request_reviews?: { required_approving_review_count?: number }
    required_status_checks?: { contexts?: string[] }
    allow_force_pushes?: { enabled?: boolean }
  }
  const reviews = rule.required_pull_request_reviews
  return {
    requiresPullRequest: reviews !== undefined,
    requiredApprovingReviewCount:
      typeof reviews?.required_approving_review_count === 'number'
        ? reviews.required_approving_review_count
        : 0,
    requiredStatusChecks: rule.required_status_checks?.contexts ?? [],
    allowsForcePush: rule.allow_force_pushes?.enabled === true,
  }
}

/**
 * How many approving reviews a branch's protection rule requires before merge. Lives here
 * rather than on the client because it reads the SAME protection resource as the probe above —
 * keeping the two together is what stops one of them learning a new failure mode the other
 * doesn't.
 *
 * Returns 1 when the setting is unreadable (no protection rule, or the credential lacks admin
 * access — both common), which is the conservative default the `human-review` gate wants: a
 * gate that read "0 required" off an unreadable rule would wave work through. Any OTHER failure
 * propagates, so a provider outage is not silently rendered as a policy.
 */
export async function readRequiredApprovingReviewCount(
  request: ProtectionRequest,
  statusOf: ProtectionErrorStatus,
  ref: GitHubRepoRef,
  branch: string,
): Promise<number> {
  try {
    const { json } = await request(
      `/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(branch)}` +
        `/protection/required_pull_request_reviews`,
    )
    const count = (json as { required_approving_review_count?: number })
      .required_approving_review_count
    return typeof count === 'number' ? count : 1
  } catch (error) {
    const status = statusOf(error)
    if (status === 404 || status === 403) return 1
    throw error
  }
}
