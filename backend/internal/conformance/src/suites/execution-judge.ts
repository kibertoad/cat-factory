import { describe, expect, it } from 'vitest'
import {
  type ExecutionInstance,
  type JudgeAssessor,
  type JudgeRegistry,
  type JudgeStepState,
  type Pipeline,
  defaultJudgeRegistry,
} from '@cat-factory/kernel'
import type { ConformanceHarness } from '../harness.js'

// Cross-runtime conformance for JUDGES — the fourth step-taxonomy bucket (an LLM assessment
// against a rubric, compared to a per-task threshold, disposed as advance / park / bounce / fail).
// See `docs/initiatives/judge-registry.md`.
//
// The verdict producer is injected through the app-owned `judgeAssessor` seam (the
// `testerQualityReviewer` precedent), so the whole loop is driven deterministically with NO model
// on either runtime. Everything asserted here is state a facade could get wrong independently:
// the registry merge, the `step.judge` round-trip through its store, the park's decision id, the
// bounce's producer rewind, and the unwired pass-through.

/** A deterministic {@link JudgeAssessor}: replays a queued score list (the last entry repeats). */
function fakeAssessor(scores: number[], enabled = true): JudgeAssessor & { calls: number } {
  let i = 0
  return {
    enabled,
    calls: 0,
    async assess() {
      const self = this as { calls: number }
      self.calls += 1
      const score = scores[Math.min(i, scores.length - 1)] ?? 1
      i += 1
      return {
        verdict: {
          score,
          summary: `scored ${score}`,
          findings:
            score < 1
              ? [{ title: 'Out of scope change', detail: 'touched an unrelated module', severity: 'high' }]
              : [],
        },
        model: 'fake:judge',
      }
    },
  }
}

/** Register a `scope-judge` judge with the given failure disposition on a fresh registry. */
function makeJudgeRegistry(onFail: 'park' | 'bounce' | 'fail'): JudgeRegistry {
  const registry = defaultJudgeRegistry()
  registry.register('scope-judge', () => ({
    kind: 'scope-judge',
    rubric: {
      id: 'rubric_scope',
      name: 'Scope adherence',
      body: 'The change must do what the task asked and nothing else.',
    },
    onFail,
    bounceTargets: ['coder'],
    presentation: {
      label: 'Scope judge',
      icon: 'i-lucide-scale',
      color: '#f59e0b',
      description: 'Scores the work against the scope-adherence rubric.',
      category: 'review',
    },
  }))
  return registry
}

/** Find the run's judge step, which every assertion below reads. */
function judgeStep(exec: ExecutionInstance): { judge: JudgeStepState | null | undefined; state: string } {
  const step = exec.steps.find((s) => s.agentKind === 'scope-judge')!
  return { judge: step.judge, state: step.state }
}

