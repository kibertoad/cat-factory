import { getFragment } from '@cat-factory/prompt-fragments'

// Folds the best-practice fragments selected for a block into the agent's base
// system prompt. There are two sources of fragment bodies, in priority order:
//
//  1. `resolvedFragments` — already-resolved `{ id, body }` entries the execution
//     engine attaches for a `code-aware`/`doc-aware` step: the block's applicable
//     best-practice fragments, resolved against the universal pool. For a TASK that
//     is the task's OWN `fragmentIds` (which already carries the service standards it
//     inherited at creation — the service's set is NOT re-unioned at run time); only a
//     FRAME-level run adds the frame's `serviceFragmentIds`. Used as-is.
//  2. `fragmentIds` — the block's own manual selection, resolved against the
//     universal fragment pool in @cat-factory/prompt-fragments. This is the path
//     for non-code-aware kinds (the engine attaches no `resolvedFragments` for them).
//
// Unknown ids (e.g. a fragment removed from the catalog after selection) are
// skipped so a stale selection never breaks a run.

/** One resolved best-practice standard to fold into the prompt: its body + reference label. */
export interface ComposableFragment {
  id: string
  /** The fragment's human title, used as the citation label when present (else the id). */
  title?: string
  body: string
}

/** A block's fragment selection, as the prompt composer needs it. */
export interface ComposableBlock {
  fragmentIds?: string[]
  resolvedFragments?: ComposableFragment[]
}

/**
 * Neutralise the characters that would break the single-line `<best-practice-standard …>` tag —
 * quotes and angle brackets become apostrophes, and any run of whitespace (incl. newlines) collapses
 * to a single space — so an arbitrary fragment title always yields a well-formed attribute value.
 */
function escapeAttr(value: string): string {
  return value.replace(/["<>]/g, "'").replace(/\s+/g, ' ').trim()
}

/**
 * Fold the selected best-practice standards into the base system prompt. Each standard is
 * wrapped in its OWN delimited, labelled block — carrying a stable `id` and its human `title`
 * — rather than concatenated into one blob, so the agent can tell the standards apart and cite
 * a specific one by title (what the code/PR reviewers' adherence report relies on).
 */
function foldStandards(baseSystem: string, fragments: ComposableFragment[]): string {
  if (fragments.length === 0) return baseSystem
  const blocks = fragments.map((fragment) => {
    const label = fragment.title?.trim() || fragment.id
    return [
      `<best-practice-standard id="${escapeAttr(fragment.id)}" title="${escapeAttr(label)}">`,
      fragment.body.trim(),
      '</best-practice-standard>',
    ].join('\n')
  })
  return [
    baseSystem,
    '',
    'Follow these standards while doing the work. Each best-practice standard is delimited below',
    'as its own block with a stable id and title — treat each as a SEPARATE standard, and when you',
    'need to cite one refer to it by its title.',
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

export function composeSystemPrompt(baseSystem: string, fragmentIds: string[] = []): string {
  const fragments = fragmentIds
    .map((id) => getFragment(id))
    .filter((fragment): fragment is NonNullable<typeof fragment> => fragment !== undefined)
    .map((fragment) => ({ id: fragment.id, title: fragment.title, body: fragment.body }))
  return foldStandards(baseSystem, fragments)
}

/**
 * Compose the system prompt for a block, preferring the engine-resolved tenant
 * catalog bodies when present and otherwise falling back to static id resolution.
 * Both inline and container executors use this so the fragment-library feature
 * applies uniformly to every agent kind, not just the reviewer.
 *
 * `delivery: 'context-files'` returns the base prompt UNCHANGED: that kind's own preOp writes
 * the standards as `.cat-context/` files and its prompt points the agent at them, because
 * folding them in would charge a delegating agent for every standard on every turn of its loop.
 * See {@link AgentKindDefinition.standardsDelivery}.
 */
export function composeBlockSystemPrompt(
  baseSystem: string,
  block: ComposableBlock,
  delivery: 'prompt' | 'context-files' = 'prompt',
): string {
  if (delivery === 'context-files') return baseSystem
  if (block.resolvedFragments && block.resolvedFragments.length > 0) {
    return foldStandards(baseSystem, block.resolvedFragments)
  }
  return composeSystemPrompt(baseSystem, block.fragmentIds)
}
