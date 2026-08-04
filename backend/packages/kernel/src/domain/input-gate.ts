// The PRE-TOKEN INPUT GATE: a deterministic, runtime-neutral reduction over a task's own
// authored input, answering one question: is there anything here an agent could act on?
//
// It exists because the cheapest refusal the platform could previously produce cost a model
// call: an empty task ran the requirements reviewer, which spent tokens to report the absence
// of a description that a string comparison already knew about. Every check here is a string
// comparison. No I/O, no model, no repository. The caller (`InputGateController`) supplies the
// block's fields and stamps the verdict on the run.
//
// The rules the checks are written to:
//   - A BLOCKING finding must be one no model could work around, so that parking is never a
//     judgement call the platform got wrong. "No description at all" qualifies; "a short
//     description" does not, and rides as an advisory.
//   - A check reads the AUTHORED input only. It never infers quality, never scores prose, and
//     never guesses at intent. That is exactly the judgement the reviewer is for, and a cheap
//     imitation of it would park real work.

import type {
  InputGateIssue,
  InputGateIssueCode,
  InputGateMode,
  InputGateSeverity,
  InputGateStatus,
} from '@cat-factory/contracts'

/**
 * Each finding's INTRINSIC severity: what it means about the input, before a workspace's
 * mode has a say. An exhaustive `Record` over the closed code union, so adding a code fails
 * the build here rather than defaulting silently into either bucket.
 *
 * The three `blocking` members share one property: the run has NOTHING to act on. An empty or
 * placeholder description states no work; a bug with no reproduction context gives its fixer no
 * way to know when it is fixed; a review task with no pull request has no subject at all. The
 * `advisory` members are weak inputs, not absent ones, and weak input is what the reviewer is
 * for.
 */
export const INPUT_GATE_SEVERITY: Record<InputGateIssueCode, InputGateSeverity> = {
  description_missing: 'blocking',
  description_placeholder: 'blocking',
  description_thin: 'advisory',
  reproduction_missing: 'blocking',
  review_target_missing: 'blocking',
  success_criteria_missing: 'advisory',
}

/** The task fields the gate reads. Supplied by the caller; the gate does no lookups itself. */
export interface InputGateInput {
  /** The task's title. Never on its own enough to satisfy the gate; see `descriptionFinding`. */
  title: string
  /** The task's description, as authored. */
  description: string
  /**
   * The task's type (`bug`, `spike`, `review`, a deployment's namespaced id, …). An UNKNOWN
   * type gets the description checks and nothing else: per-type checks encode what a specific
   * type needs, and a deployment's own type is not something this file can have an opinion
   * about. Absent ⇒ treated the same way.
   */
  taskType?: string | null | undefined
  /**
   * The per-type creation fields (`stepsToReproduce`, `successCriteria`, `prNumber`, …).
   * Sparse and optional, exactly as stored on the block.
   */
  taskTypeFields?:
    | {
        stepsToReproduce?: string | undefined
        successCriteria?: string | undefined
        researchQuestion?: string | undefined
        prNumber?: number | undefined
        prUrl?: string | undefined
      }
    | null
    | undefined
}

/** The gate's verdict: its disposition plus every finding, blocking and advisory alike. */
export interface InputGateVerdict {
  status: InputGateStatus
  mode: InputGateMode
  issues: InputGateIssue[]
}

/**
 * Descriptions consisting of nothing but one of these carry no statement of work. Matched
 * against the WHOLE normalized description, never as a substring: a real description that
 * happens to contain the word "TODO" is a real description, and a substring rule would park it.
 */
const PLACEHOLDER_DESCRIPTIONS = new Set([
  '-',
  '--',
  '.',
  '..',
  '...',
  '?',
  '??',
  'n/a',
  'na',
  'none',
  'tbd',
  'tba',
  'todo',
  'to do',
  'fixme',
  'fix',
  'fix it',
  'fix this',
  'wip',
  'test',
  'asap',
  'see title',
  'see above',
  'as discussed',
  'as described',
  'same as title',
  'no description',
  'description',
])

/**
 * Task types whose description is NOT the authored input, so there is nothing here to judge.
 *
 * `recurring` is the whole set today: such a block is not created through `addTask` at all, it
 * is the schedule's own reused on-board block, and its real input is the schedule (plus, for an
 * intake pipeline, whatever ticket the run picks up). Judging its blank description would park
 * every scheduled run on a field no human is ever going to fill in.
 *
 * A deployment-registered (`<ns>:<name>`) type is NOT listed and does not need to be: the
 * per-type checks already yield nothing for a type this file does not know, so such a task gets
 * the description checks alone, which is the right default for something somebody authored.
 */
const PLATFORM_AUTHORED_TASK_TYPES = new Set(['recurring'])

/** Word count below which a description specifies nothing actionable (advisory only). */
const THIN_DESCRIPTION_WORDS = 5

/**
 * Cues that a bug description carries reproduction context even though the dedicated
 * `stepsToReproduce` field is empty (people routinely type the steps straight into the
 * description). Deliberately generous: the cost of missing a cue is parking a task whose author
 * did the work, which is worse than letting a thin bug report through to a reviewer that can
 * ask about it properly.
 */
const REPRODUCTION_CUES = [
  'reproduce',
  'reproduction',
  'repro',
  'steps to',
  'expected',
  'actual',
  'observed',
  'stack trace',
  'stacktrace',
  'traceback',
  'error:',
  'exception',
  'happens when',
  'occurs when',
  'when i ',
  'when you ',
]