export function defineJudgeConformance(harness: ConformanceHarness): void {
  describe('registered judge (rubric verdict gate)', () => {
    it('passes a verdict at or above the threshold and advances the run', async () => {
      const judgeRegistry = makeJudgeRegistry('park')
      const judgeAssessor = fakeAssessor([0.9])
      const app = harness.makeApp({ asyncKinds: ['coder'] }, { judgeRegistry, judgeAssessor })
      const { workspace } = await app.createWorkspace()
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${workspace.id}/pipelines`, {
        name: 'Build + scope judge',
        agentKinds: ['coder', 'scope-judge'],
      })
      const start = await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(workspace.id)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const { judge, state } = judgeStep(exec)
      expect(state).toBe('done')
      expect(judge?.status).toBe('passed')
      expect(judge?.disposition).toBe('pass')
      // The threshold comes from the task's merge preset, not the registration.
      expect(judge?.threshold).toBe(0.7)
      expect(judge?.verdict?.score).toBe(0.9)
      expect(judge?.model).toBe('fake:judge')
      // The whole round history is persisted, not just the latest verdict.
      expect(judge?.rounds?.length).toBe(1)
      expect(judgeAssessor.calls).toBe(1)
    })

    it('parks the run on a decision when the verdict misses the threshold', async () => {
      const judgeRegistry = makeJudgeRegistry('park')
      const app = harness.makeApp(
        { asyncKinds: ['coder'] },
        { judgeRegistry, judgeAssessor: fakeAssessor([0.2]) },
      )
      const { workspace } = await app.createWorkspace()
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${workspace.id}/pipelines`, {
        name: 'Build + scope judge',
        agentKinds: ['coder', 'scope-judge'],
      })
      await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })

      const exec = (await app.drive(workspace.id)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('blocked')
      const step = exec.steps.find((s) => s.agentKind === 'scope-judge')!
      expect(step.state).toBe('waiting_decision')
      expect(step.approval?.status).toBe('pending')
      expect(step.judge?.status).toBe('awaiting_decision')
      expect(step.judge?.disposition).toBe('park')
      expect(step.judge?.verdict?.findings?.[0]?.title).toBe('Out of scope change')

      // The park is answerable over HTTP, and `proceed` overrules the rubric + advances the run.
      const resolved = await app.call<JudgeStepState>(
        'POST',
        `/workspaces/${workspace.id}/executions/${exec.id}/judge/resolve`,
        { choice: 'proceed' },
      )
      expect(resolved.status).toBe(200)
      expect(resolved.body.status).toBe('passed')
      expect(resolved.body.resolution?.choice).toBe('proceed')

      const after = (await app.drive(workspace.id)).find((e) => e.blockId === 'task_login')!
      expect(after.status).toBe('done')
    })

    it('bounces the producing step with rework feedback, then passes on the re-judgement', async () => {
      const judgeRegistry = makeJudgeRegistry('bounce')
      // Red first, clean after the coder re-ran — the bounce budget (1) covers exactly one round.
      const judgeAssessor = fakeAssessor([0.3, 0.95])
      const app = harness.makeApp({ asyncKinds: ['coder'] }, { judgeRegistry, judgeAssessor })
      const { workspace } = await app.createWorkspace()
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${workspace.id}/pipelines`, {
        name: 'Build + scope judge',
        agentKinds: ['coder', 'scope-judge'],
      })
      await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })

      const exec = (await app.drive(workspace.id)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const { judge } = judgeStep(exec)
      // One rework round was spent, and BOTH rounds are recorded — a bounce that left no trace
      // would make a looping judge a black box, exactly like an untracked gate attempt.
      expect(judge?.bounces).toBe(1)
      expect(judge?.rounds?.map((r) => r.disposition)).toEqual(['bounce', 'pass'])
      expect(judge?.status).toBe('passed')
      // The coder actually re-ran: the assessor saw the work twice.
      expect(judgeAssessor.calls).toBe(2)
      // The bounce briefed the producer with the verdict's findings.
      const coder = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(coder.state).toBe('done')
    })

    it('fails the run when the registration disposes a failing verdict as fail', async () => {
      const judgeRegistry = makeJudgeRegistry('fail')
      const app = harness.makeApp(
        { asyncKinds: ['coder'] },
        { judgeRegistry, judgeAssessor: fakeAssessor([0.1]) },
      )
      const { workspace } = await app.createWorkspace()
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${workspace.id}/pipelines`, {
        name: 'Build + scope judge',
        agentKinds: ['coder', 'scope-judge'],
      })
      await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })

      const exec = (await app.drive(workspace.id)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')
      expect(judgeStep(exec).judge?.status).toBe('failed')
    })

    it('passes THROUGH when no assessment model is wired, leaving the run unchanged', async () => {
      // The load-bearing guarantee: a deployment (or a test suite) with no model wired behaves
      // byte-for-byte as it did before judges existed. Asserted explicitly on both runtimes,
      // because a facade that accidentally hard-required an assessor would break every pipeline.
      const judgeRegistry = makeJudgeRegistry('fail')
      const judgeAssessor = fakeAssessor([0], /* enabled */ false)
      const app = harness.makeApp({ asyncKinds: ['coder'] }, { judgeRegistry, judgeAssessor })
      const { workspace } = await app.createWorkspace()
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${workspace.id}/pipelines`, {
        name: 'Build + scope judge',
        agentKinds: ['coder', 'scope-judge'],
      })
      await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })

      const exec = (await app.drive(workspace.id)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const { judge, state } = judgeStep(exec)
      expect(state).toBe('done')
      // Skipped WITH a note — a judge that quietly did nothing must not read like one that passed.
      expect(judge?.status).toBe('skipped')
      expect(judge?.note).toContain('no assessment model')
      expect(judgeAssessor.calls).toBe(0)
    })

    it('surfaces a registered judge in the workspace snapshot palette', async () => {
      const app = harness.makeApp(
        {},
        { judgeRegistry: makeJudgeRegistry('park'), judgeAssessor: fakeAssessor([1]) },
      )
      const snapshot = await app.createWorkspace()
      const entry = (snapshot.customAgentKinds ?? []).find((k) => k.kind === 'scope-judge')
      expect(entry).toBeDefined()
      expect(entry?.presentation.label).toBe('Scope judge')
      // A judge's assessment is an inline LLM call, never a container dispatch.
      expect(entry?.container).toBe(false)
      // It opens the shared judge window rather than the generic prose panel.
      expect(entry?.presentation.resultView).toBe('judge')
    })
  })
}
