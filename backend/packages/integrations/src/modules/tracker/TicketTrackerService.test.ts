import { describe, expect, it, vi } from 'vitest'
import type { CreateTicketRequest, TrackerSettings } from '@cat-factory/kernel'
import {
  type FetchLike,
  type TicketTrackerServiceDependencies,
  TicketTrackerService,
} from './TicketTrackerService.js'

const request: CreateTicketRequest = {
  workspaceId: 'ws1',
  frameId: 'frame1',
  title: 'Tech debt: Auth',
  body: '# Findings\n\n- refactor sessions',
}

function settingsRepo(settings: TrackerSettings | null): TicketTrackerServiceDependencies['trackerSettingsRepository'] {
  return { get: async () => settings, put: async () => {} }
}

function makeSettings(over: Partial<TrackerSettings>): TrackerSettings {
  return { tracker: null, jiraProjectKey: null, updatedAt: 0, ...over }
}

describe('TicketTrackerService', () => {
  it('passes through when no tracker is selected', async () => {
    const svc = new TicketTrackerService({ trackerSettingsRepository: settingsRepo(null) })
    expect(await svc.createTicket(request)).toBeNull()
  })

  it('delegates to the injected GitHub filer when tracker = github', async () => {
    const fileGitHubIssue = vi.fn(async () => ({ externalId: 'a/b#7', url: 'https://gh/7' }))
    const svc = new TicketTrackerService({
      trackerSettingsRepository: settingsRepo(makeSettings({ tracker: 'github' })),
      fileGitHubIssue,
    })
    expect(await svc.createTicket(request)).toEqual({ externalId: 'a/b#7', url: 'https://gh/7' })
    expect(fileGitHubIssue).toHaveBeenCalledWith(request)
  })

  it('passes through github when no filer is wired', async () => {
    const svc = new TicketTrackerService({
      trackerSettingsRepository: settingsRepo(makeSettings({ tracker: 'github' })),
    })
    expect(await svc.createTicket(request)).toBeNull()
  })

  it('files a Jira issue over HTTP Basic with an ADF body', async () => {
    let captured: { url: string; init: { headers: Record<string, string>; body: string } } | null =
      null
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url, init }
      return { ok: true, status: 201, text: async () => '', json: async () => ({ key: 'ENG-42' }) }
    }
    const svc = new TicketTrackerService({
      trackerSettingsRepository: settingsRepo(makeSettings({ tracker: 'jira', jiraProjectKey: 'ENG' })),
      resolveJiraConnection: async () => ({
        baseUrl: 'https://team.atlassian.net/',
        accountEmail: 'me@co.com',
        apiToken: 'tok',
      }),
      fetchImpl,
    })

    const result = await svc.createTicket(request)
    expect(result).toEqual({ externalId: 'ENG-42', url: 'https://team.atlassian.net/browse/ENG-42' })
    expect(captured!.url).toBe('https://team.atlassian.net/rest/api/3/issue')
    expect(captured!.init.headers.authorization).toBe(`Basic ${btoa('me@co.com:tok')}`)
    const payload = JSON.parse(captured!.init.body)
    expect(payload.fields.project.key).toBe('ENG')
    expect(payload.fields.description.type).toBe('doc')
  })

  it('passes through jira when no project key / connection is set', async () => {
    const svc = new TicketTrackerService({
      trackerSettingsRepository: settingsRepo(makeSettings({ tracker: 'jira', jiraProjectKey: null })),
      resolveJiraConnection: async () => ({
        baseUrl: 'https://x',
        accountEmail: 'a',
        apiToken: 'b',
      }),
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) }),
    })
    expect(await svc.createTicket(request)).toBeNull()
  })

  it('throws a clear error on a Jira HTTP failure', async () => {
    const svc = new TicketTrackerService({
      trackerSettingsRepository: settingsRepo(makeSettings({ tracker: 'jira', jiraProjectKey: 'ENG' })),
      resolveJiraConnection: async () => ({ baseUrl: 'https://x', accountEmail: 'a', apiToken: 'b' }),
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'forbidden', json: async () => null }),
    })
    await expect(svc.createTicket(request)).rejects.toThrow(/403/)
  })
})
