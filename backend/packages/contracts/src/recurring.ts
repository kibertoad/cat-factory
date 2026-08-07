import * as v from 'valibot'
import { taskSourceKindSchema } from './tasks.js'

// ---------------------------------------------------------------------------
// Recurring-pipeline wire contracts. A *pipeline schedule* attaches a reusable
// pipeline to a service (a `frame` block) and re-runs it on a recurring cadence —
// e.g. weekly dependency updates, or a tech-debt remediation pass. Each schedule
// owns exactly one reused on-board block (a `task` leaf inside the service frame);
// every time the schedule fires it starts the pipeline against that block, so the
// board shows a single recurring task whose live status and run history a human
// can inspect.
//
// The cadence is "run every `intervalHours`", optionally constrained to an
// allowed window — a set of weekdays plus an hour-of-day range (e.g. business
// hours) evaluated in the schedule's timezone. The engine rolls the computed next
// run forward until it lands inside an allowed window.
// ---------------------------------------------------------------------------

/**
 * Template a schedule was created from; drives the seeded block description.
 *
 * `tech-debt` and `bug-triage` are INFERRED by the SPA from the picked pipeline, whose shape is
 * specific to that kind of work. `dep-update` is not: its pipeline was retired in the catalog
 * collapse (it was the ordinary build tail under a recurring name), so a dependency-update schedule
 * runs a plain build rung and there is nothing to infer from. It stays in the union because an
 * explicit API caller can still name it to get the canned description.
 */
export const scheduleTemplateSchema = v.picklist([
  'dep-update',
  'tech-debt',
  'bug-triage',
  'custom',
])
export type ScheduleTemplate = v.InferOutput<typeof scheduleTemplateSchema>

const intakePredicateStringSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/**
 * Issue-intake configuration for a schedule whose pipeline pulls work from the
 * workspace's issue tracker (the `bug-intake` step of the bug-triage pipeline).
 * The pipeline stays generic; WHICH tracker board and WHICH predicates are
 * per-schedule. Credentials are the workspace's existing task connection — this
 * carries only the scope + filters.
 */
export const issueIntakeConfigSchema = v.object({
  /** Which connected task source the intake searches. */
  source: taskSourceKindSchema,
  /** The vendor's "board"/project scope; exactly the field for `source` is meaningful. */
  board: v.object({
    /** Jira project key, e.g. `PROJ`. */
    jiraProjectKey: v.optional(intakePredicateStringSchema),
    /** Linear team id (UUID). */
    linearTeamId: v.optional(intakePredicateStringSchema),
    /** GitHub repository as `owner/name`. */
    githubRepo: v.optional(intakePredicateStringSchema),
    /**
     * GitLab project as its full path with namespace, e.g. `group/project` or
     * `group/sub/project`. Its own leg rather than a reuse of `githubRepo`: a GitLab namespace
     * NESTS, so the two are not the same shape, and the two providers read different fields.
     */
    gitlabProject: v.optional(intakePredicateStringSchema),
    /**
     * A DEPLOYMENT-REGISTERED source's board scope, held opaquely: only that provider knows what
     * its board id means, so the platform carries the string and never interprets it.
     *
     * Its own field rather than reusing a built-in's. The three above are named for the vendor
     * whose provider reads them, so putting a registered source's id on one of them would hand a
     * provider a scope belonging to a different tracker — silently, since every one of them is a
     * plain string. A built-in source never sets this and a registered one never sets the others.
     */
    boardId: v.optional(intakePredicateStringSchema),
  }),
  /** Which open issues qualify. All present predicates must match. */
  predicates: v.object({
    /** Substring that must appear in the issue title. */
    titleFragment: v.optional(intakePredicateStringSchema),
    /** Label(s) that must ALL be present on the issue. */
    labels: v.optional(v.array(intakePredicateStringSchema)),
    /** Issue type name (Jira issue type / GitHub org issue type). Intake defaults to `bug`. */
    issueType: v.optional(intakePredicateStringSchema),
  }),
  /**
   * GitHub only: the label applied to mark a picked-up issue in-progress (GitHub
   * has no native workflow status). Absent ⇒ `in-progress`.
   */
  inProgressLabel: v.optional(intakePredicateStringSchema),
  /**
   * What a WEBHOOK-pushed issue event that matches these predicates actually does. Absent ⇒
   * `queue`, so every existing schedule is unchanged.
   *
   *  - **`queue`** fires this schedule, and the run's `bug-intake` step drains the board
   *    oldest-first. The pushed issue is not necessarily the one picked up: intake is fair
   *    queueing and the webhook's job is to drain the queue promptly, not to reorder it. This is
   *    the right shape for a bug backlog, where WHICH bug is worked next is the platform's call.
   *  - **`per-ticket`** dispatches THAT ticket: it is imported, materialised as its own task
   *    under the schedule's frame, and started on the schedule's pipeline. This is the shape for
   *    tickets a human already triaged — a feature request enters the platform from the tracker
   *    it was filed in rather than through an API call.
   *
   * They are different enough to be a mode rather than a knob: `queue` reuses ONE block and
   * competes for it, while `per-ticket` creates a block per ticket and never queues. A
   * `per-ticket` config therefore requires `onDemand` (see `assertValidIssueIntake`), because a
   * CADENCE tick has no triggering ticket and would otherwise silently fall back to draining the
   * queue — the same rule under a different name.
   */
  dispatch: v.optional(v.picklist(['queue', 'per-ticket'])),
})
export type IssueIntakeConfig = v.InferOutput<typeof issueIntakeConfigSchema>

