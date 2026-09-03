import * as v from 'valibot'

// ---------------------------------------------------------------------------
// ENVIRONMENT INVESTIGATION: the vocabulary of what the platform does when an environment never
// becomes usable and no checkout edit can help.
//
// The sibling of `deploy-fix.ts`, and deliberately its opposite half. The `deploy-fixer` runs
// only for `manifest_invalid`: a document the checkout owns and got wrong. Everything else a
// provisioning failure can be (a VM that went offline under a deploy job that reported success, a
// load balancer with no healthy target, a DNS record that was never published) lives entirely in
// the provider, and the conclusion the platform drew from "a code fixer cannot help here" used to
// be "nobody can help here": the run died at the tester with a report correctly saying a human had
// to look. What actually follows is that a DIFFERENT investigator is needed, one whose evidence is
// the provider rather than the repository.
//
// The division of labour is the one CLAUDE.md states for every model-in-the-loop decision: the
// model JUDGES (which layer is at fault, on which evidence) and the platform COMPUTES (which
// action it is allowed to take, whether it takes it, and, always, whether the environment came
// up afterwards). The verdict is never the proof. The re-probe is.
//
// Tracker: `docs/initiatives/environment-investigation.md`.
// ---------------------------------------------------------------------------

// Every schema below that ends up INSIDE a pipeline step is declared as an explicit interface and
// annotated `v.GenericSchema<unknown, T>` rather than inferred with `v.InferOutput`, the shape
// `binaryGenerationOptionsSchema` already uses. The investigation state nests four object levels
// under `PipelineStep` (step → state → attempt → verdict → evidence), which is deep enough that
// inferring it tips `tsc` into "type instantiation is excessively deep" in a consumer several
// packages away. It was first seen in `WorkspaceService`, which is nowhere near this file and gives a
// reader nothing to go on. `unknown` on the input side is what a parser accepts anyway.

/** The inline engine kind the investigation runs under (model resolution + spend attribution). */
export const ENVIRONMENT_INVESTIGATOR_AGENT_KIND = 'environment-investigator'

/**
 * WHERE the fault the investigator found lives, which is the one thing its report has to settle:
 * every reader (the run's recorded failure, an operator, a later retry) does something different
 * per layer, and today they all get the same "the environment did not come up".
 *
 *  - `provider`: the infrastructure the platform asked for is broken or was never delivered. A
 *    VM that went offline, a balancer with no healthy target, a DNS record never published, a
 *    quota refusal. The platform can sometimes retry into it and can never fix it.
 *  - `platform`: cat-factory itself got it wrong. A readiness ceiling that expired on an
 *    environment still legitimately converging, a URL published before it resolved, a poll that
 *    read a field the provider does not populate.
 *  - `deployment`: the description the run deployed is at fault, but NOT in a way the
 *    `manifest_invalid` classifier caught (a workload that starts and crashes, an image the
 *    cluster cannot pull). Distinct from `provider` because the fix is a commit; distinct from the
 *    deploy-fixer's admission because the finding is a HYPOTHESIS and does not itself dispatch a
 *    container against a checkout.
 *  - `unknown`: the evidence did not settle it. A first-class answer, never a default dressed up
 *    as one: "we could not tell" and "the provider is broken" send different people to different
 *    places, and collapsing them is how an operator ends up debugging a healthy cluster.
 */
export const environmentFaultLayerSchema = v.picklist([
  'provider',
  'platform',
  'deployment',
  'unknown',
])
export type EnvironmentFaultLayer = v.InferOutput<typeof environmentFaultLayerSchema>

/**
 * What the platform may DO about it, as a closed vocabulary the model picks from and the engine
 * executes. The model never acts: it names one of these and the engine decides whether this
 * deployment, this provider and this budget allow it.
 *
 *  - `stop`: nothing here is retryable. The run fails with the investigator's named cause instead
 *    of a tester's guess, which is the whole point of the second outcome.
 *  - `wait`: the environment is converging and the ceiling was simply too tight for it. Extends
 *    the readiness wait ONCE, by the ceiling again.
 *  - `restart`: restart the workload in place, without rebuilding anything around it. The one
 *    action that needs the provider to implement `EnvironmentDiagnostics.remediate`.
 *  - `reprovision`: stand it up again over the same target. Idempotent for every provider whose
 *    provision is an apply; the existing environment is left in place.
 *  - `recreate`: tear the environment down first, then stand it up again. For a target whose own
 *    state is what is wrong, where re-applying over it would reproduce the fault.
 */
