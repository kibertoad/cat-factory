import type { PromptFragment, TaskType } from '@cat-factory/contracts'
import { PromptFragmentRegistry, defaultPromptFragmentRegistry } from '@cat-factory/kernel'
import { BUILTIN_TASK_TYPE_DEFAULTS } from './task-type-defaults.js'
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
// The built-in per-task-type default sets, installed onto a registry by
// `promptFragmentRegistryWithBuiltins` below.
export { BUILTIN_TASK_TYPE_DEFAULTS } from './task-type-defaults.js'
// Re-export the migration fragment ids so the `preset_tech_migration` preset draws its default
// fragment set from the same source of truth the catalog is built from: `MIGRATION_FRAGMENT_IDS`
// (T8's descriptor `defaultFragmentIds`) + `migrationFragmentIdsFor` (T7's `seedMigrationPlan`,
// which stamps the per-agent-kind subset that respects each fragment's `appliesTo`).
export { MIGRATION_FRAGMENT_IDS, migrationFragmentIdsFor } from './collections/migration.js'
// The design-context fragment's id + the engine's presence rule for folding it: a run whose resolved
// context carries a design-origin document reads the guidance automatically, rather than depending on
// a human having ticked it in a picker basic mode does not show.
export { DESIGN_CONTEXT_FRAGMENT_ID, withDesignContextFragment } from './collections/design.js'

/** Fragments keyed by id for O(1) lookup during prompt composition. */
export const FRAGMENTS_BY_ID: ReadonlyMap<string, PromptFragment> = new Map(
  FRAGMENTS.map((fragment) => [fragment.id, fragment]),
)

/**
 * A {@link PromptFragmentRegistry} carrying the SHIPPED catalog and its built-in per-task-type
 * default sets. Each facade's composition root news one, and a deployment registers its own
 * standards onto the same instance by reference.
 *
 * The built-ins install through the registry's ordinary public methods rather than being baked in,
 * which is the `defaultGateRegistry()` ⇄ `@cat-factory/gates` shape: the platform exercises the
 * consumer's own seam on every boot, so it cannot rot for consumers only. Registration order is
 * what makes a deployment's re-registration of a shipped id an override, so the built-ins go first.
 *
 * This replaced two module globals (`registerPromptFragment`'s map and
 * `registerTaskTypeDefaultFragments`') whose correctness depended on every reader resolving the
 * same physical copy of this package. A `workspace:*` dependency publishes as an EXACT version, so
 * a consumer floating the range onto a newer patch got two copies: the registration landed in one,
 * the server read the other, and every task of the deployment's operation was seeded with ids that
 * folded nothing. Injection by reference makes that unrepresentable.
 */
export function promptFragmentRegistryWithBuiltins(): PromptFragmentRegistry {
  const registry = defaultPromptFragmentRegistry()
  registry.registerAll(FRAGMENTS)
  for (const [taskType, ids] of Object.entries(BUILTIN_TASK_TYPE_DEFAULTS)) {
    if (ids) registry.registerTaskTypeDefaults(taskType as TaskType, ids)
  }
  return registry
}

/**
 * Resolve a fragment from the SHIPPED catalog by id, or `undefined`.
 *
 * Strictly the built-ins: a deployment's own fragments live on the injected registry, and the
 * paths still calling this are the ones with no registry in hand (a prompt composed outside a
 * container, a test harness). That narrowing is deliberate rather than a leftover. Before it,
 * this function silently answered from a module global that a second copy of the package would
 * have left empty, which is the whole failure the registry removes.
 */
export function getFragment(id: string): PromptFragment | undefined {
  return FRAGMENTS_BY_ID.get(id)
}
