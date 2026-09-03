import { describe, expect, it, vi } from 'vitest'
import type {
  Block,
  EnvironmentEvidenceBundle,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import {
  describeFinding,
  EnvironmentInvestigationController,
  resolveEnvironmentInvestigationBudget,
} from './EnvironmentInvestigationController.js'

// The loop is pure state transition over an in-memory instance plus one inline call and, at most,
// one provider call, so the collaborators are stubs that record what was asked of them.
//
// What is under test is the NARROWING and the disposition, not the happy path. The loop can tear
// down and rebuild real infrastructure on a model's say-so, and the whole safety argument is that
// the model only ever picks from a list the engine computed first, and that whether the remedy
// worked is decided by the deployer re-entering its own path rather than by the verdict.

const TIMEOUT_ERROR =
  'Environment was still provisioning after 20 minutes (readiness ceiling 20 minutes).'

const EVIDENCE = {
  environment: {
    id: 'env_1',
    status: 'ready',
    url: 'https://pr-42.example.test',
    expiresAt: null,
    lastError: null,
    provisionType: 'preview',
    engine: 'remote-custom',
  },
  provisionFields: { urlHostResolves: 'false' },
  timeline: [],
  failure: {
    error: TIMEOUT_ERROR,
    reason: 'timeout',
    readinessWait: 'waited',
    waitedMs: 1_200_000,
  },
  route: { candidates: [], proof: null },
} satisfies EnvironmentEvidenceBundle

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'deployer', state: 'running', ...overrides } as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    status: 'running',
    currentStep: 0,
    pipelineName: 'pl_build',
    steps,
  } as ExecutionInstance
}

const block = { id: 'task_1', title: 'Add catalog search' } as Block

function failure(overrides: Record<string, unknown> = {}) {
  return {
    frameId: 'frame_1',
    frameTitle: 'catalog-api',
    environmentId: 'env_1',
    error: TIMEOUT_ERROR,
    reason: 'timeout',
    wait: { kind: 'waited', waitedMs: 1_200_000 },
    ...overrides,
  } as never
}

function controller(
  options: {
    verdict?: unknown
    investigateError?: Error
    collectError?: Error
    enabled?: boolean
    providerRemediations?: string[]
    remediateOutcome?: { applied: boolean; detail: string }
    remediateError?: Error
    teardown?: boolean
    teardownConfirmation?: 'confirmed' | 'still_standing' | 'unverifiable' | 'unconfirmed'
    teardownReason?: string
    provisioning?: boolean
  } = {},
) {
  const investigate = vi.fn(async () => {
    if (options.investigateError) throw options.investigateError
    return {
      verdict: options.verdict ?? { faultLayer: 'provider', summary: 's', action: 'stop' },
      model: 'm',
    }
  })
  const remediateEnvironment = vi.fn(async () => {
    if (options.remediateError) throw options.remediateError
    return options.remediateOutcome ?? { applied: true, detail: 'rolled 1 Deployment' }
  })
  const teardown = vi.fn(async () => ({
    confirmation: options.teardownConfirmation ?? ('confirmed' as const),
    reason: options.teardownReason ?? null,
  }))
  const collectEnvironmentEvidence = vi.fn(async () => {
    if (options.collectError) throw options.collectError
    return { bundle: EVIDENCE, providerActions: options.providerRemediations ?? [] }
  })
  const deps = {
    investigator: { enabled: options.enabled ?? true, investigate },
    ...(options.provisioning === false
      ? {}
      : { environmentProvisioning: { collectEnvironmentEvidence, remediateEnvironment } }),
    ...(options.teardown ? { environmentTeardown: { teardown } } : {}),
    runStateMachine: { casPersist: vi.fn(async () => {}), persistAndEmit: vi.fn(async () => {}) },
    clock: { now: () => 1_700_000_000_000 },
  }
  return {
    controller: new EnvironmentInvestigationController(deps as never),
    deps,
    investigate,
    remediateEnvironment,
    teardown,
  }
}

function investigate(c: ReturnType<typeof controller>, s: PipelineStep, f = failure()) {
  return c.controller.investigate({
    workspaceId: 'ws_1',
    instance: instance([s]),
    step: s,
    block,
    failure: f,
  })
}

