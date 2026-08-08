import { computed, type ComputedRef } from 'vue'
import {
  pipelineEnvironmentProblems,
  purposeAllowsAgentCategory,
  type PipelineEnvironmentProblemReason,
} from '@cat-factory/contracts'
import type { AgentKind } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'
import { usePipelinesStore } from '~/stores/pipelines'

/**
 * Everything the pipeline builder can say is WRONG with the draft in front of it, as an ordered
 * list of translation keys, plus the one finding that also blocks the save.
 *
 * Extracted from `PipelineBuilder.vue` because these grew into one concern wearing five copies of
 * the same coat: each was a `computed` predicate beside a `<p>` with byte-identical classes, so
 * every new rule cost another near-duplicate pair in a component that had run out of room for
 * them. Here they are a list the template renders once.
 *
 * Every entry MIRRORS a refusal the backend already makes at save (or, for the purpose conflict,
 * one only the builder can make, since the backend has no kind→category map). The point is to
 * surface it before the round trip, never to be the sole enforcement: a hint that disagrees with
 * the boundary would let an unsavable draft look clean, so each is derived from the same shared
 * rule the boundary runs rather than from a hand-written restatement of it.
 */
export interface PipelineDraftWarnings {
  /** One entry per distinct finding, in the order the builder shows them. */
  hints: ComputedRef<PipelineDraftHint[]>
  /**
   * The draft steps whose agent category the chosen purpose CONTRADICTS. Exposed as the list
   * rather than folded into {@link hints} alone because it is the one finding that also disables
   * the Save button: the builder is the enforcement point, so an empty list is a precondition.
   */
  stepsDisallowedByPurpose: ComputedRef<AgentKind[]>
}

/** One rendered warning: its i18n key, plus the test id where a spec asserts on it. */
export interface PipelineDraftHint {
  key: string
  testId?: string
}

/**
 * The environment-lifecycle faults, mapped onto the copy that names the fix for each. An
 * exhaustive `Record` over the reason union, so a fault added to the shared rule fails the build
 * here rather than rendering as a blank hint.
 */
const ENVIRONMENT_HINT_KEYS: Record<PipelineEnvironmentProblemReason, string> = {
  consumer_without_deployer: 'pipeline.builder.envNeedsDeployer',
  consumer_after_disposer: 'pipeline.builder.envConsumerAfterDisposer',
  deployer_without_disposer: 'pipeline.builder.envNeedsDisposer',
  disposer_without_deployer: 'pipeline.builder.envDisposerNeedsDeployer',
  retained_deployer_reclaimed: 'pipeline.builder.envRetainedButReclaimed',
}

export function usePipelineDraftWarnings(
  showBinaryOutputPicker: (kind: AgentKind) => boolean,
): PipelineDraftWarnings {
  const pipelines = usePipelinesStore()

  const enabled = (i: number) => pipelines.draftEnabled[i] !== false

  // A gated step with no task-estimator before it (mirrors `assertValidGating`, which rejects the
  // save and the start). Both the step's own estimate gate (`draftGating`) and the Tester QC
  // companion's (`draftTesterQuality[i].gating`) count.
  const gatingNeedsEstimator = computed(() => {
    const kinds = pipelines.draft
    const hasEstimatorBefore = (i: number) =>
      kinds.slice(0, i).some((k, j) => k === 'task-estimator' && enabled(j))
    return kinds.some((_, i) => {
      if (!enabled(i)) return false
      const gated =
        pipelines.draftGating[i]?.enabled || pipelines.draftTesterQuality[i]?.gating?.enabled
      return !!gated && !hasEstimatorBefore(i)
    })
  })

  // The environment lifecycle a draft has to spell out: provision (Deployer) → consume (a tester /
  // acceptance / human-test step) → reclaim (Disposer, or a Deployer that declares its environment
  // outlives the run). One message per DISTINCT fault, so a draft missing both a Deployer and a
  // Disposer says so at once instead of over two rejected saves.
  const environmentHintKeys = computed(() => {
    const problems = pipelineEnvironmentProblems(
      pipelines.draft,
      pipelines.draftEnabled,
      pipelines.draftStepOptions,
    )
    return [...new Set(problems.map((p) => ENVIRONMENT_HINT_KEYS[p.reason]))]
  })

  // An enabled `skill` step with no picked skill (mirrors `assertValidSkillSteps`).
  const skillStepNeedsPick = computed(() =>
    pipelines.draft.some((k, i) => k === 'skill' && enabled(i) && !pipelines.draftSkillId(i)),
  )

  // An enabled generator step with no storage selection (mirrors `assertValidBinaryOutputSteps`).
  // Same disposition as `skillStepNeedsPick`: both are a step parametrized by a selection it
  // cannot run without.
  const binaryOutputStepNeedsPick = computed(() =>
    pipelines.draft.some(
      (kind, i) =>
        showBinaryOutputPicker(kind) &&
        enabled(i) &&
        !pipelines.draftBinaryOutput(i)?.storageServiceId,
    ),
  )

  // Steps whose agent category the chosen purpose CONTRADICTS (a non-`build` purpose writes no
  // code and runs no tests, so the Implementation/Testing categories are disallowed). Only
  // reachable by switching an existing draft to a non-`build` purpose AFTER such steps were added,
  // since the palette offers neither.
  //
  // Deliberately the COMPATIBILITY predicate, not the palette's narrower relevance one: a purpose
  // that merely stops SUGGESTING a category must not turn a pipeline somebody already built into
  // one they cannot save.
  const stepsDisallowedByPurpose = computed(() =>
    pipelines.draft.filter((kind) => {
      const category = agentKindMeta(kind).category
      return !!category && !purposeAllowsAgentCategory(pipelines.draftPurpose, category)
    }),
  )

  const hints = computed<PipelineDraftHint[]>(() => [
    ...(gatingNeedsEstimator.value ? [{ key: 'pipeline.builder.gatingNeedsEstimator' }] : []),
    ...environmentHintKeys.value.map((key) => ({ key, testId: 'env-lifecycle-hint' })),
    ...(skillStepNeedsPick.value ? [{ key: 'pipeline.builder.skillNeedsPick' }] : []),
    ...(binaryOutputStepNeedsPick.value
      ? [{ key: 'pipeline.builder.binaryOutputNeedsPick', testId: 'binary-output-needs-pick' }]
      : []),
    ...(stepsDisallowedByPurpose.value.length
      ? [{ key: 'pipeline.builder.purposeStepsConflict' }]
      : []),
  ])

  return { hints, stepsDisallowedByPurpose }
}
