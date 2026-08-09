import { hasApproverPolicy, requiredGateApprovals, ValidationError } from '@cat-factory/kernel'
import type {
  GateRegistry,
  PipelineAvailability,
  StepGateConfig,
  StepGating,
  StepOptions,
  TesterQualityConfig,
} from '@cat-factory/kernel'
import type { BinaryOutputConfig } from '@cat-factory/contracts'
import { conflictingOutputSizeOptions, validateDescriptorFields } from '@cat-factory/contracts'
import {
  BINARY_OUTPUT_TRAIT,
  companionTargets,
  hasTrait,
  INLINE_ENGINE_SYSTEM_PROMPTS,
  isCompanionKind,
  isGatableKind,
  SKILL_AGENT_KIND,
  TASK_ESTIMATOR_AGENT_KIND,
} from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { isTesterKind } from '../execution/ci.logic.js'

/**
 * How a run was LAUNCHED, threaded into {@link ExecutionService.start} so the launch-constraint
 * gate can reject a `'manual'` start of a `'recurring'`-only pipeline (and vice versa). A retry
 * or restart re-drives an already-validated run, so it passes no origin and the gate is skipped.
 */
export type RunOrigin = 'manual' | 'recurring'

/**
 * The `bug-intake` engine step pulls one issue from the schedule's configured tracker board, so
 * it is meaningless without a schedule — a pipeline carrying it must be `'recurring'`. Kept as a
 * bare literal here (the step handler that registers it lives in the engine — see
 * `RunDispatcher.buildStepHandlerRegistry`); this structural guard only needs the identifier.
 * Exported so the recurring-schedule intake-config validation and the engine handler share ONE
 * source of truth for the kind id.
 */
export const BUG_INTAKE_AGENT_KIND = 'bug-intake'

/**
 * Whether a pipeline's ENABLED steps include a `bug-intake` step — the trigger for both the
 * recurring-only launch constraint (above) and the schedule's `issueIntake`-required validation
 * (`RecurringPipelineService`). A disabled `bug-intake` step never runs, so it imposes neither.
 */
export function pipelineHasEnabledBugIntake(agentKinds: string[], enabled?: boolean[]): boolean {
  return agentKinds.some((kind, i) => kind === BUG_INTAKE_AGENT_KIND && enabled?.[i] !== false)
}

/**
 * Structural validation shared by the pipeline builder (save) and the execution engine
 * (run start), so a pipeline that is invalid is rejected at BOTH boundaries.
 *
 * A run is built from the ENABLED steps alone, executed consecutively, so both checks
 * reason over the enabled subset:
 *
 *  - {@link assertValidCompanionPlacement}: a companion (reviewer / architect-companion /
 *    spec-companion) must run IMMEDIATELY after an ENABLED step it can review. Companions are
 *    dependent agents — they make no sense without their producer — so the builder surfaces
 *    them as toggles attached to the producer (inserting them immediately after), and the
 *    validation enforces exactly that adjacency: a companion's nearest preceding enabled step
 *    must be one of its targets. (The engine still reviews the nearest preceding target, but
 *    that target is now guaranteed to be the immediate predecessor.)
 *  - {@link assertValidGating}: a step gated on the task estimate must declare itself GATABLE
 *    (`isGatableKind` — a kind whose output later steps read as context rather than depend on
 *    structurally), must not also carry a human approval gate, must set at least one axis
 *    threshold (or it would always skip), and needs a `task-estimator` to have run before it (or
 *    the gate has nothing to consult).
 *  - {@link assertValidRunConditions}: a step carrying a RUN CONDITION must satisfy the two
 *    structural rules an estimate gate satisfies — a gatable kind, and no human approval gate on
 *    the same step — because a skip is a skip whichever of the two axes caused it.
 *  - {@link assertValidAgentVariants}: a step selecting a registered agent-kind VARIANT must name
 *    one that exists and that varies THIS step's kind — an unknown id would silently fall back to
 *    the shipped prompt, and a mismatched one would run the step under another role's prompt.
 *  - {@link assertValidTesterQualityGating}: the test quality-control companion's optional
 *    estimate gate lives on the Tester step itself (not a companion row), so it is validated
 *    separately — but under the same "threshold set + estimator earlier" rules, since a
 *    QC gate with no estimator would silently never gate.
 *  - {@link assertValidBinaryOutputSteps}: a step whose kind carries the `binary-output` trait
 *    must select the foundational service it stores its generated binaries through — a
 *    generator with nowhere to deliver would dispatch and only be able to refuse.
 *  - {@link assertValidGateConfig}: a step's gate configuration must have a gate to configure —
 *    an approver set needs the step's approval gate ON, a quorum needs enough named approvers to
 *    reach it, and gate PARAMETERS must be declared by a gate this deployment registers for that
 *    step kind. Each failure otherwise lands as a checkpoint that silently does not exist, a run
 *    that parks forever, or a setting nobody reads.
 *
 * Each check takes the whole shape rather than the two or three arrays it happens to read today:
 * the gating check needed `gates` + the kind registry after the estimate-gating rules were
 * generalised past companions, and threading those as further positional parameters through one
 * of four otherwise-similar signatures is how these drift apart.
 */
