import type { AgentRunContext } from '@cat-factory/kernel'
import type { AgentKindDefinition } from './registry.js'
import { registerAgentKinds } from './registry.js'

// ---------------------------------------------------------------------------
// The `initiative-breakdown` agent kind — the first agent reachable from the PUBLIC API.
//
// An external system posts an initiative brief to `POST /api/v1/initiatives`; the engine runs
// this single INLINE step (one-shot LLM, no checkout, no repo, no push) and persists the result
// to the DB for asynchronous retrieval. Its deliverable IS its reply — a structured breakdown of
// the initiative into services / modules / candidate tasks — so it is a FORWARD-planning kind
// (decompose a brief), the mirror of the reverse `blueprints` kind (describe existing code, which
// needs a container + repo). Registered through the same public `registerAgentKind` seam the
// document kinds use, so it is a first-class kind with no bespoke harness handler.
// ---------------------------------------------------------------------------

export const INITIATIVE_BREAKDOWN_KIND = 'initiative-breakdown'

const INITIATIVE_BREAKDOWN_SYSTEM_PROMPT =
  'You are a senior delivery lead breaking a high-level initiative down into an actionable plan. ' +
  'Given the initiative brief, produce a clear, hierarchical decomposition an engineering team ' +
  'could pick up: the SERVICES or areas involved, the MODULES within each, and the concrete ' +
  'candidate TASKS under those modules. For each task give a short imperative title and a ' +
  'one-line description of the work and its intent. Call out cross-cutting concerns, sequencing / ' +
  'dependencies between tasks, key risks, and any open questions or assumptions you had to make. ' +
  'Do NOT write code, do not attempt to access a repository — reason purely from the brief and ' +
  'any linked context. Respond with a well-structured Markdown document: a short overview first, ' +
  'then the service → module → task hierarchy, then risks and open questions.'

function initiativeBreakdownUserPrompt(context: AgentRunContext): string {
  const brief = context.block.description?.trim()
  return [
    `Initiative: ${context.block.title}`,
    '',
    'Brief / requirements:',
    brief || '(none provided — infer a reasonable breakdown from the title)',
    '',
    'Produce the initiative breakdown as described.',
  ].join('\n')
}

export const INITIATIVE_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: INITIATIVE_BREAKDOWN_KIND,
    systemPrompt: INITIATIVE_BREAKDOWN_SYSTEM_PROMPT,
    userPrompt: initiativeBreakdownUserPrompt,
    agent: { surface: 'inline' },
    presentation: {
      label: 'Initiative Breakdown',
      icon: 'i-lucide-list-tree',
      color: '#34d399',
      description:
        'Decomposes a high-level initiative brief into a service → module → task plan. Runs inline (no repo), the entry agent for the public API.',
      category: 'design',
    },
  },
]

/**
 * Register the initiative kind. Idempotent (the registry replaces by kind), so calling it
 * explicitly and importing this module for its side effect are safe to combine.
 */
export function registerInitiativeAgents(): void {
  registerAgentKinds(INITIATIVE_AGENT_KINDS)
}

// Side-effect registration: importing `@cat-factory/agents` registers this first-class kind.
registerInitiativeAgents()
