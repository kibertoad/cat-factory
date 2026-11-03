import type { BinaryOutputConfig, StepOptions } from '@cat-factory/contracts'

// The write side of a step's binary-output selection (`stepOptions.binaryOutput`): the one rule
// for which values the selection stores, shared by the draft store, the save payload and the
// picker's generation options, so the three cannot drift apart.

/**
 * Whether a selection value is EMPTY and is dropped rather than stored: `undefined`, `null`, a
 * blank string or an empty list.
 *
 * An empty list and an absent field are different claims to the agent. An absent
 * `contextServiceIds` means no scope service was selected, while `[]` reads as "context was
 * considered and rejected", and the brief repeats whichever it is given. The schema's fields are
 * `v.optional`, so a stored `null` is refused at save. An empty OBJECT is a value: `comparison: {}`
 * is a comparison switched on with its defaults.
 */
function isEmptySelectionValue(value: unknown): boolean {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0)
}

/**
 * A copy of `value` without its empty fields. Every other field is kept as given, so a field the
 * schema gains later survives without this function having to learn its name.
 */
export function withoutEmptySelectionValues<T extends object>(value: T): Partial<T> {
  const kept: Partial<T> = {}
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (!isEmptySelectionValue(value[key])) kept[key] = value[key]
  }
  return kept
}

/**
 * The selection as it is stored, or `undefined` when there is none. A blank storage id is no
 * selection at all: every other field only means anything as part of a generation that has
 * somewhere to land, and the backend refuses a step that carries them alone.
 */
export function normalizeBinaryOutput(
  config: BinaryOutputConfig | undefined,
): BinaryOutputConfig | undefined {
  if (!config) return undefined
  const kept = withoutEmptySelectionValues(config)
  return kept.storageServiceId ? { ...kept, storageServiceId: kept.storageServiceId } : undefined
}

/**
 * One step's options bag as it is SAVED, with its binary-output selection normalised. A pipeline
 * loaded for edit carries its bag as the backend returned it, so the save is the one point every
 * selection passes, edited or not. An emptied bag becomes `null`, like the draft setters leave it.
 */
export function savedStepOptions(options: StepOptions | null | undefined): StepOptions | null {
  if (!options || !('binaryOutput' in options)) return options ?? null
  const { binaryOutput, ...rest } = options
  const selection = normalizeBinaryOutput(binaryOutput)
  const next: StepOptions = selection ? { ...rest, binaryOutput: selection } : rest
  return Object.keys(next).length ? next : null
}