export interface PipelineShape {
  agentKinds: string[]
  enabled?: boolean[]
  /**
   * The per-step HUMAN approval gate flags. Read by {@link assertValidGating} to refuse a step
   * that carries both a human gate and an estimate gate — the estimate may ADD a human
   * checkpoint, never cancel one a pipeline author asked for.
   */
  gates?: boolean[]
  gating?: (StepGating | null)[]
  testerQuality?: (TesterQualityConfig | null)[]
  stepOptions?: (StepOptions | null)[]
  /**
   * The app-owned agent-kind registry, so a DEPLOYMENT-registered kind's own `gatable` flag is
   * honoured. Absent ⇒ built-in kinds only, which is correct for a caller validating a built-in
   * catalog (the kernel seed test) but would wrongly refuse a registered gatable kind at a
   * boundary that has the registry — so both real boundaries (builder save, run start) pass it.
   */
  agentKindRegistry?: AgentKindRegistry
  /**
   * The app-owned gate registry, so a step's gate PARAMETERS are validated against the fields the
   * gate itself declared. Absent ⇒ the gate-declared half is not checked, which is correct for a
   * caller validating a built-in catalog with no registrations in view (the kernel seed test) and
   * wrong at a real boundary — so both pass one.
   */
  gateRegistry?: GateRegistry
}

export function validatePipelineShape(pipeline: PipelineShape): void {
  assertValidCompanionPlacement(pipeline)
  assertValidGating(pipeline)
  assertValidRunConditions(pipeline)
  assertValidTesterQualityGating(pipeline)
  assertValidSkillSteps(pipeline)
  assertValidAgentVariants(pipeline)
  assertValidBinaryOutputSteps(pipeline)
  assertValidGateConfig(pipeline)
}

/**
 * Validate every step's gate configuration (`stepOptions[i].gateConfig`) — both halves, each
 * against the thing that owns it.
 *
 *  1. The approval half (`approvers` / `minApprovals`) needs a human gate to configure. On a step
 *     with no `gates[i]`, an approver set is a checkpoint that silently does not exist: nobody is
 *     ever asked, and the author has every reason to believe two sign-offs are being collected.
 *  2. A quorum above 1 counts DISTINCT identities, so it needs more than one possible approver.
 *     A policy naming exactly one user with `minApprovals: 2` can never be satisfied — the second
 *     approval has nobody left to come from — and the run would park forever.
 *  3. The gate-declared half (`fields`) needs a REGISTERED gate on this step's kind, and every
 *     key must be one that gate declared. An undeclared key is indistinguishable from a typo'd
 *     one, and both read to whoever typed them as configuration that took effect.
 *
 * Skipped when no registry is supplied (the kernel seed test's built-in catalog, which has no
 * deployment registrations in view); both real boundaries pass one.
 */
