import { describe, expect, it } from 'vitest'
import { describeGitHubPatScope, summarizeGitHubPatScope } from './githubPatScope.js'

// The classification behind the connect form's breadth warnings. The property that matters is
// that BREADTH IS STATED rather than assumed: a classic `repo` token is called out, a
// fine-grained one is left alone, and a token whose scopes GitHub did not report is reported as
// unknown rather than passing silently as narrow.

const codes = (header: string | null, token = 'ghp_abc'): string[] =>
  describeGitHubPatScope(token, header).warnings.map((w) => w.code)

describe('describeGitHubPatScope', () => {
  it('flags a classic token carrying `repo` as account-wide', () => {
    const report = describeGitHubPatScope('ghp_abc', 'repo, workflow')
    expect(report.kind).toBe('classic')
    expect(report.scopes).toEqual(['repo', 'workflow'])
    expect(report.warnings.map((w) => w.code)).toEqual(['github_pat_classic_account_wide'])
    // The message names the actual grant, so the member can act on it without a second lookup.
    expect(report.warnings[0]?.message).toContain('repo, workflow')
  })

  it('does not treat `public_repo` as account-wide', () => {
    // Still broad, but it cannot touch a private repository — which is the case the security
    // model is about. Warning on it too would make the real one easy to ignore.
    expect(codes('public_repo')).toEqual([])
  })

  it('reports excess scopes separately from account-wide reach', () => {
    const report = describeGitHubPatScope('ghp_abc', 'repo, delete_repo, admin:org')
    expect(report.warnings.map((w) => w.code)).toEqual([
      'github_pat_classic_account_wide',
      'github_pat_scopes_beyond_need',
    ])
    expect(report.warnings[1]?.message).toContain('delete_repo, admin:org')
  })

  it('flags excess scopes even on a token that is not account-wide', () => {
    expect(codes('public_repo, delete_repo')).toEqual(['github_pat_scopes_beyond_need'])
  })

  it('treats a fine-grained token with no scope header as narrow by construction', () => {
    // GitHub sends no `x-oauth-scopes` for fine-grained tokens; the owner picked the
    // repositories at mint time, so there is nothing to warn about.
    const report = describeGitHubPatScope('github_pat_11ABCDE', null)
    expect(report.kind).toBe('fine_grained')
    expect(report.warnings).toEqual([])
  })

  it('reports an unreadable scope header rather than assuming narrow', () => {
    // A classic-looking token with no scope header: "we could not tell" is its own answer, and
    // must not render identically to "narrow".
    const report = describeGitHubPatScope('ghp_abc', null)
    expect(report.kind).toBe('unknown')
    expect(report.warnings.map((w) => w.code)).toEqual(['github_pat_scope_unreadable'])
  })

  // The header is PRESENT for every classic token, so an empty value is a positive statement
  // that this one grants nothing — the opposite fact from an absent header, and the one a reader
  // most easily produces by accident, since GitHub's form ticks nothing by default. Folded
  // together they classified as `unknown`, which sent every downstream reader to the
  // fine-grained code path where a repository read its OWNER could satisfy masked the gap.
  it('reads an empty scope header as no scopes granted, not as unreported', () => {
    const report = describeGitHubPatScope('ghp_abc', '')
    expect(report.kind).toBe('classic')
    expect(report.scopes).toEqual([])
    expect(report.warnings.map((w) => w.code)).toEqual(['github_pat_no_scopes'])
    // A header carrying only separators says the same thing.
    expect(codes('  ,  ')).toEqual(['github_pat_no_scopes'])
  })

  it('summarises each kind for the test verdict line', () => {
    expect(summarizeGitHubPatScope(describeGitHubPatScope('ghp_a', 'repo'))).toContain('repo')
    expect(summarizeGitHubPatScope(describeGitHubPatScope('github_pat_a', null))).toContain(
      'fine-grained',
    )
    expect(summarizeGitHubPatScope(describeGitHubPatScope('ghp_a', null))).toContain('not reported')
    expect(summarizeGitHubPatScope(describeGitHubPatScope('ghp_a', ''))).toContain('no scopes')
  })
})
