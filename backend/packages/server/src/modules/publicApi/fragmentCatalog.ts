import type { PublicPromptFragment } from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'
import type { ResolvedCatalogEntry } from '@cat-factory/kernel'
import type { FragmentLibraryModule } from '@cat-factory/orchestration'
import { requireCapability } from '../../http/guards.js'

// The best-practice-standard CATALOG as `/api/v1` reads it: the merged tenant catalog behind
// `GET /api/v1/prompt-fragments`, and the check a task creation's `fragmentIds` is held to.
//
// One module for both halves because they are one question asked twice ("which standards does
// this workspace resolve"), and answering it in two places is how a list that offers an id and a
// create that refuses it come to disagree. It is also why both read the same merged catalog the
// RUN path folds from (`resolveBodiesForRun` shares its cache), rather than the deployment's
// registered pool: the pool is one of the three tiers, so judging against it alone would refuse
// exactly the account- and workspace-tier standards a team authored, and admit a built-in the
// board has tombstoned.

/** How many missing ids the human-readable refusal names before it counts the rest. */
const MESSAGE_ID_CAP = 5

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
export function toPublicPromptFragment(entry: ResolvedCatalogEntry): PublicPromptFragment {
  return {
    fragmentId: entry.id,
    title: entry.title,
    // `''` for an uncategorised entry, matching what the management wire shape does with the same
    // null: a picker groups by this string, and "no category" is a heading it can render, where a
    // missing key is a second absent-vs-empty case for every client to tell apart.
    category: entry.category ?? '',
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

/** One page of the published catalog, plus whether the caller should ask for another. */
export interface PublicFragmentPage {
  fragments: PublicPromptFragment[]
  hasMore: boolean
}

/**
 * One keyset page of the merged catalog, ordered by `fragmentId` (the merge's own key, so the
 * order is deterministic and a cursor cannot drift under a concurrent library edit).
 *
 * Sliced in memory rather than pushed into SQL, unlike the board lists on this surface, and that
 * is not a shortcut: the catalog is a MERGE of three tiers plus the deployment's registered pool,
 * so there is no single table to page over, and the merged result is already cached per workspace
 * and re-read on every agent dispatch. The bound is therefore about what crosses the WIRE, which
 * is the half that is unbounded here (one standard per Markdown file in a linked guidelines repo).
 */
export async function catalogPage(
  library: FragmentLibraryModule,
  workspaceId: string,
  page: { limit: number; afterId?: string },
): Promise<PublicFragmentPage> {
  const catalog = await library.libraryService.resolveCatalog(workspaceId)
  const start = page.afterId ? catalog.findIndex((entry) => entry.id > (page.afterId as string)) : 0
  // A cursor naming an id past the end of a catalog that has since shrunk is an empty LAST page,
  // never the first one: `findIndex` misses, and resuming at 0 would hand a paging client the top
  // of the list again and loop it forever.
  const window = start < 0 ? [] : catalog.slice(start, start + page.limit)
  return {
    fragments: window.map(toPublicPromptFragment),
    hasMore: start >= 0 && start + page.limit < catalog.length,
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
 * person picked and what the task inherited: one library id gone stale on a service would then
 * refuse every task filed under it. What separates the two is not the store being read but WHO
 * named the ids, and everything here was named by the caller, in the same request cycle it read
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
  // The merged ENTRIES, not the wire projection: this needs a set of ids, and `resolvedCatalog`
  // would map every body, brief, source and document ref into a throwaway object per row to build
  // it: several hundred of them on a workspace with a synced guidelines repo, on every create
  // that names a standard.
  const catalog = await requireFragmentLibrary(library).libraryService.resolveCatalog(workspaceId)
  const known = new Set(catalog.map((entry) => entry.id))
  const missing = fragmentIds.filter((id) => !known.has(id))
  if (missing.length === 0) return
  // EVERY id that missed rides `details`, not the first: a caller assembling a selection from
  // configuration wants one round trip to fix all of them. Naming them at all is safe here (and
  // useful) where the preset guard withholds its library, because this catalog is readable at the
  // same `write` that creates a task: a caller told which of its OWN ids missed learns nothing it
  // could not have listed.
  //
  // The prose half is capped and SAYS it is capped, because the array is bounded at
  // `MAX_TASK_FRAGMENTS` and a message naming a hundred ids is one nobody reads. The machine-
  // readable list is what a client acts on and stays whole. Neither can repeat an id: the schema
  // dedupes the request before this sees it, so a client rendering one remediation row per entry
  // gets one row per problem.
  const named = missing.slice(0, MESSAGE_ID_CAP).join(', ')
  const rest = missing.length - MESSAGE_ID_CAP
  throw new ValidationError(
    `No best-practice standard in this workspace for: ${named}${rest > 0 ? ` (and ${rest} more)` : ''}.`,
    { reason: 'prompt_fragment_not_found', fragmentIds: missing },
  )
}