export function assertValidGateConfig({
  agentKinds,
  enabled,
  gates,
  stepOptions,
  gateRegistry,
}: PipelineShape): void {
  if (!stepOptions) return
  for (let i = 0; i < agentKinds.length; i++) {
    const config = stepOptions[i]?.gateConfig
    const kind = agentKinds[i]
    if (!config || kind === undefined || enabled?.[i] === false) continue
    const configuresApproval =
      hasApproverPolicy(config.approvers) || config.minApprovals !== undefined
    if (configuresApproval && gates?.[i] !== true) {
      throw new ValidationError(
        `Step '${kind}' configures an approval gate (approvers / required approvals) but carries no approval gate. Turn the step's approval gate on, or drop the configuration.`,
      )
    }
    assertSatisfiableQuorum(kind, config)
    // The gate-declared half needs the registry to judge it: with none in view the caller is
    // validating a catalog it cannot resolve registrations for, so it checks the platform half only.
    if (!gateRegistry || !config.fields || Object.keys(config.fields).length === 0) continue
    if (!gateRegistry.has(kind)) {
      throw new ValidationError(
        `Step '${kind}' carries gate parameters, but this deployment registers no gate for that step kind.`,
      )
    }
    const problems = validateDescriptorFields(gateRegistry.configFields(kind) ?? [], config.fields)
    if (problems.length) {
      throw new ValidationError(`Step '${kind}' has invalid gate parameters: ${problems.join(' ')}`)
    }
  }
}

/**
 * A quorum must be REACHABLE by the policy that narrows it. Counting distinct identities means
 * an approver set smaller than the quorum can never clear the gate, and the run parks with no
 * error to explain it — which is exactly the failure mode a save-time refusal is for.
 *
 * Only a `userIds`-only policy bounds the approver COUNT: a role names an open-ended set (a
 * workspace can gain members), so a role-bearing policy is always considered reachable.
 */
function assertSatisfiableQuorum(kind: string, config: StepGateConfig): void {
  const required = requiredGateApprovals(config)
  if (required <= 1) return
  const named = config.approvers?.userIds?.length ?? 0
  if ((config.approvers?.roles?.length ?? 0) > 0 || named === 0) return
  if (named < required) {
    throw new ValidationError(
      `Step '${kind}' asks for ${required} approvals but names only ${named} approver(s), so the gate could never be cleared. Name more approvers, allow a role, or lower the required approvals.`,
    )
  }
}

/**
 * Every ENABLED step whose kind carries the `binary-output` trait (a generator whose
 * deliverable is binary artifacts stored through a foundational service) must SELECT its
 * storage service (`stepOptions[i].binaryOutput`). The same rule as a `skill` step's
 * `skillId`: the step is parametrized by the selection and has nowhere to deliver without it,
 * so it is rejected at pipeline save (and again at run start, which shares this validation)
 * rather than dispatching a generator that can only refuse. Whether the selected ids RESOLVE
 * against the catalog is the run-admission guard's half — the catalog is workspace state this
 * structural check deliberately does not read.
 *
 * Skipped when no registry is supplied (the kernel seed test's built-in catalog): the trait is
 * carried only by deployment-registered kinds, which such a caller cannot see.
 */
export function assertValidBinaryOutputSteps({
  agentKinds,
  enabled,
  stepOptions,
  agentKindRegistry,
}: PipelineShape): void {
  if (!agentKindRegistry) return
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    const kind = agentKinds[i]
    if (kind === undefined || !isEnabled(i)) continue
    if (!hasTrait(kind, BINARY_OUTPUT_TRAIT, agentKindRegistry)) continue
    const config = stepOptions?.[i]?.binaryOutput
    if (!config?.storageServiceId?.trim()) {
      throw new ValidationError(
        `Step '${kind}' generates binary outputs but selects no storage service — pick the ` +
          "foundational service it stores them through in the step's options.",
      )
    }
    assertComparableCandidates(kind, config)
    assertUnambiguousOutputSize(kind, config)
  }
}

/**
 * A step that states exact output DIMENSIONS may not also state the shape a second way.
 *
 * WHICH options conflict, and why, is contracts' {@link conflictingOutputSizeOptions}: the SPA's
 * pipeline builder has to state this same refusal where it is fixable without a round trip, so the
 * rule is shared and only the MESSAGE is composed here. What stays here is the disposition (this
 * one refuses the save) and the wording, which names the numbers actually configured.
 *
 * Structural, so it lands beside {@link assertComparableCandidates} at pipeline SAVE and again at
 * run start: all three fields are readable off the step and none depends on workspace state or on
 * which integrations happen to be registered.
 */
