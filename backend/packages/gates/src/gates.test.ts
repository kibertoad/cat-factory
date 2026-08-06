import type {
  Block,
  ExecutionInstance,
  GateStepState,
  IncidentUpdate,
  PipelineStep,
  RaiseNotificationInput,
  ReleaseSignal,
  GateHelperJobResult,
  ProviderRegistry,
} from '@cat-factory/kernel'
import { DEFAULT_RISK_POLICY, defaultProviderRegistry, stubGateContext } from '@cat-factory/kernel'
import type { DescriptorFieldValues } from '@cat-factory/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ciGate, conflictsGate, docQualityGate, postReleaseHealthGate } from './gates.js'
import {
  wireCiStatusProvider,
  wireDocQualityProvider,
  wireIncidentEnrichment,
  wireMergeabilityProvider,
  wireReleaseHealthProvider,
} from './providers.js'
import { gateRegistryWithBuiltins } from './index.js'

// The built-in gates' VERDICTS and their give-up paths. `index.test.ts` covers the wiring seam and
// the happy/failed probe of each gate; what is pinned here is the part a run's behaviour turns on:
// which budget a step gets, what a pass says, and what the operator is told when a gate gives up.

let providerRegistry: ProviderRegistry
beforeEach(() => {
  providerRegistry = defaultProviderRegistry()
})

const NOW = 1_700_000_000_000
const MINUTE = 60_000

const gateState = (over: Partial<GateStepState> = {}): GateStepState =>
  ({ phase: 'checking', attempts: 0, maxAttempts: 3, ...over }) as GateStepState

const config = (values: Record<string, unknown>) => values as DescriptorFieldValues

const instance = { id: 'ex_1', pipelineName: 'Ship it' } as ExecutionInstance
const block = (over: Partial<Block> = {}) =>
  ({ id: 'blk_1', title: 'Login', ...over }) as unknown as Block

/** A step whose gate state carries whatever the exhaustion path is meant to read back. */
const step = (gate: Partial<GateStepState> = {}) =>
  ({ agentKind: 'ci', gate: gateState(gate) }) as unknown as PipelineStep

function recordingContext(overrides: Parameters<typeof stubGateContext>[0] = {}) {
  const raised: RaiseNotificationInput[] = []
  const ctx = stubGateContext(
    {
      clock: { now: () => NOW },
      raiseNotification: async (_ws, input) => void raised.push(input),
      ...overrides,
    },
    providerRegistry,
  )
  return { ctx, raised }
}

describe('attempt budgets', () => {
  const preset = DEFAULT_RISK_POLICY

  it('gives the CI gate the task preset’s budget, and lets the STEP override it', () => {
    const gate = ciGate(stubGateContext({}, providerRegistry))
    expect(gate.attemptBudget?.(preset, config({}))).toBe(preset.ciMaxAttempts)
    // The step's own budget wins: "this pipeline's CI gate gets three rounds" is a property of
    // the pipeline, not of the workspace-wide preset.
    expect(gate.attemptBudget?.(preset, config({ maxAttempts: 3 }))).toBe(3)
    expect(gate.attemptBudget?.(preset, config({ maxAttempts: 0 }))).toBe(0)
  })

  it('caps conflict-resolver rounds low, independently of the CI budget', () => {
    // A conflict retry re-merges the SAME base and gets no new signal, so a large budget just
    // burns containers on the same conflict. It must not inherit CI's much larger default.
    const gate = conflictsGate(stubGateContext({}, providerRegistry))
    const budget = gate.attemptBudget?.(preset, config({})) ?? Number.MAX_SAFE_INTEGER
    expect(budget).toBe(3)
    expect(budget).toBeLessThan(preset.ciMaxAttempts)
    expect(gate.attemptBudget?.(preset, config({ maxAttempts: 7 }))).toBe(7)
  })

  it('caps doc-fixer rounds low: a document still failing after two rounds needs a human', () => {
    const gate = docQualityGate(stubGateContext({}, providerRegistry))
    expect(gate.attemptBudget?.(preset, config({}))).toBe(2)
    expect(gate.attemptBudget?.(preset, config({ maxAttempts: 5 }))).toBe(5)
  })

  it('gives post-release health the preset’s on-call budget, overridable per step', () => {
    const gate = postReleaseHealthGate(stubGateContext({}, providerRegistry))
    expect(gate.attemptBudget?.(preset, config({}))).toBe(preset.releaseMaxAttempts)
    expect(gate.attemptBudget?.(preset, config({ maxAttempts: 4 }))).toBe(4)
  })

  it('names the gate in every pass-through output, so an unwired gate explains itself', () => {
    // The step output an operator reads when a gate did nothing. An empty (or generic) one
    // leaves them looking for a gate that never ran.
    const registry = gateRegistryWithBuiltins()
    for (const { factory } of registry.factories()) {
      const output = factory(stubGateContext({}, providerRegistry)).unwiredOutput
      expect(output).toMatch(/provider/)
      expect(output.toLowerCase()).toContain('skipped')
    }
  })
})

