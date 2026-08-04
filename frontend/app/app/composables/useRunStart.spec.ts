import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import type { Block, Pipeline } from '~/types/domain'
import type { RiskPolicy, WorkspaceRole } from '~/types/merge'
import { useBoardStore } from '~/stores/board'
import { useExecutionStore } from '~/stores/execution'
import { useRiskPoliciesStore } from '~/stores/riskPolicies'
import { useUiModeStore } from '~/stores/uiMode'
import { useDryRunPolicy, useRunStart } from '~/composables/useRunStart'

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

/**
 * Seed a board governed by `policy`, signed in as `role`, and hand back the composable.
 *
 * `b1` is the task under test. `b2` is a second one carrying its own preset, so a test can move
 * the id the composable is bound to: that is what the inspector does, being mounted once for the
 * session and following the board selection rather than being rebuilt per block.
 */
function setup(options: {
  role: WorkspaceRole | null
  policy?: RiskPolicy
  otherPolicy?: RiskPolicy
  advanced?: boolean
}) {
  const start = vi.fn().mockResolvedValue(true)
  vi.stubGlobal('useWorkspaceAccess', () => ({ role: { value: options.role } }))
  useBoardStore().blocks = [
    { id: 'b1', level: 'task', title: 'Task' } as Block,
    { id: 'b2', level: 'task', title: 'Other task', riskPolicyId: 'mp_other' } as Block,
  ]
  const other = options.otherPolicy ?? preset({ id: 'mp_other', isDefault: false })
  useRiskPoliciesStore().hydrate([options.policy ?? preset(), other])
  useUiModeStore().setMode(options.advanced === false ? 'basic' : 'advanced')
  useExecutionStore().start = start
  const blockId: Ref<string | undefined> = ref('b1')
  return { run: useRunStart(blockId), start, blockId }
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

  // The request belongs to the block it was made on, and the surface holding it outlives that
  // block: the inspector is mounted once and follows the board selection. Carrying the request
  // across would sandbox the NEXT run started, on a task nobody armed it for, with the Run
  // button's icon the only tell and reading as a property of the task now shown.
  it('drops a pending request when the block changes under it', async () => {
    const { run, blockId, start } = setup({ role: 'member' })
    run.setRequested(true)
    expect(run.dryRun.value).toBe(true)

    blockId.value = 'b2'
    await nextTick()

    expect(run.requested.value).toBe(false)
    expect(run.dryRun.value).toBe(false)
    await run.start(pipeline)
    expect(start).toHaveBeenCalledWith('b2', pipeline, { mode: undefined })
  })

  // The other half of following the selection: the policy read is per BLOCK, so moving to a task
  // governed by a sandboxing preset must report the sandbox rather than the previous task's.
  it('re-reads the policy for the block it is now bound to', async () => {
    const { run, blockId } = setup({
      role: 'member',
      otherPolicy: preset({ id: 'mp_other', isDefault: false, dryRunRoles: ['member'] }),
    })
    expect(run.forced.value).toBe(false)

    blockId.value = 'b2'
    await nextTick()

    expect(run.forced.value).toBe(true)
    expect(run.canRequest.value).toBe(false)
  })
})

// The board's one-tap start and its drag-drop start resolve a task at the moment of the action
// and have no block to bind a composable to, so they read the policy through the same functions
// `useRunStart` wraps. Sharing them is what keeps a sandbox from being visible on one start
// surface and silent on another.
describe('useDryRunPolicy', () => {
  it('answers per block, for a target resolved at the moment of the start', () => {
    setup({
      role: 'member',
      otherPolicy: preset({ id: 'mp_other', isDefault: false, dryRunRoles: ['member'] }),
    })
    const { forcedFor, presetFor } = useDryRunPolicy()
    expect(forcedFor('b1')).toBe(false)
    expect(forcedFor('b2')).toBe(true)
    expect(presetFor('b2')?.id).toBe('mp_other')
  })

  // A block with no preset of its own is governed by the workspace default, and so is one the
  // board cannot resolve: the same fallback the engine makes, rather than reading an unresolved
  // block as unsandboxed, which would state the safer-looking answer without knowing it.
  it('falls back to the workspace default for a block carrying no preset', () => {
    setup({ role: 'member', policy: preset({ dryRunRoles: ['member'] }) })
    const { forcedFor } = useDryRunPolicy()
    expect(forcedFor('b1')).toBe(true)
    expect(forcedFor(undefined)).toBe(true)
  })
})