/**
 * Why a schedule's issue-intake configuration was refused, as `error.details.reason`.
 *
 * The backend does not localize prose, so a refusal that carried only its `message` would reach a
 * non-English user as English. These are the machine-readable half the SPA maps to translated copy
 * through an exhaustive `Record`, which is why the vocabulary lives HERE rather than as string
 * literals at the throw site: both sides import the same union, and adding a member fails the SPA's
 * typecheck until it has copy.
 *
 * Both members describe the same underlying rule (the two dispatch modes are exclusive) from the
 * two directions an author can hit it, and they are kept apart because the fix differs: one is
 * "make the schedule on-demand", the other is "pick a pipeline with no `bug-intake` step".
 */
export const issueIntakeRefusalReasonSchema = v.picklist([
  'per_ticket_requires_on_demand',
  'per_ticket_conflicts_with_bug_intake',
])
export type IssueIntakeRefusalReason = v.InferOutput<typeof issueIntakeRefusalReasonSchema>

const hourOfDaySchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(23))
const weekdaySchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))

/**
 * How often a schedule fires and when it is allowed to. `intervalHours` is the
 * base cadence; `weekdays` (0=Sunday..6=Saturday; empty = every day) and the
 * `windowStartHour`/`windowEndHour` range (both null = any hour) gate which
 * instants are eligible, evaluated in `timezone` (an IANA zone, e.g.
 * "Europe/Helsinki"; default "UTC").
 */
export const recurrenceSchema = v.object({
  intervalHours: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(24 * 365)),
  /** Allowed weekdays (0–6). Empty means every day. */
  weekdays: v.array(weekdaySchema),
  /** Inclusive start of the allowed hour-of-day window, or null for no lower bound. */
  windowStartHour: v.nullable(hourOfDaySchema),
  /** Exclusive end of the allowed hour-of-day window, or null for no upper bound. */
  windowEndHour: v.nullable(hourOfDaySchema),
  /** IANA timezone the weekday/hour window is evaluated in. */
  timezone: v.string(),
})
export type Recurrence = v.InferOutput<typeof recurrenceSchema>

