import { describe, expect, it } from 'vitest'
import { pipelineEnvironmentProblems } from '@cat-factory/contracts'
import { usePipelinesStore } from '~/stores/pipelines'

/**
 * The pipeline-builder draft's retain declaration (`stepOptions.retainEnvironment`): how an author
 * says a Deployer's environment is MEANT to outlive the run, which is the only savable form of
 * "deploy a preview and leave it up" (the reclaim rule refuses a Deployer that neither reclaims
 * nor declares this). Same contract as the option helpers beside it: merge into the bag, normalize
 * an emptied bag back to null.
 */
describe('pipelines store — per-step retain-environment declaration', () => {
  it('stores only the opt-in, and normalizes the bag away when it is cleared', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('deployer')
    // OFF by default, and stored as ABSENCE rather than `false`: reclaiming is the default, so a
    // step that never touched this persists exactly the shape it always did.
    expect(pipelines.draftRetainEnvironment(0)).toBe(false)
    expect(pipelines.draftStepOptions[0]).toBeNull()

    pipelines.toggleDraftRetainEnvironment(0)
    expect(pipelines.draftRetainEnvironment(0)).toBe(true)
    expect(pipelines.draftStepOptions[0]).toEqual({ retainEnvironment: true })

    pipelines.toggleDraftRetainEnvironment(0)
    expect(pipelines.draftRetainEnvironment(0)).toBe(false)
    expect(pipelines.draftStepOptions[0]).toBeNull()
  })

  it('merges with the other options on the same step rather than clobbering them', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('deployer')
    pipelines.setDraftAgentVariantId(0, 'acme:fast')

    pipelines.toggleDraftRetainEnvironment(0)
    expect(pipelines.draftStepOptions[0]).toEqual({
      agentVariantId: 'acme:fast',
      retainEnvironment: true,
    })

    pipelines.toggleDraftRetainEnvironment(0)
    expect(pipelines.draftStepOptions[0]).toEqual({ agentVariantId: 'acme:fast' })
  })

  it('turns a draft the save boundary refuses into one it accepts', () => {
    // The point of the whole field, asserted against the SAME rule the backend refuses on rather
    // than against a restatement of it: without the declaration this draft has no savable form,
    // since dropping the Deployer instead just moves the fault onto the tester.
    const pipelines = usePipelinesStore()
    for (const kind of ['coder', 'deployer', 'human-test'] as const) pipelines.addToDraft(kind)
    const problems = () =>
      pipelineEnvironmentProblems(
        pipelines.draft,
        pipelines.draftEnabled,
        pipelines.draftStepOptions,
      ).map((p) => p.reason)

    expect(problems()).toEqual(['deployer_without_disposer'])
    pipelines.toggleDraftRetainEnvironment(1)
    expect(problems()).toEqual([])
  })
})