describe('investigate: when the loop does not apply', () => {
  it('passes through when no investigator is wired', async () => {
    const c = controller({ enabled: false })
    expect(await investigate(c, step())).toBeNull()
    expect(c.investigate).not.toHaveBeenCalled()
  })

  it('passes through when there is no provisioning service to read the evidence with', async () => {
    const c = controller({ provisioning: false })
    expect(await investigate(c, step())).toBeNull()
    expect(c.investigate).not.toHaveBeenCalled()
  })

  it('passes through when the step author disabled the loop', async () => {
    const c = controller()
    const s = step({ stepOptions: { environmentInvestigation: { enabled: false } } } as never)
    expect(await investigate(c, s)).toBeNull()
    expect(c.investigate).not.toHaveBeenCalled()
  })
})

describe('investigate: what the model is offered', () => {
  async function offeredFor(
    c: ReturnType<typeof controller>,
    s: PipelineStep,
    f = failure(),
  ): Promise<readonly string[]> {
    await investigate(c, s, f)
    const call = c.investigate.mock.calls[0] as [{ offeredActions: readonly string[] }] | undefined
    return call?.[0].offeredActions ?? []
  }

  it('always offers `stop`, because refusing is always available', async () => {
    const c = controller()
    expect(await offeredFor(c, step())).toContain('stop')
  })

  it('withholds `restart` unless the provider declares and implements it', async () => {
    expect(await offeredFor(controller(), step())).not.toContain('restart')
    expect(await offeredFor(controller({ providerRemediations: ['restart'] }), step())).toContain(
      'restart',
    )
  })

  it('withholds `recreate` when no teardown seam is wired', async () => {
    expect(await offeredFor(controller(), step())).not.toContain('recreate')
    expect(await offeredFor(controller({ teardown: true }), step())).toContain('recreate')
  })

  it('offers `wait` only for OUR deadline expiring, never for the provider’s own verdict', async () => {
    // A provider that has DECLARED the environment failed answers identically forever, so a wait
    // there is an offer to postpone the same verdict.
    expect(await offeredFor(controller(), step())).toContain('wait')
    expect(
      await offeredFor(controller(), step(), failure({ reason: 'environment_not_ready' })),
    ).not.toContain('wait')
  })

  it('withholds `wait` once the extension budget is spent', async () => {
    const s = step({
      environmentInvestigation: {
        attempts: 0,
        maxAttempts: 2,
        frameId: 'frame_1',
        waitExtensions: 1,
      },
    } as never)
    expect(await offeredFor(controller(), s)).not.toContain('wait')
  })

  it('offers `reprovision` even with no environment recorded, and nothing that acts on one', async () => {
    const c = controller({ teardown: true, providerRemediations: ['restart'] })
    const offered = await offeredFor(c, step(), failure({ environmentId: null, reason: 'timeout' }))
    expect(offered).toEqual(['stop', 'reprovision'])
  })

  it('offers only `stop` when the deployment forbids acting on infrastructure', async () => {
    const c = controller({ teardown: true, providerRemediations: ['restart'] })
    const s = step({
      stepOptions: { environmentInvestigation: { allowRemediation: false } },
    } as never)
    expect(await offeredFor(c, s)).toEqual(['stop'])
  })
})

