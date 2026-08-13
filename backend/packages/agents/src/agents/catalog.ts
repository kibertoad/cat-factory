import type { AgentDispatchContext, AgentKind } from '@cat-factory/kernel'
import type { AgentRunContext } from '@cat-factory/kernel'
import {
  acceptanceSystemPrompt,
  testApproachSection,
  e2eTargetSection,
} from './prompts/acceptance.js'
import { isStandardsContextFile } from './runtime/fragments.js'
import { companionSystemPrompt } from './prompts/companion.js'
import { companionTargets } from './kinds/companions.js'
import { READ_ONLY_GUARDRAIL, isReadOnlyAgentKind } from './kinds/read-only.js'
import { SPIKE_AGENT_KIND, spikeContextSection } from './kinds/spike.js'
import { businessLogicSystemPrompt } from './prompts/business-logic.js'
import { mockFrontendSection, mockSystemPrompt } from './prompts/mock.js'
import { testingSystemPrompt, testerEnvironmentSection } from './prompts/testing.js'
import type { AgentKindRegistry } from './kinds/registry.js'
import { traitGuidanceFor } from './kinds/traits.js'
import { roleSystemPrompt } from './prompts/roles.js'
import {
  FINAL_ANSWER_IN_REPLY,
  PLATFORM_IS_NOT_THE_PRODUCT,
  REVIEW_FINDINGS_LAYOUT,
} from './prompts/shared.js'
import {
  ACCOUNTING_REVIEW_DIRECTIVE,
  FEEDBACK_ACCOUNTING_DIRECTIVE,
  PRIOR_ROUNDS_DIRECTIVE,
  renderPriorReviewRounds,
} from './prompts/review-rounds.js'
import { REVIEW_COMMENT_SEVERITY_RANK } from '@cat-factory/contracts'
import {
  customTaskTypeSection,
  environmentSection,
  initiativePresetSection,
  involvedServicesSection,
  linkedContextSection,
  ownServiceSection,
  phaseForKind,
  renderStandardUserPrompt,
  standardSystemPrompt,
  testSecretsSection,
} from './prompts/standard.js'

// Prompt construction for the built-in agent kinds: turns an agent kind + block
// context into the system/user prompts handed to the LLM. This file is the
// DISPATCHER — `baseSystemPromptFor` picks which track owns a kind; the prompt TEXT
// for each track lives under ./prompts (the four standard phases design/build/review/
// test in ./prompts/standard, the acceptance track in ./prompts/acceptance, the mock
// builder in ./prompts/mock, the business-logic track in ./prompts/business-logic,
// the tester/fixer track in ./prompts/testing, the companions in ./prompts/companion,
// and the thin one-line roles + generic fallback in ./prompts/roles).

/**
 * The fragments an override must never be able to delete, whether they reach the shipped prompt
 * by being APPENDED ({@link applySurfaceDirectives}) or by being written INLINE into a built-in
 * track prompt. That difference is invisible from the outside and is exactly the trap: an
 * override replaces the track prompt, so for a built-in kind it silently takes the inline copy
 * with it. See {@link restoreShippedInvariants}.
 *
 * {@link REVIEW_FINDINGS_LAYOUT} belongs here for the same reason the final-answer rule does: it
 * is a fact about how the platform READS a reviewer's reply, not editorial content. The severities
 * it asks for are what the ENGINE acts on (a `blocker` holds the step), the `summary` it shapes is
 * rendered as markdown in the run panel, and the escaping sentence it carries is what keeps a
 * multi-line verdict from arriving as invalid JSON. A workspace that edits its reviewer prompt for
 * an unrelated reason would otherwise get ungraded findings back — every point reaching the engine
 * as equally urgent — with nothing in the editor saying why.
 */
const OVERRIDE_PRESERVED_FRAGMENTS = [
  READ_ONLY_GUARDRAIL,
  FINAL_ANSWER_IN_REPLY,
  REVIEW_FINDINGS_LAYOUT,
] as const

