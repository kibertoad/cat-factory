import type { BinaryOutputConfig, StepOptions, StepServiceScope } from '@cat-factory/contracts'
import type { PipelinesContext } from './context'

/**
 * The pipeline-builder draft's `StepOptions` BAG accessors: every per-step parameter that lives in
 * the one extensible options object rather than in a parallel array of its own — the requirements
 * auto-recommendation, the Deployer's retain declaration, the step's run CONDITION, the picked
 * skill, the picked agent-kind variant, the binary-output selection, and the per-step output-token
 * ceiling.
 *
 * Its own module for the reason `./draftGateConfig` is: the sibling `./draftStepConfig` owns the
 * per-step TOGGLES that each write a parallel array, while every function here reads and writes
 * one FIELD of one bag through {@link patchStepOption}. The split is along that seam rather than
 * an arbitrary line count, so a new per-step knob has an obvious home — and since the bag is the
 * declared home for every NEW knob, this is the half that keeps growing.
 */

/**
 * Write ONE field of the step's `StepOptions` bag at `index`, merging into whatever else that step
 * carries and normalizing an emptied bag back to `null`. `undefined` CLEARS the field.
 *
 * Every per-step option below goes through this rather than repeating the clone/assign/normalize
 * dance, because the two halves that are easy to get wrong are shared by all of them: replacing
 * the bag loses the neighbouring options a step may also carry, and leaving a `{}` behind makes a
 * step that is back on every default persist a shape it never had.
 */
function patchStepOption<K extends keyof StepOptions>(
  draftStepOptions: PipelinesContext['draftStepOptions'],
  index: number,
  key: K,
  value: StepOptions[K] | undefined,
) {
  const next: StepOptions = { ...draftStepOptions.value[index] }
  if (value === undefined) delete next[key]
  else next[key] = value
  draftStepOptions.value[index] = Object.keys(next).length ? next : null
}

