import type { BlueprintService } from '@cat-factory/kernel'

// Pure helpers for reconciling a service blueprint onto the board — no IO, no
// ports. They render a node's codebase references into the parseable form the board
// embeds in block descriptions and count a tree's modules. Keeping them pure makes
// reconciliation deterministic and trivially testable without a repo or an LLM.
// (Coercion of the agent's raw JSON lives in the executor harness, which validates
// and renders the tree before it ever reaches the engine.)

/** Module count for a service — the structural size of the map. */
export function countModules(service: BlueprintService): number {
  return (service.modules ?? []).length
}

/**
 * Render a node's summary and codebase references into a board block description.
 * The references are emitted under a stable `Code references:` marker so an agent
 * scoping later work can parse exactly which files a frame/module/task maps to.
 */
export function describeNode(
  summary: string | undefined,
  references: string[] | undefined,
): string {
  const parts: string[] = []
  const trimmed = summary?.trim()
  if (trimmed) parts.push(trimmed)
  if (references && references.length > 0) {
    parts.push(['Code references:', ...references.map((r) => `- ${r}`)].join('\n'))
  }
  return parts.join('\n\n')
}
