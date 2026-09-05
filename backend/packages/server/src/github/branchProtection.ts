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
 * Probe a branch's protection posture across BOTH of GitHub's protection mechanisms.
 *
 * Classic **branch protection** lives at `/branches/{b}` (`protected`) with its contents at
 * `/branches/{b}/protection` — which needs ADMIN, exactly what a minimally-scoped App
 * installation does not have. **Rulesets** are the newer mechanism and the only way to enforce
 * protection org-wide; `/rules/branches/{b}` returns every active rule "regardless of the level
 * at which they are configured (e.g. repository or organization)", and needs only repo read.
 *
 * Reading only the legacy pair was a FALSE ALARM generator against precisely the orgs doing it
 * right: a branch protected solely by an org-level ruleset has no classic rule to find, so it
 * would be reported `unprotected` on a panel whose entire purpose is naming exposed repos. An
 * operator who is told their hardened repo is exposed stops believing the panel.
 *
 * The two reads run concurrently because neither depends on the other, and `/protection` is
 * attempted only when there is a classic rule to read. Rules also serve as the detail source
 * when `/protection` is refused, so a minimally-scoped installation now gets real detail where
 * it previously got `detailUnavailable`.
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
  const repo = `/repos/${ref.owner}/${ref.repo}`
  const base = `${repo}/branches/${encodeURIComponent(branch)}`
  const [branchRead, rulesRead] = await Promise.allSettled([
    request(base),
    request(`${repo}/rules/branches/${encodeURIComponent(branch)}`),
  ])

  if (branchRead.status === 'rejected') {
    return { state: 'unknown', reason: unknownProtectionReason(statusOf(branchRead.reason)) }
  }
  const hasClassicRule = (branchRead.value.json as { protected?: boolean }).protected === true
  const rules = rulesRead.status === 'fulfilled' ? readActiveRules(rulesRead.value.json) : null

  if (!hasClassicRule) {
    // No classic rule. Rulesets are the only remaining source, so an UNREADABLE rules response
    // means we genuinely cannot tell — and `unprotected` is the one answer we must not guess,
    // since it is the one an operator acts on.
    if (rules === null) {
      const reason =
        rulesRead.status === 'rejected'
          ? unknownProtectionReason(statusOf(rulesRead.reason))
          : 'error'
      return { state: 'unknown', reason }
    }
    if (rules.length === 0) return { state: 'unprotected' }
    return { state: 'protected', detail: detailFromRules(rules) }
  }

  try {
    const { json } = await request(`${base}/protection`)
    return { state: 'protected', detail: readProtectionDetail(json) }
  } catch (error) {
    // The branch IS protected; the classic rule's contents just need admin we may not have.
    // Rules can still describe it — and being able to say WHAT is enforced beats saying only
    // THAT something is. Only when both are unreadable do we admit the gap, because a
    // protected branch whose rule we cannot see may still permit direct pushes, and reporting
    // it as a plain "protected" would overstate what was actually verified.
    if (rules !== null && rules.length > 0) {
      return { state: 'protected', detail: detailFromRules(rules) }
    }
    const reason = unknownProtectionReason(statusOf(error))
    return {
      state: 'protected',
      detailUnavailable: reason === 'forbidden' ? 'forbidden' : 'error',
    }
  }
}

/** One entry of `/rules/branches/{branch}` — a rule type plus its (optional) parameters. */
interface ActiveRule {
  type?: string
  parameters?: {
    required_approving_review_count?: number
    required_status_checks?: { context?: string }[]
  }
}

/**
 * The active-rules array, or null when the payload is not one. Null means "could not read",
 * which is deliberately distinct from `[]` ("read it, nothing applies") — collapsing the two
 * is how an unreadable response becomes a confident `unprotected`.
 */
function readActiveRules(json: unknown): ActiveRule[] | null {
  return Array.isArray(json) ? (json as ActiveRule[]) : null
}

/**
 * Project active rules onto the same four facts the classic rule reports, so the surface needs
 * no branch on which mechanism answered.
 *
 * `allow_force_pushes` has no ruleset equivalent — the inverse does: a `non_fast_forward` rule
 * is what FORBIDS a force push, so its absence is what permits one.
 */
function detailFromRules(rules: ActiveRule[]): BranchProtectionDetail {
  const pullRequest = rules.find((rule) => rule.type === 'pull_request')
  const checks = rules.find((rule) => rule.type === 'required_status_checks')
  const reviews = pullRequest?.parameters?.required_approving_review_count
  return {
    requiresPullRequest: pullRequest !== undefined,
    requiredApprovingReviewCount: typeof reviews === 'number' ? reviews : 0,
    requiredStatusChecks: (checks?.parameters?.required_status_checks ?? [])
      .map((check) => check.context)
      .filter((context): context is string => typeof context === 'string'),
    allowsForcePush: !rules.some((rule) => rule.type === 'non_fast_forward'),
  }
}

/**
 * Classify a failed probe into the reason an operator would act on differently: a missing
 * branch is a stale projection, a refusal is a credential problem, anything else is transient.
 */
function unknownProtectionReason(status: number | undefined): BranchProtectionUnknownReason {
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
 *
 * Deliberately NOT ruleset-aware, unlike {@link probeBranchProtection}. A ruleset-protected
 * branch 404s here and so reads as 1, which may be fewer approvals than the ruleset demands —
 * and that is safe in a way the preflight's equivalent was not, because this number only sets
 * how many approvals WE wait for, while the host still refuses the merge until its own count is
 * met. Under-counting costs an extra round trip through the gate; it cannot land unreviewed work.
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
