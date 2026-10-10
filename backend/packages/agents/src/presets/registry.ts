import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { registerDocsRefreshPreset } from './docs-refresh/preset.js'
import { registerTechMigrationPreset } from './tech-migration/preset.js'

/**
 * A fresh {@link InitiativePresetRegistry} pre-loaded with the built-in presets. This is the single
 * place the built-ins are installed — there is no module-load side effect — so every app (and every
 * test) gets its own instance with the built-ins present: the generic preset is baked into the
 * registry class, and the docs-refresh + tech-migration presets are registered here. A deployment
 * then registers its own presets by reference on the instance the composition root injects.
 */
export function defaultInitiativePresetRegistry(): InitiativePresetRegistry {
  const registry = new InitiativePresetRegistry()
  registerDocsRefreshPreset(registry)
  registerTechMigrationPreset(registry)
  return registry
}