function assertUnambiguousOutputSize(kind: string, config: BinaryOutputConfig): void {
  const generation = config.generation
  const conflicting = conflictingOutputSizeOptions(generation)
  if (!generation?.outputSize || conflicting.length === 0) return
  const { width, height } = generation.outputSize
  const conflicts = conflicting.map((option) =>
    option === 'aspectRatio'
      ? `an aspect ratio of ${generation.aspectRatio}`
      : `an upscale of ${generation.upscale}x`,
  )
  throw new ValidationError(
    `Step '${kind}' asks for an exact output size of ${width}x${height} and also states ` +
      `${conflicts.join(' and ')}, which describe the delivered dimensions a second time and ` +
      'can disagree with it. Keep whichever one is the requirement and remove the other: with ' +
      'both, the agent writing the generation call is the one left to decide which the step ' +
      'meant.',
  )
}

/**
 * A step that COMPARES candidates must be able to produce more than one of them.
 *
 * There are exactly two ways to get a comparison, and a step needs one of them: several
 * integrations rendering the same subject, or one integration asked for several candidates. A
 * step with a single producer and `perGenerator: 1` yields one candidate per subject, which the
 * engine auto-keeps rather than parking on, so the human review the comparison was configured for
 * silently never happens.
 *
 * Structural, so it lands at pipeline SAVE alongside the missing-storage refusal above rather
 * than at run start: both halves are readable off the step, neither depends on workspace state,
 * and a comparison that cannot compare is a mis-configured step whatever the catalog says. What
 * this deliberately does not check is whether the selected ids RESOLVE, which is admission's job
 * and reads a registry this function has no business holding.
 */
function assertComparableCandidates(kind: string, config: BinaryOutputConfig): void {
  const comparison = config.comparison
  if (!comparison) return
  if ((comparison.perGenerator ?? 1) > 1) return
  if ((config.generatorIds?.length ?? 0) >= 2) return
  throw new ValidationError(
    `Step '${kind}' is configured to compare generated candidates, but it can only produce one ` +
      'per subject: select a second generative integration, or raise the candidates-per-' +
      'integration count. With one candidate there is nothing to choose between, so the run ' +
      'would keep it without asking.',
  )
}

/**
 * Every ENABLED step that selects an agent-kind VARIANT (`stepOptions[i].agentVariantId`) must
 * name one the deployment registered, that variant's `baseKind` must be the step's own kind, and
 * the step's kind must be one whose prompt the DISPATCH composes.
 *
 * None of the three fails loudly on its own. An unknown id would simply run the shipped prompt —
 * the step still works, so nothing surfaces except that it silently stopped being the variation
 * someone configured. A MISMATCHED one is worse: the variant's prompt is written for a different
 * role, so the step would run a Coder told to be a reviewer and the output would look like a model
 * failure rather than a configuration error.
 *
 * The third is {@link INLINE_ENGINE_SYSTEM_PROMPTS} — the requirements + clarity reviewers, both
 * brainstorm stages and their rework editors. `IterativeReviewService` drives those as bare inline
 * calls and composes their prompt from (workspace, kind) with no STEP in hand, so a variant
 * selected on one of them cannot reach the model at all. Refusing it is the honest disposition
 * until that path can resolve a step: a per-workspace prompt override is what varies those kinds
 * today. Note this is NOT the whole bespoke-prompt family — `merger` and `on-call` dispatch through
 * the engine like any container kind, so a variant works there and is covered by tests.
 *
 * Skipped entirely when no registry is supplied — the caller is validating a built-in catalog
 * with no deployment registrations in view (the kernel seed test), where refusing an id it
 * cannot resolve would be wrong. Both real boundaries (builder save, run start) pass one.
 */
export function assertValidAgentVariants({
  agentKinds,
  enabled,
  stepOptions,
  agentKindRegistry,
}: PipelineShape): void {
  if (!stepOptions || !agentKindRegistry) return
  for (let i = 0; i < agentKinds.length; i++) {
    const variantId = stepOptions[i]?.agentVariantId
    if (!variantId || enabled?.[i] === false) continue
    const variant = agentKindRegistry.variant(variantId)
    if (!variant) {
      throw new ValidationError(
        `Step '${agentKinds[i]}' selects the agent variant '${variantId}', which this deployment does not register.`,
      )
    }
    if (variant.baseKind !== agentKinds[i]) {
      throw new ValidationError(
        `Agent variant '${variantId}' varies '${variant.baseKind}', so it cannot be selected on a '${agentKinds[i]}' step.`,
      )
    }
    if (agentKinds[i] && agentKinds[i]! in INLINE_ENGINE_SYSTEM_PROMPTS) {
      throw new ValidationError(
        `Agent variant '${variantId}' cannot be selected on a '${agentKinds[i]}' step: that step runs inline in the engine, which composes its prompt without a step, so the variant would never reach the model. Edit the agent's prompt for this workspace instead.`,
      )
    }
  }
}