describe('investigate: dispositions', () => {
  it('reports a `stop` verdict as a NAMED cause that replaces the bare provider error', async () => {
    const c = controller({
      verdict: {
        faultLayer: 'provider',
        summary: 'The VM behind the environment went offline; DNS was never published.',
        evidence: [{ source: 'provisionFields', statement: 'urlHostResolves = false' }],
        action: 'stop',
        actionRationale: 'Nothing the platform can do reaches a dead instance.',
      },
    })
    const s = step()
    const outcome = await investigate(c, s)

    expect(outcome?.kind).toBe('reported')
    const message = outcome?.kind === 'reported' ? outcome.message : ''
    // The provider error still LEADS: the finding is added under it, never in place of it.
    expect(message.startsWith(TIMEOUT_ERROR)).toBe(true)
    expect(message).toContain('fault: provider')
    expect(message).toContain('urlHostResolves = false')
    expect(s.environmentInvestigation?.attemptLog?.[0]?.outcome).toBe('reported')
    expect(s.environmentInvestigation?.attemptLog?.[0]?.ranAction).toBeUndefined()
  })

  it('re-enters the deployer fan-out for a `reprovision`, clearing the frame outcome', async () => {
    const c = controller({
      verdict: { faultLayer: 'unknown', summary: 's', action: 'reprovision' },
    })
    const s = step({
      deployEnvs: { frame_1: { status: 'failed', url: null, environmentId: 'env_1', error: 'x' } },
      deployProvisioning: { type: 'kubernetes' },
      deployFrameId: 'frame_1',
    } as never)
    const outcome = await investigate(c, s)

    expect(outcome).toEqual({ kind: 'retrying', advance: { kind: 'continue' } })
    // Clearing the TERMINAL outcome is what makes the re-provision happen; the pinned config has
    // to go too, so the retry resolves the frame fresh.
    expect(s.deployEnvs).toEqual({})
    expect(s.deployProvisioning).toBeUndefined()
    expect(s.deployFrameId).toBeUndefined()
    expect(s.environmentInvestigation?.attemptLog?.[0]).toMatchObject({
      outcome: 'remediated',
      ranAction: 'reprovision',
    })
  })

  it('parks on the readiness wait again for a `wait`, and counts the extension', async () => {
    const c = controller({ verdict: { faultLayer: 'platform', summary: 's', action: 'wait' } })
    const s = step()
    const outcome = await investigate(c, s)

    expect(outcome).toEqual({
      kind: 'retrying',
      advance: { kind: 'awaiting_environment', stepIndex: 0 },
    })
    expect(s.deployWait).toEqual({
      frameId: 'frame_1',
      environmentId: 'env_1',
      startedAt: 1_700_000_000_000,
      polls: 0,
    })
    expect(s.environmentInvestigation?.waitExtensions).toBe(1)
  })

  it('tears down before re-provisioning for a `recreate`', async () => {
    const c = controller({
      teardown: true,
      verdict: { faultLayer: 'provider', summary: 's', action: 'recreate' },
    })
    const outcome = await investigate(c, step())
    expect(c.teardown).toHaveBeenCalledWith('ws_1', 'env_1')
    expect(outcome).toEqual({ kind: 'retrying', advance: { kind: 'continue' } })
  })

  it('does NOT re-provision when the teardown a `recreate` depends on threw', async () => {
    // Re-applying over half-removed infrastructure reproduces the fault the recreate was for.
    const c = controller({
      teardown: true,
      verdict: { faultLayer: 'provider', summary: 's', action: 'recreate' },
    })
    c.deps.environmentTeardown!.teardown = vi.fn(async () => {
      throw new Error('namespace stuck Terminating')
    }) as never
    const outcome = await investigate(c, step())
    expect(outcome?.kind).toBe('reported')
    expect(outcome?.kind === 'reported' && outcome.message).toContain('namespace stuck Terminating')
  })

  it('does NOT re-provision when the teardown PROBE could not confirm the environment gone', async () => {
    // Only a `confirmed` probe is a reclaim. A namespace wedged in `Terminating` behind a stuck
    // finalizer makes `teardown()` return without complaint, and re-provisioning into it
    // reproduces the fault and burns the remaining round.
    const c = controller({
      teardown: true,
      teardownConfirmation: 'still_standing',
      teardownReason: 'namespace cf-env-42 is still Terminating',
      verdict: { faultLayer: 'provider', summary: 's', action: 'recreate' },
    })
    const s = step()
    const outcome = await investigate(c, s)
    expect(outcome?.kind).toBe('reported')
    const message = outcome?.kind === 'reported' ? outcome.message : ''
    expect(message).toContain('could not be confirmed gone')
    expect(message).toContain('still Terminating')
    expect(s.deployEnvs).toBeUndefined()
    expect(s.environmentInvestigation?.attemptLog?.[0]?.outcome).toBe('reported')
  })

  it('treats a provider that found nothing to restart as a remedy that did not run', async () => {
    const c = controller({
      providerRemediations: ['restart'],
      remediateOutcome: { applied: false, detail: 'no Deployment to restart' },
      verdict: { faultLayer: 'provider', summary: 's', action: 'restart' },
    })
    const s = step()
    const outcome = await investigate(c, s)
    expect(outcome?.kind).toBe('reported')
    expect(s.environmentInvestigation?.attemptLog?.[0]).toMatchObject({
      outcome: 'reported',
      withheld: 'no Deployment to restart',
    })
  })

  it('parks on the readiness wait after a restart rather than standing the env up again', async () => {
    // Re-provisioning would discard the very thing the restart was meant to fix.
    const c = controller({
      providerRemediations: ['restart'],
      verdict: { faultLayer: 'provider', summary: 's', action: 'restart' },
    })
    const s = step()
    const outcome = await investigate(c, s)
    expect(outcome).toEqual({
      kind: 'retrying',
      advance: { kind: 'awaiting_environment', stepIndex: 0 },
    })
    expect(s.environmentInvestigation?.waitExtensions).toBeUndefined()
  })

  it('withholds an action the round did not offer instead of substituting a neighbour', async () => {
    const c = controller({
      verdict: { faultLayer: 'provider', summary: 's', action: 'restart' },
    })
    const s = step()
    const outcome = await investigate(c, s)
    expect(outcome?.kind).toBe('reported')
    expect(c.remediateEnvironment).not.toHaveBeenCalled()
    expect(s.environmentInvestigation?.attemptLog?.[0]?.withheld).toContain('not offered')
  })

  it('never RECOMMENDS an action it withheld, which would name a decision that never existed', async () => {
    // Narrowing before the model is asked is the safety argument; it survives only if the one
    // operator-facing message says so too. `Recommended: restart` against a provider that cannot
    // restart anything sends a person to look for a remedy nobody offered.
    const c = controller({
      verdict: {
        faultLayer: 'provider',
        summary: 's',
        action: 'restart',
        actionRationale: 'The workload is wedged.',
      },
    })
    const outcome = await investigate(c, step())
    const message = outcome?.kind === 'reported' ? outcome.message : ''
    expect(message).not.toContain('Recommended:')
    expect(message).toContain('not offered this round')
    expect(message).toContain('The workload is wedged.')
  })

  it('says what it TRIED and could not do, rather than recommending it after the fact', async () => {
    const c = controller({
      providerRemediations: ['restart'],
      remediateError: new Error('the apiserver refused the patch'),
      verdict: { faultLayer: 'provider', summary: 's', action: 'restart' },
    })
    const outcome = await investigate(c, step())
    const message = outcome?.kind === 'reported' ? outcome.message : ''
    expect(message).toContain('The platform tried to restart the workload in place and could not')
    expect(message).toContain('the apiserver refused the patch')
    expect(message).not.toContain('Recommended:')
  })
})