describe('ci gate', () => {
  const ciReport = (
    repos: { repo: string; headSha: string | null; conclusions: (string | null)[] }[],
  ) => ({
    repos: repos.map((r) => ({
      repo: r.repo,
      headSha: r.headSha,
      checks: r.conclusions.map((conclusion, i) => ({
        name: `check-${i}`,
        status: conclusion === null ? 'in_progress' : 'completed',
        conclusion,
        url: null,
      })),
    })),
  })

  it('passes with NOTHING spun up when the head has no checks configured', async () => {
    wireCiStatusProvider(providerRegistry, {
      getStatus: async () => ciReport([{ repo: 'o/r', headSha: 'sha', conclusions: [] }]),
    })
    const probe = await ciGate(stubGateContext({}, providerRegistry)).probe('ws', 'b', gateState())
    expect(probe.status).toBe('pass')
    // "No checks" and "checks green" are different facts, and the output says which one it is.
    expect(probe.passOutput).toContain('no checks configured')
  })

  it('counts the checks across EVERY repo the task opened a PR in', async () => {
    wireCiStatusProvider(providerRegistry, {
      getStatus: async () =>
        ciReport([
          { repo: 'o/own', headSha: 'a', conclusions: ['success', 'success'] },
          { repo: 'o/peer', headSha: 'b', conclusions: ['success'] },
        ]),
    })
    const probe = await ciGate(stubGateContext({}, providerRegistry)).probe('ws', 'b', gateState())
    expect(probe.status).toBe('pass')
    expect(probe.passOutput).toBe('CI gate passed: 3 check(s) green across 2 repos.')

    // A single-repo task says so without the repo count.
    wireCiStatusProvider(providerRegistry, {
      getStatus: async () =>
        ciReport([{ repo: 'o/own', headSha: 'a', conclusions: ['success', 'success'] }]),
    })
    const single = await ciGate(stubGateContext({}, providerRegistry)).probe('ws', 'b', gateState())
    expect(single.passOutput).toBe('CI gate passed: 2 check(s) green.')
  })

  it('keeps polling while any check is still running', async () => {
    wireCiStatusProvider(providerRegistry, {
      getStatus: async () =>
        ciReport([{ repo: 'o/r', headSha: 'sha', conclusions: ['success', null] }]),
    })
    const probe = await ciGate(stubGateContext({}, providerRegistry)).probe('ws', 'b', gateState())
    expect(probe.status).toBe('pending')
    expect(probe.headSha).toBe('sha')
  })

  it('fails on a red check in ANY repo, listing the failing checks for the fixer', async () => {
    wireCiStatusProvider(providerRegistry, {
      getStatus: async () =>
        ciReport([
          { repo: 'o/own', headSha: 'a', conclusions: ['success'] },
          { repo: 'o/peer', headSha: 'b', conclusions: ['failure'] },
        ]),
    })
    const probe = await ciGate(stubGateContext({}, providerRegistry)).probe('ws', 'b', gateState())
    expect(probe.status).toBe('fail')
    expect(probe.failingChecks?.map((c) => c.repo)).toEqual(['o/peer'])
    expect(probe.failureSummary).toContain('o/peer')
  })

  it('tells a human how many fixer rounds were spent when it gives up', async () => {
    const { ctx, raised } = recordingContext()
    const result = await ciGate(ctx).onExhausted({
      workspaceId: 'ws',
      instance,
      block: block({ pullRequest: { url: 'https://host/pr/7' } } as Partial<Block>),
      step: step({ attempts: 4 }),
      summary: 'check-0 failed',
    })
    expect(raised[0]?.type).toBe('ci_failed')
    expect(raised[0]?.title).toContain('Login')
    expect(raised[0]?.body).toContain('4 time(s)')
    expect(raised[0]?.body).toContain('check-0 failed')
    expect(raised[0]?.executionId).toBe('ex_1')
    expect(raised[0]?.payload).toEqual({ prUrl: 'https://host/pr/7', pipelineName: 'Ship it' })
    expect(result.error).toContain('4 CI-fixer attempt(s)')
    expect(result.error).toContain('check-0 failed')
  })

  it('omits the PR link from the card when the task never opened one', async () => {
    const { ctx, raised } = recordingContext()
    const result = await ciGate(ctx).onExhausted({
      workspaceId: 'ws',
      instance,
      block: block(),
      // A step that never reached a gate state at all: the count is still reported as zero, and
      // the error carries no dangling summary separator.
      step: {} as unknown as PipelineStep,
      summary: undefined,
    })
    expect(raised[0]?.payload).toEqual({ pipelineName: 'Ship it' })
    expect(raised[0]?.body).toContain('0 time(s)')
    expect(result.error).toBe('CI did not pass after 0 CI-fixer attempt(s).')
  })
})