/**
 * Re-append any invariant the SHIPPED prompt for this kind guaranteed and the overridden
 * composition now lacks.
 *
 * The property, stated once: **an override changes what an agent is told to BE, never how the
 * platform RUNS it.** `applySurfaceDirectives` alone cannot hold that, because its
 * final-answer rule is gated on the base being the REGISTRY's prompt — a guard against
 * double-appending for built-in kinds, whose track prompts carry the rule inline. The moment an
 * override replaces such a track prompt, the guard reads "already has it" about a string that
 * no longer exists, and the rule is lost on precisely the kinds that need it (spec-writer,
 * merger, the testers, the reviewers — every kind whose deliverable IS its visible reply).
 *
 * Comparing against the fully COMPOSED shipped prompt rather than its base is what makes this
 * total: it covers a fragment however it arrived, so a kind that later moves a directive from
 * inline to appended (or the reverse) needs no change here. Membership is a plain `includes`, so
 * an override that restates the rule itself is not given a second copy.
 */
function restoreShippedInvariants(
  composed: string,
  kind: AgentKind,
  registry: AgentKindRegistry,
): string {
  // No `override` argument ⇒ terminates after exactly one level.
  const shipped = systemPromptFor(kind, registry)
  let result = composed
  for (const fragment of OVERRIDE_PRESERVED_FRAGMENTS) {
    if (shipped.includes(fragment) && !result.includes(fragment)) {
      result = `${result}\n\n${fragment}`
    }
  }
  return result
}

/**
 * A string no real prompt contains, used to MEASURE what the platform appends without having to
 * restate it. Composed in-process only; never stored, never sent.
 */
const DIRECTIVE_PROBE = ' cat-factory:override-probe '

/**
 * The text {@link systemPromptFor} appends to an override for this kind — the surface directives,
 * the trait guidance, and anything {@link restoreShippedInvariants} puts back.
 *
 * MEASURED, never restated: compose the real prompt around a probe and return the tail. That is
 * what makes it total — a hand-written summary would miss precisely the invisible case (a rule the
 * shipped track prompt carried inline), and would go stale the first time a directive is added.
 *
 * Two consumers depend on it: the prompt editor SHOWS it, so a workspace can see the rules its
 * override cannot delete; and the sandbox composes a candidate the same way production does, so a
 * prompt is graded on the text that will actually be sent.
 */
export function appendedDirectivesFor(kind: AgentKind, registry: AgentKindRegistry): string {
  return systemPromptFor(kind, registry, DIRECTIVE_PROBE).slice(DIRECTIVE_PROBE.length)
}

/**
 * The system prompt for a kind: its track prompt plus the surface directives and trait
 * guidance the engine enforces.
 *
 * `override` replaces only the TRACK prompt — a workspace's edited prompt for this kind (see
 * ./prompt-overrides). The directives and trait guidance are still appended on top, and
 * {@link restoreShippedInvariants} puts back any invariant the shipped prompt happened to carry
 * INLINE rather than appended, because they are invariants of how the platform runs the kind (a
 * read-only kind must not edit; a reasoning kind's answer must land in its visible reply), not
 * editorial content: an override that dropped them would break the run in exactly the ways they
 * exist to prevent.
 */
export function systemPromptFor(
  kind: AgentKind,
  registry: AgentKindRegistry,
  override?: string,
): string {
  const base = override ?? baseSystemPromptFor(kind, registry)
  // Append the surface-driven directives (read-only guardrail + final-answer-in-reply) — see
  // {@link applySurfaceDirectives}. This is the single place that decision lives, so a
  // registered kind gets the SAME treatment a built-in does from its declared `agent.surface`.
  // Then the platform/product boundary, which is UNCONDITIONAL: every kind is run by the same
  // orchestrator and can see its mechanics, so every kind needs telling that they are not the
  // subject of the work. Appended here rather than inside `applySurfaceDirectives` because it is
  // not derived from the surface — and appended AFTER the override, so an edited prompt cannot
  // delete it (which is why it needs no `OVERRIDE_PRESERVED_FRAGMENTS` entry).
  const withDirectives = `${applySurfaceDirectives(base, kind, registry)}\n\n${PLATFORM_IS_NOT_THE_PRODUCT}`
  // Fold in any guidance contributed by the kind's traits (e.g. the spec-aware kinds get
  // the in-repo-spec reading guidance). Marker traits like `code-aware` add nothing here —
  // their effect (folding the service's fragments) is applied by the execution engine.
  const guidance = traitGuidanceFor(kind, registry)
  const composed = guidance.length
    ? `${withDirectives}\n\n${guidance.join('\n\n')}`
    : withDirectives
  // Unedited ⇒ byte-for-byte what the kind always sent. Overridden ⇒ put back any invariant the
  // shipped prompt carried inline, which replacing the track prompt would otherwise have taken
  // with it. Only reachable with an override, so the unedited path costs nothing.
  return override === undefined ? composed : restoreShippedInvariants(composed, kind, registry)
}

