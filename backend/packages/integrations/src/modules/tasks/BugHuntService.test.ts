import type {
  BugCandidate,
  BugHuntAssessor,
  IssueIntakeQuery,
  SourceTask,
  TaskSourceProvider,
  TaskSourceRegistry,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { BUG_HUNT_SCAN_LIMIT, BugHuntService } from './BugHuntService.js'

// The service's own decisions, none of which the conformance suite can drive cheaply: the
// truncation probe (which needs a board bigger than the scan cap), and the three ways a hunt
// gives back an unranked scan. The conformance suite covers the wiring across runtimes; this
// covers what the service decides once it is wired.

function candidate(externalId: string): BugCandidate {
  return {
    source: 'jira',
    externalId,
    title: `Bug ${externalId}`,
    url: `https://acme.atlassian.net/browse/${externalId}`,
    status: 'To Do',
    type: 'Bug',
    priority: null,
    labels: [],
    description: 'something is broken',
    createdAt: '2026-01-01T00:00:00.000Z',
    commentCount: 0,
  }
}

/** A provider serving a fixed board, recording the query it was asked. */
function provider(board: BugCandidate[]) {
  const queries: IssueIntakeQuery[] = []
  const impl = {
    listBugCandidates: async (_c: unknown, query: IssueIntakeQuery) => {
      queries.push(query)
      return board.slice(0, query.limit)
    },
  } as unknown as TaskSourceProvider
  return { impl, queries }
}

function service(options: {
  board: BugCandidate[]
  assessor?: BugHuntAssessor
  isOverBudget?: (workspaceId: string) => Promise<boolean>
}) {
  const { impl, queries } = provider(options.board)
  const registry = { get: () => impl } as unknown as TaskSourceRegistry
  const hunt = new BugHuntService({
    taskSourceRegistry: registry,
    taskConnectionStore: {
      getByWorkspace: async () => ({ credentials: {} }),
    } as never,
    taskRepository: { listByWorkspace: async (): Promise<SourceTask[]> => [] } as never,
    importService: {} as never,
    linkService: {} as never,
    ...(options.assessor ? { assessor: options.assessor } : {}),
    ...(options.isOverBudget ? { isOverBudget: options.isOverBudget } : {}),
  })
  return { hunt, queries }
}

/** Rates everything it is given, so a ranked hunt is distinguishable from every degraded one. */
const ratingAssessor: BugHuntAssessor = {
  enabled: true,
  assess: async ({ candidates }) => ({
    model: 'fake:ranker',
    verdicts: {
      candidates: candidates.map((c) => ({
        externalId: c.externalId,
        impact: 4,
        complexity: 2,
        confidence: 'high',
        rationale: 'rated',
        recommended: false,
      })),
    },
  }),
}

describe('BugHuntService.hunt truncation', () => {
  it('reports a board holding MORE than the cap as truncated, and returns exactly the cap', async () => {
    const board = Array.from({ length: BUG_HUNT_SCAN_LIMIT + 5 }, (_, i) => candidate(`PROJ-${i}`))
    const { hunt, queries } = service({ board })

    const result = await hunt.hunt('ws_1', 'jira', { board: 'PROJ' })

    // The probe: one PAST the cap is what makes "the board holds more" answerable at all.
    expect(queries[0]?.limit).toBe(BUG_HUNT_SCAN_LIMIT + 1)
    expect(result.truncated).toBe(true)
    expect(result.candidates).toHaveLength(BUG_HUNT_SCAN_LIMIT)
    expect(result.scanned).toBe(BUG_HUNT_SCAN_LIMIT)
  })

  it('does NOT claim a board holds more when it holds exactly the cap', async () => {
    const board = Array.from({ length: BUG_HUNT_SCAN_LIMIT }, (_, i) => candidate(`PROJ-${i}`))
    const { hunt } = service({ board })

    const result = await hunt.hunt('ws_1', 'jira', { board: 'PROJ' })

    expect(result.truncated).toBe(false)
    expect(result.candidates).toHaveLength(BUG_HUNT_SCAN_LIMIT)
  })

  it('leaves a board comfortably under the cap untruncated', async () => {
    const { hunt } = service({ board: [candidate('PROJ-1'), candidate('PROJ-2')] })

    const result = await hunt.hunt('ws_1', 'jira', { board: 'PROJ' })

    expect(result.truncated).toBe(false)
    expect(result.scanned).toBe(2)
  })
})

describe('BugHuntService.hunt ranking degradation', () => {
  it('ranks when a model is wired and the workspace is within budget', async () => {
    const { hunt } = service({
      board: [candidate('PROJ-1')],
      assessor: ratingAssessor,
      isOverBudget: async () => false,
    })

    const result = await hunt.hunt('ws_1', 'jira', { board: 'PROJ' })

    expect(result.analysisStatus).toBe('ranked')
    expect(result.candidates[0]?.analysis?.score).toBe(2)
  })

  it('skips the billable ranking call when the workspace is over budget', async () => {
    let assessed = false
    const { hunt } = service({
      board: [candidate('PROJ-1')],
      assessor: {
        enabled: true,
        assess: async () => {
          assessed = true
          throw new Error('must not be called over budget')
        },
      },
      isOverBudget: async () => true,
    })

    const result = await hunt.hunt('ws_1', 'jira', { board: 'PROJ' })

    // Not spent, and reported as its own status: an exhausted budget is not a broken model,
    // and the scan the user asked for is still theirs.
    expect(assessed).toBe(false)
    expect(result.analysisStatus).toBe('over_budget')
    expect(result.model).toBeNull()
    expect(result.candidates.map((c) => c.externalId)).toEqual(['PROJ-1'])
    expect(result.candidates[0]?.analysis).toBeNull()
  })

  it('does not consult the budget when there is nothing to rank', async () => {
    let checked = false
    const { hunt } = service({
      board: [],
      assessor: ratingAssessor,
      isOverBudget: async () => {
        checked = true
        return true
      },
    })

    const result = await hunt.hunt('ws_1', 'jira', { board: 'PROJ' })

    expect(result.analysisStatus).toBe('empty')
    expect(checked).toBe(false)
  })

  it('reports a wired-but-broken model as failed, keeping the scan', async () => {
    const { hunt } = service({
      board: [candidate('PROJ-1')],
      assessor: {
        enabled: true,
        assess: async () => {
          throw new Error('provider unreachable')
        },
      },
      isOverBudget: async () => false,
    })

    const result = await hunt.hunt('ws_1', 'jira', { board: 'PROJ' })

    expect(result.analysisStatus).toBe('failed')
    expect(result.candidates).toHaveLength(1)
  })

  it('keeps the scan, and spends nothing, when the budget probe itself cannot answer', async () => {
    let assessed = false
    const { hunt } = service({
      board: [candidate('PROJ-1')],
      assessor: {
        enabled: true,
        assess: async () => {
          assessed = true
          throw new Error('must not be called on an unanswerable budget')
        },
      },
      isOverBudget: async () => {
        throw new Error('spend ledger unreachable')
      },
    })

    const result = await hunt.hunt('ws_1', 'jira', { board: 'PROJ' })

    // Fail closed on the guard, but never at the cost of the vendor read already paid for.
    expect(assessed).toBe(false)
    expect(result.analysisStatus).toBe('failed')
    expect(result.candidates).toHaveLength(1)
  })

  it('ranks with no budget guard wired at all', async () => {
    const { hunt } = service({ board: [candidate('PROJ-1')], assessor: ratingAssessor })

    expect((await hunt.hunt('ws_1', 'jira', { board: 'PROJ' })).analysisStatus).toBe('ranked')
  })
})

describe('BugHuntService.listBoards', () => {
  /** A registry serving one provider, so the refusal is decided by what that provider DECLARES. */
  function withProvider(impl: Partial<TaskSourceProvider>) {
    return new BugHuntService({
      taskSourceRegistry: {
        get: () => impl as TaskSourceProvider,
      } as unknown as TaskSourceRegistry,
      taskConnectionStore: { getByWorkspace: async () => ({ credentials: {} }) } as never,
      taskRepository: { listByWorkspace: async (): Promise<SourceTask[]> => [] } as never,
      importService: {} as never,
      linkService: {} as never,
    })
  }

  it('refuses a REPO-BACKED source, whose board is its service repo rather than a choice', async () => {
    // Declares BOTH: repo-backing is what decides, so a provider that could enumerate boards is
    // still refused. Offering its reachable repositories would let a hunt scan (and adopt from) a
    // repository nothing on this board is linked to.
    let listed = false
    const hunt = withProvider({
      repoScope: { matches: () => true },
      listBoards: async () => {
        listed = true
        return [{ id: 'acme/web', name: 'web', key: 'acme/web' }]
      },
    })

    await expect(hunt.listBoards('ws_1', 'github')).rejects.toMatchObject({
      details: { reason: 'board_from_service' },
    })
    expect(listed).toBe(false)
  })

  it('tells a source that simply cannot enumerate boards apart from that', async () => {
    // The two refusals lead the SPA to opposite places ("type the board in yourself" versus
    // "there is nothing to type"), so they must never collapse into one reason.
    const hunt = withProvider({})

    await expect(hunt.listBoards('ws_1', 'acme:servicenow')).rejects.toMatchObject({
      details: { reason: 'boards_unsupported' },
    })
  })

  it('lists a repo-less source through its provider, on the connection credentials', async () => {
    const calls: Record<string, string>[] = []
    const hunt = withProvider({
      listBoards: async (credentials) => {
        calls.push(credentials)
        return [{ id: 'PROJ', name: 'Platform', key: 'PROJ' }]
      },
    })

    expect((await hunt.listBoards('ws_1', 'jira')).map((b) => b.id)).toEqual(['PROJ'])
    expect(calls).toHaveLength(1)
  })
})

describe('BugHuntService board scope routing', () => {
  // Every leg here is a plain string, so a source routed to the wrong one fails as "no matching
  // issues" rather than as the mis-routing it is. That is exactly what happened when `gitlab`
  // joined the built-ins ahead of a leg of its own, so the routing is pinned per source.
  it.each([
    ['jira', 'PROJ', { jiraProjectKey: 'PROJ' }],
    ['linear', 'team_1', { linearTeamId: 'team_1' }],
    ['github', 'acme/web', { githubRepo: 'acme/web' }],
    ['gitlab', 'group/sub/web', { gitlabProject: 'group/sub/web' }],
    // A deployment-registered source takes the opaque leg only ITS provider interprets.
    ['acme:servicenow', 'QUEUE-1', { boardId: 'QUEUE-1' }],
  ] as const)('routes a %s board onto the leg its provider reads', async (source, board, leg) => {
    const { hunt, queries } = service({ board: [candidate('X-1')] })

    await hunt.hunt('ws_1', source, { board })

    expect(queries[0]!.board).toEqual(leg)
  })
})
