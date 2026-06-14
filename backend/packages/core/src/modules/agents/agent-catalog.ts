import type { AgentKind } from '../../domain/types'
import type { AgentRunContext } from '../../ports/agent-executor'
import { acceptanceSystemPrompt, testTargetSection } from './acceptance-prompts'
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
// the built-out prompts in ./acceptance-prompts; the remaining kinds use the
// thin roles below, and custom agent kinds (free-form ids) fall back to a
// generic role.

const ROLES: Partial<Record<AgentKind, string>> = {
  researcher:
    'You are a technical researcher. Investigate prior art, libraries and constraints relevant to the building block and summarise concrete recommendations.',
  documenter:
    'You are a technical writer. Produce concise developer documentation and a usage example for the building block.',
  integrator:
    'You are an integration engineer. Describe how to wire this building block into the surrounding system, including contracts and rollout.',
}

export function systemPromptFor(kind: AgentKind): string {
  const phase = phaseForKind(kind)
  if (phase) return standardSystemPrompt(phase)
  const acceptance = acceptanceSystemPrompt(kind)
  if (acceptance) return acceptance
  return (
    ROLES[kind] ??
    `You are the "${kind}" agent. Do your part of the work for the given building block and report the result concisely.`
  )
}

/** Build the user prompt from the block context and the run so far. */
export function userPromptFor(context: AgentRunContext): string {
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
  const envSection = environmentSection(context)
  if (envSection) lines.push(envSection)
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
