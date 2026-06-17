import { getFragment } from '@cat-factory/prompt-fragments'

// Folds the best-practice fragments selected for a block into the agent's base
// system prompt. There are two sources of fragment bodies, in priority order:
//
//  1. `resolvedFragments` — already-resolved `{ id, body }` entries the execution
//     engine attaches when the tenant fragment-library module is configured (the
//     merged catalog + relevance selection; ADR 0006). Used as-is.
//  2. `fragmentIds` — the legacy/manual selection, resolved against the
//     build-static registry in @cat-factory/prompt-fragments.
//
// Unknown ids (e.g. a fragment removed from the catalog after selection) are
// skipped so a stale selection never breaks a run.

/** A block's fragment selection, as the prompt composer needs it. */
export interface ComposableBlock {
  fragmentIds?: string[]
  resolvedFragments?: { id: string; body: string }[]
}

/** Fold a set of fragment bodies into the base system prompt under a header. */
function foldStandards(baseSystem: string, bodies: string[]): string {
  if (bodies.length === 0) return baseSystem
  return [
    baseSystem,
    '',
    'Follow these standards while doing the work:',
    '',
    bodies.join('\n\n'),
  ].join('\n')
}

export function composeSystemPrompt(baseSystem: string, fragmentIds: string[] = []): string {
  const bodies = fragmentIds
    .map((id) => getFragment(id))
    .filter((fragment): fragment is NonNullable<typeof fragment> => fragment !== undefined)
    .map((fragment) => fragment.body)
  return foldStandards(baseSystem, bodies)
}

/**
 * Compose the system prompt for a block, preferring the engine-resolved tenant
 * catalog bodies when present and otherwise falling back to static id resolution.
 * Both inline and container executors use this so the fragment-library feature
 * applies uniformly to every agent kind, not just the reviewer.
 */
export function composeBlockSystemPrompt(baseSystem: string, block: ComposableBlock): string {
  if (block.resolvedFragments && block.resolvedFragments.length > 0) {
    return foldStandards(
      baseSystem,
      block.resolvedFragments.map((f) => f.body),
    )
  }
  return composeSystemPrompt(baseSystem, block.fragmentIds)
}
