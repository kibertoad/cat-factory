import { getFragment } from '@cat-factory/prompt-fragments'

// Folds the best-practice fragments a user selected for a block into the agent's
// base system prompt. The catalog is the build-static registry in
// @cat-factory/prompt-fragments; selection is just a list of ids carried on the
// block. Unknown ids (e.g. a fragment removed from the catalog after selection)
// are skipped so a stale selection never breaks a run.

export function composeSystemPrompt(baseSystem: string, fragmentIds: string[] = []): string {
  const bodies = fragmentIds
    .map((id) => getFragment(id))
    .filter((fragment): fragment is NonNullable<typeof fragment> => fragment !== undefined)
    .map((fragment) => fragment.body)

  if (bodies.length === 0) return baseSystem

  return [
    baseSystem,
    '',
    'Follow these standards while doing the work:',
    '',
    bodies.join('\n\n'),
  ].join('\n')
}
