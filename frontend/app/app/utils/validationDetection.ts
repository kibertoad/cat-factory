import type { ValidationCheck } from '~/types/validationChecks'

// Folding an autodetected suggestion into the pre-PR validation panel's UNSAVED rows.
//
// Pure, and separate from the panel, because the merge carries the two rules that make the
// button safe to press: it never destroys what the operator already typed, and it never
// produces a row set the write contract would reject.

/** What a merge did, so the panel can say something specific rather than "done". */
export interface MergedDetection {
  rows: ValidationCheck[]
  /** Suggestions appended as new rows. */
  added: number
  /** Suggestions dropped because the row cap was already reached. */
  dropped: number
}

/**
 * Append detected checks to the rows already on screen.
 *
 * - A suggestion whose COMMAND is already present is skipped, so pressing Detect twice (or
 *   pressing it on a service that is already configured) adds nothing rather than
 *   duplicating every check.
 * - Existing rows are never rewritten. The button is assistive; silently replacing an
 *   operator's hand-tuned command with the generic guess would be a worse failure than not
 *   detecting anything.
 * - Wholly blank rows (an unused "Add check" click) are dropped first, so the suggestion
 *   lands in a contiguous list instead of after a gap.
 * - Labels are made unique against the surviving rows, because the write contract REJECTS a
 *   duplicate label — a merge that produced one would surface as an unexplained save error
 *   on rows the operator did not write.
 */
export function mergeDetectedChecks(
  existing: ValidationCheck[],
  detected: ValidationCheck[],
  maxRows: number,
): MergedDetection {
  const rows = existing.filter((r) => r.label.trim() !== '' || r.command.trim() !== '')
  const commands = new Set(rows.map((r) => r.command.trim()))
  const labels = new Set(rows.map((r) => r.label.trim()).filter((l) => l !== ''))

  let added = 0
  let dropped = 0
  for (const candidate of detected) {
    const command = candidate.command.trim()
    if (command === '' || commands.has(command)) continue
    if (rows.length >= maxRows) {
      dropped += 1
      continue
    }
    const label = uniqueLabel(candidate.label.trim() || command, labels)
    rows.push({ label, command })
    commands.add(command)
    labels.add(label)
    added += 1
  }
  return { rows, added, dropped }
}

/** `lint` → `lint 2` → `lint 3` … until it no longer collides. Clamped to the contract's 80. */
function uniqueLabel(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base.slice(0, 80)
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`.slice(0, 80)
    if (!taken.has(candidate)) return candidate
  }
}