/**
 * Every ENABLED `skill` step must name the skill it runs (`stepOptions[i].skillId`). The one
 * generic `skill` agent kind is parametrized entirely by that id — with none it has nothing to
 * execute — so a skill step missing it is rejected at pipeline save (and again at run start,
 * since both boundaries share this validation) rather than failing deep in dispatch. A DISABLED
 * skill step never runs, so it imposes no requirement.
 */
export function assertValidSkillSteps({ agentKinds, enabled, stepOptions }: PipelineShape): void {
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    if (agentKinds[i] !== SKILL_AGENT_KIND || !isEnabled(i)) continue
    if (!stepOptions?.[i]?.skillId?.trim()) {
      throw new ValidationError(
        `A '${SKILL_AGENT_KIND}' step must select a skill — set its skill in the step options.`,
      )
    }
  }
}

/**
 * A companion step is only valid when the step IMMEDIATELY before it (over the enabled
 * subset) produces output it is allowed to review (a step whose kind is in the companion's
 * target allow-list). Validated over the enabled subset — that is exactly the chain the run
 * executes — so it also rejects "disable the producer but leave its companion on" (which
 * would leave the companion grading nothing at runtime) AND "slip another step between the
 * producer and its companion". Companions are surfaced in the builder as toggles attached to
 * their producer and run immediately after it, so adjacency is required.
 */
export function assertValidCompanionPlacement({
  agentKinds,
  enabled,
  agentKindRegistry,
}: PipelineShape): void {
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    const kind = agentKinds[i]
    if (kind === undefined || !isCompanionKind(kind, agentKindRegistry) || !isEnabled(i)) continue
    const targets = companionTargets(kind, agentKindRegistry)
    // The nearest preceding ENABLED step must be a producer this companion can review.
    let predecessor: string | undefined
    for (let j = i - 1; j >= 0; j--) {
      if (isEnabled(j)) {
        predecessor = agentKinds[j]
        break
      }
    }
    if (predecessor === undefined || !targets.includes(predecessor)) {
      throw new ValidationError(
        `Companion '${kind}' must run immediately after an enabled step it can review (${targets.join(', ')}).`,
      )
    }
  }
}

/**
 * Validate every ENABLED step that carries enabled estimate gating. A disabled gated step
 * never runs, so it imposes no requirement; an enabled one must satisfy all four rules:
 *
 *  1. The gated step's kind must be GATABLE ({@link isGatableKind}). Gating means "skip this
 *     step when the task is light", which is safe for a kind whose output later steps read as
 *     CONTEXT (a design proposal, a research note, an extra verification pass) and unsafe for one
 *     some other mechanism reads STRUCTURALLY — `merger` (whose mere presence in `instance.steps`
 *     is what makes a committing kind deliver via a PR), `deployer` (which provisions the
 *     environment its consumer reads), `conflicts`/`ci` (the guards), `bug-intake` (the run's
 *     subject). Gatability is declared per kind rather than derived from a category, because the
 *     answer is a property of what the kind produces and who reads it.
 *
 *     This rule used to be "must be a COMPANION", on the reasoning that skipping a producer would
 *     starve downstream steps. The old catalog disproved it: `pl_simple` shipped with no architect
 *     and no spec-writer, `pl_quick` with no reviewer.
 *  2. It must NOT also carry a human approval gate (`gates[i]`). The estimate may ADD a human
 *     checkpoint — that is what gating a `human-review` step on risk does — but it may never
 *     CANCEL an approval pause the pipeline author asked for, which is what an estimate-gated
 *     human-gated step would do below its threshold. A model's own triage must not be able to
 *     decide that nobody needs to look.
 *  3. It must set at least one axis threshold. With none, the axis loop in
 *     `shouldRunGatedStep` never matches, so a step with an estimate would ALWAYS skip — the
 *     opposite of the usual intent — making the toggle a silent footgun.
 *  4. An enabled `task-estimator` must run earlier in the chain, or the gate has no estimate
 *     to consult.
 */