describe('conflicts gate', () => {
  const mergeability = (
    repos: { repo: string; headSha: string | null; verdict: string; frameId?: string }[],
  ) => ({ getMergeability: async () => ({ repos }) })

  it('advances when no PR resolved anywhere: there is nothing to gate', async () => {
    wireMergeabilityProvider(
      providerRegistry,
      mergeability([{ repo: 'o/r', headSha: null, verdict: 'unknown' }]) as never,
    )
    const probe = await conflictsGate(stubGateContext({}, providerRegistry)).probe(
      'ws',
      'b',
      gateState(),
    )
    expect(probe.status).toBe('pass')
    expect(probe.headSha).toBeNull()
    expect(probe.passOutput).toContain('no open PR')
  })

  it('keeps polling while the host is still computing ANY PR’s mergeability', async () => {
    wireMergeabilityProvider(
      providerRegistry,
      mergeability([
        { repo: 'o/own', headSha: 'a', verdict: 'mergeable' },
        { repo: 'o/peer', headSha: 'b', verdict: 'unknown' },
      ]) as never,
    )
    const probe = await conflictsGate(stubGateContext({}, providerRegistry)).probe(
      'ws',
      'b',
      gateState(),
    )
    expect(probe.status).toBe('pending')
  })

  it('reports how many PRs merge cleanly on a multi-repo task', async () => {
    wireMergeabilityProvider(
      providerRegistry,
      mergeability([
        { repo: 'o/own', headSha: 'a', verdict: 'mergeable' },
        { repo: 'o/peer', headSha: 'b', verdict: 'mergeable' },
      ]) as never,
    )
    const probe = await conflictsGate(stubGateContext({}, providerRegistry)).probe(
      'ws',
      'b',
      gateState(),
    )
    expect(probe.passOutput).toBe('Conflict gate passed: all 2 PRs merge cleanly with their base.')
  })

  it('names the conflicted repo when it gives up, and stays generic when it has no target', async () => {
    const gate = conflictsGate(stubGateContext({}, providerRegistry))
    const targeted = await gate.onExhausted({
      workspaceId: 'ws',
      instance,
      block: block(),
      step: step({ attempts: 3, conflictTarget: { repo: 'o/peer' } }),
    })
    expect(targeted.error).toContain('The pull request for o/peer')
    expect(targeted.error).toContain('3 conflict-resolver attempt(s)')
    expect(targeted.error).toContain('manually')

    const untargeted = await gate.onExhausted({
      workspaceId: 'ws',
      instance,
      block: block(),
      // No gate state at all: the message still reads as a sentence about zero attempts.
      step: {} as unknown as PipelineStep,
    })
    expect(untargeted.error).toContain('The pull request still conflicts')
    expect(untargeted.error).toContain('0 conflict-resolver attempt(s)')
  })
})

