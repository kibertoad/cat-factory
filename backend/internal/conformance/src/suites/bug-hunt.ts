import {
  BUGFIX_PIPELINE_ID,
  type Block,
  type BugHuntAssessor,
  type BugHuntResult,
  type ExecutionInstance,
  type SourceTask,
  type TrackerBoard,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FakeTaskSourceProvider } from '../FakeTaskSourceProvider.js'
import type { ConformanceHarness } from '../harness.js'

// The interactive bug hunt (the dual of the recurring `bug-intake` step): list a tracker's
// boards, rank one board's open + unassigned bugs, adopt the confirmed candidate as a bug task
// and start its run.
//
// It persists nothing of its own, so what needs pinning across runtimes is the WIRING, not a
// schema: every facade must build the hunt service from its task-source registry and thread its
// ranking assessor through `createCore`. A facade that forgets either fails here rather than
// silently offering a board scan that never ranks, or a 503 on a connected tracker.

/**
 * A deterministic ranking producer: rates every candidate it is handed, impact descending in
 * the order it received them, so the suite can assert the ORDERING is applied without a model.
 * Deliberately returns the raw verdict shape the parser consumes (not the parsed one), so the
 * whole parse → score → join path is exercised.
 */
function fakeAssessor(): BugHuntAssessor {
  return {
    enabled: true,
    async assess({ candidates }) {
      return {
        model: 'fake:ranker',
        verdicts: {
          candidates: candidates.map((candidate, index) => ({
            externalId: candidate.externalId,
            // First candidate: high impact, low effort. Later ones get progressively worse
            // ratios, so a correct implementation returns them in the order they arrived.
            impact: Math.max(1, 5 - index),
            complexity: Math.min(5, 1 + index),
            confidence: 'high',
            rationale: `rated ${candidate.externalId}`,
            recommended: index === 0,
          })),
        },
      }
    },
  }
}

