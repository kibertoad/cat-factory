// The PRE-DISPATCH INPUT GATE: a deterministic, runtime-neutral reduction over a task's own
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

import { unfilledRequiredDescriptorFields } from '@cat-factory/contracts'
import type {
  BlockLevel,
  DescriptorField,
  DescriptorFieldValues,
  InputGateIssue,
  InputGateIssueCode,
  InputGateMode,
  InputGateSeverity,
  InputGateStatus,
} from '@cat-factory/contracts'
import type { TaskTypeRegistry } from './task-type-registry.js'

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
  // BLOCKING because the deployment said so, which is the only authority there is here. The
  // built-in codes are classified by this file's own judgement about what a model can work
  // around; a custom type's pipeline is one this file has never seen, so the org that wrote it
  // is the only party that can know. A deployment wanting the softer reading marks the field
  // OPTIONAL and lets its reviewer ask, which is the same "when in doubt, advisory" trade the
  // built-ins make — expressed by the declaration rather than by a second severity knob.
  required_field_missing: 'blocking',
}

/** The task fields the gate reads. Supplied by the caller; the gate does no lookups itself. */
export interface InputGateInput {
  /** The task's title. Never on its own enough to satisfy the gate; see `descriptionFinding`. */
  title: string
  /** The task's description, as authored. */
  description: string
  /**
   * The block's level. The gate judges a TASK's authored input, so anything else is
   * `not_applicable`: see {@link describesAuthoredTaskInput}. Required rather than optional,
   * because a caller that forgets it would silently judge a frame's description as a task's.
   */
  level: BlockLevel
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
        /** The custom-task-type value bag, keyed by each declared field's `key`. */
        custom?: DescriptorFieldValues | undefined
      }
    | null
    | undefined
  /**
   * The create-form fields the task's CUSTOM type declares, resolved from the deployment's
   * `TaskTypeRegistry` by {@link inputGateInputOf}. Empty for every built-in type, and for a
   * namespaced type no deployment registered (stale data after an extension was removed) — the
   * honest answer there, since a gone registration declares nothing to require.
   *
   * Passed IN rather than looked up here so the evaluation stays a pure reduction over data: the
   * gate runs at three call sites that must agree byte-for-byte, and one of them (`wouldBlock`)
   * runs before a run exists at all.
   */
  customFields?: readonly DescriptorField[] | undefined
}

/**
 * The gate's input, read off a board block. The ONE mapping, because the gate is evaluated at
 * three points that must agree byte-for-byte about the same block: the engine's pre-dispatch
 * check, a `recheck` after a human edits the task, and the public API's pre-start admission. A
 * per-call-site object literal is how one of them silently stops passing `level` and starts
 * judging an initiative anchor as if it were a task.
 */
export function inputGateInputOf(
  block: {
    title: string
    description: string
    level: BlockLevel
    taskType?: string | null | undefined
    taskTypeFields?: InputGateInput['taskTypeFields']
  },
  taskTypes: TaskTypeRegistry,
): InputGateInput {
  return {
    title: block.title,
    description: block.description,
    level: block.level,
    taskType: block.taskType,
    taskTypeFields: block.taskTypeFields,
    // REQUIRED rather than optional, so a fourth evaluation site cannot quietly ship without
    // it. An optional registry would default a deployment's task types to "declares nothing",
    // which is indistinguishable from a correct answer right up until somebody's required
    // field stops being checked on one path only.
    customFields: block.taskType ? declaredFieldsOf(taskTypes, block.taskType) : undefined,
  }
}

/**
 * The create-form fields a task type declares, or undefined where that declaration is not the
 * truth about the collected bag.
 *
 * The SAME two stand-downs the CREATE door takes (`taskTypeCreationDefaults`'s
 * `checkCustomFields`), and they have to match: the whole argument for reading the existing
 * declaration rather than adding a second one is that both doors then answer identically.
 *
 *  - **A type this process does not REGISTER** declares nothing here. An unregistered namespaced
 *    type is a supported row (task types are node-local by design), so the honest answer is that
 *    this build cannot say what such a task needs, not that it needs nothing.
 *  - **A type carrying a `formPanel`**, whose bespoke create-form section owns the whole bag. Its
 *    descriptor fields are not what that panel collects, so requiring them would park a run on
 *    inputs the form it was authored in never offered.
 *
 * What the gate adds over the create door, given they agree, is WHEN it asks. The create check
 * fires once, against the declaration as it stood that day, on the paths that go through
 * `addTask`. This one fires at every run, against the declaration as it stands now, so a
 * requirement a deployment adds in a later release reaches the tasks that predate it, and a
 * task created on a node that did not register the type is still judged where it runs.
 */