describe('doc-quality gate', () => {
  it('passes with a distinct output when there is no document to check at all', async () => {
    wireDocQualityProvider(providerRegistry, {
      check: async () => ({ ok: true, headSha: 'sha', findings: [] }),
    })
    const probe = await docQualityGate(stubGateContext({}, providerRegistry)).probe(
      'ws',
      'b',
      gateState(),
    )
    expect(probe.status).toBe('pass')
    expect(probe.passOutput).toContain('no document to check')
  })

  it('renders every finding as its own line under the document path', async () => {
    wireDocQualityProvider(providerRegistry, {
      check: async () => ({
        ok: false,
        headSha: 'sha',
        path: 'docs/prd/login.md',
        findings: ['Missing required section: "Success Metrics".', 'Placeholder TODO left in §3.'],
      }),
    })
    const probe = await docQualityGate(stubGateContext({}, providerRegistry)).probe(
      'ws',
      'b',
      gateState(),
    )
    expect(probe.failureSummary).toBe(
      'The document at `docs/prd/login.md` failed the quality checks:\n' +
        '- Missing required section: "Success Metrics".\n' +
        '- Placeholder TODO left in §3.',
    )
  })

  it('asks a human to look when the fixer rounds are spent', async () => {
    const { ctx, raised } = recordingContext()
    const result = await docQualityGate(ctx).onExhausted({
      workspaceId: 'ws',
      instance,
      block: block({ pullRequest: { url: 'https://host/pr/3' } } as Partial<Block>),
      step: step({ attempts: 2 }),
      summary: 'still missing a section',
    })
    expect(raised[0]?.type).toBe('decision_required')
    expect(raised[0]?.body).toContain('2 time(s)')
    expect(raised[0]?.body).toContain('still missing a section')
    expect(raised[0]?.payload).toEqual({ prUrl: 'https://host/pr/3', pipelineName: 'Ship it' })
    expect(result.error).toContain('2 doc-fixer attempt(s)')
  })

  it('leaves no dangling separator when there is no summary to quote', async () => {
    const { ctx, raised } = recordingContext()
    const result = await docQualityGate(ctx).onExhausted({
      workspaceId: 'ws',
      instance,
      block: block(),
      step: {} as unknown as PipelineStep,
    })
    expect(result.error).toBe(
      'The document still fails the quality checks after 0 doc-fixer attempt(s).',
    )
    expect(raised[0]?.body).toBe(
      'The doc-fixer tried 0 time(s) but the document still fails the quality checks.  Review the PR and retry the run once fixed.',
    )
  })
})