export const environmentRemediationActionSchema = v.picklist([
  'stop',
  'wait',
  'restart',
  'reprovision',
  'recreate',
])
export type EnvironmentRemediationAction = v.InferOutput<typeof environmentRemediationActionSchema>

/**
 * Whether an action needs the provider to implement the optional remediation capability.
 *
 * An exhaustive `Record` rather than a membership test, for the reason
 * `REPO_FIXABLE_ENVIRONMENT_FAILURES` is one: the default a new action would silently inherit is
 * wrong in both directions. `false` on an action no provider can perform makes the engine promise
 * something and do nothing; `true` on one the platform owns outright (tearing an environment down
 * and standing it up again are `EnvironmentProvider` methods every provider already has) withholds
 * the only remedy available from every provider that never implemented diagnostics.
 */
const REMEDIATION_NEEDS_PROVIDER_SUPPORT: Record<EnvironmentRemediationAction, boolean> = {
  stop: false,
  wait: false,
  restart: true,
  reprovision: false,
  recreate: false,
}

/** See {@link REMEDIATION_NEEDS_PROVIDER_SUPPORT}. */
export function remediationNeedsProviderSupport(action: EnvironmentRemediationAction): boolean {
  return REMEDIATION_NEEDS_PROVIDER_SUPPORT[action]
}

/**
 * Narrow an arbitrary string to a member, DERIVED from the picklist's own options so adding one
 * needs no second edit here. Used wherever a PERSISTED action is read back: the vocabulary is
 * closed and stored on a run's step, so a member retired later is still in the database, and a
 * reader that assumed the type was total would splice `undefined` into the very message whose job
 * is to name what a human must re-pick (CLAUDE.md's closed-vocabulary rule).
 */
export function isEnvironmentRemediationAction(
  value: string | null | undefined,
): value is EnvironmentRemediationAction {
  if (!value) return false
  return (environmentRemediationActionSchema.options as readonly string[]).includes(value)
}

/** Compile-time totality guard for {@link describeRemediationAction}. */
function unrecognisedRemediation(action: never): string {
  return `an unrecognised remediation (${JSON.stringify(action)})`
}

/**
 * One-line description of a stored action, for an operator-facing message. Total against the TYPE
 * through the `never` helper (adding a member fails the build) and honest about the DATA: a value
 * that is no longer a member is named as retired rather than guessed onto a current one, because
 * nothing knows which one was meant.
 */
export function describeRemediationAction(action: string): string {
  if (!isEnvironmentRemediationAction(action)) {
    return `a remediation this deployment no longer offers (${JSON.stringify(action)})`
  }
  switch (action) {
    case 'stop':
      return 'stop and report the cause'
    case 'wait':
      return 'keep waiting for the environment to converge'
    case 'restart':
      return 'restart the workload in place'
    case 'reprovision':
      return 'provision the environment again'
    case 'recreate':
      return 'tear the environment down and provision it again'
    default:
      return unrecognisedRemediation(action)
  }
}

/**
 * One piece of evidence the investigator cites, kept as a `{ source, statement }` pair rather than
 * a sentence so a reader can tell WHICH read produced it. The failure this feature was filed for
 * turned on exactly that distinction: the environment record said `ready`, the provider's own
 * describe said the VM was offline, and the argument is entirely that two named sources disagreed.
 */
export interface EnvironmentEvidenceItem {
  /** Where the fact came from (`provider.describe`, `provisionFields`, `timeline`, …). */
  source: string
  /** The fact itself, in the investigator's words. */
  statement: string
}

export const environmentEvidenceItemSchema: v.GenericSchema<unknown, EnvironmentEvidenceItem> =
  v.object({
    source: v.pipe(v.string(), v.maxLength(120)),
    statement: v.pipe(v.string(), v.maxLength(1000)),
  })

/**
 * The investigator's verdict: what it concluded and what it wants done, nothing else.
 *
 * There is deliberately no "did the remediation work" field. Whether the environment came up is
 * established by the re-provision and the provider's next readiness verdict, never by the model's
 * account of itself: the same rule the teardown probe (only a `confirmed` probe is a reclaim), the
 * bugfix reproduction proof (only red-then-green is proof) and the deploy-fixer are built on.
 */