export function createPipelineStepOptionActions(ctx: PipelinesContext) {
  const { draftStepOptions } = ctx

  /** Whether auto-recommendation is on for the draft (requirements-review) step at `index`. */
  function draftAutoRecommendEnabled(index: number): boolean {
    return draftStepOptions.value[index]?.autoRecommend !== false
  }

  /**
   * Toggle the requirements-review auto-recommendation on the draft step at `index`. It is on by
   * default, so we store ONLY the opt-out (`{ autoRecommend: false }`); toggling back drops the
   * flag. Merges with any other future StepOptions fields rather than clobbering the whole bag.
   */
  function toggleDraftAutoRecommend(index: number) {
    const off = draftAutoRecommendEnabled(index) ? false : undefined
    patchStepOption(draftStepOptions, index, 'autoRecommend', off)
  }

  /**
   * Whether the draft `deployer` step at `index` declares that its environments outlive the run
   * (its `stepOptions.retainEnvironment`). OFF by default: the everyday shape is a run that
   * reclaims what it stood up, and the save boundary refuses a Deployer that does neither.
   */
  function draftRetainEnvironment(index: number): boolean {
    return draftStepOptions.value[index]?.retainEnvironment === true
  }

  /**
   * Toggle the retain declaration on the draft `deployer` step at `index`. It is off by default,
   * so we store ONLY the opt-in (the mirror of `toggleDraftAutoRecommend`, which stores only the
   * opt-out); toggling back drops the flag and, if the bag empties, the whole entry.
   */
  function toggleDraftRetainEnvironment(index: number) {
    const on = draftRetainEnvironment(index) ? undefined : true
    patchStepOption(draftStepOptions, index, 'retainEnvironment', on)
  }

  /**
   * The RUN CONDITION on the draft step at `index` — the service scope it applies to, or
   * `undefined` when it runs on every task (`stepOptions.condition`).
   */
  function draftStepCondition(index: number): StepServiceScope | undefined {
    return draftStepOptions.value[index]?.condition?.serviceScope
  }

  /**
   * Cycle the draft step's run condition: unconditional → frontend-only → backend-only →
   * unconditional.
   *
   * A CYCLE rather than a picker because the states are three and mutually exclusive, and the
   * control has to live in a dense per-step icon row beside eight others. It cycles back to
   * unconditional deliberately: a condition arrives on a step by CLONING a built-in (the tester
   * pair), so the state a user most needs to reach from here is the one that clears it.
   */
  function cycleDraftStepCondition(index: number) {
    const current = draftStepCondition(index)
    const next: StepServiceScope | undefined =
      current === undefined ? 'frontend' : current === 'frontend' ? 'backend' : undefined
    patchStepOption(draftStepOptions, index, 'condition', next ? { serviceScope: next } : undefined)
  }

  /** The skill picked for the draft `skill` step at `index` (its `stepOptions.skillId`). */
  function draftSkillId(index: number): string | undefined {
    return draftStepOptions.value[index]?.skillId
  }

  /**
   * Set (or clear) the picked skill on the draft `skill` step at `index`. Merges into the
   * step's `StepOptions` bag rather than clobbering it; clearing drops the field and, if the
   * bag empties, the whole entry (so it normalizes away like the other options).
   */
  function setDraftSkillId(index: number, skillId: string | undefined) {
    patchStepOption(draftStepOptions, index, 'skillId', skillId || undefined)
  }

  /**
   * The agent-kind VARIANT picked for the draft step at `index` (its
   * `stepOptions.agentVariantId`), or undefined when it runs the kind's shipped prompt.
   */
  function draftAgentVariantId(index: number): string | undefined {
    return draftStepOptions.value[index]?.agentVariantId
  }

  /**
   * Set (or clear) the picked variant on the draft step at `index`. Merges into the step's
   * `StepOptions` bag rather than clobbering it; clearing drops the field and, if the bag
   * empties, the whole entry — exactly like the other options here, so a step back on the
   * shipped prompt persists nothing.
   */
  function setDraftAgentVariantId(index: number, agentVariantId: string | undefined) {
    patchStepOption(draftStepOptions, index, 'agentVariantId', agentVariantId || undefined)
  }

  /**
   * The binary-output SELECTION on the draft step at `index` (its `stepOptions.binaryOutput`) —
   * the foundational storage service a generator kind's artifacts are stored through, plus any
   * services consulted for the generation's scope. Undefined on every step of every stock
   * pipeline; required on a step whose kind carries the `binary-output` trait.
   */
  function draftBinaryOutput(index: number): BinaryOutputConfig | undefined {
    return draftStepOptions.value[index]?.binaryOutput
  }

  /**
   * Set (or clear) the binary-output selection on the draft step at `index`. Merges into the
   * step's `StepOptions` bag rather than clobbering it; clearing drops the field and, if the
   * bag empties, the whole entry — exactly like the other options here, so a step that never
   * used it persists the shape it always did.
   *
   * An EMPTY `contextServiceIds` is dropped rather than stored, for the reason the consensus
   * tier set drops its own empty array: the field's absence means "no scope service was
   * selected", while `[]` reads as "context was considered and rejected" — a different claim,
   * and one the brief renderer would repeat to the agent. `generatorIds` and `modalities` take
   * the same treatment for the same reason: an absent `generatorIds` means the step generates
   * through whatever its agent already has, and an absent `modalities` imposes no delivery
   * requirement — both of which the brief STATES, so persisting `[]` would have it state the
   * wrong thing.
   */
  function setDraftBinaryOutput(index: number, config: BinaryOutputConfig | undefined) {
    const { storageServiceId, contextServiceIds, generatorIds, modalities } = config ?? {}
    const selection = storageServiceId
      ? {
          storageServiceId,
          ...(contextServiceIds?.length ? { contextServiceIds } : {}),
          ...(generatorIds?.length ? { generatorIds } : {}),
          ...(modalities?.length ? { modalities } : {}),
        }
      : undefined
    patchStepOption(draftStepOptions, index, 'binaryOutput', selection)
  }

  /**
   * The output-token ceiling pinned on the draft step at `index`, or undefined when the step
   * inherits (the workspace's per-kind setting, else the deployment default).
   */
  function draftMaxOutputTokens(index: number): number | undefined {
    return draftStepOptions.value[index]?.maxOutputTokens
  }

  /**
   * Set (or clear) this step's own output-token ceiling. Merges into the step's `StepOptions`
   * bag rather than clobbering it; clearing drops the field and, if the bag empties, the whole
   * entry — so a step back on the inherited budget persists no options at all, exactly like the
   * other fields here.
   */
  function setDraftMaxOutputTokens(index: number, maxOutputTokens: number | undefined) {
    patchStepOption(draftStepOptions, index, 'maxOutputTokens', maxOutputTokens ?? undefined)
  }

  return {
    draftAutoRecommendEnabled,
    toggleDraftAutoRecommend,
    draftRetainEnvironment,
    toggleDraftRetainEnvironment,
    draftStepCondition,
    cycleDraftStepCondition,
    draftSkillId,
    setDraftSkillId,
    draftAgentVariantId,
    setDraftAgentVariantId,
    draftBinaryOutput,
    setDraftBinaryOutput,
    draftMaxOutputTokens,
    setDraftMaxOutputTokens,
  }
}
