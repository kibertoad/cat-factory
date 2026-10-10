import type { ConsensusStepConfig } from '~/types/consensus'
import { defaultConsensusConfig, type PipelinesContext } from './context'

/**
 * The pipeline-builder draft's PER-STEP CONFIG toggles: consensus (inline panel and the workspace
 * consensus-GROUP tier set), the human approval gate, the estimate gate on a companion step, the
 * follow-up and test-QC companions, and the per-step enable flag — every toggle that writes a
 * PARALLEL ARRAY. The `StepOptions` bag accessors are the sibling `./draftStepOptions`, and the
 * step's GATE configuration `./draftGateConfig`; each is split along the state it writes rather
 * than an arbitrary line count.
 *
 * Split out of `./draftActions`, which owns the draft's STRUCTURE (insert / remove / reorder /
 * units). Every function here reads and writes one of the parallel per-step arrays at an index and
 * touches nothing else, which is what makes the two independent; both are spread into the store,
 * so the store's API is unchanged.
 */
export function createPipelineStepConfigActions(ctx: PipelinesContext) {
  const {
    draftGates,
    draftEnabled,
    draftConsensus,
    draftGating,
    draftFollowUps,
    draftTesterQuality,
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
  }
}