export interface EnvironmentInvestigationVerdict {
  faultLayer: EnvironmentFaultLayer
  /** One paragraph a human reads first: what is wrong, in plain words. */
  summary: string
  /** The facts the conclusion rests on. Empty is legitimate and means "nothing supported it". */
  evidence: EnvironmentEvidenceItem[]
  action: EnvironmentRemediationAction
  /** Why THIS action, in one or two sentences. */
  actionRationale: string
}

export const environmentInvestigationVerdictSchema: v.GenericSchema<
  unknown,
  EnvironmentInvestigationVerdict
> = v.object({
  faultLayer: environmentFaultLayerSchema,
  summary: v.pipe(v.string(), v.maxLength(4000)),
  evidence: v.array(environmentEvidenceItemSchema),
  action: environmentRemediationActionSchema,
  actionRationale: v.pipe(v.string(), v.maxLength(1000)),
})

/** At most this many cited facts survive coercion; past it the model is padding, not evidencing. */
const MAX_EVIDENCE_ITEMS = 20

function isFaultLayer(value: unknown): value is EnvironmentFaultLayer {
  return (
    typeof value === 'string' &&
    (environmentFaultLayerSchema.options as readonly string[]).includes(value)
  )
}

/**
 * Trim a prose field to `max` characters INCLUSIVE of the ellipsis that states the drop.
 *
 * The ellipsis counts against the budget rather than riding on top of it, because `max` is the
 * same number the schema beside it declares as `v.maxLength`: a coercion that answered `max + 1`
 * produced a value its own validator then rejected, on a field persisted to `step
 * .environmentInvestigation` and served through `executionInstanceSchema`, whose lengths are
 * published into the OpenAPI spec and the four SDKs.
 */
function coerceText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

function coerceEvidence(value: unknown): EnvironmentEvidenceItem[] {
  if (!Array.isArray(value)) return []
  const items: EnvironmentEvidenceItem[] = []
  for (const entry of value) {
    if (items.length >= MAX_EVIDENCE_ITEMS) break
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const statement = coerceText(record.statement, 1000)
    if (!statement) continue
    items.push({ source: coerceText(record.source, 120) ?? 'unattributed', statement })
  }
  return items
}

/**
 * Read a model reply into a verdict, LENIENTLY in the fields that are prose and STRICTLY in the
 * two that are decisions.
 *
 * A fault layer or an action the model invented is not coerced onto a neighbour: both drop to the
 * value meaning "this did not settle anything" (`unknown` / `stop`), because the action is the one
 * field where a generous reading spends real infrastructure on a guess. The prose fields degrade
 * field-by-field instead of discarding the whole verdict, since a report whose `evidence` array is
 * malformed still names a cause worth putting on the record.
 *
 * Returns null when there is no object at all. The caller then records the investigation as FAILED,
 * which is not the same as a verdict of `stop` and must never read like one.
 */
export function coerceEnvironmentInvestigationVerdict(
  raw: unknown,
): EnvironmentInvestigationVerdict | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const action = typeof value.action === 'string' ? value.action : undefined
  return {
    faultLayer: isFaultLayer(value.faultLayer) ? value.faultLayer : 'unknown',
    summary: coerceText(value.summary, 4000) ?? '',
    evidence: coerceEvidence(value.evidence),
    action: isEnvironmentRemediationAction(action) ? action : 'stop',
    actionRationale: coerceText(value.actionRationale, 1000) ?? '',
  }
}

/**
 * How many investigation rounds a `deployer` step gets. Two, for the reason the deploy-fixer's
 * budget is two: the first round has the whole evidence bag and the provider's own account, and a
 * second covers a remedy that was right about the layer and wrong about the action. A third round
 * against an environment that has twice refused to come up is not converging, and each round costs
 * an LLM call plus real infrastructure work.
 */
export const DEFAULT_ENVIRONMENT_INVESTIGATION_MAX_ATTEMPTS = 2

/** Bounds on the per-step budget: `0` disables the loop, 5 is the ceiling. */
export const environmentInvestigationAttemptsSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(5),
)

/**
 * A `deployer` step's investigation configuration (`stepOptions.environmentInvestigation`), the
 * sibling of `stepOptions.deployFix` and on the step for the same reason: whether a failed
 * provision is worth an automatic diagnosis-and-retry is a fact about the ENVIRONMENT (a throwaway
 * preview stack wants it; a deployer pointed at shared infrastructure may want a person on every
 * failure), and the task's risk appetite says nothing about which of those this step is.
 */