describe('investigate: when the investigation itself fails', () => {
  it('records the round and passes through, keeping the run’s own error', async () => {
    const c = controller({ investigateError: new Error('no model is configured') })
    const s = step()
    expect(await investigate(c, s)).toBeNull()
    expect(s.environmentInvestigation?.attemptLog?.[0]).toMatchObject({
      outcome: 'failed',
      failure: 'no model is configured',
    })
  })

  it('treats an unreadable reply as a failed round, never as a `stop` verdict', async () => {
    const c = controller({ verdict: 'I could not determine the cause.' })
    const s = step()
    expect(await investigate(c, s)).toBeNull()
    expect(s.environmentInvestigation?.attemptLog?.[0]?.outcome).toBe('failed')
  })

  it('records a failed round when GATHERING throws, rather than failing the caller with it', async () => {
    // The gather is a chain of repository and provider reads, and it runs INSIDE the caller's own
    // terminal-failure path. A throw escaping here reaches the durable driver as an unreadable
    // poll, which fast-fails the run as a `timeout`: the loop replacing the failure it exists to
    // explain with a misattributed one of its own.
    const c = controller({ collectError: new Error('the environment store is unreachable') })
    const s = step()
    expect(await investigate(c, s)).toBeNull()
    expect(c.investigate).not.toHaveBeenCalled()
    expect(s.environmentInvestigation?.attemptLog?.[0]).toMatchObject({
      outcome: 'failed',
      failure: 'the environment store is unreachable',
    })
  })
})

