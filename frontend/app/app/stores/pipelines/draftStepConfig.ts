import type { BinaryOutputConfig, StepOptions } from '@cat-factory/contracts'
import type { ConsensusStepConfig } from '~/types/consensus'
import { defaultConsensusConfig, type PipelinesContext } from './context'

/**
 * The pipeline-builder draft's PER-STEP CONFIG toggles: consensus (inline panel and the workspace
 * consensus-GROUP tier set), the human approval gate, the estimate gate on a companion step, the
 * follow-up and test-QC companions, the per-step enable flag, and the `StepOptions` bag
 * (requirements auto-recommendation, the picked skill, the picked agent-kind variant, the
 * per-step output-token ceiling, the binary-output storage/context selection). The step's GATE
 * configuration is the sibling `./draftGateConfig`, which explains why it is not here.
 *
 * Split out of `./draftActions`, which owns the draft's STRUCTURE (insert / remove / reorder /
 * units). Every function here reads and writes one of the parallel per-step arrays at an index and
 * touches nothing else, which is what makes the two independent; both are spread into the store,
 * so the store's API is unchanged.
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

export function createPipelineStepConfigActions(ctx: PipelinesContext) {
  const {
    draftGates,
    draftEnabled,
    draftConsensus,
    draftGating,
    draftFollowUps,
    draftTesterQuality,
    draftStepOptions,
  } = ctx

  /** Toggle estimate gating on/off for the (companion) step at `index`. */
  function toggleDraftGating(index: number) {
    draftGating.value[index] = draftGating.value[index]?.enabled
      ? null
      : { enabled: true, minRisk: 0.5, minImpact: 0.5, onMissingEstimate: 'run' }
  }

  /** Toggle the consensus mechanism on the draft step at `index` (default config / off). */
  function toggleDraftConsensus(index: number) {
    draftConsensus.value[index] = draftConsensus.value[index] ? null : defaultConsensusConfig()
  }

  /** Replace the consensus config of the draft step at `index` (builder editor edits). */
  function setDraftConsensus(index: number, config: ConsensusStepConfig | null) {
    draftConsensus.value[index] = config
  }

  /**
   * Add/remove a workspace consensus GROUP from the draft step's tier set. The array is a SET,
   * not a precedence list — the engine ranks candidates by the bar each group sets — so this
   * appends without ceremony.
   *
   * An empty tier set falls back to the step's inline participants; a non-empty one takes over,
   * which is why the builder shows only one of the two editors at a time.
   */
  function toggleDraftConsensusGroup(index: number, groupId: string) {
    const config = draftConsensus.value[index]
    if (!config) return
    const current = config.groupIds ?? []
    const next = current.includes(groupId)
      ? current.filter((id) => id !== groupId)
      : [...current, groupId]
    // Drop the key entirely when the set empties, so a step that never used tiers persists the
    // same shape it always did rather than an empty array that reads as "tiered, but none".
    if (next.length) config.groupIds = next
    else delete config.groupIds
  }

  /** Toggle the approval gate on the draft step at `index`. */
  function toggleDraftGate(index: number) {
    draftGates.value[index] = !draftGates.value[index]
  }

  /** Toggle the Follow-up companion on the draft (coder) step at `index` (default on → off). */
  function toggleDraftFollowUps(index: number) {
    // Default (null/true) is enabled, so the first toggle disables it (false); toggle back to null.
    draftFollowUps.value[index] = draftFollowUps.value[index] === false ? null : false
  }

  /**
   * Toggle the test quality-control companion on the draft (Tester) step at `index`. The
   * companion is enabled by default (a `null` entry), so the first toggle disables it
   * (`{ enabled: false }`, dropping any gating) and the next restores the default.
   */
  function toggleDraftTesterQuality(index: number) {
    draftTesterQuality.value[index] =
      draftTesterQuality.value[index]?.enabled === false ? null : { enabled: false }
  }

  /**
   * Toggle estimate gating on/off for the QC companion on the draft (Tester) step at `index`.
   * A no-op while the companion is disabled (nothing to gate). Enabling gating pins the config
   * to `{ enabled: true, gating }` so the thresholds are editable; disabling drops back to the
   * default `null` (enabled, ungated).
   */
  function toggleDraftTesterQualityGating(index: number) {
    const cur = draftTesterQuality.value[index]
    if (cur?.enabled === false) return
    draftTesterQuality.value[index] = cur?.gating?.enabled
      ? null
      : {
          enabled: true,
          gating: { enabled: true, minRisk: 0.5, minImpact: 0.5, onMissingEstimate: 'run' },
        }
  }

  /** Enable/disable the draft step at `index` without removing it. */
  function toggleDraftEnabled(index: number) {
    draftEnabled.value[index] = draftEnabled.value[index] === false
  }

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
    toggleDraftGating,
    toggleDraftConsensus,
    setDraftConsensus,
    toggleDraftConsensusGroup,
    toggleDraftGate,
    toggleDraftFollowUps,
    toggleDraftTesterQuality,
    toggleDraftTesterQualityGating,
    toggleDraftEnabled,
    draftAutoRecommendEnabled,
    toggleDraftAutoRecommend,
    draftRetainEnvironment,
    toggleDraftRetainEnvironment,
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