export interface EnvironmentInvestigationConfig {
  /**
   * Whether a non-repo-fixable provisioning failure is investigated at all. Absent ⇒ enabled.
   * `false` restores the prior behaviour exactly: the failure is terminal, and unexplained.
   */
  enabled?: boolean | undefined
  /** Attempt budget; absent ⇒ {@link DEFAULT_ENVIRONMENT_INVESTIGATION_MAX_ATTEMPTS}. */
  maxAttempts?: number | undefined
  /**
   * Whether a verdict may act at all, or only report. `false` leaves `stop` as the ONLY offered
   * action, so every round diagnoses and nothing else happens: that keeps most of the value (a
   * named cause instead of a tester guessing from a DNS failure) for a deployer pointed at
   * infrastructure a person insists on touching themselves. Absent ⇒ acting is allowed.
   *
   * `wait` is refused too, though it touches no infrastructure. It is a member of the remediation
   * vocabulary and it does change what the run does (it holds it for another readiness ceiling),
   * and an operator who asked for report-only is owed the failure at the time they expected it.
   */
  allowRemediation?: boolean | undefined
}

export const environmentInvestigationConfigSchema: v.GenericSchema<
  unknown,
  EnvironmentInvestigationConfig
> = v.object({
  enabled: v.optional(v.boolean()),
  maxAttempts: v.optional(environmentInvestigationAttemptsSchema),
  allowRemediation: v.optional(v.boolean()),
})

/**
 * One investigation round, recorded when it settles so the run detail (and a human reading the
 * failure) can see what was concluded, what was attempted, and what the environment did next.
 *
 * `outcome` is about the ROUND, not about the environment: `reported` means the investigation
 * produced a verdict and nothing was acted on, `remediated` means an action ran, and `failed`
 * means the investigation itself could not be completed. Whether the environment then came up is
 * the deployer's next verdict and is nowhere in here on purpose.
 */
export interface EnvironmentInvestigationAttempt {
  /**
   * 1-based ordinal in this log. It matches `attempts` on a run that never loops back to the
   * deployer, and diverges from it after one: the counter is re-armed for each provisioning cycle
   * (`restartEnvironmentInvestigationState`) while these rows survive the whole run, being what
   * the verification report reduces.
   */
  attempt: number
  /**
   * The 0-based provisioning CYCLE this round ran in. A loop-back to the deployer re-arms the
   * budget and opens a new cycle (`restartEnvironmentInvestigationState`) while these rows
   * survive the whole run, so the marker is what tells a reader which rounds were counted
   * against the LIVE budget, and what scopes a read of the last verdict to the environment now
   * under investigation rather than the one a re-provision superseded. Absent on a row written
   * before the field existed, which reads as cycle 0.
   */
  cycle?: number | null | undefined
  /** Epoch ms when the round settled. */
  at: number
  outcome: 'reported' | 'remediated' | 'failed'
  /** The classified provisioning cause this round was dispatched against, when there was one. */
  reason?: string | null | undefined
  /** The provisioning error this round was handed. */
  error: string
  /** The verdict, absent when the investigation itself failed. */
  verdict?: EnvironmentInvestigationVerdict | null | undefined
  /**
   * The action the engine actually RAN, which is not always the one the verdict asked for: a
   * budget can be spent, a deployment can forbid acting, and a provider can lack the capability.
   * Absent ⇒ nothing was run. Stated separately from `verdict.action` precisely so a reader can
   * tell a refused remedy from one that ran and did not help.
   *
   * A plain `string` rather than the action union, because it is PERSISTED: a member retired later
   * is still in the database, and a column typed as the current union would make every exhaustive
   * reader total against the type and partial against the data. Readers narrow with
   * {@link isEnvironmentRemediationAction}.
   */
  ranAction?: string | null | undefined
  /** Why the requested action was not run, when it was not. */
  withheld?: string | null | undefined
  /** The investigation's own failure message when `outcome` is `failed`. */
  failure?: string | null | undefined
}

export const environmentInvestigationAttemptSchema: v.GenericSchema<
  unknown,
  EnvironmentInvestigationAttempt
