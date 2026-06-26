import type { GitHubClient, GitHubInstallationRepository } from '@cat-factory/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import { GitHubIssuesProvider } from './GitHubIssuesProvider.js'
import { JiraProvider } from './JiraProvider.js'

// Unit tests for the live "check setup" diagnostics on each provider. The probes
// classify real auth/permission/transport failures, so we drive a fake GitHub
// client (and a stubbed global fetch for Jira) through each failure mode and
// assert the resulting status — the contract the panel renders verbatim.

/** An error carrying an HTTP `status`, mirroring GitHubApiError / JiraApiError. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

const INSTALLATION = { installationId: 42, accountLogin: 'acme' }

/** A fake installations repo that resolves the workspace to a fixed installation (or none). */
function installations(found = true): GitHubInstallationRepository {
  return {
    getByWorkspace: async () => (found ? (INSTALLATION as never) : null),
  } as unknown as GitHubInstallationRepository
}

/** A fake GitHub client whose three diagnose-relevant calls are individually overridable. */
function githubClient(over: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getInstallation: async () => ({ accountLogin: 'acme', targetType: 'Organization', appId: '1' }),
    listInstallationRepos: async () => ({ items: [{ owner: 'acme', name: 'web' }] }),
    listIssues: async () => ({ items: [] }),
    ...over,
  } as unknown as GitHubClient
}

describe('GitHubIssuesProvider.diagnose', () => {
  const input = { workspaceId: 'ws_1', credentials: null }

  it('reports not_installed when the workspace has no installation', async () => {
    const p = new GitHubIssuesProvider({
      githubClient: githubClient(),
      installations: installations(false),
    })
    const d = await p.diagnose(input)
    expect(d.status).toBe('not_installed')
    expect(d.ok).toBe(false)
  })

  it('reports ready when all three probes succeed', async () => {
    const p = new GitHubIssuesProvider({
      githubClient: githubClient(),
      installations: installations(),
    })
    const d = await p.diagnose(input)
    expect(d.status).toBe('ready')
    expect(d.ok).toBe(true)
    expect(d.detail).toContain('1 repository')
  })

  it('classifies a 401 from the App credentials as auth_failed', async () => {
    const p = new GitHubIssuesProvider({
      githubClient: githubClient({
        getInstallation: async () => {
          throw httpError(401)
        },
      }),
      installations: installations(),
    })
    const d = await p.diagnose(input)
    expect(d.status).toBe('auth_failed')
  })

  it('classifies a 403 on the issues read as forbidden + names the Issues permission', async () => {
    const p = new GitHubIssuesProvider({
      githubClient: githubClient({
        listIssues: async () => {
          throw httpError(403)
        },
      }),
      installations: installations(),
    })
    const d = await p.diagnose(input)
    expect(d.status).toBe('forbidden')
    expect(d.message).toContain('Issues permission')
  })

  it('reports unreachable when a call throws without an HTTP status', async () => {
    const p = new GitHubIssuesProvider({
      githubClient: githubClient({
        getInstallation: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
      installations: installations(),
    })
    const d = await p.diagnose(input)
    expect(d.status).toBe('unreachable')
  })

  it('is ready (with a no-repos hint) when the App sees no repositories', async () => {
    const p = new GitHubIssuesProvider({
      githubClient: githubClient({ listInstallationRepos: async () => ({ items: [] }) as never }),
      installations: installations(),
    })
    const d = await p.diagnose(input)
    expect(d.status).toBe('ready')
    expect(d.detail).toContain('No repositories')
  })
})

describe('JiraProvider.diagnose', () => {
  const creds = {
    baseUrl: 'https://acme.atlassian.net',
    accountEmail: 'dev@acme.io',
    apiToken: 'tok',
  }
  const input = { workspaceId: 'ws_1', credentials: creds }
  const JIRA = 'https://acme.atlassian.net'
  const MYSELF = '/rest/api/3/myself'

  // The probe authenticates against the real Jira `/myself` endpoint over the global `fetch`;
  // intercept that real fetch with undici's MockAgent rather than replacing `fetch` wholesale.
  let agent: MockAgent
  let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

  beforeEach(() => {
    previousDispatcher = getGlobalDispatcher()
    agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
  })

  afterEach(async () => {
    setGlobalDispatcher(previousDispatcher)
    await agent.close()
  })

  /** Reply to the next `GET /myself` with a status + body. */
  function myself(status: number, body: string) {
    agent.get(JIRA).intercept({ path: MYSELF, method: 'GET' }).reply(status, body)
  }

  it('reports not_connected when credentials are missing', async () => {
    const d = await new JiraProvider().diagnose({ workspaceId: 'ws_1', credentials: null })
    expect(d.status).toBe('not_connected')
  })

  it('reports ready on a 200 /myself and surfaces the display name', async () => {
    myself(200, JSON.stringify({ displayName: 'Dev User' }))
    const d = await new JiraProvider().diagnose(input)
    expect(d.status).toBe('ready')
    expect(d.detail).toContain('Dev User')
  })

  it('classifies a 401 as auth_failed', async () => {
    myself(401, 'nope')
    const d = await new JiraProvider().diagnose(input)
    expect(d.status).toBe('auth_failed')
  })

  it('classifies a 403 as forbidden', async () => {
    myself(403, 'nope')
    const d = await new JiraProvider().diagnose(input)
    expect(d.status).toBe('forbidden')
  })

  it('reports unreachable when fetch throws', async () => {
    agent
      .get(JIRA)
      .intercept({ path: MYSELF, method: 'GET' })
      .replyWithError(new Error('getaddrinfo ENOTFOUND'))
    const d = await new JiraProvider().diagnose(input)
    expect(d.status).toBe('unreachable')
  })
})