/**
 * A recurring pipeline attached to a service. `blockId` is the reused on-board
 * task block the pipeline runs against; `frameId` is the service frame it lives
 * in. `nextRunAt` is the computed epoch-ms of the next eligible fire (the global
 * sweeper queries `enabled AND nextRunAt <= now`).
 *
 * An **on-demand** schedule (`onDemand: true`) has no automatic cadence — the
 * global sweeper never fires it; it runs ONLY when a human triggers it via
 * "run now". Because a person is always present at fire time, an on-demand
 * schedule's block MAY use an individual-usage subscription model (Claude/Codex/
 * GLM), which a cadence schedule can never do (no one is present to unlock it).
 * Its `recurrence` is retained but ignored, and `nextRunAt` never drives a fire.
 */
export const pipelineScheduleSchema = v.object({
  id: v.string(),
  /**
   * The account-owned service this schedule belongs to (in-org sharing): a schedule on a
   * shared service is visible on every workspace that mounts it and fires once per org.
   * Null for a legacy schedule not yet associated with a service.
   */
  serviceId: v.nullable(v.string()),
  blockId: v.string(),
  frameId: v.string(),
  pipelineId: v.string(),
  template: scheduleTemplateSchema,
  name: v.string(),
  recurrence: recurrenceSchema,
  /** Manual-only: never auto-fired by the sweeper; may use an individual-usage model. */
  onDemand: v.boolean(),
  /** Issue-intake scope + predicates, for a pipeline with a `bug-intake` step. */
  issueIntake: v.optional(issueIntakeConfigSchema),
  enabled: v.boolean(),
  lastRunAt: v.nullable(v.number()),
  nextRunAt: v.number(),
  createdAt: v.number(),
})
export type PipelineSchedule = v.InferOutput<typeof pipelineScheduleSchema>

/** One historical fire of a schedule (retained ~1 week), surfaced in the inspector. */
export const scheduleRunSchema = v.object({
  id: v.string(),
  scheduleId: v.string(),
  /** The execution this fire started, or null if the start was skipped/failed. */
  executionId: v.nullable(v.string()),
  status: v.picklist(['running', 'done', 'failed', 'skipped']),
  startedAt: v.number(),
  finishedAt: v.nullable(v.number()),
  /** Short outcome line (e.g. a PR URL or "merged"), or null while running. */
  outcome: v.nullable(v.string()),
})
export type ScheduleRun = v.InferOutput<typeof scheduleRunSchema>

// ---- Request bodies -------------------------------------------------------

const scheduleNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80))

/** Create a recurring pipeline on a service frame. */
export const createScheduleSchema = v.object({
  frameId: v.string(),
  pipelineId: v.string(),
  template: v.optional(scheduleTemplateSchema, 'custom'),
  name: scheduleNameSchema,
  /**
   * The cadence for a scheduled pipeline. Optional — an on-demand schedule needs no
   * cadence, so the server fills a nominal (ignored) recurrence when it is omitted.
   */
  recurrence: v.optional(recurrenceSchema),
  /**
   * When true the schedule is manual-only: the sweeper never fires it, so its block may
   * use an individual-usage subscription model (unlocked per run-now by the initiator).
   */
  onDemand: v.optional(v.boolean(), false),
  /** Issue-intake scope + predicates (required by Phase E's validation for a `bug-intake` pipeline). */
  issueIntake: v.optional(issueIntakeConfigSchema),
  enabled: v.optional(v.boolean(), true),
  /**
   * The prompt/description for the reused on-board task block — the same free-text a
   * normal task carries, fed to every agent step. Omitted/empty ⇒ the template's seed
   * description. This is what lets a `custom` recurring task say what it should do.
   */
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
})
export type CreateScheduleInput = v.InferOutput<typeof createScheduleSchema>

/** Patch an existing schedule (all fields optional). */
export const updateScheduleSchema = v.object({
  name: v.optional(scheduleNameSchema),
  pipelineId: v.optional(v.string()),
  recurrence: v.optional(recurrenceSchema),
  /** New intake config, or null to clear it. Omitted ⇒ unchanged. */
  issueIntake: v.optional(v.nullable(issueIntakeConfigSchema)),
  enabled: v.optional(v.boolean()),
})
export type UpdateScheduleInput = v.InferOutput<typeof updateScheduleSchema>