/**
 * Append the surface-driven prompt directives, derived ONCE from the kind's `agent.surface`
 * so a registered (custom) kind gets exactly what a built-in does without the author reasoning
 * about either directive:
 *   - READ_ONLY_GUARDRAIL — a built-in read-only kind (architect/analysis/…) OR any registered
 *     `container-explore` kind (it clones read-only and returns a report; it must never edit).
 *   - FINAL_ANSWER_IN_REPLY — a registered `inline`/`container-explore` kind, whose deliverable
 *     IS its visible reply (a report / structured JSON the platform parses), so a reasoning
 *     model can't lose the answer to its hidden channel. Built-in kinds already get this from
 *     their own track prompts, so it's scoped to kinds whose prompt actually CAME from the
 *     registry to avoid double-append. A `container-coding` kind (product is a pushed commit)
 *     and a no-`agent` kind get neither.
 *
 * `base` is the resolved base prompt: when a registered id collides with a built-in track (e.g.
 * a deployment registers `architect`), `baseSystemPromptFor` returns the TRACK prompt (which
 * already carries FINAL_ANSWER_IN_REPLY), not the registered one — so we gate `needsFinalAnswer`
 * on the base actually being the registered prompt, not merely on the kind being in the registry.
 */
function applySurfaceDirectives(
  prompt: string,
  kind: AgentKind,
  registry: AgentKindRegistry,
): string {
  const step = registry.agentStep(kind)
  const surface = step?.surface
  // True only when the base prompt is the one from the registry — i.e. no built-in track claimed
  // this kind. A built-in-track-owned id (even if also registered) already got the directive.
  const usedRegisteredPrompt = prompt === registry.systemPrompt(kind)
  // `localWrites` is the explore kind that legitimately writes inside its own working tree (a
  // tester installs dependencies and runs a suite). The surface still means "never pushes"; the
  // guardrail's wording ("must not create files") does not, and reads to that agent as a refusal
  // to run the suite. See {@link AgentStepSpec.localWrites}.
  const needsGuardrail =
    isReadOnlyAgentKind(kind) || (surface === 'container-explore' && !step?.localWrites)
  const needsFinalAnswer =
    usedRegisteredPrompt && (surface === 'inline' || surface === 'container-explore')
  let result = prompt
  if (needsGuardrail) result = `${result}\n\n${READ_ONLY_GUARDRAIL}`
  if (needsFinalAnswer) result = `${result}\n\n${FINAL_ANSWER_IN_REPLY}`
  return result
}

/**
 * The SHIPPED track prompt for a kind, before the surface directives and trait guidance
 * `systemPromptFor` layers on. Exported because it is the unit a workspace prompt override
 * replaces (see ./prompt-overrides): the directives are engine-enforced invariants — a
 * read-only kind must not edit, a reasoning kind must answer in its reply — so they are
 * re-applied on top of an override rather than being handed to an editor that could delete
 * them. It is also therefore the text the prompt editor shows as the built-in baseline.
 */
export function baseSystemPromptFor(kind: AgentKind, registry: AgentKindRegistry): string {
  // Companion kinds (reviewer, architect-companion, spec-companion, …) win over every
  // built-in track: they grade a prior step's output and return a JSON rating.
  const companion = companionSystemPrompt(kind, registry)
  if (companion) return companion
  const phase = phaseForKind(kind)
  if (phase) return standardSystemPrompt(phase)
  // The Tester/Fixer track runs in a container and returns a structured report /
  // pushes fixes; it owns its own prompts rather than the generic `test` phase.
  const testing = testingSystemPrompt(kind)
  if (testing) return testing
  const acceptance = acceptanceSystemPrompt(kind)
  if (acceptance) return acceptance
  const mock = mockSystemPrompt(kind)
  if (mock) return mock
  const businessLogic = businessLogicSystemPrompt(kind)
  if (businessLogic) return businessLogic
  // Custom kinds registered by a deployment (e.g. a proprietary org package) win over
  // the generic fallback below, but never shadow the built-in tracks above. The
  // surface-driven directives (FINAL_ANSWER_IN_REPLY / read-only guardrail) are applied
  // centrally in `systemPromptFor` via `applySurfaceDirectives`, so the raw registered
  // prompt is returned here as-is.
  const registered = registry.systemPrompt(kind)
  if (registered !== undefined) return registered
  return roleSystemPrompt(kind)
}