export function defineBugHuntConformance(harness: ConformanceHarness): void {
  describe('bug hunt', () => {
    /** A connected Jira fake holding an open backlog; the suite keeps the instance to inspect it. */
    async function setup(options: { assessor?: BugHuntAssessor } = {}) {
      const source = new FakeTaskSourceProvider('jira')
      const app = harness.makeApp(
        { confidence: 1 },
        {
          taskSourceProviders: [source],
          ...(options.assessor ? { bugHuntAssessor: options.assessor } : {}),
        },
      )
      const { workspace } = await app.createWorkspace()
      // Connect the source so the hunt can resolve its credentials (the fake accepts any bag).
      await app.call('POST', `/workspaces/${workspace.id}/task-sources/jira/connect`, {
        credentials: {
          baseUrl: 'https://acme.atlassian.net',
          accountEmail: 'd@a.io',
          apiToken: 't',
        },
      })
      return { app, source, wsId: workspace.id }
    }

    it('lists the tracker boards a hunt can be scoped to', async () => {
      const { app, source, wsId } = await setup()
      source.boards = [
        { id: 'PROJ', name: 'Platform', key: 'PROJ' },
        { id: 'WEB', name: 'Web app', key: 'WEB' },
      ]

      const res = await app.call<{ source: string; boards: TrackerBoard[] }>(
        'GET',
        `/workspaces/${wsId}/bug-hunt/jira/boards`,
      )
      expect(res.status).toBe(200)
      expect(res.body.source).toBe('jira')
      expect(res.body.boards.map((b) => b.id)).toEqual(['PROJ', 'WEB'])
      // The connection's stored credentials were used, not an empty bag.
      expect(source.boardCalls[0]?.credentials.apiToken).toBe('t')
    })

    it('refuses to list boards for a repo-backed source, whose board is its service repo', async () => {
      // GitHub Issues / GitLab Issues put every issue in one repository, and the one a hunt may
      // read is the repository its service frame is linked to. So there is no board to offer, and
      // offering the connection's repositories would aim a hunt at a repository nothing on this
      // board is linked to. The reason is what the SPA acts on: distinct from
      // `boards_unsupported`, which means "type the board in yourself".
      const source = new FakeTaskSourceProvider('github')
      const app = harness.makeApp({ confidence: 1 }, { taskSourceProviders: [source] })
      const { workspace } = await app.createWorkspace()

      const res = await app.call<{ error: { details?: { reason?: string } } }>(
        'GET',
        `/workspaces/${workspace.id}/bug-hunt/github/boards`,
      )

      expect(res.status).toBe(422)
      expect(res.body.error.details?.reason).toBe('board_from_service')
      // Refused before the provider is reached: the point is that nothing enumerates repos.
      expect(source.boardCalls).toEqual([])
    })

    it('ranks a board unassigned-only, best ratio first, and pushes the predicates down', async () => {
      const { app, source, wsId } = await setup({ assessor: fakeAssessor() })
      source.set('PROJ-1', { title: 'Checkout crashes', labels: ['bug'], assignee: null })
      source.set('PROJ-2', { title: 'Checkout total wrong', labels: ['bug'], assignee: null })
      // Already owned by a human, so it is not free to pick up and must never be offered.
      source.set('PROJ-3', { title: 'Checkout slow', labels: ['bug'], assignee: 'ada' })

      const res = await app.call<BugHuntResult>('POST', `/workspaces/${wsId}/bug-hunt/jira/hunts`, {
        containerId: 'blk_auth',
        board: 'PROJ',
        labels: ['bug'],
        titleFragment: 'Checkout',
      })
      expect(res.status).toBe(200)
      expect(res.body.analysisStatus).toBe('ranked')
      expect(res.body.model).toBe('fake:ranker')
      expect(res.body.candidates.map((c) => c.externalId)).toEqual(['PROJ-1', 'PROJ-2'])
      expect(res.body.scanned).toBe(2)
      expect(res.body.truncated).toBe(false)
      // The score is the platform's own impact/complexity, never a number the model supplied.
      expect(res.body.candidates[0]?.analysis?.score).toBe(5)
      expect(res.body.candidates[0]?.analysis?.recommended).toBe(true)
      expect(res.body.candidates[1]?.analysis?.score).toBe(2)

      // Every predicate reached the provider query, including the hunt's own unassigned-only
      // narrowing and the board scope mapped onto Jira's project field.
      const query = source.candidateCalls[0]?.query
      expect(query?.unassignedOnly).toBe(true)
      expect(query?.board.jiraProjectKey).toBe('PROJ')
      expect(query?.labels).toEqual(['bug'])
      expect(query?.titleFragment).toBe('Checkout')
    })

    it('returns the board scan unranked when no ranking model is wired', async () => {
      // A DISABLED assessor is how a deployment with no model looks to the service (the same
      // way the judge suite proves its unwired pass-through). The scan must still come back:
      // it is useful on its own, and presenting it as ranked would be the misleading outcome.
      const { app, source, wsId } = await setup({
        assessor: {
          enabled: false,
          assess: () => {
            throw new Error('a disabled assessor must never be called')
          },
        },
      })
      source.set('PROJ-9', { title: 'Broken link', labels: ['bug'], assignee: null })

      const res = await app.call<BugHuntResult>('POST', `/workspaces/${wsId}/bug-hunt/jira/hunts`, {
        containerId: 'blk_auth',
        board: 'PROJ',
      })
      expect(res.status).toBe(200)
      expect(res.body.analysisStatus).toBe('unavailable')
      expect(res.body.model).toBeNull()
      expect(res.body.candidates.map((c) => c.externalId)).toEqual(['PROJ-9'])
      expect(res.body.candidates[0]?.analysis).toBeNull()
    })

    it('still returns the board scan when the ranking itself fails', async () => {
      // A wired-but-broken model (revoked key, provider outage) must not cost the user the
      // scan they paid for — and must be reported as `failed`, distinctly from the `unavailable`
      // above, because "nobody configured a model" and "your model is broken" need different
      // fixes from whoever reads it.
      const { app, source, wsId } = await setup({
        assessor: {
          enabled: true,
          assess: async () => {
            throw new Error('provider unreachable')
          },
        },
      })
      source.set('PROJ-10', { title: 'Upload times out', labels: ['bug'], assignee: null })

      const res = await app.call<BugHuntResult>('POST', `/workspaces/${wsId}/bug-hunt/jira/hunts`, {
        containerId: 'blk_auth',
        board: 'PROJ',
      })
      expect(res.status).toBe(200)
      expect(res.body.analysisStatus).toBe('failed')
      expect(res.body.candidates.map((c) => c.externalId)).toEqual(['PROJ-10'])
      expect(res.body.candidates[0]?.analysis).toBeNull()
    })

    it('adopts a candidate as a bug task on the bug-fix pipeline and starts its run', async () => {
      const { app, source, wsId } = await setup({ assessor: fakeAssessor() })
      source.set('PROJ-5', {
        title: 'Coupon double-discounts shipping',
        labels: ['bug'],
        assignee: null,
        description: 'Applying a percentage coupon discounts the shipping line twice.',
      })

      const adopted = await app.call<{
        block: Block
        task: SourceTask
        execution: ExecutionInstance
      }>('POST', `/workspaces/${wsId}/bug-hunt/jira/adoptions`, {
        externalId: 'PROJ-5',
        containerId: 'blk_auth',
      })
      expect(adopted.status).toBe(201)

      // The new task is pre-classified from what the hunt already knows: a bug, pinned to the
      // built-in bug-fix pipeline, seeded from the issue and titled by its key.
      const block = adopted.body.block
      expect(block.level).toBe('task')
      expect(block.taskType).toBe('bug')
      expect(block.pipelineId).toBe(BUGFIX_PIPELINE_ID)
      expect(block.parentId).toBe('blk_auth')
      expect(block.title).toContain('PROJ-5')
      expect(block.title).toContain('Coupon double-discounts shipping')
      expect(block.description).toContain('discounts the shipping line twice')

      // The issue is linked to it, so every agent step gets the report as context.
      expect(adopted.body.task.externalId).toBe('PROJ-5')
      expect(adopted.body.task.linkedBlockId).toBe(block.id)

      // And the run is already going, on the pipeline the response reports.
      expect(adopted.body.execution.pipelineId).toBe(BUGFIX_PIPELINE_ID)
      expect(adopted.body.execution.blockId).toBe(block.id)
      const persisted = await app.blockRepository().get(wsId, block.id)
      expect(persisted?.taskType).toBe('bug')
    })

    it('never re-offers a bug already adopted onto a block', async () => {
      const { app, source, wsId } = await setup({ assessor: fakeAssessor() })
      source.set('PROJ-7', { title: 'Session drops', labels: ['bug'], assignee: null })
      source.set('PROJ-8', { title: 'Avatar missing', labels: ['bug'], assignee: null })

      await app.call('POST', `/workspaces/${wsId}/bug-hunt/jira/adoptions`, {
        externalId: 'PROJ-7',
        containerId: 'blk_auth',
      })

      const res = await app.call<BugHuntResult>('POST', `/workspaces/${wsId}/bug-hunt/jira/hunts`, {
        containerId: 'blk_auth',
        board: 'PROJ',
      })
      expect(res.status).toBe(200)
      // Excluded via the batched projection read, so a second person can't start a duplicate run
      // on the bug the first one just took.
      expect(res.body.candidates.map((c) => c.externalId)).toEqual(['PROJ-8'])
      expect(source.candidateCalls.at(-1)?.query.excludeExternalIds).toContain('PROJ-7')
    })
  })
}
