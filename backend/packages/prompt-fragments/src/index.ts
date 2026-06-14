import type { PromptFragment } from '@cat-factory/contracts'
import { nodeFragments } from './collections/node'
import { reactFragments } from './collections/react'

// Source of truth for the best-practice prompt fragment catalog. Collections are
// authored per topic (one module each) and merged here into a single registry.
// This is plain, build-static data: the worker serves it read-only to the
// frontend, and the core composes selected fragment bodies into the system prompt.
//
// To add a collection: create `collections/<topic>.ts`, export its array, and
// spread it into FRAGMENTS below. Ids must be globally unique and stable, since
// blocks persist them.

export type { PromptFragment } from '@cat-factory/contracts'

export const FRAGMENTS: PromptFragment[] = [...nodeFragments, ...reactFragments]

/** Fragments keyed by id for O(1) lookup during prompt composition. */
export const FRAGMENTS_BY_ID: ReadonlyMap<string, PromptFragment> = new Map(
  FRAGMENTS.map((fragment) => [fragment.id, fragment]),
)

/** Resolve a fragment by id, or `undefined` if no such fragment exists. */
export function getFragment(id: string): PromptFragment | undefined {
  return FRAGMENTS_BY_ID.get(id)
}