export function assertValidGating({
  agentKinds,
  enabled,
  gates,
  gating,
  agentKindRegistry,
}: PipelineShape): void {
  if (!gating) return
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    const g = gating[i]
    if (!g?.enabled || !isEnabled(i)) continue
    const kind = agentKinds[i]
    if (kind === undefined || !isGatableKind(kind, agentKindRegistry)) {
      throw new ValidationError(
        `Step '${kind}' cannot be estimate-gated — its output is required by the rest of the run. Only a step whose result later steps read as context (a design, a review, an extra verification pass) may be skipped on the estimate.`,
      )
    }
    if (gates?.[i] === true) {
      throw new ValidationError(
        `Step '${kind}' carries a human approval gate, so it cannot also be estimate-gated — the estimate may add a human checkpoint but never remove one. Drop the approval gate to make the step conditional, or drop the estimate gate to keep it unconditional.`,
      )
    }
    if (g.minComplexity === undefined && g.minRisk === undefined && g.minImpact === undefined) {
      throw new ValidationError(
        `Step '${kind}' is estimate-gated but sets no threshold — set at least one of complexity / risk / impact, or it would always be skipped.`,
      )
    }
    const hasEstimator = agentKinds
      .slice(0, i)
      .some((k, j) => k === TASK_ESTIMATOR_AGENT_KIND && isEnabled(j))
    if (!hasEstimator) {
      throw new ValidationError(
        `Step '${kind}' is gated on the task estimate but no enabled '${TASK_ESTIMATOR_AGENT_KIND}' step runs before it. Add a task-estimator earlier in the pipeline.`,
      )
    }
  }
}

/**
 * Validate every ENABLED step carrying a RUN CONDITION (`stepOptions[i].condition`).
 *
 * A run condition is the SECOND axis that can skip a step, and a skip is a skip whichever axis
 * caused it — so the two structural rules that keep the estimate gate from removing something the
 * run needs bind here verbatim, and for the same reasons:
 *
 *  1. The kind must be GATABLE. Gatability answers "may this step be absent from a run at all",
 *     which is a property of what the kind produces and who reads it, not of the reason for the
 *     absence. Without this, a condition on `merger` silently drops the merge on every run outside
 *     its scope and the pipeline finishes reporting success; on `coder`, the run reviews and merges
 *     an unchanged branch. `isGatableKind` is asked with the registry so a DEPLOYMENT-registered
 *     kind's own flag is honoured, exactly as the estimate gate asks it.
 *  2. It must NOT also carry a human approval gate (`gates[i]`), for the reason the estimate gate
 *     refuses the pair: a condition may leave a checkpoint un-reached, never CANCEL a pause the
 *     author asked for. That the scope is computed rather than modelled makes it worse here, not
 *     better — nobody chose it per run.
 *
 * Deliberately NOT refused: a condition BESIDE an enabled estimate gate. Those two compose
 * (skip if either says no) and answer genuinely different questions — "does this step apply to this
 * kind of change" and "is this change big enough to be worth it" — so a UI pass that runs only on
 * frontend work and only above a complexity floor is a coherent thing to author.
 *
 * This lives in the shape validation rather than in `validatePipelineAuthoring` because it states
 * what is BROKEN, not what is incomplete, so the RUN door refuses it too. Nothing stored predates
 * the rule: run conditions ship with it.
 */
export function assertValidRunConditions({
  agentKinds,
  enabled,
  gates,
  stepOptions,
  agentKindRegistry,
}: PipelineShape): void {
  if (!stepOptions) return
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    if (!stepOptions[i]?.condition || !isEnabled(i)) continue
    const kind = agentKinds[i]
    if (kind === undefined || !isGatableKind(kind, agentKindRegistry)) {
      throw new ValidationError(
        `Step '${kind}' cannot carry a run condition — its output is required by the rest of the run, so a run outside the condition's scope would silently finish without it. Only a step whose result later steps read as context (a design, a review, an extra verification pass) may be skipped.`,
      )
    }
    if (gates?.[i] === true) {
      throw new ValidationError(
        `Step '${kind}' carries a human approval gate, so it cannot also carry a run condition — a condition may leave a checkpoint un-reached but never remove one the pipeline author asked for. Drop the approval gate to make the step conditional, or drop the condition to keep it unconditional.`,
      )
    }
  }
}

