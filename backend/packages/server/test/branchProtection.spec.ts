import { describe, expect, it, vi } from 'vitest'
import {
  probeBranchProtection,
  readProtectionDetail,
  readRequiredApprovingReviewCount,
} from '../src/github/branchProtection.js'

// The branch-protection probe behind the security preflight. The property under test throughout
// is that it NEVER collapses "we could not tell" into an answer: an unreachable host, a refused
// read and an unreadable rule each land as their own state, because the consumer is a report an
// operator acts on (backend/docs/security-model.md, checklist item 1).

const REF = { owner: 'acme', repo: 'widgets' }

/** An error carrying an HTTP status, as the client's `request` throws. */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}
const statusOf = (e: unknown): number | undefined => (e instanceof HttpError ? e.status : undefined)

/**
 * A request stub answering per path suffix; anything unmatched throws the given status.
 *
 * Matches the LONGEST suffix rather than the first, because the paths genuinely nest:
 * `/rules/branches/main` also ends with `/branches/main`, and `/branches/main/protection`
 * contains `/branches/main`. Order-dependent matching would silently answer the wrong read.
 */
function requestOver(answers: Record<string, unknown>, fallbackStatus = 500) {
  const bySpecificity = Object.entries(answers).sort(([a], [b]) => b.length - a.length)
  return vi.fn(async (path: string) => {
    for (const [suffix, json] of bySpecificity) {
      if (path.endsWith(suffix)) return { json }
    }
    throw new HttpError(fallbackStatus)
  })
}

/** No rulesets apply — the common case for a repo using classic protection (or nothing). */
const NO_RULES = { '/rules/branches/main': [] }

describe('probeBranchProtection', () => {
  it('reports unprotected only when BOTH mechanisms say so, without reading the rule', async () => {
    const request = requestOver({ '/branches/main': { protected: false }, ...NO_RULES })
    const result = await probeBranchProtection(request, statusOf, REF, 'main')

    expect(result).toEqual({ state: 'unprotected' })
    // The branch object and the rules, and nothing else: there is no classic rule to fetch, and
    // a third call would burn rate limit on every unprotected repo in the report.
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('reports a branch protected ONLY by a ruleset as protected, not as a false alarm', async () => {
    // The regression this exists for. Org-level rulesets are how protection is enforced
    // org-wide, and they leave no classic rule behind — so a legacy-only probe reported the
    // best-configured repos as exposed, on a panel whose whole job is naming exposed repos.
    const request = requestOver({
      '/branches/main': { protected: false },
      '/rules/branches/main': [
        { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'ci' }] },
        },
        { type: 'non_fast_forward' },
      ],
    })

    expect(await probeBranchProtection(request, statusOf, REF, 'main')).toEqual({
      state: 'protected',
      detail: {
        requiresPullRequest: true,
        requiredApprovingReviewCount: 2,
        requiredStatusChecks: ['ci'],
        // `non_fast_forward` is the rule that FORBIDS a force push, so its presence is what
        // makes this false — there is no `allow_force_pushes` equivalent to read.
        allowsForcePush: false,
      },
    })
  })

  it('treats an unreadable rules response as unknown, never as unprotected', async () => {
    // With no classic rule, rulesets are the only remaining source. If we could not read them we
    // genuinely do not know — and `unprotected` is the one answer that must never be a guess,
    // because it is the one an operator acts on.
    const request = vi.fn(async (path: string) => {
      if (path.includes('/rules/')) throw new HttpError(403)
      return { json: { protected: false } }
    })

    expect(await probeBranchProtection(request, statusOf, REF, 'main')).toEqual({
      state: 'unknown',
      reason: 'forbidden',
    })
  })

  it('falls back to ruleset detail when the classic rule needs admin we lack', async () => {
    // `/protection` needs admin; `/rules` needs only repo read. Being able to say WHAT is
    // enforced beats saying only THAT something is, so a minimally-scoped installation now gets
    // real detail where it previously got `detailUnavailable`.
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/protection')) throw new HttpError(403)
      if (path.includes('/rules/')) return { json: [{ type: 'pull_request' }] }
      return { json: { protected: true } }
    })

    expect(await probeBranchProtection(request, statusOf, REF, 'main')).toEqual({
      state: 'protected',
      detail: {
        requiresPullRequest: true,
        requiredApprovingReviewCount: 0,
        requiredStatusChecks: [],
        allowsForcePush: true,
      },
    })
  })

  it('reports a protected branch with the rule it could read', async () => {
    const request = requestOver({
      '/branches/main/protection': {
        required_pull_request_reviews: { required_approving_review_count: 2 },
        required_status_checks: { contexts: ['build', 'test'] },
        allow_force_pushes: { enabled: false },
      },
      '/branches/main': { protected: true },
      ...NO_RULES,
    })

    expect(await probeBranchProtection(request, statusOf, REF, 'main')).toEqual({
      state: 'protected',
      detail: {
        requiresPullRequest: true,
        requiredApprovingReviewCount: 2,
        requiredStatusChecks: ['build', 'test'],
        allowsForcePush: false,
      },
    })
  })

  it('keeps "protected but the rule is unreadable" distinct from plain protected', async () => {
    // A minimally-scoped App installation cannot read the rule. Reporting this as a plain
    // "protected" would overstate what was verified — the rule may still permit direct pushes.
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/protection')) throw new HttpError(403)
      if (path.includes('/rules/')) return { json: [] }
      return { json: { protected: true } }
    })

    expect(await probeBranchProtection(request, statusOf, REF, 'main')).toEqual({
      state: 'protected',
      detailUnavailable: 'forbidden',
    })
  })

  it.each([
    [404, 'branch_not_found'],
    [403, 'forbidden'],
    [401, 'forbidden'],
    [500, 'error'],
  ])(
    'turns a %i on the branch read into unknown/%s, never into a verdict',
    async (status, reason) => {
      const request = vi.fn(async () => {
        throw new HttpError(status)
      })

      expect(await probeBranchProtection(request, statusOf, REF, 'main')).toEqual({
        state: 'unknown',
        reason,
      })
    },
  )

  it('never throws, so one unreachable repo cannot fail the whole preflight', async () => {
    const request = vi.fn(async () => {
      throw new Error('socket hang up')
    })

    await expect(probeBranchProtection(request, statusOf, REF, 'main')).resolves.toEqual({
      state: 'unknown',
      reason: 'error',
    })
  })

  it('URL-encodes a branch name with a slash on BOTH reads', async () => {
    const request = requestOver({
      '/rules/branches/release%2F1.2': [],
      '/branches/release%2F1.2': { protected: false },
    })
    expect(await probeBranchProtection(request, statusOf, REF, 'release/1.2')).toEqual({
      state: 'unprotected',
    })
    // An unencoded slash on either read would 404 and surface as `unknown`, so the verdict
    // above only holds if both paths were encoded.
    expect(request.mock.calls.every(([path]) => path.includes('release%2F1.2'))).toBe(true)
  })
})

