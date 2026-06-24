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
import { businessLogicSystemPrompt } from './prompts/business-logic.js'
import { mockSystemPrompt } from './prompts/mock.js'
import { testingSystemPrompt, testerEnvironmentSection } from './prompts/testing.js'
import {
  registeredAgentStep,
  registeredSystemPrompt,
  registeredUserPrompt,
} from './kinds/registry.js'
import { traitGuidanceFor } from './kinds/traits.js'
import { roleSystemPrompt } from './prompts/roles.js'
import { FINAL_ANSWER_IN_REPLY } from './prompts/shared.js'
import {
  environmentSection,
  linkedContextSection,
  phaseForKind,
  renderStandardUserPrompt,
  standardSystemPrompt,
} from './prompts/standard.js'

// Prompt construction for the built-in agent kinds: turns an agent kind + block
// context into the system/user prompts handed to the LLM. This file is the
// DISPATCHER — `baseSystemPromptFor` picks which track owns a kind; the prompt TEXT
// for each track lives under ./prompts (the four standard phases design/build/review/
// test in ./prompts/standard, the acceptance track in ./prompts/acceptance, the mock
// builder in ./prompts/mock, the business-logic track in ./prompts/business-logic,
// the tester/fixer track in ./prompts/testing, the companions in ./prompts/companion,
// and the thin one-line roles + generic fallback in ./prompts/roles).

export function systemPromptFor(kind: AgentKind): string {
  const base = baseSystemPromptFor(kind)
  // Read-only kinds (architect, analysis) explore a real checkout but must never edit
  // it; append the shared guardrail so the harness `/explore` run stays edit-free.
  const withGuardrail = isReadOnlyAgentKind(kind) ? `${base}\n\n${READ_ONLY_GUARDRAIL}` : base
  // Fold in any guidance contributed by the kind's traits (e.g. the spec-aware kinds get
  // the in-repo-spec reading guidance). Marker traits like `code-aware` add nothing here —
  // their effect (folding the service's fragments) is applied by the execution engine.
  const guidance = traitGuidanceFor(kind)
  return guidance.length ? `${withGuardrail}\n\n${guidance.join('\n\n')}` : withGuardrail
}

function baseSystemPromptFor(kind: AgentKind): string {
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
  // the generic fallback below, but never shadow the built-in tracks above. A registered
  // prompt is authored by the deployment and never flows through `roleSystemPrompt`, so
  // append the shared FINAL_ANSWER_IN_REPLY directive HERE for the surfaces whose
  // deliverable IS the reply — an `inline` or `container-explore` kind returning a report /
  // structured JSON the platform parses into `result.custom` — otherwise that answer can
  // be silently lost to a reasoning model's hidden channel. NOT appended for
  // `container-coding` (its product is a pushed commit, a side effect, like
  // roleSystemPrompt's SIDE_EFFECT kinds) nor for a kind with no LLM `agent` step at all
  // (the prompt is never used).
  const registered = registeredSystemPrompt(kind)
  if (registered !== undefined) {
    const surface = registeredAgentStep(kind)?.surface
    const producesFinalReply = surface === 'inline' || surface === 'container-explore'
    return producesFinalReply ? `${registered}\n\n${FINAL_ANSWER_IN_REPLY}` : registered
  }
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

/** Build the user prompt from the block context and the run so far. */
export function userPromptFor(context: AgentRunContext): string {
  return withRevision(buildBaseUserPrompt(context), context)
}

function buildBaseUserPrompt(context: AgentRunContext): string {
  // Standard phases get their built-out, templated user prompt.
  const phase = phaseForKind(context.agentKind)
  if (phase) return renderStandardUserPrompt(phase, context)

  // A registered custom kind may supply its own user prompt; otherwise it falls through
  // to the generic block-context prompt below, like any other non-standard-phase kind.
  const registered = registeredUserPrompt(context)
  if (registered !== undefined) return registered

  const { block, pipelineName, priorOutputs, decisions, resolvedDecision } = context
  const lines: string[] = [
    `Pipeline: ${pipelineName}`,
    `Block: ${block.title} (${block.type})`,
    `Description: ${block.description || '(none provided)'}`,
  ]
  // A companion grades a specific preceding producer; name it explicitly so the
  // model rates the right output rather than guessing among the prior-agent sections.
  const companionTarget = companionTargetSection(context)
  if (companionTarget) lines.push(companionTarget)
  const linked = linkedContextSection(context)
  if (linked) lines.push(linked)
  const envSection = environmentSection(context)
  if (envSection) lines.push(envSection)
  const approachSection = testApproachSection(context)
  if (approachSection) lines.push(approachSection)
  const targetSection = e2eTargetSection(context)
  if (targetSection) lines.push(targetSection)
  const testerEnv = testerEnvironmentSection(context)
  if (testerEnv) lines.push(testerEnv)
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