/**
 * Who asked for the revision, said in one sentence. An exhaustive `Record`, so a third kind of
 * reviewer fails to compile here rather than silently borrowing one of these two framings.
 *
 * The distinction is load-bearing in both directions: a companion's automatic round framed as a
 * person's request tells the agent somebody is waiting on work no person has read, and a real
 * "request changes" flattened into "your work was reviewed" loses the one fact that outranks the
 * feedback itself.
 */
const REVISION_REQUESTER_FRAMING: Record<
  NonNullable<AgentRunContext['revision']>['requestedBy'],
  string
> = {
  human: 'A person reviewed your previous proposal and requested changes.',
  reviewer: 'An automated reviewer graded your previous proposal and asked for changes.',
}

/**
 * When changes were requested on this step's previous proposal — by a person on its gate, or by
 * the reviewer that grades it — append the feedback and that proposal so the agent revises rather
 * than restarts. Applied to every inline agent kind (standard-phase and generic alike).
 */
function withRevision(prompt: string, context: AgentRunContext): string {
  const revision = context.revision
  if (!revision) return prompt
  const lines = [
    prompt,
    '',
    // Falls back to the reviewer framing for a rework row written before `requestedBy` existed:
    // it is the common case, and it is the false-human claim that this exists to stop.
    REVISION_REQUESTER_FRAMING[revision.requestedBy] ?? REVISION_REQUESTER_FRAMING.reviewer,
    'Revise that proposal to answer the feedback: keep what still holds, change what was',
    'flagged. Do not start from scratch.',
    '',
    FEEDBACK_ACCOUNTING_DIRECTIVE,
    '',
    'Your previous proposal:',
    revision.previousProposal || '(empty)',
    '',
    'Reviewer feedback:',
    revision.feedback || '(none given)',
  ]
  // Per-block comments the reviewer left on specific parts of the proposal. Each
  // quotes the exact text it targets, so the agent can locate and revise it.
  //
  // Worst first, and each one labelled with the urgency it was raised at, because that is what
  // decides whether this rework ends the loop: a `blocker` left open sends the work straight back
  // however much else was addressed. A person's comment carries no grade and is simply unlabelled
  // — they are already holding the run, so there is nothing for a label to add.
  if (revision.comments?.length) {
    const graded = [...revision.comments].sort(
      (a, b) =>
        (b.severity ? REVIEW_COMMENT_SEVERITY_RANK[b.severity] : -1) -
        (a.severity ? REVIEW_COMMENT_SEVERITY_RANK[a.severity] : -1),
    )
    lines.push('', 'Comments on specific parts of your proposal:')
    if (graded.some((c) => c.severity === 'blocker')) {
      lines.push(
        'Every comment marked [blocker] MUST be resolved in this revision: while one is open the',
        'work does not move on. Deal with those first, then the rest.',
      )
    }
    for (const c of graded) {
      lines.push(
        '',
        `On this part:${c.severity ? ` [${c.severity}]` : ''}`,
        c.quotedSource || '(empty)',
        'Comment:',
        c.body || '(none given)',
      )
    }
  }
  return lines.join('\n')
}

/** How a caller wants the user prompt rendered. See {@link userPromptFor}. */
export interface AgentUserPromptOptions {
  /**
   * The caller has a filesystem and has already written the run's context files onto it, so
   * linked context renders as an index pointing at them rather than folding their bodies in.
   */
  materialized?: boolean
  /**
   * The resolved checkout this dispatch creates, for the kinds whose own prompt names a branch.
   * Absent for every inline caller (which has no checkout), so a builder that reads it must
   * phrase itself without one rather than invent a branch name.
   */
  dispatch?: AgentDispatchContext
}

/**
 * Build the user prompt from the block context and the run so far. `opts.materialized`
 * (set by the container executor) renders linked context as a summary index pointing at
 * the on-disk files; the default (inline executors) injects the bodies into the prompt.
 * `opts.dispatch` carries the resolved checkout facts (base/work branch, multi-repo) for the
 * kinds whose own prompt has to name a branch; absent for every inline caller, which has no
 * checkout to describe.
 */
