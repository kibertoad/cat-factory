import type { TaskSourceKind, TaskSourceState } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { type IssueSourceMatchDeps, matchIssueSources } from './assistant-module.js'

// What this covers: which trackers an assistant turn asks about a pasted reference.
//
// It is one predicate and one read, and both were wrong in ways nothing downstream could notice.
// The predicate decides whether a tracker nobody connected gets a vote: `enabled` defaults ON for
// a source with no settings row, so reading it alone counts every REGISTERED source as connected.
// The read decides how many round trips a turn costs, and a per-provider one grows with the
// registry on a path a person waits on.

function state(source: TaskSourceKind, over: Partial<TaskSourceState> = {}): TaskSourceState {
  return {
    source,
    label: source,
    available: true,
    enabled: true,
    ridesVcsProvider: null,
    supportsIntake: false,
    ignoredIntakePredicates: [],
    repoBacked: false,
    ...over,
  } as unknown as TaskSourceState
}

/** A registry whose providers all claim a reference, so only the PREDICATE decides the answer. */
function deps(
  states: TaskSourceState[],
  sources: TaskSourceKind[] = states.map((s) => s.source),
): { deps: IssueSourceMatchDeps; reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    deps: {
      registry: {
        list: () =>
          sources.map((source) => ({
            descriptor: { source },
            parseRef: (ref: string) => `${source}:${ref}`,
          })),
      },
      connectionService: {
        listSourceStates: async (workspaceId: string) => {
          reads.push(workspaceId)
          return states
        },
      },
    } as unknown as IssueSourceMatchDeps,
  }
}

describe('matchIssueSources', () => {
  it('asks only the sources that are CONNECTED, not the ones merely registered', async () => {
    // Linear has no settings row, so its `enabled` defaults to true; `available` is what says
    // nobody ever connected it. Counting it here turns a bare Jira key into an ambiguity whose
    // second answer does not exist, and can route an import at a source with no credential.
    const d = deps([state('jira'), state('linear', { available: false })])
    expect(await matchIssueSources(d.deps, 'ws_1', 'PROJ-12')).toEqual([
      { source: 'jira', externalId: 'jira:PROJ-12' },
    ])
  })

  it('skips a connected source the workspace has switched off', async () => {
    const d = deps([state('jira'), state('linear', { enabled: false })])
    expect((await matchIssueSources(d.deps, 'ws_1', 'PROJ-12')).map((m) => m.source)).toEqual([
      'jira',
    ])
  })

  it('reports every source that claims the reference, so ambiguity stays a question', async () => {
    const d = deps([state('jira'), state('linear')])
    expect((await matchIssueSources(d.deps, 'ws_1', 'PROJ-12')).map((m) => m.source)).toEqual([
      'jira',
      'linear',
    ])
  })

  it('skips a provider whose own parser does not recognise the reference', async () => {
    const d = deps([state('jira'), state('github')])
    const narrowed: IssueSourceMatchDeps = {
      ...d.deps,
      registry: {
        list: () => [
          { descriptor: { source: 'jira' }, parseRef: () => null },
          { descriptor: { source: 'github' }, parseRef: () => 'acme/api#1' },
        ],
      },
    } as unknown as IssueSourceMatchDeps
    expect(
      await matchIssueSources(narrowed, 'ws_1', 'https://github.com/acme/api/issues/1'),
    ).toEqual([{ source: 'github', externalId: 'acme/api#1' }])
  })

  it('reads the source states ONCE, however many providers are registered', async () => {
    // The N+1 this repo bans: a per-provider `isOffered` would be one repository read per
    // registered tracker, on a path a person is waiting on, growing with the registry.
    const d = deps([state('jira'), state('linear'), state('github'), state('gitlab')])
    await matchIssueSources(d.deps, 'ws_1', 'PROJ-12')
    expect(d.reads).toEqual(['ws_1'])
  })
})