function declaredFieldsOf(
  taskTypes: TaskTypeRegistry,
  taskType: string,
): readonly DescriptorField[] | undefined {
  const descriptor = taskTypes.get(taskType)
  return descriptor && !descriptor.formPanel ? descriptor.fields : undefined
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

/**
 * Whether this block's description is the authored statement of work the gate is entitled to
 * judge. Two ways it is not, and they are separate mechanisms rather than one list:
 *
 *  - **The block is not a TASK.** A run can be started against a frame, a module, an epic or an
 *    INITIATIVE ANCHOR, and each of those blocks stands for an entity whose real input lives
 *    elsewhere: the initiative's goal and committed plan, the service's spec, the module's
 *    contents. The description on such a block is a caption, not a brief, and a run against one
 *    (an initiative's planning pipeline is the everyday case) reads the entity rather than the
 *    caption. Judging it would park exactly the runs with no task to go and fix.
 *  - **The task type is platform-authored** ({@link PLATFORM_AUTHORED_TASK_TYPES}).
 *
 * Deliberately NOT here: a task the platform CREATED but whose description is still a real
 * statement of work (an initiative-spawned item, a task imported from a tracker ticket). Those
 * carry a brief someone or something wrote, they sit on the board as ordinary task cards, and a
 * human can edit them, so the gate judges them like any other task. What such a run needs is a
 * way to ANSWER the park without a browser, which is the public decision surface's job, not a
 * blanket exemption here.
 */
function describesAuthoredTaskInput(input: InputGateInput): boolean {
  if (input.level !== 'task') return false
  return !(input.taskType && PLATFORM_AUTHORED_TASK_TYPES.has(input.taskType))
}

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

/** A finding before the mode has floored its severity: the code, and what it is ABOUT. */
type PendingIssue = Omit<InputGateIssue, 'severity'>

/**
 * The per-TYPE checks for the BUILT-IN types. Each states what that type's pipeline
 * structurally consumes, so a gap here means a downstream step has no input rather than a weak
 * one. A type this file does not know yields nothing here, which is the honest answer: the
 * platform cannot have an opinion about what somebody else's task type needs — only the
 * deployment that registered it can, and it states that through {@link customFieldFindings}.
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
 * The per-type checks for a CUSTOM (deployment-registered) task type: the fields its own
 * create-form declares `required` and the task does not answer.
 *
 * This is the whole extension seam, and it is deliberately a READ of a declaration the
 * deployment already made rather than a second place to make it. A registered type's field
 * descriptors drive the create form; marking one required there and having the gate ignore it
 * would mean the same task is refused through the browser and accepted through the public API,
 * an initiative spawn or a tracker import — which is exactly the set of paths that produce the
 * empty tasks this gate exists for.
 *
 * The requiredness rule itself is `unfilledRequiredDescriptorFields` in contracts, shared with
 * the form's own validator so the two doors cannot drift. It honours `showWhen`: a field the
 * form would have hidden is not required, because parking a run on an input with nowhere to go
 * and fill it in is worse than letting a thin task reach a reviewer.
 *
 * A missing field is reported ONE PER FIELD, unlike the description checks which collapse to a
 * single reading. Three unanswered fields are three separate things to go and do, and a human
 * reading "one required field is missing" would fix it and be parked again.
 */
function customFieldFindings(input: InputGateInput): PendingIssue[] {
  const declared = input.customFields ?? []
  if (declared.length === 0) return []
  const values = input.taskTypeFields?.custom ?? {}
  return unfilledRequiredDescriptorFields(declared, values).map((field) => ({
    code: 'required_field_missing' as const,
    field: { key: field.key, label: field.label },
  }))
}

/**
 * Evaluate a task's input under a workspace's mode.
 *
 * `off` returns `status: 'off'` with NO findings: the check did not run, and an empty finding
 * list under a `passed` status would claim it did. A block whose description is not authored task
 * input (see {@link describesAuthoredTaskInput}) returns `not_applicable` for the same reason, one
 * step further: the check ran and found there was nothing here it is entitled to judge.
 * `advisory` runs every check and floors each finding to `advisory`, so it can report what
 * `standard` would have parked on without parking anything. The mode only ever SOFTENS: there is
 * no mode that promotes an advisory finding to blocking, because the advisory set is advisory on
 * the merits, not by configuration.
 */
export function evaluateInputGate(input: InputGateInput, mode: InputGateMode): InputGateVerdict {
  if (mode === 'off') return { status: 'off', mode, issues: [] }
  // Nothing here the gate is entitled to judge. Reported as its own status rather than as `off`
  // (which would blame a setting) or `passed` (which would claim the input was checked and found
  // sound).
  if (!describesAuthoredTaskInput(input)) {
    return { status: 'not_applicable', mode, issues: [] }
  }

  const pending: PendingIssue[] = []
  const description = descriptionFinding(input.description)
  if (description) pending.push({ code: description })
  pending.push(...typeFindings(input).map((code) => ({ code })))
  pending.push(...customFieldFindings(input))

  const issues: InputGateIssue[] = pending.map((issue) => ({
    ...issue,
    severity: mode === 'advisory' ? 'advisory' : INPUT_GATE_SEVERITY[issue.code],
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