describe('readProtectionDetail', () => {
  it('reads an omitted block as "not required", which is an answer rather than a gap', async () => {
    expect(readProtectionDetail({})).toEqual({
      requiresPullRequest: false,
      requiredApprovingReviewCount: 0,
      requiredStatusChecks: [],
      allowsForcePush: false,
    })
  })

  it('distinguishes "a PR is required" from "approvals are required"', () => {
    // A rule can require a pull request while requiring zero approving reviews — which still
    // stops a direct push, so flattening the two would misreport the protection that exists.
    const detail = readProtectionDetail({ required_pull_request_reviews: {} })
    expect(detail.requiresPullRequest).toBe(true)
    expect(detail.requiredApprovingReviewCount).toBe(0)
  })

  it('surfaces force pushes still being allowed on a protected branch', () => {
    expect(readProtectionDetail({ allow_force_pushes: { enabled: true } }).allowsForcePush).toBe(
      true,
    )
  })
})

describe('readRequiredApprovingReviewCount', () => {
  it('reads the configured count', async () => {
    const request = requestOver({
      '/required_pull_request_reviews': { required_approving_review_count: 3 },
    })
    expect(await readRequiredApprovingReviewCount(request, statusOf, REF, 'main')).toBe(3)
  })

  it('defaults to 1 when the rule is absent or unreadable', async () => {
    // The conservative default the `human-review` gate wants: reading "0 required" off an
    // unreadable rule would wave work through.
    for (const status of [404, 403]) {
      const request = vi.fn(async () => {
        throw new HttpError(status)
      })
      expect(await readRequiredApprovingReviewCount(request, statusOf, REF, 'main')).toBe(1)
    }
  })

  it('propagates any OTHER failure rather than rendering an outage as a policy', async () => {
    const request = vi.fn(async () => {
      throw new HttpError(500)
    })
    await expect(readRequiredApprovingReviewCount(request, statusOf, REF, 'main')).rejects.toThrow(
      'HTTP 500',
    )
  })
})