export function userPromptFor(
  context: AgentRunContext,
  registry: AgentKindRegistry,
  opts: AgentUserPromptOptions = {},
): string {
  const { prompt, suffix } = buildBaseUserPrompt(context, registry, opts)
  // The kind's closing instruction is applied OUTSIDE both wrappers, not folded into the base
  // prompt: `userPromptSuffix` exists to be the last thing the agent reads (the `on-call` kind's
  // "respond with ONLY a JSON object" is the shape), and both wrappers append. Folded in earlier,
  // a revision re-run would end on the reviewer's feedback and an inline run on a context-file
  // dump, leaving the reply-shape instruction buried mid-prompt.
  return withSuffix(
    withInjectedContext(withPriorReview(withRevision(prompt, context), context), context, opts),
    suffix,
  )
}

/**
 * Append the rounds this step's companion loop has already been through.
 *
 * ONE site, deliberately, and it is what makes the memory arrive for every companion rather than
 * for whichever one somebody wired: `userPromptFor` is the single prompt assembly both surfaces
 * go through, so an inline companion (`architect-companion`, `spec-companion`), a
 * container-backed one (`reviewer`, `doc-reviewer`) and a companion a DEPLOYMENT registered all
 * receive it on the same terms, as does the producer being reworked.
 *
 * Applied AFTER {@link withRevision} so a producer reads the current round's asks first (that is
 * the work) and the older rounds after it (that is the thing not to regress on). `context.role`
 * decides the framing, since the two sides need opposite instructions from the same data.
 */
function withPriorReview(prompt: string, context: AgentRunContext): string {
  const prior = context.priorReview
  if (!prior?.rounds.length) return prompt
  const grading = prior.role === 'grader'
  const lines = [
    prompt,
    '',
    grading
      ? `You have already reviewed earlier revisions of this work ${prior.rounds.length} time(s), ` +
        `against a bar of ${prior.threshold.toFixed(2)}. Your own previous verdicts:`
      : `This work has been through ${prior.rounds.length} review round(s) before the feedback ` +
        `above. Everything previously raised, so you do not undo a fix or drop an open point:`,
    ...renderPriorReviewRounds(prior.rounds),
    '',
    grading
      ? PRIOR_ROUNDS_DIRECTIVE
      : 'Keep every earlier point that was already addressed addressed. Where an earlier point ' +
        'is still open, deal with it in this revision too, not only the feedback above, and ' +
        'account for it in the same way.',
  ]
  // Only the grader, and only here: an accounting can exist only once a round has been answered,
  // which is exactly the condition this whole section renders under.
  if (grading) lines.push('', ACCOUNTING_REVIEW_DIRECTIVE)
  // How much rope is left, stated to the GRADER only. A producer told "this is the last round"
  // optimises for the grader rather than for the work; a grader that knows it is holding the run
  // has the context to weigh a marginal call, which is the call this loop keeps getting wrong.
  if (grading) {
    lines.push(
      prior.roundsRemaining > 0
        ? `${prior.roundsRemaining} automatic rework round(s) remain after this one.`
        : 'This is the LAST automatic round: below the bar, the run stops for a person or ' +
            "proceeds on this work under the run's risk policy. Rate what is actually there.",
    )
  }
  return lines.join('\n')
}

/** Append a kind's closing task instructions ({@link buildBaseUserPrompt}'s `suffix`), if any. */
function withSuffix(prompt: string, suffix: string | undefined): string {
  return suffix ? `${prompt}\n\n${suffix}` : prompt
}

/**
 * Total budget for the folded context bodies. A panel re-sends this prompt to every participant
 * on every round, so an unbounded fold multiplies by panel size × rounds; and a preOp's output is
 * only as bounded as that preOp chose to be. Generous enough for the `pr-reviewer` diff (its own
 * renderer caps well under this) while keeping a pathological custom kind from filling a context
 * window with one file.
 */
const MAX_INJECTED_CONTEXT_CHARS = 320_000

