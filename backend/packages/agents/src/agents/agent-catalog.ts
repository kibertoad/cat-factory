import type { AgentKind } from '@cat-factory/kernel'
import type { AgentRunContext } from '@cat-factory/kernel'
import {
  acceptanceSystemPrompt,
  testApproachSection,
  testTargetSection,
} from './acceptance-prompts'
import { businessLogicSystemPrompt } from './business-logic-prompts'
import { mockSystemPrompt } from './mock-prompts'
import { renderTaskContext } from '@cat-factory/kernel'
import {
  environmentSection,
  phaseForKind,
  renderStandardUserPrompt,
  standardSystemPrompt,
} from './standard-prompts'

// Role definitions and prompt construction for the built-in agent kinds. These
// turn an agent kind + block context into the system/user prompts handed to the
// LLM. The four standard solution phases — design (architect), build (coder),
// review (reviewer) and test (tester) — use the built-out prompts in
// ./standard-prompts; the acceptance-testing track (acceptance, playwright) uses
// the built-out prompts in ./acceptance-prompts; the mock builder (mocker) uses
// the built-out prompt in ./mock-prompts; the business-logic / domain-rules track
// (business-documenter, business-reviewer) uses the built-out prompts in
// ./business-logic-prompts; the remaining kinds use the thin roles below, and
// custom agent kinds (free-form ids) fall back to a generic role.

const ROLES: Partial<Record<AgentKind, string>> = {
  researcher:
    'You are a technical researcher. Investigate prior art, libraries and constraints relevant to the building block and summarise concrete recommendations.',
  documenter:
    'You are a technical writer. Produce concise developer documentation and a usage example for the building block.',
  integrator:
    'You are an integration engineer. Describe how to wire this building block into the surrounding system, including contracts and rollout.',
  // Runs before the architect: reviews the collected requirements and surfaces
  // what would block confident implementation. Its findings are presented to a
  // human at an approval gate (to reject items or supply missing information)
  // before the architect proceeds, so it must read as a clear, editable list.
  requirements:
    'You are a meticulous product / requirements analyst reviewing the collected requirements for a single building block before an engineer designs or builds it. Surface everything that would block confident implementation: missing information (gaps), ambiguities that need clarification, unstated assumptions, risks, and open questions. Be specific, concrete and actionable, and phrase each item so a product owner can answer it directly. Do NOT invent answers or requirements. Group your findings under clear headings and present a concise, readable markdown list — a human will review and edit it before the architect proceeds.',
  // Runs in a container against the PR head branch when CI is red. It must make the
  // failing build/tests pass with the smallest correct change and push to the same
  // branch (no new branch / PR) so CI re-runs.
  'ci-fixer':
    'You are a CI/build engineer. The pull request on this branch has failing CI. Reproduce the failure locally (run the project build / tests), diagnose the root cause, and make the minimal correct change to get every check passing. Do not disable or skip tests to make them pass. Commit your fix to the current branch.',
  // Runs in a container against the PR head branch as the final pipeline step. It
  // ONLY assesses — it must not modify the repo — and returns a JSON score object.
  merger:
    'You are a release manager assessing a pull request before merge. Inspect the change against the base branch and judge three axes, each from 0 (trivial/safe) to 1 (severe): complexity, risk and impact. Be conservative. Make no commits. Respond with ONLY a JSON object {"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"} — no prose, no code fences.',
}

export function systemPromptFor(kind: AgentKind): string {
  const phase = phaseForKind(kind)
  if (phase) return standardSystemPrompt(phase)
  const acceptance = acceptanceSystemPrompt(kind)
  if (acceptance) return acceptance
  const mock = mockSystemPrompt(kind)
  if (mock) return mock
  const businessLogic = businessLogicSystemPrompt(kind)
  if (businessLogic) return businessLogic
  return (
    ROLES[kind] ??
    `You are the "${kind}" agent. Do your part of the work for the given building block and report the result concisely.`
  )
}

/**
 * When a human requested changes on this step's gated proposal, append their
 * feedback and the previous proposal so the agent revises rather than restarts.
 * Applied to every inline agent kind (standard-phase and generic alike).
 */
function withRevision(prompt: string, context: AgentRunContext): string {
  const revision = context.revision
  if (!revision) return prompt
  return [
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
  ].join('\n')
}

/** Build the user prompt from the block context and the run so far. */
export function userPromptFor(context: AgentRunContext): string {
  return withRevision(buildBaseUserPrompt(context), context)
}

function buildBaseUserPrompt(context: AgentRunContext): string {
  // Standard phases get their built-out, templated user prompt.
  const phase = phaseForKind(context.agentKind)
  if (phase) return renderStandardUserPrompt(phase, context)

  const { block, pipelineName, priorOutputs, decisions, resolvedDecision } = context
  const lines: string[] = [
    `Pipeline: ${pipelineName}`,
    `Block: ${block.title} (${block.type})`,
    `Description: ${block.description || '(none provided)'}`,
  ]
  if (block.features?.length) {
    lines.push(`Target features: ${block.features.join(', ')}`)
  }
  if (block.contextDocs?.length) {
    lines.push('', 'Linked context documents (requirements / RFCs / PRDs):')
    for (const doc of block.contextDocs) {
      lines.push(`### ${doc.title} (${doc.url})`, doc.excerpt)
    }
  }
  if (block.contextTasks?.length) {
    lines.push('', 'Linked tracker issues (extra context):')
    for (const task of block.contextTasks) lines.push(renderTaskContext(task))
  }
  const envSection = environmentSection(context)
  if (envSection) lines.push(envSection)
  const approachSection = testApproachSection(context)
  if (approachSection) lines.push(approachSection)
  const targetSection = testTargetSection(context)
  if (targetSection) lines.push(targetSection)
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
