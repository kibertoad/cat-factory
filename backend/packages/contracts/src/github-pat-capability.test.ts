import { describe, expect, it } from 'vitest'
import {
  GITHUB_PAT_BLOCKING_CAPABILITIES,
  GITHUB_PAT_CAPABILITIES,
  GITHUB_PAT_CLASSIC_SCOPES,
  githubPatCapabilitiesSchema,
  githubPatCheckNeedsAttention,
  githubPatCheckSource,
  githubPatCreateUrl,
  missingGitHubPatCapabilities,
  type GitHubPatCapabilities,
  type GitHubPatCapabilityReport,
} from './github-pat-capability.js'

function report(
  capabilities: Partial<GitHubPatCapabilities>,
  overrides: Partial<GitHubPatCapabilityReport> = {},
): GitHubPatCapabilityReport {
  return {
    source: 'initiator',
    kind: 'classic',
    capabilities: {
      push: 'granted',
      pullRequests: 'granted',
      workflows: 'granted',
      ...capabilities,
    },
    probedRepos: [],
    deniedRepos: [],
    unprobedRepoCount: 0,
    webUrl: 'https://github.com',
    ...overrides,
  }
}

describe('the capability vocabulary', () => {
  // A RELATION over two lists this file does not own the contents of, rather than a count: the
  // per-capability verdict is an explicit object so a new capability fails the typecheck at each
  // construction site, and this is what stops the object and the picklist drifting apart.
  it('gives every capability in the picklist a slot in the verdict object', () => {
    expect([...GITHUB_PAT_CAPABILITIES].sort()).toEqual(
      Object.keys(githubPatCapabilitiesSchema.entries).sort(),
    )
  })

  it('draws every blocking capability from the same picklist', () => {
    for (const capability of GITHUB_PAT_BLOCKING_CAPABILITIES) {
      expect(GITHUB_PAT_CAPABILITIES).toContain(capability)
    }
  })
})

describe('missingGitHubPatCapabilities', () => {
  it('splits established gaps by whether they stop a pipeline', () => {
    expect(missingGitHubPatCapabilities(report({ push: 'missing', workflows: 'missing' }))).toEqual(
      { blocking: ['push'], advisory: ['workflows'] },
    )
  })

  // The distinction the whole tri-state exists for: a fine-grained token reports nothing about
  // its pull-request permission, and treating that silence as a refusal would nag every
  // correctly-configured deployment.
  it('never counts an unknown capability as missing', () => {
    expect(
      missingGitHubPatCapabilities(
        report({ push: 'unknown', pullRequests: 'unknown', workflows: 'unknown' }),
      ),
    ).toEqual({ blocking: [], advisory: [] })
  })
})

describe('githubPatCheckNeedsAttention', () => {
  it('raises on a rejected token', () => {
    expect(
      githubPatCheckNeedsAttention({ state: 'token_rejected', status: 401, source: 'initiator' }),
    ).toBe(true)
  })

  it('raises on an established blocking gap', () => {
    expect(
      githubPatCheckNeedsAttention({ state: 'checked', report: report({ push: 'missing' }) }),
    ).toBe(true)
  })

  // An upstream outage is not a permissions problem, and the remedy a banner would advertise
  // (mint a new token) is both wrong and expensive when GitHub was simply unreachable.
  it('stays silent when the probe could not get an answer', () => {
    expect(githubPatCheckNeedsAttention({ state: 'probe_failed', message: 'fetch failed' })).toBe(
      false,
    )
  })

  it('stays silent when no personal access token is in play', () => {
    expect(githubPatCheckNeedsAttention({ state: 'not_applicable' })).toBe(false)
  })

  // Advisory findings belong in the card, never as its reason for opening.
  it('stays silent when only a non-blocking capability is missing', () => {
    expect(
      githubPatCheckNeedsAttention({ state: 'checked', report: report({ workflows: 'missing' }) }),
    ).toBe(false)
  })
})

// Asserted by string rather than through `URL`: this package compiles with neither the DOM nor
// the Node lib (which is why the builder assembles its own query string), so the global is not in
// scope for its tests either.
describe('githubPatCreateUrl', () => {
  it('pre-selects the required scopes on the classic form', () => {
    expect(githubPatCreateUrl('classic', { webUrl: 'https://github.com' })).toBe(
      `https://github.com/settings/tokens/new?scopes=${encodeURIComponent(
        GITHUB_PAT_CLASSIC_SCOPES.join(','),
      )}`,
    )
  })

  it('carries an optional description through, percent-encoded', () => {
    expect(
      githubPatCreateUrl('classic', { webUrl: 'https://github.com', description: 'cat factory' }),
    ).toContain('&description=cat%20factory')
  })

  // GitHub's fine-grained form accepts no permission parameters, so a query string here would be
  // a link that LOOKS pre-filled and arrives with nothing selected.
  it('links the fine-grained form bare, with no query string', () => {
    expect(githubPatCreateUrl('fine_grained', { webUrl: 'https://github.com' })).toBe(
      'https://github.com/settings/personal-access-tokens/new',
    )
  })

  // Nothing is known about an unclassified token, so it lands on the form that CAN be pre-filled.
  it('sends an unclassified token to the pre-fillable form', () => {
    expect(githubPatCreateUrl('unknown', { webUrl: 'https://github.com' })).toContain(
      '/settings/tokens/new?',
    )
  })

  it('joins a host with a trailing slash without doubling it', () => {
    expect(githubPatCreateUrl('fine_grained', { webUrl: 'https://ghe.example.com/' })).toBe(
      'https://ghe.example.com/settings/personal-access-tokens/new',
    )
  })
})

describe('githubPatCheckSource', () => {
  // The state with no report is the one whose remedy is most easily misrouted, and the reason
  // the source rides the variant rather than being read off a report that may not exist.
  it('names the credential a rejected token belonged to', () => {
    expect(
      githubPatCheckSource({ state: 'token_rejected', status: 401, source: 'deployment' }),
    ).toBe('deployment')
  })

  it('reads a checked report’s source', () => {
    expect(githubPatCheckSource({ state: 'checked', report: report({}) })).toBe('initiator')
  })

  // Null is a real answer, not a default: neither state judged a credential, so a caller that
  // renders a remedy has nothing to attribute it to.
  it('answers null for the states that judged no credential', () => {
    expect(githubPatCheckSource({ state: 'not_applicable' })).toBeNull()
    expect(githubPatCheckSource({ state: 'probe_failed', message: 'fetch failed' })).toBeNull()
  })
})
