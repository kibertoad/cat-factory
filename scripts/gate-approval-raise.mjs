// DETECTION for `check-gate-approval-raise.mjs`: which `step.approval = …` writes are a GATE
// BEING RAISED, and therefore must go through `buildStepApproval`.
//
// Split from the walker for the reason the silent-catch detector is: a guard nothing tests is a
// guard trusted without evidence, and this one has to tell three superficially identical writes
// apart. Fixtures live in `gate-approval-raise.test.mjs`.
//
// WHAT IS BEING GUARDED. Two engine paths raise the same human approval gate: the ordinary step
// settle (`RunDispatcher`) and a gated COMPANION's settle (`CompanionController`, which raises it
// on the producer's output once the companion has cleared it). Each built its own object literal,
// and they drifted: when per-step gate config landed, only the first learned to snapshot the
// step's approver policy and quorum. That failure is SILENT and it fails OPEN, because an
// approval with no `approverPolicy` reads to `refuseGateResolution` as "anyone entitled to write"
// and one with no `requiredApprovals` reads to `foldGateApproval` as a quorum of one. A pipeline
// author configured two named approvers, saved with no complaint, and got a gate anyone could
// clear alone.
//
// So the rule is structural, not behavioural: a raise may not be spelled as a literal.
//
// NOT a raise, and each exclusion is a different thing:
//   - a SPREAD of the existing approval (`{ ...step.approval, proposal }`) is a refresh; whatever
//     the builder froze onto it survives, which is exactly the property being protected;
//   - `RunStateMachine.parkStepOnDecision` raises the AGENT-DECISION parks (fork choice, human
//     test, visual confirmation, input gate). Those carry no per-step approver policy and are
//     answered through their own resolvers, never the generic approve verbs.

/** The single-file check: the 1-based line numbers carrying a hand-rolled gate raise. */
export function findHandRolledApprovalRaises(source) {
  const code = maskComments(source)
  const offenders = []
  // Scanned over the WHOLE masked source rather than line by line, because the formatter decides
  // where the literal breaks: `{ ...step.approval,` and `{\n  ...step.approval,` are one shape,
  // and a line-local check would flag the second as a hand-rolled raise the moment a line grew
  // past the print width. `\s` spans newlines, so both read the same.
  for (const match of code.matchAll(/\.approval\s*=\s*\{\s*(\.\.\.)?/g)) {
    // A leading spread is a refresh of the existing approval: whatever the builder froze onto it
    // survives, which is the property being protected.
    if (match[1]) continue
    offenders.push(lineOf(code, match.index))
  }
  return offenders
}

/**
 * Blank out comment CONTENT while preserving every offset, so a line DESCRIBING the banned shape
 * (this guard's own header, the builder's doc comment) is not reported as one and the line numbers
 * still point at real source.
 *
 * Deliberately naive about strings: the pattern is punctuation-heavy enough that hiding a raise
 * from it would take writing the assignment inside a string literal, which is not a way anyone
 * raises a gate.
 */
function maskComments(source) {
  return source
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('/*')) {
        return ' '.repeat(line.length)
      }
      const at = line.indexOf('//')
      return at === -1 ? line : line.slice(0, at) + ' '.repeat(line.length - at)
    })
    .join('\n')
}

/** 1-based line number of a character offset. */
function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++
  return line
}