/** Lower-cased, whitespace-collapsed text. The basis for "did anybody type anything at all". */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * A normalized description reduced to what it actually SAYS: surrounding markdown emphasis and
 * terminal punctuation stripped, so `**TBD.**` and `TBD` compare equal against the placeholder
 * set. An empty key means the text was punctuation and nothing else (`...`, `???`), which is
 * authored but contentless: a placeholder rather than an absence.
 */
function placeholderKey(normalized: string): string {
  return normalized.replace(/^[\s*_`>#\-.?!]+|[\s*_`\-.?!:;]+$/g, '').trim()
}

/** Words in `text`, counting only runs of letters/digits (so `---` and `...` count as nothing). */
function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length
}

/** Whether the description shows any sign of carrying reproduction context. */
function hasReproductionCue(description: string): boolean {
  const lower = description.toLowerCase()
  if (REPRODUCTION_CUES.some((cue) => lower.includes(cue))) return true
  // An ordered or bulleted list of at least two items reads as steps whatever it says.
  const listItems = description
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)).length
  return listItems >= 2
}

/**
 * The description checks, in descending severity, emitting AT MOST ONE finding: `missing`,
 * `placeholder` and `thin` are three readings of the same field, so reporting two of them
 * would ask a human to fix one thing twice.
 *
 * The TITLE is deliberately not a substitute. A title names a task; it does not specify one,
 * and treating "the title says enough" as a pass is precisely the judgement the platform is
 * trying not to make without a model.
 */
function descriptionFinding(description: string): InputGateIssueCode | null {
  const normalized = normalize(description)
  if (normalized.length === 0) return 'description_missing'
  const key = placeholderKey(normalized)
  if (key.length === 0 || PLACEHOLDER_DESCRIPTIONS.has(key)) return 'description_placeholder'
  if (wordCount(normalized) < THIN_DESCRIPTION_WORDS) return 'description_thin'
  return null
}

/**
 * The per-TYPE checks. Each states what that type's pipeline structurally consumes, so a gap
 * here means a downstream step has no input rather than a weak one. A type this file does not
 * know (including every deployment-registered namespaced type) yields nothing, which is the
 * honest answer: the platform cannot know what somebody else's task type requires.
 */
function typeFindings(input: InputGateInput): InputGateIssueCode[] {
  const fields = input.taskTypeFields ?? {}
  switch (input.taskType) {
    case 'bug': {
      const steps = normalize(fields.stepsToReproduce ?? '')
      if (steps.length > 0 || hasReproductionCue(input.description)) return []
      return ['reproduction_missing']
    }
    case 'review': {
      // `prUrl` wins over `prNumber` when both are set, but either identifies the target.
      if (fields.prUrl?.trim() || (fields.prNumber != null && fields.prNumber > 0)) return []
      return ['review_target_missing']
    }
    case 'spike': {
      const stated =
        normalize(fields.successCriteria ?? '').length > 0 ||
        normalize(fields.researchQuestion ?? '').length > 0
      return stated ? [] : ['success_criteria_missing']
    }
    default:
      return []
  }
}

/**
 * Evaluate a task's input under a workspace's mode.
 *
 * `off` returns `status: 'off'` with NO findings: the check did not run, and an empty finding
 * list under a `passed` status would claim it did. A PLATFORM-authored task (see
 * {@link PLATFORM_AUTHORED_TASK_TYPES}) returns `not_applicable` for the same reason, one step
 * further: the check ran and found there was nothing here it is entitled to judge. `advisory` runs every check and floors each
 * finding to `advisory`, so it can report what `standard` would have parked on without parking
 * anything. The mode only ever SOFTENS: there is no mode that promotes an advisory finding to
 * blocking, because the advisory set is advisory on the merits, not by configuration.
 */
export function evaluateInputGate(input: InputGateInput, mode: InputGateMode): InputGateVerdict {
  if (mode === 'off') return { status: 'off', mode, issues: [] }
  // A platform-authored task has no authored description to judge. Reported as its own status
  // rather than as `off` (which would blame a setting) or `passed` (which would claim the input
  // was checked and found sound).
  if (input.taskType && PLATFORM_AUTHORED_TASK_TYPES.has(input.taskType)) {
    return { status: 'not_applicable', mode, issues: [] }
  }

  const codes: InputGateIssueCode[] = []
  const description = descriptionFinding(input.description)
  if (description) codes.push(description)
  codes.push(...typeFindings(input))

  const issues: InputGateIssue[] = codes.map((code) => ({
    code,
    severity: mode === 'advisory' ? 'advisory' : INPUT_GATE_SEVERITY[code],
  }))
  const blocked = issues.some((issue) => issue.severity === 'blocking')
  return { status: blocked ? 'blocked' : 'passed', mode, issues }
}

/** Whether a verdict's findings include at least one that parks the run. */
export function hasBlockingInputIssues(issues: readonly InputGateIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'blocking')
}

/**
 * A one-line English summary of the blocking findings, for the places the platform writes
 * PROSE rather than data: the parked step's proposal text and the run's log line. Every
 * user-facing surface renders from the CODES instead (the SPA maps them to translated copy),
 * so this is a detail line, never the explanation somebody is expected to read.
 */
export function describeInputGateIssues(issues: readonly InputGateIssue[]): string {
  const blocking = issues.filter((issue) => issue.severity === 'blocking').map((i) => i.code)
  const shown = blocking.length > 0 ? blocking : issues.map((i) => i.code)
  return shown.join(', ')
}
