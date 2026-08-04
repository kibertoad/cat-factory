import { describe, expect, it, vi } from 'vitest'
import type { Block, Pipeline } from '~/types/domain'
import type { RiskPolicy, WorkspaceRole } from '~/types/merge'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { useRiskPoliciesStore } from '~/stores/riskPolicies'
import { useUiModeStore } from '~/stores/uiMode'
import { useRunStart } from '~/composables/useRunStart'

// `useRunStart` resolves the mode a start will run in from two independent facts: what the user
// asked for, and whether the task's merge preset sandboxes their role. The stores are real (a
// fresh Pinia per test); only the caller's resolved RBAC role and the store's start command are
// stubbed, since neither an HTTP call nor an auth gate is what these assertions are about.
const pipeline = { id: 'pl_build', name: 'Build' } as Pipeline

const preset = (over: Partial<RiskPolicy> = {}): RiskPolicy =>
  ({
    id: 'mp_balanced',
    name: 'Balanced',
    maxComplexity: 0.6,
    maxRisk: 0.4,
    maxImpact: 0.5,
    ciMaxAttempts: 10,
    maxRequirementIterations: 6,
    maxRequirementConcernAllowed: 'none',
    maxTesterQualityIterations: 3,
    releaseWatchWindowMinutes: 30,
    releaseMaxAttempts: 1,
    humanReviewGraceMinutes: 10,
    judgeMinScore: 0.7,
    judgeMaxBounces: 2,
    autoMergeEnabled: true,
    classRules: {},
    classRulesByRole: {},
    dryRunRoles: [],
    isDefault: true,
    createdAt: 0,
    ...over,
  }) as RiskPolicy

/** Seed a task governed by `policy`, signed in as `role`, and hand back the composable. */
function setup(options: { role: WorkspaceRole | null; policy?: RiskPolicy; advanced?: boolean }) {
  const start = vi.fn().mockResolvedValue(true)
  vi.stubGlobal('useWorkspaceAccess', () => ({ role: { value: options.role } }))
  useBoardStore().blocks = [{ id: 'b1', level: 'task', title: 'Task' } as Block]
  useRiskPoliciesStore().hydrate([options.policy ?? preset()])
  useUiModeStore().setMode(options.advanced === false ? 'basic' : 'advanced')
  useExecutionStore().start = start
  return { run: useRunStart('b1'), start }
}

describe('useRunStart', () => {
  it('starts live by default, sending no mode at all', async () => {
    const { run, start } = setup({ role: 'member' })
    expect(run.dryRun.value).toBe(false)
    await run.start(pipeline)
    expect(start).toHaveBeenCalledWith('b1', pipeline, { mode: undefined })
  })

  it('sends the request when the initiator asks for a sandbox', async () => {
    const { run, start } = setup({ role: 'member' })
    run.setRequested(true)
    expect(run.dryRun.value).toBe(true)
    await run.start(pipeline)
    expect(start).toHaveBeenCalledWith('b1', pipeline, { mode: 'dry_run' })
  })

  it('clears the request once it has been spent, so the next run is live again', async () => {
    const { run } = setup({ role: 'member' })
    run.setRequested(true)
    await run.start(pipeline)
    expect(run.requested.value).toBe(false)
  })

  it('reports a policy sandbox and offers nothing to ask for', () => {
    const { run } = setup({ role: 'member', policy: preset({ dryRunRoles: ['member'] }) })
    expect(run.forced.value).toBe(true)
    expect(run.dryRun.value).toBe(true)
    expect(run.canRequest.value).toBe(false)
  })

  // The engine reads the preset itself and reports the sandbox as policy rather than as a
  // request, which is what lets the run explain a sandbox its initiator never chose. Re-sending
  // it from here would file it under "they asked for this".
  it('sends no mode for a policy sandbox: the engine settles that, not the caller', async () => {
    const { run, start } = setup({ role: 'member', policy: preset({ dryRunRoles: ['member'] }) })
    await run.start(pipeline)
    expect(start).toHaveBeenCalledWith('b1', pipeline, { mode: undefined })
  })

  it('leaves a role the preset does not list alone', () => {
    const { run } = setup({ role: 'admin', policy: preset({ dryRunRoles: ['member'] }) })
    expect(run.forced.value).toBe(false)
    expect(run.canRequest.value).toBe(true)
  })

  // Auth-disabled dev resolves no role, so no entry can match. Reading absence as a tier would
  // sandbox every run on a deployment that runs with auth off.
  it('never force-sandboxes a caller with no resolved role', () => {
    const { run } = setup({
      role: null,
      policy: preset({ dryRunRoles: ['admin', 'member', 'viewer'] }),
    })
    expect(run.forced.value).toBe(false)
  })

  // The request is an override of the default a basic-tier user would otherwise have got, and
  // hiding it leaves exactly that default. A policy sandbox is not an override, so it is not
  // subject to the tier at all.
  it('offers the request only on the advanced tier, and states a sandbox on both', () => {
    expect(setup({ role: 'member', advanced: false }).run.canRequest.value).toBe(false)
    const basicForced = setup({
      role: 'member',
      advanced: false,
      policy: preset({ dryRunRoles: ['member'] }),
    })
    expect(basicForced.run.forced.value).toBe(true)
    expect(basicForced.run.dryRun.value).toBe(true)
  })

  it('falls back to the workspace default preset for a task that picks none', () => {
    const { run } = setup({ role: 'member', policy: preset({ dryRunRoles: ['member'] }) })
    expect(run.preset.value?.id).toBe('mp_balanced')
    expect(run.forced.value).toBe(true)
  })
})
