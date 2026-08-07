import { describe, expect, it } from 'vitest'
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
  TaskConnectionRepository,
  TaskSourceProvider,
  TaskSourceRegistry,
  TaskSourceSettingsRepository,
  VcsProvider,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { GITHUB_ISSUES_DESCRIPTOR } from './github-issues.logic.js'
import { GITLAB_ISSUES_DESCRIPTOR } from './gitlab-issues.logic.js'
import { TaskConnectionService } from './TaskConnectionService.js'

// The two VCS-backed task sources share ONE connection table with one row per workspace, so
// availability is not "a connection exists" but "the connection is THIS provider's". Reading
// only the existence made a GitLab-connected workspace offer GitHub Issues, whose import then
// resolved an empty App projection — a source that looks connected and answers nothing.

/** A stand-in provider carrying only what the availability branch reads: kind + descriptor. */
function source(kind: 'github' | 'gitlab'): TaskSourceProvider {
  return {
    kind,
    descriptor: kind === 'github' ? GITHUB_ISSUES_DESCRIPTOR : GITLAB_ISSUES_DESCRIPTOR,
  } as unknown as TaskSourceProvider
}

function service(connected: VcsProvider | null): TaskConnectionService {
  const installations = {
    async getByWorkspace() {
      if (!connected) return null
      return {
        installationId: 1,
        accountLogin: 'acme',
        provider: connected,
      } as GitHubInstallation
    },
  } as unknown as GitHubInstallationRepository
  return new TaskConnectionService({
    taskConnectionRepository: {
      async listByWorkspace() {
        return []
      },
    } as unknown as TaskConnectionRepository,
    taskSourceSettingsRepository: {
      async getByWorkspace() {
        return []
      },
    } as unknown as TaskSourceSettingsRepository,
    registry: {
      list: () => [source('github'), source('gitlab')],
      get: (kind: string) => (kind === 'github' ? source('github') : source('gitlab')),
    } as unknown as TaskSourceRegistry,
    workspaceRepository: {} as WorkspaceRepository,
    clock: { now: () => 0 },
    installations,
  })
}

async function availability(connected: VcsProvider | null): Promise<Record<string, boolean>> {
  const states = await service(connected).listSourceStates('ws1')
  return Object.fromEntries(states.map((s) => [s.source, s.available]))
}

describe('TaskConnectionService — VCS-backed source availability', () => {
  it('offers only the source matching the workspace’s connected provider', async () => {
    expect(await availability('github')).toEqual({ github: true, gitlab: false })
    expect(await availability('gitlab')).toEqual({ github: false, gitlab: true })
  })

  it('offers neither when the workspace has no VCS connection', async () => {
    expect(await availability(null)).toEqual({ github: false, gitlab: false })
  })

  it('names the provider’s own connect route when its source is unavailable', async () => {
    const onGitHub = await service('github').diagnose('ws1', 'gitlab')
    expect(onGitHub.status).toBe('not_installed')
    expect(onGitHub.message).toMatch(/personal access token under Integrations → GitLab/)

    const onGitLab = await service('gitlab').diagnose('ws1', 'github')
    expect(onGitLab.status).toBe('not_installed')
    expect(onGitLab.message).toMatch(/Install it under Integrations → GitHub/)
  })
})
