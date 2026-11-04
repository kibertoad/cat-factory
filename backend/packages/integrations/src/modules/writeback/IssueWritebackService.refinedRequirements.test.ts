import { describe, expect, it } from 'vitest'
import { sameIssueDescription } from '@cat-factory/kernel'
import type {
  TaskRecord,
  TaskRepository,
  TaskSourceKind,
  TaskSourceProvider,
  TrackerSettings,
  TrackerSettingsRepository,
} from '@cat-factory/kernel'
import { IssueWritebackService } from './IssueWritebackService.js'

const DOCUMENT = '# Export Requirements\n\n## Overview\nAsk @alice whether this closes #42.'

function issue(source: TaskSourceKind, externalId: string): TaskRecord {
  return { workspaceId: 'ws', source, externalId, linkedBlockId: 'blk_1' } as TaskRecord
}

function tasks(issues: TaskRecord[]): TaskRepository {
  return { listByBlock: async () => issues } as unknown as TaskRepository
}

function settings(over: Partial<TrackerSettings> | null = null): TrackerSettingsRepository {
  return { get: async () => over as TrackerSettings | null } as unknown as TrackerSettingsRepository
}

/** A tracker holding one description per issue, compared the way the real adapters compare. */
function trackerSource(kind: TaskSourceKind, opts: { fail?: boolean; describe?: boolean } = {}) {
  const descriptions = new Map<string, string>()
  const writes: string[] = []
  const provider = {
    kind,
    writeback: {
      authenticates: 'out-of-band',
      async comment() {},
      ...(opts.describe === false
        ? {}
        : {
            async replaceDescription(_ctx: unknown, externalId: string, body: string) {
              if (opts.fail) throw new Error('tracker down for https://x.test/?token=sk-secret')
              if (sameIssueDescription(descriptions.get(externalId), body)) return 'unchanged'
              descriptions.set(externalId, body)
              writes.push(externalId)
              return 'updated'
            },
          }),
    },
  } as unknown as TaskSourceProvider
  return { provider, descriptions, writes }
}

describe('IssueWritebackService.writeRefinedRequirements', () => {
  it('writes the defused document into every linked description, and only once', async () => {
    const github = trackerSource('github')
    const jira = trackerSource('jira')
    const svc = new IssueWritebackService({
      trackerSettingsRepository: settings(),
      taskRepository: tasks([issue('github', 'acme/web#3'), issue('jira', 'ENG-7')]),
      taskSourceProviders: [github.provider, jira.provider],
    })

    const first = await svc.writeRefinedRequirements('ws', 'blk_1', DOCUMENT, 'manual')
    expect(first).toEqual({
      issues: [
        { source: 'github', externalId: 'acme/web#3', outcome: 'updated' },
        { source: 'jira', externalId: 'ENG-7', outcome: 'updated' },
      ],
    })
    const body = github.descriptions.get('acme/web#3')!
    expect(body).toContain('## Overview')
    expect(body).toContain("The previous description is in this issue's history")
    // Model-authored text reaches a host-parsed surface defused: no mention, no cross-link.
    expect(body).not.toContain('@alice')
    expect(body).not.toContain('#42')

    const again = await svc.writeRefinedRequirements('ws', 'blk_1', DOCUMENT, 'manual')
    expect(again).toEqual({
      issues: [
        { source: 'github', externalId: 'acme/web#3', outcome: 'already_current' },
        { source: 'jira', externalId: 'ENG-7', outcome: 'already_current' },
      ],
    })
    expect(github.writes).toHaveLength(1)
    expect(jira.writes).toHaveLength(1)
  })

  it('answers disabled for an automatic trigger unless the workspace opted in', async () => {
    const github = trackerSource('github')
    const deps = {
      taskRepository: tasks([issue('github', 'acme/web#3')]),
      taskSourceProviders: [github.provider],
    }
    const off = new IssueWritebackService({ ...deps, trackerSettingsRepository: settings() })
    expect(await off.writeRefinedRequirements('ws', 'blk_1', DOCUMENT, 'automatic')).toBe(
      'disabled',
    )
    expect(github.writes).toEqual([])

    const on = new IssueWritebackService({
      ...deps,
      trackerSettingsRepository: settings({ writebackRequirementsToDescription: true }),
    })
    const result = await on.writeRefinedRequirements('ws', 'blk_1', DOCUMENT, 'automatic')
    expect(result).toEqual({
      issues: [{ source: 'github', externalId: 'acme/web#3', outcome: 'updated' }],
    })
  })

  it('isolates a failing tracker and keeps writing the others', async () => {
    const broken = trackerSource('jira', { fail: true })
    const github = trackerSource('github')
    const svc = new IssueWritebackService({
      trackerSettingsRepository: settings(),
      taskRepository: tasks([issue('jira', 'ENG-7'), issue('github', 'acme/web#3')]),
      taskSourceProviders: [broken.provider, github.provider],
    })
    const result = await svc.writeRefinedRequirements('ws', 'blk_1', DOCUMENT, 'manual')
    expect(result !== 'disabled' && result.issues.map((r) => r.outcome)).toEqual([
      'failed',
      'updated',
    ])
  })

  it('reports a source with no description write, or no writeback at all, as unsupported', async () => {
    const noDescribe = trackerSource('linear', { describe: false })
    const svc = new IssueWritebackService({
      trackerSettingsRepository: settings(),
      taskRepository: tasks([
        issue('linear', 'ENG-1'),
        issue('acme-tracker' as TaskSourceKind, 'A-1'),
      ]),
      taskSourceProviders: [noDescribe.provider],
    })
    const result = await svc.writeRefinedRequirements('ws', 'blk_1', DOCUMENT, 'manual')
    expect(result !== 'disabled' && result.issues.map((r) => r.outcome)).toEqual([
      'unsupported',
      'unsupported',
    ])
  })

  it('returns an empty result for a block with no linked issues', async () => {
    const svc = new IssueWritebackService({
      trackerSettingsRepository: settings(),
      taskRepository: tasks([]),
    })
    expect(await svc.writeRefinedRequirements('ws', 'blk_1', DOCUMENT, 'manual')).toEqual({
      issues: [],
    })
  })
})
