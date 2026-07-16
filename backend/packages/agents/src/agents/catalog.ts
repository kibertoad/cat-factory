import type { AgentKind } from '@cat-factory/kernel'
import type { AgentRunContext } from '@cat-factory/kernel'
import {
  acceptanceSystemPrompt,
  testApproachSection,
  e2eTargetSection,
} from './prompts/acceptance.js'
import { companionSystemPrompt } from './prompts/companion.js'
import { companionTargets, isCompanionKind } from './kinds/companions.js'
import { READ_ONLY_GUARDRAIL, isReadOnlyAgentKind } from './kinds/read-only.js'
import { SPIKE_AGENT_KIND, spikeContextSection } from './kinds/spike.js'
import { businessLogicSystemPrompt } from './prompts/business-logic.js'
import { mockFrontendSection, mockSystemPrompt } from './prompts/mock.js'
import { testingSystemPrompt, testerEnvironmentSection } from './prompts/testing.js'
import type { AgentKindRegistry } from './kinds/registry.js'
import { traitGuidanceFor } from './kinds/traits.js'
import { roleSystemPrompt } from './prompts/roles.js'
import { FINAL_ANSWER_IN_REPLY } from './prompts/shared.js'
import {
  environmentSection,
  initiativePresetSection,
  involvedServicesSection,
  linkedContextSection,
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

export function systemPromptFor(kind: AgentKind, registry: AgentKindRegistry): string {
  const base = baseSystemPromptFor(kind, registry)
  // Append the surface-driven directives (read-only guardrail + final-answer-in-reply) — see
  // {@link applySurfaceDirectives}. This is the single place that decision lives, so a
  // registered kind gets the SAME treatment a built-in does from its declared `agent.surface`.
  const withDirectives = applySurfaceDirectives(base, kind, registry)
  // Fold in any guidance contributed by the kind's traits (e.g. the spec-aware kinds get
  // the in-repo-spec reading guidance). Marker traits like `code-aware` add nothing here —
  // their effect (folding the service's fragments) is applied by the execution engine.
  const guidance = traitGuidanceFor(kind, registry)
  return guidance.length ? `${withDirectives}\n\n${guidance.join('\n\n')}` : withDirectives
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
  const surface = registry.agentStep(kind)?.surface
  // True only when the base prompt is the one from the registry — i.e. no built-in track claimed
  // this kind. A built-in-track-owned id (even if also registered) already got the directive.
  const usedRegisteredPrompt = prompt === registry.systemPrompt(kind)
  const needsGuardrail = isReadOnlyAgentKind(kind) || surface === 'container-explore'
  const needsFinalAnswer =
    usedRegisteredPrompt && (surface === 'inline' || surface === 'container-explore')
  let result = prompt
  if (needsGuardrail) result = `${result}\n\n${READ_ONLY_GUARDRAIL}`
  if (needsFinalAnswer) result = `${result}\n\n${FINAL_ANSWER_IN_REPLY}`
  return result
}

function baseSystemPromptFor(kind: AgentKind, registry: AgentKindRegistry): string {
  // Companion kinds (reviewer, architect-companion, spec-companion, …) win over every
  // built-in track: they grade a prior step's output and return a JSON rating.
  const companion = companionSystemPrompt(kind)
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
 * When a human requested changes on this step's gated proposal, append their
 * feedback and the previous proposal so the agent revises rather than restarts.
 * Applied to every inline agent kind (standard-phase and generic alike).
 */
function withRevision(prompt: string, context: AgentRunContext): string {
  const revision = context.revision
  if (!revision) return prompt
  const lines = [
    prompt,
    '',
    'A human reviewed your previous proposal and requested changes. Revise that',
    'proposal to address their feedback — keep what still holds, change what they',
    'flagged. Do not start from scratch.',
    '',
    'Your previous proposal:',
    revision.previousProposal || '(empty)',
    '',
    'Reviewer feedback:',
    revision.feedback || '(none given)',
  ]
  // Per-block comments the reviewer left on specific parts of the proposal. Each
  // quotes the exact text it targets, so the agent can locate and revise it.
  if (revision.comments?.length) {
    lines.push('', 'Comments on specific parts of your proposal:')
    for (const c of revision.comments) {
      lines.push(
        '',
        'On this part:',
        c.quotedSource || '(empty)',
        'Comment:',
        c.body || '(none given)',
      )
    }
  }
  return lines.join('\n')
}

/**
 * Build the user prompt from the block context and the run so far. `opts.materialized`
 * (set by the container executor) renders linked context as a summary index pointing at
 * the on-disk files; the default (inline executors) injects the bodies into the prompt.
 */
export function userPromptFor(
  context: AgentRunContext,
  registry: AgentKindRegistry,
  opts: { materialized?: boolean } = {},
): string {
  return withRevision(buildBaseUserPrompt(context, registry, opts), context)
}

function buildBaseUserPrompt(
  context: AgentRunContext,
  registry: AgentKindRegistry,
  opts: { materialized?: boolean } = {},
): string {
  // Standard phases get their built-out, templated user prompt.
  const phase = phaseForKind(context.agentKind)
  if (phase) return renderStandardUserPrompt(phase, context, opts)

  // A registered custom kind may supply its own user prompt; otherwise it falls through
  // to the generic block-context prompt below, like any other non-standard-phase kind. Even a
  // self-authored prompt still gets the initiative-preset steering folded in FIRST — an
  // initiative-spawned custom kind's standing org methodology frames its role before its own
  // task text — so the preset addition reaches a custom kind however it builds its prompt.
  // Empty on every non-initiative run ⇒ the custom prompt is byte-for-byte unchanged.
  const registered = registry.userPrompt(context)
  if (registered !== undefined) {
    const presetSection = initiativePresetSection(context)
    return presetSection ? `${presetSection.trimStart()}\n\n${registered}` : registered
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
  // A companion grades a specific preceding producer; name it explicitly so the
  // model rates the right output rather than guessing among the prior-agent sections.
  const companionTarget = companionTargetSection(context)
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
  return lines.join('\n')
}

/**
 * For a companion step, name the specific producer output it must grade: the NEAREST
 * preceding step whose kind is one of the companion's targets. Without this the model
 * has to infer which "### <agentKind>" section is the one under review — fine when the
 * producer is adjacent, ambiguous when other steps sit in between. Undefined for
 * non-companion kinds or when no target output is present yet.
 */
function companionTargetSection(context: AgentRunContext): string | undefined {
  if (!isCompanionKind(context.agentKind)) return undefined
  const targets = companionTargets(context.agentKind)
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