describe('investigate: the budget', () => {
  it('freezes the bar at the first round so a mid-run pipeline edit cannot move it', async () => {
    const c = controller()
    const s = step({ stepOptions: { environmentInvestigation: { maxAttempts: 1 } } } as never)
    await investigate(c, s)
    expect(s.environmentInvestigation).toMatchObject({ attempts: 1, maxAttempts: 1 })

    // The author raises the budget mid-run; the spent round was counted against the old bar.
    s.stepOptions = { environmentInvestigation: { maxAttempts: 5 } } as never
    await investigate(c, s)
    expect(c.investigate).toHaveBeenCalledTimes(1)
  })

  it('reports the LAST verdict when the budget is spent, rather than discarding it', async () => {
    // Reporting is the point; a spent budget removes only the ability to act on the finding.
    const c = controller()
    const s = step({
      stepOptions: { environmentInvestigation: { maxAttempts: 1 } },
      environmentInvestigation: {
        attempts: 1,
        maxAttempts: 1,
        frameId: 'frame_1',
        attemptLog: [
          {
            attempt: 1,
            at: 1,
            outcome: 'remediated',
            error: TIMEOUT_ERROR,
            verdict: {
              faultLayer: 'provider',
              summary: 'The instance never came back.',
              evidence: [],
              action: 'recreate',
              actionRationale: 'r',
            },
          },
        ],
      },
    } as never)
    const outcome = await investigate(c, s)
    expect(outcome?.kind).toBe('reported')
    expect(outcome?.kind === 'reported' && outcome.message).toContain(
      'The instance never came back.',
    )
    expect(outcome?.kind === 'reported' && outcome.message).toContain(
      'budget for this step is spent',
    )
    expect(c.investigate).not.toHaveBeenCalled()
  })

  it('never explains a spent cycle with a SUPERSEDED cycle’s verdict', async () => {
    // The log survives the whole run while the counter is re-armed per provisioning cycle. Cycle
    // 1 diagnosed env_1 and restarted it; a loop-back then provisioned env_2, whose own rounds
    // both threw, so this cycle reached no verdict at all. Walking the whole log back would
    // explain env_2's terminal failure with evidence about an environment that no longer exists.
    const c = controller()
    const s = step({
      stepOptions: { environmentInvestigation: { maxAttempts: 1 } },
      environmentInvestigation: {
        attempts: 1,
        maxAttempts: 1,
        frameId: 'frame_1',
        cycle: 1,
        attemptLog: [
          {
            attempt: 1,
            cycle: 0,
            at: 1,
            outcome: 'remediated',
            error: TIMEOUT_ERROR,
            verdict: {
              faultLayer: 'provider',
              summary: 'The instance never came back.',
              evidence: [],
              action: 'restart',
              actionRationale: 'r',
            },
          },
          {
            attempt: 2,
            cycle: 1,
            at: 2,
            outcome: 'failed',
            error: TIMEOUT_ERROR,
            failure: 'the provider credentials could not be opened',
          },
        ],
      },
    } as never)

    expect(await investigate(c, s)).toBeNull()
    expect(c.investigate).not.toHaveBeenCalled()
  })

  it('passes through with nothing to report when the budget is spent and nothing was concluded', async () => {
    const c = controller()
    const s = step({
      environmentInvestigation: { attempts: 2, maxAttempts: 2, frameId: 'frame_1' },
    } as never)
    expect(await investigate(c, s)).toBeNull()
  })
})

describe('resolveEnvironmentInvestigationBudget', () => {
  it('defaults to the shipped budget and collapses `enabled: false` onto zero rounds', () => {
    expect(resolveEnvironmentInvestigationBudget({} as PipelineStep)).toBe(2)
    expect(
      resolveEnvironmentInvestigationBudget({
        stepOptions: { environmentInvestigation: { enabled: false, maxAttempts: 5 } },
      } as never),
    ).toBe(0)
  })
})

describe('describeFinding', () => {
  it('leads with the provider error and lists the cited evidence under it', () => {
    const message = describeFinding(
      failure(),
      {
        faultLayer: 'platform',
        summary: 'The readiness ceiling expired before the deploy job started.',
        evidence: [{ source: 'timeline', statement: 'deploy started 98s after readiness settled' }],
        action: 'wait',
        actionRationale: 'It was still converging.',
      },
      { kind: 'recommended' },
    )
    expect(message.startsWith(TIMEOUT_ERROR)).toBe(true)
    expect(message).toContain('- [timeline] deploy started 98s after readiness settled')
    expect(message).toContain('Recommended: keep waiting')
  })
})