describe('post-release-health gate', () => {
  const signal = (over: Partial<ReleaseSignal> = {}): ReleaseSignal => ({
    kind: 'monitor',
    id: 'mon_1',
    name: 'checkout p99',
    state: 'alert',
    detail: '1.9s vs 500ms',
    ...over,
  })

  let gatheredSince: number[] = []
  beforeEach(() => {
    gatheredSince = []
  })

  const wireHealth = (over: {
    status?: 'healthy' | 'pending' | 'regressed'
    signals?: ReleaseSignal[]
    evidence?: { regressedSignals: ReleaseSignal[]; errors: []; notes?: string }
    onProbe?: (since: number) => void
  }) => {
    wireReleaseHealthProvider(providerRegistry, {
      probe: async (_ws, _b, since) => {
        over.onProbe?.(since)
        return { status: over.status ?? 'healthy', signals: over.signals ?? [signal()] }
      },
      gatherEvidence: async (_ws, _b, since) => {
        gatheredSince.push(since)
        return over.evidence ?? { regressedSignals: [], errors: [], notes: '' }
      },
    })
  }

  const doneBlock = { ...block(), status: 'done' } as Block

  it('does not watch a release that never shipped', async () => {
    // The merger leaves the block `pr_ready` when it raises a review without merging, and a
    // pipeline with no merger never auto-merges: there is nothing deployed to watch, so the gate
    // passes through rather than polling (and possibly escalating on) an unreleased change.
    const probe = vi.fn()
    wireHealth({ status: 'regressed', onProbe: probe })
    const ctx = stubGateContext(
      {
        clock: { now: () => NOW },
        getBlock: async () => ({ ...block(), status: 'pr_ready' }) as Block,
      },
      providerRegistry,
    )
    const result = await postReleaseHealthGate(ctx).probe('ws', 'b', gateState())
    expect(result.status).toBe('pass')
    expect(result.passOutput).toContain('not merged')
    expect(probe).not.toHaveBeenCalled()
  })

  it('advances immediately when the release has no monitors mapped to it', async () => {
    wireHealth({ status: 'healthy', signals: [] })
    const ctx = stubGateContext(
      { clock: { now: () => NOW }, getBlock: async () => doneBlock },
      providerRegistry,
    )
    const result = await postReleaseHealthGate(ctx).probe('ws', 'b', gateState())
    expect(result.status).toBe('pass')
    expect(result.passOutput).toContain('no monitors/SLOs configured')
  })

  it('watches until the window elapses, then passes', async () => {
    wireHealth({ status: 'healthy' })
    const ctx = stubGateContext(
      { clock: { now: () => NOW }, getBlock: async () => doneBlock },
      providerRegistry,
    )
    const gate = postReleaseHealthGate(ctx)
    const watching = DEFAULT_RISK_POLICY.releaseWatchWindowMinutes
    // Mid-window: healthy so far is not yet a verdict.
    expect(
      (await gate.probe('ws', 'b', gateState({ watchSince: NOW - (watching - 1) * MINUTE })))
        .status,
    ).toBe('pending')
    // Exactly at the window: the watch is over and the release is healthy.
    const settled = await gate.probe('ws', 'b', gateState({ watchSince: NOW - watching * MINUTE }))
    expect(settled.status).toBe('pass')
    expect(settled.passOutput).toContain('1 signal(s) healthy')
  })

  it('lets the STEP’s window override the preset’s, and resolves `since` once', async () => {
    const probedSince: number[] = []
    wireHealth({ status: 'healthy', onProbe: (since) => void probedSince.push(since) })
    const ctx = stubGateContext(
      { clock: { now: () => NOW }, getBlock: async () => doneBlock },
      providerRegistry,
    )
    const gate = postReleaseHealthGate(ctx)
    const state = gateState({
      watchSince: NOW - 5 * MINUTE,
      watchWindowMinutes: 60,
      config: config({ watchWindowMinutes: 5 }),
    })
    // The preset stash says 60 minutes and the step says 5: at five minutes in, the step wins.
    expect((await gate.probe('ws', 'b', state)).status).toBe('pass')
    expect(probedSince).toEqual([NOW - 5 * MINUTE])
    // With no stashed start the clock supplies it, so the window opens at this poll.
    await gate.probe('ws', 'b', gateState({ watchWindowMinutes: 60 }))
    expect(probedSince[1]).toBe(NOW)
  })

  it('escalates a regression whatever the window says, naming the regressed signals', async () => {
    wireHealth({ status: 'regressed' })
    const ctx = stubGateContext(
      { clock: { now: () => NOW }, getBlock: async () => doneBlock },
      providerRegistry,
    )
    const result = await postReleaseHealthGate(ctx).probe('ws', 'b', gateState({ watchSince: NOW }))
    expect(result.status).toBe('fail')
    expect(result.failureSummary).toContain('checkout p99')
    expect(result.failureSummary).toContain('1.9s vs 500ms')
  })

  it('stashes the signals the on-call agent was given, so the completion reuses the SAME evidence', async () => {
    const regressed = [signal({ id: 'mon_9', name: 'error rate' })]
    wireHealth({
      status: 'regressed',
      evidence: { regressedSignals: regressed, errors: [], notes: 'n' },
    })
    const ctx = stubGateContext(
      { clock: { now: () => NOW }, getBlock: async () => doneBlock },
      providerRegistry,
    )
    const state = gateState({ watchSince: NOW - MINUTE })
    const outputs = await postReleaseHealthGate(ctx).gatherHelperPriorOutputs!('ws', 'b', state)
    expect(gatheredSince).toEqual([NOW - MINUTE])
    expect(outputs[0]?.agentKind).toBe('post-release-health')
    expect(outputs[0]?.output).toContain('error rate')
    expect(state.regressedSignals).toEqual(regressed)
  })

  it('opens the watch window at this poll when nothing was stashed yet', async () => {
    wireHealth({ status: 'regressed' })
    const ctx = stubGateContext(
      { clock: { now: () => NOW }, getBlock: async () => doneBlock },
      providerRegistry,
    )
    await postReleaseHealthGate(ctx).gatherHelperPriorOutputs!('ws', 'b', gateState())
    expect(gatheredSince).toEqual([NOW])
  })

  it('alerts a human when there is no on-call investigation configured', async () => {
    wireHealth({ status: 'regressed' })
    const { ctx, raised } = recordingContext({ getBlock: async () => doneBlock })
    const result = await postReleaseHealthGate(ctx).onExhausted({
      workspaceId: 'ws',
      instance,
      block: block(),
      step: step({ regressedSignals: [signal()] }),
      summary: 'Regressed signals: checkout p99',
    })
    expect(raised[0]?.type).toBe('release_regression')
    expect(raised[0]?.payload?.releaseSignals).toHaveLength(1)
    expect(raised[0]?.payload?.onCallAssessment).toBeUndefined()
    expect(raised[0]?.body).toContain('Regressed signals: checkout p99')
    expect(result.error).toContain('no on-call investigation was configured')
  })

  describe('on-call completion', () => {
    const assessmentResult = (culpritConfidence: number): GateHelperJobResult => ({
      state: 'done',
      result: {
        output: '',
        onCallAssessment: {
          culpritConfidence,
          recommendation: 'revert',
          rationale: 'the error spike starts at the deploy marker',
          evidence: [],
        },
      },
    })

    it('reports the assessment as a rounded percentage in the card and the step output', async () => {
      wireHealth({ status: 'regressed' })
      const { ctx, raised } = recordingContext()
      const resolution = await postReleaseHealthGate(ctx).resolveHelperCompletion!({
        workspaceId: 'ws',
        instance,
        block: block(),
        step: step({ regressedSignals: [signal()], watchSince: NOW }),
        result: assessmentResult(0.815),
      })
      expect(raised[0]?.body).toContain('**revert**')
      expect(raised[0]?.body).toContain('82%')
      expect(raised[0]?.body).toContain('the error spike starts at the deploy marker')
      expect(raised[0]?.payload?.onCallAssessment).toMatchObject({ recommendation: 'revert' })
      expect(resolution.output).toContain('revert')
      expect(resolution.output).toContain('82%')
    })

    it('says the investigation did not complete rather than reporting no culprit as no problem', async () => {
      wireHealth({ status: 'regressed' })
      const { ctx, raised } = recordingContext()
      const resolution = await postReleaseHealthGate(ctx).resolveHelperCompletion!({
        workspaceId: 'ws',
        instance,
        block: block(),
        step: step({ regressedSignals: [signal()], lastFailureSummary: 'Regressed: checkout p99' }),
        result: { state: 'failed', error: 'container died' } as GateHelperJobResult,
      })
      expect(raised[0]?.body).toContain('Investigate before deciding')
      expect(raised[0]?.body).toContain('could not complete')
      expect(resolution.output).toContain('did not complete')
    })

    it('treats an unparseable assessment as no assessment rather than failing the resolution', async () => {
      wireHealth({ status: 'regressed' })
      const { ctx, raised } = recordingContext()
      const resolution = await postReleaseHealthGate(ctx).resolveHelperCompletion!({
        workspaceId: 'ws',
        instance,
        block: block(),
        step: step({ regressedSignals: [signal()] }),
        result: {
          state: 'done',
          result: { output: '', onCallAssessment: 'not json' },
        } as unknown as GateHelperJobResult,
      })
      expect(raised[0]?.payload?.onCallAssessment).toBeUndefined()
      expect(resolution.output).toContain('completed')
    })

    it('re-gathers the evidence only when the escalation stashed none', async () => {
      const gathered = vi.fn(async () => ({
        regressedSignals: [signal({ id: 'mon_fresh' })],
        errors: [] as [],
        notes: '',
      }))
      wireReleaseHealthProvider(providerRegistry, {
        probe: async () => ({ status: 'regressed', signals: [signal()] }),
        gatherEvidence: gathered,
      })
      const { ctx, raised } = recordingContext()
      const gate = postReleaseHealthGate(ctx)
      await gate.resolveHelperCompletion!({
        workspaceId: 'ws',
        instance,
        block: block(),
        step: step({ regressedSignals: [], watchSince: NOW - MINUTE }),
        result: assessmentResult(0.5),
      })
      expect(gathered).toHaveBeenCalledWith('ws', 'blk_1', NOW - MINUTE)
      expect(raised[0]?.payload?.releaseSignals).toHaveLength(1)

      // With signals already stashed at escalation, the notification is built from exactly what
      // the on-call agent investigated — not from a third read of the observability vendor.
      await gate.resolveHelperCompletion!({
        workspaceId: 'ws',
        instance,
        block: block(),
        step: step({ regressedSignals: [signal({ id: 'mon_stashed' })] }),
        result: assessmentResult(0.5),
      })
      expect(gathered).toHaveBeenCalledTimes(1)
      expect(raised[1]?.payload?.releaseSignals).toEqual([signal({ id: 'mon_stashed' })])
    })

    it('annotates an already-open incident with the investigation, and survives a failing annotate', async () => {
      wireHealth({ status: 'regressed' })
      const updates: { args: unknown; update: IncidentUpdate }[] = []
      wireIncidentEnrichment(providerRegistry, {
        enrich: async (args, update) => void updates.push({ args, update }),
      })
      const { ctx } = recordingContext()
      await postReleaseHealthGate(ctx).resolveHelperCompletion!({
        workspaceId: 'ws',
        instance,
        block: block({ pullRequest: { url: 'https://host/pr/1' } } as Partial<Block>),
        step: step({ regressedSignals: [signal({ id: 'mon_1' })], watchSince: NOW - MINUTE }),
        result: assessmentResult(0.4),
      })
      expect(updates[0]?.args).toEqual({
        workspaceId: 'ws',
        signalIds: ['mon_1'],
        since: NOW - MINUTE,
      })
      expect(updates[0]?.update.title).toContain('Login')
      expect(updates[0]?.update.body).toContain('revert')
      expect(updates[0]?.update.body).toContain('40%')
      expect(updates[0]?.update.prUrl).toBe('https://host/pr/1')

      // Enrichment is a courtesy annotation on a system that already paged: its failure must
      // never take the gate resolution (or the notification) down with it.
      wireIncidentEnrichment(providerRegistry, {
        enrich: async () => {
          throw new Error('incident.io is down')
        },
      })
      const resolution = await postReleaseHealthGate(ctx).resolveHelperCompletion!({
        workspaceId: 'ws',
        instance,
        block: block(),
        step: step({ regressedSignals: [signal()] }),
        result: assessmentResult(0.4),
      })
      expect(resolution.output).toContain('revert')
    })
  })
})
