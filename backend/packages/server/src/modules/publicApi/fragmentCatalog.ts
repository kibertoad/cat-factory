import type { PublicPromptFragment, ResolvedFragment } from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'
import type { FragmentLibraryModule } from '@cat-factory/orchestration'
import { requireCapability } from '../../http/guards.js'

// The best-practice-standard CATALOG as `/api/v1` reads it: the merged tenant catalog behind
// `GET /api/v1/prompt-fragments`, and the check a task creation's `fragmentIds` is held to.
//
// One module for both halves because they are one question asked twice ("which standards does
// this workspace resolve"), and answering it in two places is how a list that offers an id and a
// create that refuses it come to disagree. It is also why the check reads the same
// `resolvedCatalog` the RUN path folds from (`resolveBodiesForRun` shares its cache), rather than
// the deployment's registered pool: the pool is one of the three tiers, so judging against it
// alone would refuse exactly the account- and workspace-tier standards a team authored, and admit
// a built-in the board has tombstoned.

/** The fragment library, or the 503 naming what this deployment has not wired. */
export function requireFragmentLibrary(
  library: FragmentLibraryModule | undefined,
): FragmentLibraryModule {
  return requireCapability(
    library,
    'Best-practice standards are not configured',
    'prompt_fragments_unwired',
  )
}

/** Project one merged catalog entry onto the published resource (identity and metadata, no body). */
export function toPublicPromptFragment(entry: ResolvedFragment): PublicPromptFragment {
  return {
    fragmentId: entry.id,
    title: entry.title,
    category: entry.category,
    summary: entry.summary,
    version: entry.version,
    tier: entry.tier,
    // Flattened to an ARRAY rather than passed through as optional: the library carries tags only
    // on a managed row, and "this standard has no tags" is not a fact a caller should have to tell
    // apart from "this tier does not do tags".
    tags: entry.tags ?? [],
    ...(entry.appliesTo ? { appliesTo: entry.appliesTo } : {}),
  }
}

/**
 * Refuse a creation naming a standard the workspace's merged catalog does not hold.
 *
 * The run path DROPS an unresolvable id on purpose, because a standard deleted after a task was
 * filed must not break its run, and that disposition is wrong at a door where the ids were named in
 * this request: a typo would answer `201` for a review folding nothing, which reads afterwards
 * exactly like a review nobody asked to be judged against anything.
 *
 * Deliberately at THIS door rather than on `BoardService` beside the preset-pin guard, which is
 * where a repository-read refusal otherwise belongs. The app's create form seeds its picker from
 * the enclosing service's standing set and submits it verbatim, so that list is a MIX of what a
 * person picked and what the task inherited, so one library id gone stale on a service would
 * then refuse every task filed under it. What separates the two is not the store being read but
 * WHO named the ids: everything here was named by the caller, in the same request cycle it read
 * the catalog in.
 *
 * Fires only for a caller that named standards, so a deployment with no library wired keeps
 * creating tasks exactly as before and only a caller that depends on the module meets its 503.
 */
export async function assertFragmentsResolvable(
  library: FragmentLibraryModule | undefined,
  workspaceId: string,
  fragmentIds: string[] | undefined,
): Promise<void> {
  if (!fragmentIds?.length) return
  const catalog = await requireFragmentLibrary(library).libraryService.resolvedCatalog(workspaceId)
  const known = new Set(catalog.map((entry) => entry.id))
  const missing = fragmentIds.filter((id) => !known.has(id))
  if (missing.length === 0) return
  // Every id that missed, not the first: a caller assembling a selection from configuration wants
  // one round trip to fix all of them. Naming them is safe here (and useful) where the preset
  // guard withholds its library, because this catalog is readable at `read`: a floor BELOW the
  // `write` that creates a task, so a caller told which of its own ids missed learns nothing it
  // could not have listed.
  throw new ValidationError(
    `No best-practice standard in this workspace for: ${missing.join(', ')}.`,
    { reason: 'prompt_fragment_not_found', fragmentIds: missing },
  )
}
