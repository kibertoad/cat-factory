import type { AgentKind } from '../../domain/types'
import type { AgentRunContext } from '../../ports/agent-executor'

// Role definitions and prompt construction for the built-in agent kinds. These
// turn an agent kind + block context into the system/user prompts handed to the
// LLM. Custom agent kinds (free-form ids) fall back to a generic role.

const ROLES: Partial<Record<AgentKind, string>> = {
  architect:
    'You are a software architect. Design the shape of the solution for the given building block and break the work down into clear steps.',
  researcher:
    'You are a technical researcher. Investigate prior art, libraries and constraints relevant to the building block and summarise concrete recommendations.',
  coder:
    'You are a senior engineer. Produce a focused implementation sketch (key modules, functions, data shapes) for the building block.',
  tester:
    'You are a test engineer. Propose a pragmatic test plan and the most important test cases for the building block.',
  reviewer:
    'You are a code reviewer. Assess the proposed implementation for correctness, quality and risks, and list actionable findings.',
  documenter:
    'You are a technical writer. Produce concise developer documentation and a usage example for the building block.',
  integrator:
    'You are an integration engineer. Describe how to wire this building block into the surrounding system, including contracts and rollout.',
}

export function systemPromptFor(kind: AgentKind): string {
  return (
    ROLES[kind] ??
    `You are the "${kind}" agent. Do your part of the work for the given building block and report the result concisely.`
  )
}

/** Build the user prompt from the block context and the run so far. */
export function userPromptFor(context: AgentRunContext): string {
  const { block, pipelineName, priorOutputs, decisions, resolvedDecision } = context
  const lines: string[] = [
    `Pipeline: ${pipelineName}`,
    `Block: ${block.title} (${block.type})`,
    `Description: ${block.description || '(none provided)'}`,
  ]
  if (block.features?.length) {
    lines.push(`Target features: ${block.features.join(', ')}`)
  }
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
