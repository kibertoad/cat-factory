import {
  type Block,
  type CreateReviewInput,
  type ExecutionInstance,
  type PrReviewStepState,
  type RepoFiles,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from '../harness.js'

// PR deep-review park → select → resolve (finish / fix / post), asserted identically against every
// facade. Extracted from `core.ts` as a cohesive sub-suite so that giant function stays within its
// line budget (see CLAUDE.md — split, don't raise the budget). Registers under the same parent
// `[name] conformance` describe because it's called from within `defineCoreConformance`'s body.
export function definePrReviewSuite(harness: ConformanceHarness): void {
  describe('PR deep-review (pr-reviewer park → select → resolve)', () => {
    // The read-only pr-reviewer's structured findings, returned by the fake as `result.custom`.
    const reviewerOutput = {
      summary: 'Mostly solid; one correctness concern.',
      slices: [{ title: 'Auth', rationale: 'auth + its test', paths: ['src/auth.ts'] }],
      findings: [
        {
          path: 'src/auth.ts',
          line: 12,
          side: 'RIGHT',
          severity: 'high',
          category: 'correctness',
          title: 'Missing null guard',
          detail: 'The token may be undefined here.',
          suggestedFix: 'Guard before dereferencing.',
        },
        {
          path: 'README.md',
          severity: 'nit',
          category: 'style',
          title: 'Typo',
          detail: 'teh → the',
        },
      ],
    }

    it('parks a review run on its findings, then resolves the human selection to done', async () => {
      const { call, createWorkspace, drive } = harness.makeApp({ customResult: reviewerOutput })
      const { workspace } = await createWorkspace({ seed: true })
      const wsId = workspace.id

      // A review task defaults to the pl_review pipeline (a single read-only pr-reviewer step).
      const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Review PR #42',
        taskType: 'review',
        taskTypeFields: { prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' },
      })
      expect(task.status).toBe(201)
      const start = await call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        { pipelineId: 'pl_review' },
      )
      expect(start.status).toBe(201)

      // Driving runs the reviewer; its findings are recorded onto the step and the run PARKS
      // for a human to select — it does NOT finish on its own.
      const parked = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(parked.status).toBe('blocked')
      const step = parked.steps.find((s) => s.agentKind === 'pr-reviewer')!
      expect(step.prReview?.status).toBe('awaiting_selection')
      expect(step.prReview?.prUrl).toBe('https://github.com/o/r/pull/42')
      // Findings are id-stamped, severity-ordered (high before nit), and anchored to a slice.
      const findings = step.prReview?.findings ?? []
      expect(findings.map((f) => f.severity)).toEqual(['high', 'nit'])
      expect(findings[0]!.id).toMatch(/^prf_/)
      expect(findings[0]!.sliceId).toBe(step.prReview?.slices?.[0]?.id)

      // The park raised a `pr_review_ready` inbox card (identically on both runtimes).
      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(snap.body.notifications?.some((n) => n.type === 'pr_review_ready')).toBe(true)

      // The GET returns the same active state.
      const active = await call<PrReviewStepState>(
        'GET',
        `/workspaces/${wsId}/executions/${parked.id}/pr-review`,
      )
      expect(active.body.status).toBe('awaiting_selection')

      // Resolving with a curated selection records it and advances the read-only run to done.
      const resolved = await call<PrReviewStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/pr-review/resolve`,
        { action: 'finish', findingIds: [findings[0]!.id] },
      )
      expect(resolved.status).toBe(200)
      expect(resolved.body.status).toBe('done')
      expect(resolved.body.selectedFindingIds).toEqual([findings[0]!.id])

      const done = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(done.status).toBe('done')
      const finalBlock = (
        await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      ).body.blocks.find((b) => b.id === task.body.id)!
      expect(finalBlock.status).toBe('done')
    })

    // A checkout-free RepoFiles capturing the deep-review resolutions' VCS writes/reads (the
    // suite's stand-in for a facade's GitHubClient-backed RepoFiles) — no real GitHub needed.
    const makeReviewRepo = (
      recorder: {
        headRefFor?: number
        posted?: { number: number; input: CreateReviewInput }[]
        /** Comment paths to REJECT (simulating GitHub's "Line could not be resolved" 422). */
        failPaths?: string[]
        /** The PR head sha the fake reports; mutate between drives to simulate a branch update. */
        headSha?: string | null
      },
      headRef: string | null = 'feature/pr-42',
    ): RepoFiles => ({
      getFile: async () => null,
      listDirectory: async () => [],
      headSha: async () => 'base-sha',
      createBranch: async () => {},
      deleteBranch: async () => {},
      commitFiles: async () => ({ sha: 'commit-sha' }),
      openPullRequest: async () => {
        throw new Error('not exercised by this test')
      },
      pullRequestHeadRef: async (number) => {
        recorder.headRefFor = number
        return headRef
      },
      pullRequestHeadSha: async () => recorder.headSha ?? null,
      createReview: async (number, input) => {
        ;(recorder.posted ??= []).push({ number, input })
        const fail = new Set(recorder.failPaths ?? [])
        return {
          comments: input.comments.map((c) =>
            fail.has(c.path)
              ? { posted: false, error: 'Line could not be resolved' }
              : { posted: true },
          ),
          bodyPosted: input.body ? true : null,
        }
      },
    })

    const seedReviewTask = async (
      call: ConformanceApp['call'],
      drive: ConformanceApp['drive'],
      wsId: string,
    ) => {
      const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Review PR #42',
        taskType: 'review',
        taskTypeFields: { prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' },
      })
      await call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
        pipelineId: 'pl_review',
      })
      const parked = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
      const step = parked.steps.find((s) => s.agentKind === 'pr-reviewer')!
      return {
        taskId: task.body.id,
        executionId: parked.id,
        findings: step.prReview?.findings ?? [],
      }
    }

    it('resolves with `fix` — re-dispatches the step as a Fixer on the reviewed PR head branch', async () => {
      const recorder: { headRefFor?: number } = {}
      const { call, createWorkspace, drive } = harness.makeApp(
        { customResult: reviewerOutput },
        {
          resolveRunRepoContext: async () => ({
            repo: makeReviewRepo(recorder),
            baseBranch: 'main',
          }),
        },
      )
      const { workspace } = await createWorkspace({ seed: true })
      const wsId = workspace.id
      const { taskId, executionId, findings } = await seedReviewTask(call, drive, wsId)

      // Resolve with `fix`, selecting the blocker finding — re-arms the step to `fixing`.
      const resolved = await call<PrReviewStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${executionId}/pr-review/resolve`,
        { action: 'fix', findingIds: [findings[0]!.id] },
      )
      expect(resolved.status).toBe(200)
      expect(resolved.body.status).toBe('fixing')
      expect(resolved.body.resolution).toBe('fix')

      // Driving dispatches + completes the Fixer against the PR head branch, then finishes.
      const done = (await drive(wsId)).find((e) => e.blockId === taskId)!
      expect(done.status).toBe('done')
      const finalStep = done.steps.find((s) => s.agentKind === 'pr-reviewer')!
      expect(finalStep.prReview?.status).toBe('done')
      expect(finalStep.prReview?.resolution).toBe('fix')
      // The Fixer resolved PR #42's head branch to clone + push to (a review task has no own PR).
      expect(recorder.headRefFor).toBe(42)
    })

    it('resolves with `post` — publishes the selected findings as inline PR review comments', async () => {
      const recorder: { posted?: { number: number; input: CreateReviewInput }[] } = {}
      const { call, createWorkspace, drive } = harness.makeApp(
        { customResult: reviewerOutput },
        {
          resolveRunRepoContext: async () => ({
            repo: makeReviewRepo(recorder),
            baseBranch: 'main',
          }),
        },
      )
      const { workspace } = await createWorkspace({ seed: true })
      const wsId = workspace.id
      const { taskId, executionId, findings } = await seedReviewTask(call, drive, wsId)

      // Resolve with `post`, selecting BOTH findings (one anchored, one line-less).
      const resolved = await call<PrReviewStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${executionId}/pr-review/resolve`,
        { action: 'post', findingIds: findings.map((f) => f.id) },
      )
      expect(resolved.status).toBe(200)
      expect(resolved.body.status).toBe('posting')

      // Driving posts the comments + finishes the read-only run with a full-success report.
      const done = (await drive(wsId)).find((e) => e.blockId === taskId)!
      expect(done.status).toBe('done')
      const finalStep = done.steps.find((s) => s.agentKind === 'pr-reviewer')!
      expect(finalStep.prReview?.status).toBe('done')
      expect(finalStep.prReview?.resolution).toBe('post')
      expect(finalStep.prReview?.postReport?.posted).toBe(1)
      expect(finalStep.prReview?.postReport?.failures ?? []).toHaveLength(0)
      expect(finalStep.prReview?.postedFindingIds).toContain(findings[0]!.id)

      // One review call, to PR #42, with the anchored finding as an inline comment.
      expect(recorder.posted).toHaveLength(1)
      expect(recorder.posted![0]!.number).toBe(42)
      expect(recorder.posted![0]!.input.event).toBe('COMMENT')
      expect(
        recorder.posted![0]!.input.comments.some((c) => c.path === 'src/auth.ts' && c.line === 12),
      ).toBe(true)
    })

    it('re-parks (does NOT fail the run) when a comment fails, carrying a retryable report', async () => {
      // GitHub rejects the anchored comment (line outside the diff). The old behaviour failed the
      // whole run and stuck the window; now the run RE-PARKS at `awaiting_selection` carrying a
      // report of what posted / what failed, so the human can retry ONLY the posting.
      const recorder: {
        posted?: { number: number; input: CreateReviewInput }[]
        failPaths?: string[]
      } = { failPaths: ['src/auth.ts'] }
      const { call, createWorkspace, drive } = harness.makeApp(
        { customResult: reviewerOutput },
        {
          resolveRunRepoContext: async () => ({
            repo: makeReviewRepo(recorder),
            baseBranch: 'main',
          }),
        },
      )
      const { workspace } = await createWorkspace({ seed: true })
      const wsId = workspace.id
      const { taskId, executionId, findings } = await seedReviewTask(call, drive, wsId)

      // Select the anchored (soon-to-fail) finding + resolve `post`.
      await call('POST', `/workspaces/${wsId}/executions/${executionId}/pr-review/resolve`, {
        action: 'post',
        findingIds: [findings[0]!.id],
      })

      // The run is parked again, NOT failed, and the step carries the failure report.
      const parked = (await drive(wsId)).find((e) => e.blockId === taskId)!
      expect(parked.status).toBe('blocked')
      const step = parked.steps.find((s) => s.agentKind === 'pr-reviewer')!
      expect(step.prReview?.status).toBe('awaiting_selection')
      expect(step.prReview?.postReport?.posted).toBe(0)
      expect(step.prReview?.postReport?.failures?.[0]?.reason).toMatch(/Line could not be resolved/)
      expect(step.prReview?.postedFindingIds ?? []).toHaveLength(0)
      // The inline comment failed but the summary/body comment DID land — so it is marked posted,
      // which suppresses re-posting it on the retry below (the body's at-most-once guard).
      expect(step.prReview?.postedBody).toBe(true)

      // Retry (the SAME `post`) after GitHub now accepts the comment — only the un-posted finding
      // is re-attempted, and the run completes without re-running the reviewer.
      recorder.failPaths = []
      await call('POST', `/workspaces/${wsId}/executions/${executionId}/pr-review/resolve`, {
        action: 'post',
        findingIds: [findings[0]!.id],
      })
      const done = (await drive(wsId)).find((e) => e.blockId === taskId)!
      expect(done.status).toBe('done')
      const finalStep = done.steps.find((s) => s.agentKind === 'pr-reviewer')!
      expect(finalStep.prReview?.status).toBe('done')
      expect(finalStep.prReview?.postedFindingIds).toContain(findings[0]!.id)
      // The summary/body comment was published exactly ONCE across both attempts — the retry
      // suppressed it (its body was empty) so the PR conversation isn't spammed with duplicates.
      const bodiesPosted = (recorder.posted ?? []).filter((p) => p.input.body).length
      expect(bodiesPosted).toBe(1)
    })

    it('folds every finding into the summary when the PR branch moved after the review started', async () => {
      // The reviewer anchored a finding to src/auth.ts:12, but the PR branch is force-pushed
      // AFTER the review parked. Posting that finding inline would stamp it onto a line that may
      // now be different code, so the `post` resolution detects the head drift and folds the
      // finding into the summary comment instead of anchoring it — the review still lands.
      const recorder: {
        posted?: { number: number; input: CreateReviewInput }[]
        headSha?: string | null
      } = { headSha: 'sha-at-review-start' }
      const { call, createWorkspace, drive } = harness.makeApp(
        { customResult: reviewerOutput },
        {
          resolveRunRepoContext: async () => ({
            repo: makeReviewRepo(recorder),
            baseBranch: 'main',
          }),
        },
      )
      const { workspace } = await createWorkspace({ seed: true })
      const wsId = workspace.id
      // Dispatching the reviewer captured the review-start head sha ('sha-at-review-start').
      const { taskId, executionId, findings } = await seedReviewTask(call, drive, wsId)

      // The PR head moves (a push) while the review sits parked awaiting selection.
      recorder.headSha = 'sha-after-push'

      // Post the anchored (line 12) finding — the drift must fold it rather than anchor it.
      await call('POST', `/workspaces/${wsId}/executions/${executionId}/pr-review/resolve`, {
        action: 'post',
        findingIds: [findings[0]!.id],
      })
      const done = (await drive(wsId)).find((e) => e.blockId === taskId)!
      expect(done.status).toBe('done')
      const step = done.steps.find((s) => s.agentKind === 'pr-reviewer')!
      expect(step.prReview?.status).toBe('done')
      // Nothing anchored inline; the finding was folded into the summary (reported as `folded`).
      expect(step.prReview?.postReport?.posted).toBe(0)
      expect(step.prReview?.postReport?.folded).toBe(1)
      expect(recorder.posted).toHaveLength(1)
      expect(recorder.posted![0]!.input.comments).toHaveLength(0)
      expect(recorder.posted![0]!.input.body).toContain('branch was updated')
    })
  })
}