> = v.object({
  attempt: v.number(),
  cycle: v.optional(v.nullable(v.number())),
  at: v.number(),
  outcome: v.picklist(['reported', 'remediated', 'failed']),
  reason: v.optional(v.nullable(v.string())),
  error: v.string(),
  verdict: v.optional(v.nullable(environmentInvestigationVerdictSchema)),
  ranAction: v.optional(v.nullable(v.string())),
  withheld: v.optional(v.nullable(v.string())),
  failure: v.optional(v.nullable(v.string())),
})

/**
 * How many readiness-ceiling extensions a `wait` verdict may win on a `deployer` step, counted
 * over the whole RUN. One: a second would let a model postpone a run indefinitely, one ceiling at
 * a time.
 *
 * Deliberately NOT re-armed per provisioning cycle, unlike the round budgets beside it. A cycle
 * is not always started by a person or a gate: `StepGraph.rerunProducerThrough` resets every step
 * from a producer through its companion and judge, and the judge loop and the below-threshold
 * companion loop both drive it with no human in the loop. A per-cycle bound would therefore hand
 * the model a fresh extension on each automatic rework round, which is the outcome this bound
 * exists to prevent.
 */
export const MAX_ENVIRONMENT_WAIT_EXTENSIONS = 1

/**
 * The live investigation state on a `deployer` step.
 *
 * Unlike `deployFix` there is no `phase` discriminator, because there is no job: the whole loop is
 * an inline LLM call plus provider calls the engine makes itself, so nothing rides `step.jobId`
 * and the poll router needs no help telling two kinds of job apart. Provider credentials also
 * never leave the backend, which is the reason this is not a container agent.
 */
export interface EnvironmentInvestigationState {
  /** Rounds run so far. */
  attempts: number
  /** The budget resolved at the FIRST round, frozen so a mid-run pipeline edit can't move it. */
  maxAttempts: number
  /** The service frame whose environment is under investigation. */
  frameId: string
  /** The environment the rounds are about, when one was recorded before the failure. */
  environmentId?: string | null | undefined
  /**
   * Readiness-ceiling extensions granted over the whole run, never re-armed by a loop-back; see
   * {@link MAX_ENVIRONMENT_WAIT_EXTENSIONS}. It is both the bound's counter and the run's only
   * record that a `wait` was granted, a remedy that otherwise leaves no trace: the bring-up
   * simply runs past the configured ceiling.
   */
  waitExtensions?: number | null | undefined
  /**
   * The 0-based provisioning cycle now running, bumped by `restartEnvironmentInvestigationState`
   * and stamped onto each round; see {@link EnvironmentInvestigationAttempt.cycle}.
   */
  cycle?: number | null | undefined
  /**
   * Per-round history, newest last, CAPPED at {@link MAX_ENVIRONMENT_INVESTIGATION_ATTEMPT_LOG}.
   * The log survives the whole run (the verification report reduces it) while the state rides the
   * run's `detail` JSON, re-serialized on every step write, so an uncapped log would grow with
   * every loop-back for the rest of the run. A round carries a 4000-character verdict summary and
   * up to {@link MAX_EVIDENCE_ITEMS} cited facts, so the rows are not small.
   */
  attemptLog?: EnvironmentInvestigationAttempt[] | null | undefined
  /**
   * How many of the oldest rounds the {@link attemptLog} cap has dropped. Recorded rather than
   * silently truncated: the report reduces the surviving rows, so a dropped one would otherwise
   * turn into a round that reads as never having run.
   */
  droppedAttempts?: number | null | undefined
}

export const environmentInvestigationStateSchema: v.GenericSchema<
  unknown,
  EnvironmentInvestigationState
> = v.object({
  attempts: v.number(),
  maxAttempts: v.number(),
  frameId: v.string(),
  environmentId: v.optional(v.nullable(v.string())),
  waitExtensions: v.optional(v.nullable(v.number())),
  cycle: v.optional(v.nullable(v.number())),
  attemptLog: v.optional(v.nullable(v.array(environmentInvestigationAttemptSchema))),
  droppedAttempts: v.optional(v.nullable(v.number())),
})

/**
 * How many investigation rounds the run-long attempt log keeps. Four times the per-cycle ceiling
 * of 5, so only a run that looped its deployer back several times over reaches it, and what it
 * then drops is the oldest cycle rather than the one a reader is looking at.
 */
export const MAX_ENVIRONMENT_INVESTIGATION_ATTEMPT_LOG = 20