/**
 * Fold the backend-prepared context files a preOp produced into the prompt when the caller
 * has NO filesystem to materialise them onto (every inline caller: the inline executor, the
 * consensus panel). The container path passes `materialized`, where the same bodies are
 * written to `.cat-context/` and the agent reads them with tools — folding them here as well
 * would double the tokens on exactly the kinds whose files are largest.
 *
 * Applied at the wrapper level, beside {@link withRevision}, deliberately: `buildBaseUserPrompt`
 * returns early for a standard phase AND for a kind that supplies its own user prompt, and it
 * is precisely those self-authoring kinds (`pr-reviewer`, whose preOps inject the diff, the
 * existing review threads and the standards) whose whole input arrives this way. A fold inside
 * the generic branch would reach none of them.
 *
 * STANDARDS files are deliberately excluded ({@link isStandardsContextFile}). They reach an
 * inline caller through the SYSTEM prompt instead, where `composeBlockSystemPrompt` folds them at
 * the kind's {@link StandardsVerbosity} — so an implementer kind gets each standard's condensed
 * `brief` rather than its full body. Folding them here as well would both duplicate every
 * standard and silently restore the full bodies, which is the hazard the verbosity tier exists to
 * prevent. Inline executors therefore pass `standardsDeliveredAsFiles: false`: with no filesystem,
 * the files were never really delivered.
 */
function withInjectedContext(
  prompt: string,
  context: AgentRunContext,
  opts: AgentUserPromptOptions,
): string {
  if (opts.materialized) return prompt
  const files = (context.injectedContextFiles ?? []).filter((f) => !isStandardsContextFile(f.path))
  if (!files.length) return prompt
  const lines = [
    prompt,
    '',
    'Context files prepared for this run (their full contents follow — there is no',
    'checkout to read them from):',
  ]
  // Bounded, and the boundary is STATED. A silently shortened body reads exactly like a complete
  // one, so a reviewer would report on a file whose tail it never saw without ever knowing.
  let budget = MAX_INJECTED_CONTEXT_CHARS
  const dropped: string[] = []
  for (const file of files) {
    if (file.content.length > budget) {
      dropped.push(file.path)
      continue
    }
    budget -= file.content.length
    lines.push('', `--- ${file.path} ---`, file.content)
  }
  if (dropped.length) {
    lines.push(
      '',
      `NOT INCLUDED (over the injected-context budget): ${dropped.join(', ')}. You cannot read ` +
        'these and must not infer their contents; say so rather than treating them as reviewed.',
    )
  }
  return lines.join('\n')
}

/**
 * The prompt body, plus the kind's closing instructions carried OUT rather than folded in.
 *
 * The split is what lets {@link userPromptFor} apply the suffix outside `withRevision` /
 * `withInjectedContext`: a suffix appended here would stop being last the moment either wrapper
 * fires. Only the generic block-context branch produces one — a standard phase owns its whole
 * template, and a kind supplying its own `userPrompt` replaces the generic prompt outright.
 */
interface BaseUserPrompt {
  prompt: string
  suffix?: string
}

