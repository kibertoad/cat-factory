import { describe, expect, it } from 'vitest'
import { INITIATIVE_PLANNER_AGENT_KIND, defaultStepResolverRegistry } from '@cat-factory/kernel'
import type {
  AgentRunResult,
  ExecutionInstance,
  Initiative,
  PipelineStep,
  StepResolverContext,
} from '@cat-factory/kernel'
import { buildStepResolverRegistry, type DispatcherRegistryDeps } from './dispatcher-registries.js'

/**
 * The `initiative-planner`'s post-completion resolver authors the document its human gate
 * parks on. What this pins is the reason that job lives HERE rather than on the generic
 * `reviewableArtifactOutput` seam: the plan the reviewer approves must be the plan that
 * EXECUTES, and the two differ. Ingest reshapes the draft — a preset's phase template
 * reorders phases and forces checkpoints, its `seedPlan` hook adds and drops items, and a
 * re-plan carries over items a previous plan already materialised. Rendering the planner's
 * raw draft would show a document the approval does not govern, which is a silent failure:
 * nothing errors, the reviewer simply approves work they were never shown.
 */
describe('the initiative-planner step resolver', () => {
  /** The planner's raw draft: one phase, one item, in the planner's own order. */
  const rawDraft = {
    goal: 'Migrate off the legacy client.',
    phases: [
      { id: 'phase-cutover', title: 'Cut over' },
      { id: 'phase-adapter', title: 'Introduce the adapter' },
    ],
    items: [{ id: 'item-drafted', phaseId: 'phase-adapter', title: 'An item the seed hook drops' }],
    policy: { maxConcurrent: 1, defaultPipelineId: 'pl_simple' },
  }

  /**
   * What the ingest actually committed: phases reordered into the preset's template order, a
   * checkpoint the template forced, the drafted item dropped and a seeded one added. Every
   * difference here is one a real preset makes (`normalizeDraftAgainstPhaseTemplate` +
   * `seedMigrationPlan`); the point is that NONE of them are visible in `rawDraft`.
   */
  const ingested = {
    id: 'init_1',
    blockId: 'blk_1',
    slug: 'legacy-client',
    title: 'Legacy client migration',
    goal: 'Migrate off the legacy client.',
    constraints: [],
    nonGoals: [],
    qa: [],
    analysisSummary: '',
    phases: [
      { id: 'phase-adapter', title: 'Introduce the adapter', goal: '' },
      { id: 'phase-cutover', title: 'Cut over', goal: '', checkpoint: true },
    ],
    items: [
      {
        id: 'item-seeded',
        phaseId: 'phase-adapter',
        title: 'An item the seed hook added',
        description: '',
        dependsOn: [],
        status: 'pending' as const,
      },
    ],
    policy: {
      maxConcurrent: 1,
      defaultPipelineId: 'pl_simple',
      rules: [],
      onMissingEstimate: 'default' as const,
    },
    decisions: [],
    deviations: [],
    followUps: [],
    caveats: [],
    status: 'awaiting_approval' as const,
    rev: 1,
    createdAt: 0,
    updatedAt: 0,
  } satisfies Initiative

  function resolverContext(result: AgentRunResult): StepResolverContext {
    return {
      workspaceId: 'ws_1',
      instance: { id: 'exec_1', blockId: 'blk_1' } as ExecutionInstance,
      step: { agentKind: INITIATIVE_PLANNER_AGENT_KIND } as PipelineStep,
      result,
      isFinalStep: false,
    }
  }

  /** Only the two seams this resolver touches; the rest of the deps bag is irrelevant here. */
  function deps(ingestPlan: (raw: unknown) => Promise<Initiative | null>): DispatcherRegistryDeps {
    return {
      initiativeService: {
        ingestPlan: (_ws: string, _block: string, raw: unknown) => ingestPlan(raw),
      },
      stepResolverRegistry: defaultStepResolverRegistry(),
      runInitiatorScope: (_initiatedBy: string | undefined, fn: () => unknown) => fn(),
    } as unknown as DispatcherRegistryDeps
  }

  it('renders the INGESTED plan, not the draft the planner emitted', async () => {
    let ingestedRaw: unknown
    const registry = buildStepResolverRegistry(
      deps(async (raw) => {
        ingestedRaw = raw
        return ingested
      }),
    )
    const resolution = await registry
      .get(INITIATIVE_PLANNER_AGENT_KIND)!
      .resolve(resolverContext({ output: 'Initiative plan drafted.', initiativePlan: rawDraft }))

    // The trust boundary still sees the planner's own bytes.
    expect(ingestedRaw).toBe(rawDraft)

    const output = resolution?.output ?? ''
    // The planner's transcript summary is never what the gate parks on.
    expect(output).not.toContain('Initiative plan drafted.')
    // Committed order, not drafted order.
    expect(output.indexOf('Introduce the adapter')).toBeLessThan(output.indexOf('Cut over'))
    // A checkpoint the template forced changes when the initiative pauses for a human — it is
    // absent from the draft, so a draft-rendered document would never mention it.
    expect(output).toContain('Checkpoint')
    // The seed hook's edits to the item set are what the reviewer is actually approving.
    expect(output).toContain('An item the seed hook added')
    expect(output).not.toContain('An item the seed hook drops')
  })

  it('marks the rendering non-editable, so the gate refuses corrections typed over it', async () => {
    const registry = buildStepResolverRegistry(deps(async () => ingested))
    const resolution = await registry
      .get(INITIATIVE_PLANNER_AGENT_KIND)!
      .resolve(resolverContext({ output: 'Initiative plan drafted.', initiativePlan: rawDraft }))
    expect(resolution?.outputIsRendered).toBe(true)
  })

  it('fails the step loudly when the block has no initiative to ingest into', async () => {
    const registry = buildStepResolverRegistry(deps(async () => null))
    await expect(
      registry
        .get(INITIATIVE_PLANNER_AGENT_KIND)!
        .resolve(resolverContext({ output: 'x', initiativePlan: rawDraft })),
    ).rejects.toThrow(/No initiative entity/)
  })
})
