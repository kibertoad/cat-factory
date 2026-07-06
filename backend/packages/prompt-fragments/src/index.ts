import type { PromptFragment } from '@cat-factory/contracts'
import { acceptanceFragments } from './collections/acceptance.js'
import { designFragments } from './collections/design.js'
import { migrationFragments } from './collections/migration.js'
import { nodeFragments } from './collections/node.js'
import { reactFragments } from './collections/react.js'
import { styleFragments } from './collections/style.js'

// Source of truth for the best-practice prompt fragment catalog. Collections are
// authored per topic (one module each) and merged here into a single registry.
// This is plain, build-static data: the worker serves it read-only to the
// frontend, and the core composes selected fragment bodies into the system prompt.
//
// To add a collection: create `collections/<topic>.ts`, export its array, and
// spread it into FRAGMENTS below. Ids must be globally unique and stable, since
// blocks persist them.

export type { PromptFragment } from '@cat-factory/contracts'

export const FRAGMENTS: PromptFragment[] = [
  ...nodeFragments,
  ...reactFragments,
  ...acceptanceFragments,
  ...designFragments,
  ...styleFragments,
  ...migrationFragments,
]

// Re-export the writing-style collection + the document-task style defaults so a consumer (the
// board service seeding a new document task's fragments, the docs-refresh preset building its
// `styleFragments` form options) draws on the same source of truth the catalog is built from.
export { styleFragments, DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS } from './collections/style.js'

/** Fragments keyed by id for O(1) lookup during prompt composition. */
export const FRAGMENTS_BY_ID: ReadonlyMap<string, PromptFragment> = new Map(
  FRAGMENTS.map((fragment) => [fragment.id, fragment]),
)

// Installation-level extension point for the universal fragment pool, mirroring the
// custom-agent (`registerAgentKind`) and model-provider registry seams. A deployment —
// e.g. a proprietary org package — adds extra best-practice fragments once at startup
// (an import side effect); every `getFragment` lookup and the `GET /prompt-fragments`
// catalog then see them, so a service's fragment selection can draw on them without the
// core packages knowing they exist. Registering an id that already exists in the
// built-in catalog overrides it (later registration wins), so a deployment can refine a
// shipped fragment's body in place.
const registered = new Map<string, PromptFragment>()

/** Register a custom prompt fragment into the universal pool. Re-registering an id replaces it. */
export function registerPromptFragment(fragment: PromptFragment): void {
  registered.set(fragment.id, fragment)
}

/** Register several custom prompt fragments at once. */
export function registerPromptFragments(fragments: Iterable<PromptFragment>): void {
  for (const fragment of fragments) registerPromptFragment(fragment)
}

/** Drop all registered fragments. Intended for tests that exercise registration. */
export function clearRegisteredPromptFragments(): void {
  registered.clear()
}

/**
 * The universal fragment pool: the built-in catalog plus any deployment-registered
 * fragments, with a registered id shadowing the built-in of the same id. This is what
 * the catalog endpoint serves and what a service's fragment selection is drawn from.
 */
export function universalFragments(): PromptFragment[] {
  if (registered.size === 0) return [...FRAGMENTS]
  const byId = new Map<string, PromptFragment>()
  for (const fragment of FRAGMENTS) byId.set(fragment.id, fragment)
  for (const fragment of registered.values()) byId.set(fragment.id, fragment)
  return [...byId.values()]
}

/**
 * Resolve a fragment by id, or `undefined` if no such fragment exists. Checks the
 * deployment-registered fragments first (override-by-id) then the built-in catalog.
 */
export function getFragment(id: string): PromptFragment | undefined {
  return registered.get(id) ?? FRAGMENTS_BY_ID.get(id)
}
