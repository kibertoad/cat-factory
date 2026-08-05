import type { DescriptorField, DescriptorFieldValues } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// What the BUILT-IN gates let a pipeline step configure about them, and the reader they share.
//
// This is the dogfood half of the per-step gate config: the platform's own gates declare their
// knobs through exactly the seam a deployment's gate uses (`register(kind, factory,
// { configFields })`), rather than the engine growing a branch per gate. Everything a gate reads
// off `gateState.config` is declared HERE, so the authoring form, the save-time validation and
// the runtime read cannot describe different parameters.
//
// The values these override come from the task's merge preset, which is the right grain for a
// workspace-wide policy and the wrong one for "this particular step in this particular pipeline
// gets three attempts". Absent ⇒ the preset's value, byte-for-byte the prior behaviour.
// ---------------------------------------------------------------------------

/**
 * How many helper rounds a gate may dispatch. Bounded, and the bound is DECLARED rather than
 * clamped on read: a step asking for a thousand ci-fixer attempts is a mistake worth refusing at
 * save time, and a reader that quietly capped it would run a budget nobody configured.
 */
const MAX_ATTEMPTS_FIELD: DescriptorField = {
  key: 'maxAttempts',
  label: 'Helper attempts',
  type: 'number',
  min: 0,
  max: 20,
  help: "How many times this gate's helper agent may try before the run gives up. Leave empty to use the task's merge preset.",
}

/** The `ci` gate's per-step parameters. */
export const CI_GATE_CONFIG_FIELDS: readonly DescriptorField[] = [MAX_ATTEMPTS_FIELD]

/** The `conflicts` gate's per-step parameters. */
export const CONFLICTS_GATE_CONFIG_FIELDS: readonly DescriptorField[] = [MAX_ATTEMPTS_FIELD]

/** The `doc-quality` gate's per-step parameters. */
export const DOC_QUALITY_GATE_CONFIG_FIELDS: readonly DescriptorField[] = [MAX_ATTEMPTS_FIELD]

/** The `post-release-health` gate's per-step parameters. */
export const POST_RELEASE_HEALTH_GATE_CONFIG_FIELDS: readonly DescriptorField[] = [
  MAX_ATTEMPTS_FIELD,
  {
    key: 'watchWindowMinutes',
    label: 'Watch window (minutes)',
    type: 'number',
    min: 1,
    max: 7 * 24 * 60,
    help: "How long to watch the release's monitors and SLOs before passing. Leave empty to use the task's merge preset.",
  },
]

/**
 * The `human-review` gate's per-step parameters. Note it declares NO attempt budget: the gate
 * waits for a person indefinitely by design, so a step that could cap its rounds would be a
 * deadline on a human review that nothing else in the gate expects.
 */
export const HUMAN_REVIEW_GATE_CONFIG_FIELDS: readonly DescriptorField[] = [
  {
    key: 'graceMinutes',
    label: 'Fixer grace window (minutes)',
    type: 'number',
    min: 0,
    max: 24 * 60,
    help: 'How long to wait after the latest review comment before handing the feedback to the fixer, so a reviewer mid-review is not interrupted. Leave empty to use the merge preset.',
  },
]

/**
 * Read a declared numeric parameter off a gate's live per-step config.
 *
 * TOTAL and narrow: a value that is not a finite number is treated as absent, which cannot happen
 * through either door (both validate against the same declaration before freezing) but keeps a
 * hand-edited row from turning into `NaN` deep inside a poll loop. It does NOT clamp — the bound
 * is enforced where the value is frozen, and a reader that silently corrected it would hide the
 * misconfiguration from the person who could fix it.
 */
export function gateConfigNumber(
  config: DescriptorFieldValues | null | undefined,
  key: string,
): number | undefined {
  const value = config?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