/**
 * Validate every ENABLED Tester step whose test quality-control companion carries an enabled
 * estimate gate. The QC gate lives on the Tester step itself (not a companion), so it is
 * checked here rather than in {@link assertValidGating} (which is companion-only). The same two
 * safety rules apply as for step gating: at least one axis threshold must be set (or the gate
 * would never fire), and an enabled `task-estimator` must run earlier (or the gate has no
 * estimate to consult). The QC companion being enabled/disabled itself imposes no requirement —
 * only an enabled GATE does.
 */
export function assertValidTesterQualityGating({
  agentKinds,
  enabled,
  testerQuality,
}: PipelineShape): void {
  if (!testerQuality) return
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    const qc = testerQuality[i]
    const g = qc?.gating
    if (!g?.enabled || !isEnabled(i)) continue
    const kind = agentKinds[i]
    if (kind === undefined || !isTesterKind(kind)) continue
    if (g.minComplexity === undefined && g.minRisk === undefined && g.minImpact === undefined) {
      throw new ValidationError(
        `Step '${kind}' has an estimate-gated test quality companion but sets no threshold — set at least one of complexity / risk / impact, or the gate would always skip the review.`,
      )
    }
    const hasEstimator = agentKinds
      .slice(0, i)
      .some((k, j) => k === TASK_ESTIMATOR_AGENT_KIND && isEnabled(j))
    if (!hasEstimator) {
      throw new ValidationError(
        `Step '${kind}' has a test quality companion gated on the task estimate but no enabled '${TASK_ESTIMATOR_AGENT_KIND}' step runs before it. Add a task-estimator earlier in the pipeline.`,
      )
    }
  }
}

/**
 * Enforce a pipeline's launch constraints (design §2 of the bug-triage pipeline):
 *
 *  - A `bug-intake` step is meaningless without a schedule, so a pipeline carrying one must be
 *    `'recurring'`. `availability` absent means `'both'` (unrestricted), so an unset pipeline
 *    with a `bug-intake` step is rejected too.
 *  - When an `origin` is supplied (a fresh launch), it must match the pipeline's `availability`:
 *    a `'recurring'`-only pipeline can't be started as a one-off manual task, and a `'one-off'`-
 *    only pipeline can't be fired from a schedule.
 *
 * This is a LAUNCH-time gate (builder save + run start + schedule attach), NOT part of the
 * shared retry/restart re-validation: those re-drive stored steps of an already-validated run,
 * so they pass no `origin` and skip the check entirely (an unset `availability` on the pipeline
 * definition is still meaningful at start, but a retry never reaches here).
 *
 * The `bug-intake` requirement is evaluated over the ENABLED subset (like every other check in
 * this file): a DISABLED `bug-intake` step never runs, so it imposes no recurring requirement.
 */
export function assertPipelineLaunchable(
  agentKinds: string[],
  availability: PipelineAvailability | undefined,
  origin?: RunOrigin,
  enabled?: boolean[],
): void {
  const effective: PipelineAvailability = availability ?? 'both'
  const hasEnabledBugIntake = pipelineHasEnabledBugIntake(agentKinds, enabled)
  if (hasEnabledBugIntake && effective !== 'recurring') {
    throw new ValidationError(
      `A pipeline with a '${BUG_INTAKE_AGENT_KIND}' step must be recurring — it pulls its work from a schedule's tracker board, so it cannot run as a one-off.`,
    )
  }
  if (origin === 'manual' && effective === 'recurring') {
    throw new ValidationError(
      'This pipeline can only run on a recurring schedule; it cannot be started as a one-off task.',
    )
  }
  if (origin === 'recurring' && effective === 'one-off') {
    throw new ValidationError(
      'This pipeline can only run as a one-off task; it cannot be attached to a recurring schedule.',
    )
  }
}
