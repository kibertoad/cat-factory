import type { Pipeline } from './types.js'

// Installation-level extension point for predefined pipelines, mirroring the custom
// agent-kind and model-provider registry seams. A deployment — e.g. a proprietary org
// package — registers extra pipelines once at startup (an import side effect);
// `seedPipelines()` then includes them, so every new workspace is seeded with them
// alongside the built-in catalog. Registered pipelines can reference both built-in and
// custom (registered) agent kinds.
const extra: Pipeline[] = []

/**
 * Register an extra predefined pipeline. A registered pipeline whose id matches a
 * built-in (or an earlier registration) replaces it, so a deployment can both add new
 * pipelines and customize the built-in catalog.
 */
export function registerPipeline(pipeline: Pipeline): void {
  const existing = extra.findIndex((p) => p.id === pipeline.id)
  if (existing >= 0) extra[existing] = pipeline
  else extra.push(pipeline)
}

/** Register several extra predefined pipelines at once. */
export function registerPipelines(pipelines: Iterable<Pipeline>): void {
  for (const pipeline of pipelines) registerPipeline(pipeline)
}

/** The registered extra pipelines (registration order). */
export function registeredPipelines(): Pipeline[] {
  return [...extra]
}

/**
 * Merge the registered pipelines into a built-in list: a registered pipeline replaces a
 * built-in with the same id in place, new ones are appended (registration order).
 */
export function mergeRegisteredPipelines(builtins: readonly Pipeline[]): Pipeline[] {
  const merged = [...builtins]
  for (const pipeline of extra) {
    const at = merged.findIndex((p) => p.id === pipeline.id)
    if (at >= 0) merged[at] = pipeline
    else merged.push(pipeline)
  }
  return merged
}

/** Drop all registered pipelines. Intended for tests that exercise registration. */
export function clearRegisteredPipelines(): void {
  extra.length = 0
}