function buildBaseUserPrompt(
  context: AgentRunContext,
  registry: AgentKindRegistry,
  opts: AgentUserPromptOptions = {},
): BaseUserPrompt {
  // Standard phases get their built-out, templated user prompt.
  const phase = phaseForKind(context.agentKind)
  if (phase) return { prompt: renderStandardUserPrompt(phase, context, opts) }
  const dispatch = opts.dispatch

  // A registered custom kind may supply its own user prompt; otherwise it falls through
  // to the generic block-context prompt below, like any other non-standard-phase kind. Even a
  // self-authored prompt still gets the initiative-preset steering folded in FIRST — an
  // initiative-spawned custom kind's standing org methodology frames its role before its own
  // task text — so the preset addition reaches a custom kind however it builds its prompt.
  // Empty on every non-initiative run ⇒ the custom prompt is byte-for-byte unchanged.
  //
  // The operation's per-case PARAMETERS ride the same prepend, and this is the emit point that
  // matters most for them: an org's reusable operation typically runs on that org's OWN kinds,
  // which are exactly the kinds that author their own user prompt. Miss it and the parameters
  // vanish for the runs the whole feature exists to serve.
  const registered = registry.userPrompt(context, dispatch)
  if (registered !== undefined) {
    const prepended = [initiativePresetSection(context), customTaskTypeSection(context)]
      .filter(Boolean)
      .map((section) => section.trimStart())
    return {
      prompt: prepended.length ? `${prepended.join('\n\n')}\n\n${registered}` : registered,
    }
  }

  const { block, pipelineName, priorOutputs, decisions, resolvedDecision } = context
  const lines: string[] = [
    `Pipeline: ${pipelineName}`,
    `Block: ${block.title} (${block.type})`,
    `Description: ${block.description || '(none provided)'}`,
  ]
  // Preset steering (an initiative-spawned custom kind's standing org methodology) FIRST — it
  // frames the agent's role before the task specifics. Empty on every non-initiative run.
  const presetSection = initiativePresetSection(context)
  if (presetSection) lines.push(presetSection)
  // What system this work belongs to (or that nothing said) — see `ownServiceSection`. Before the
  // linked context, which it frames.
  const ownService = ownServiceSection(context)
  if (ownService) lines.push(ownService)
  // The operation's per-case parameters, in the same position the standard prompt puts them.
  const taskParams = customTaskTypeSection(context)
  if (taskParams) lines.push(taskParams)
  // A companion grades a specific preceding producer; name it explicitly so the
  // model rates the right output rather than guessing among the prior-agent sections.
  const companionTarget = companionTargetSection(context, registry)
  if (companionTarget) lines.push(companionTarget)
  const linked = linkedContextSection(context, opts)
  if (linked) lines.push(linked)
  // A `spike`'s per-task research criteria + time-box (the create form's spike fields), folded
  // in after the block description + linked context so the investigation is scoped to them.
  if (context.agentKind === SPIKE_AGENT_KIND) {
    const spikeSection = spikeContextSection(context)
    if (spikeSection) lines.push(spikeSection)
  }
  const envSection = environmentSection(context)
  if (envSection) lines.push(envSection)
  const involvedSection = involvedServicesSection(context)
  if (involvedSection) lines.push(involvedSection)
  const approachSection = testApproachSection(context)
  if (approachSection) lines.push(approachSection)
  const targetSection = e2eTargetSection(context)
  if (targetSection) lines.push(targetSection)
  const testerEnv = testerEnvironmentSection(context)
  if (testerEnv) lines.push(testerEnv)
  const testSecrets = testSecretsSection(context)
  if (testSecrets) lines.push(testSecrets)
  const mockFrontend = mockFrontendSection(context)
  if (mockFrontend) lines.push(mockFrontend)
  const allDecisions = resolvedDecision ? [...decisions, resolvedDecision] : decisions
  if (allDecisions.length) {
    lines.push('', 'Resolved decisions:')
    for (const d of allDecisions) lines.push(`- ${d.question} → ${d.chosen}`)
  }
  if (priorOutputs.length) {
    lines.push('', 'Work from earlier agents in this pipeline:')
    for (const p of priorOutputs) {
      lines.push(`### ${p.agentKind}`, p.output)
    }
  }
  lines.push('', 'Produce your contribution. Be concise and concrete.')
  // A kind's ADDITIVE closing instructions (see `AgentKindDefinition.userPromptSuffix`) — the
  // shape for a kind that needs everything above (the run's evidence, the prior agents' output)
  // plus its own task framing. Returned BESIDE the prompt rather than pushed onto `lines`, so
  // `userPromptFor` can append it after the revision/injected-context wrappers and it genuinely
  // ends the prompt.
  const suffix = registry.userPromptSuffix(context, dispatch)
  return { prompt: lines.join('\n'), ...(suffix ? { suffix } : {}) }
}

/**
 * For a companion step, name the specific producer output it must grade: the NEAREST
 * preceding step whose kind is one of the companion's targets. Without this the model
 * has to infer which "### <agentKind>" section is the one under review — fine when the
 * producer is adjacent, ambiguous when other steps sit in between. Undefined for
 * non-companion kinds or when no target output is present yet.
 */
function companionTargetSection(
  context: AgentRunContext,
  registry: AgentKindRegistry,
): string | undefined {
  const targets = companionTargets(context.agentKind, registry)
  if (targets.length === 0) return undefined
  for (let i = context.priorOutputs.length - 1; i >= 0; i--) {
    const produced = context.priorOutputs[i]!
    if (targets.includes(produced.agentKind)) {
      return (
        `You are grading the output of the \`${produced.agentKind}\` step (shown under ` +
        `"### ${produced.agentKind}" below). Base your rating on THAT output.`
      )
    }
  }
  return undefined
}
