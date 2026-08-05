import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance } from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import {
  StepDecisionController,
  type StepDecisionControllerDeps,
} from './StepDecisionController.js'

// The MANUAL merge exit: the `merge_review` card's own button, and the inspector's merge
// control. Two policies refuse it outright, and both exist because refusing only the AUTOMATIC
// exit leaves them decorative: the card a run raises is answered by whoever is looking at it,
// which is routinely the person who started the run.
//
// Driven through the controller with fake engine primitives, because what is under test is which
// state each guard reads and how much it pays to read it, not the merge itself.

const BLOCK: Block = {
  id: 'task_login',
  title: 'Login',
  status: 'pr_ready',
  executionId: 'exec_1',
  pullRequest: { url: 'https://pr', number: 42 },
} as Block

/** The run that opened the PR, as started by `role` and (optionally) sandboxed. */
function runBy(role?: string, mode?: string): ExecutionInstance {
  return { id: 'exec_1', blockId: 'task_login', initiatedByRole: role, mode } as ExecutionInstance
}

function fakeDeps(
  over: {
    block?: Block
    instance?: ExecutionInstance | null
    preset?: Record<string, unknown>
    changeClass?: string
  } = {},
) {
  const finalizeMerge = vi.fn(async () => ({ kind: 'merged' }) as const)
  const resolve = vi.fn(async () => over.preset ?? { name: 'Balanced' })
  const classifyChangeClass = vi.fn(async () => over.changeClass ?? 'unknown')
  const get = vi.fn(async () => over.instance ?? null)
  const deps = {
    executionRepository: { get },
    mergePolicy: { resolve, classifyChangeClass, recordHumanMerge: vi.fn(async () => {}) },
    requireWorkspace: vi.fn(async () => ({})),
    requireBlock: vi.fn(async () => over.block ?? BLOCK),
    finalizeMerge,
  } as unknown as StepDecisionControllerDeps
  return {
    controller: new StepDecisionController(deps),
    finalizeMerge,
    resolve,
    classifyChangeClass,
  }
}

/** The conflict a refused merge throws, or `null` when the merge went through. */
async function mergeAndCatch(controller: StepDecisionController): Promise<ConflictError | null> {
  try {
    await controller.mergePr('ws', 'task_login')
    return null
  } catch (error) {
    if (error instanceof ConflictError) return error
    throw error
  }
}

/** The machine-readable `details.reason` a refusal carries, which is what the SPA maps. */
const reasonOf = (error: ConflictError | null) =>
  (error?.details as { reason?: string } | undefined)?.reason

describe('StepDecisionController.mergePr: dry-run guard', () => {
  it('refuses a PR the sandbox produced, naming the re-run remedy', async () => {
    const { controller, finalizeMerge } = fakeDeps({ instance: runBy('member', 'dry_run') })
    const error = await mergeAndCatch(controller)
    expect(reasonOf(error)).toBe('dry_run_not_mergeable')
    expect(finalizeMerge).not.toHaveBeenCalled()
  })

  it('merges a live run, and one whose record cannot be found at all', async () => {
    // A block with no run recorded (or one since swept) is the disposition every pre-existing
    // block has: refusing it would block merges the platform has always allowed on the strength
    // of state it cannot find.
    for (const instance of [runBy('member'), null]) {
      const { controller, finalizeMerge } = fakeDeps({ instance })
      expect(await mergeAndCatch(controller)).toBeNull()
      expect(finalizeMerge).toHaveBeenCalledOnce()
    }
  })
})

describe('StepDecisionController.mergePr: submission allowlist', () => {
  const scoped = (classes: string[], changeClass: string) => ({
    preset: { name: 'Balanced', submissionClassesByRole: { member: classes } },
    changeClass,
    instance: runBy('member'),
  })

  it('refuses a class the initiator’s role may not land', async () => {
    const { controller, finalizeMerge } = fakeDeps(scoped(['docs'], 'source'))
    const error = await mergeAndCatch(controller)
    expect(reasonOf(error)).toBe('submission_not_allowed')
    // The remedy is a PERSON or a policy edit, never a re-run: the same role would produce the
    // same refusal, so the copy must not offer the sandbox's way out.
    expect(error?.message).not.toContain('again')
    expect(error?.details).toMatchObject({ role: 'member', changeClass: 'source' })
    expect(finalizeMerge).not.toHaveBeenCalled()
  })

  it('merges a class the role allowlists', async () => {
    const { controller, finalizeMerge } = fakeDeps(scoped(['docs', 'source'], 'source'))
    expect(await mergeAndCatch(controller)).toBeNull()
    expect(finalizeMerge).toHaveBeenCalledOnce()
  })

  it('merges an unreadable diff rather than reading an outage as a verdict', async () => {
    const { controller, finalizeMerge } = fakeDeps(scoped([], 'unknown'))
    expect(await mergeAndCatch(controller)).toBeNull()
    expect(finalizeMerge).toHaveBeenCalledOnce()
  })

  // The order the guard reads its inputs in is the point: classification is a VCS call, and a
  // deployment that scopes nobody must not pay for one on every manual merge.
  it('does not classify when no allowlist could match', async () => {
    const unscopedRole = fakeDeps({
      preset: { name: 'Balanced', submissionClassesByRole: { viewer: ['docs'] } },
      instance: runBy('member'),
    })
    expect(await mergeAndCatch(unscopedRole.controller)).toBeNull()
    expect(unscopedRole.classifyChangeClass).not.toHaveBeenCalled()

    const unattributed = fakeDeps({
      preset: { name: 'Balanced', submissionClassesByRole: { member: [] } },
      instance: runBy(undefined),
    })
    expect(await mergeAndCatch(unattributed.controller)).toBeNull()
    // An unattributed run cannot match an entry, so it owes neither the classification NOR the
    // preset read that would have decided nothing.
    expect(unattributed.resolve).not.toHaveBeenCalled()
    expect(unattributed.classifyChangeClass).not.toHaveBeenCalled()
  })

  it('refuses a block with no PR awaiting merge before any policy is consulted', async () => {
    const { controller, resolve } = fakeDeps({
      block: { ...BLOCK, status: 'in_progress' } as Block,
      ...scoped(['docs'], 'source'),
    })
    const error = await mergeAndCatch(controller)
    expect(reasonOf(error)).toBe('no_pr_to_merge')
    expect(resolve).not.toHaveBeenCalled()
  })
})
