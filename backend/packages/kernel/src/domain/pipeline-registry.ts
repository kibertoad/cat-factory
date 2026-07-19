import type { Pipeline } from './types.js'

// App-owned registry of extra predefined pipelines, mirroring the agent-kind / gate registries.
// A deployment — e.g. a proprietary org package — registers extra pipelines on the instance the
// composition root injects (`registry.register(pipeline)`); `seedPipelines(registry)` then merges
// them into the built-in catalog, so every new workspace is seeded with them. Registered pipelines
// can reference both built-in and custom (registered) agent kinds.
//
// This replaces the previous module-global array: the composition root news ONE instance
// (`defaultPipelineRegistry()`), threads it through `CoreDependencies`, and the workspace + pipeline
// services read it from there — so there is no module-global state, no `clear*()` test cruft, and a
// separately-published extension package can never register into a phantom array.

/**
 * App-owned registry of extra predefined pipelines. The composition root news ONE instance and a
 * deployment registers its pipelines on it by reference; the seeding path merges them into the
 * built-in catalog via {@link merge}.
 */
export class PipelineRegistry {
  private readonly extra: Pipeline[] = []

  /**
   * Register an extra predefined pipeline. A registered pipeline whose id matches a built-in (or an
   * earlier registration) replaces it, so a deployment can both add new pipelines and customize the
   * built-in catalog.
   */
  register(pipeline: Pipeline): void {
    const at = this.extra.findIndex((p) => p.id === pipeline.id)
    if (at >= 0) this.extra[at] = pipeline
    else this.extra.push(pipeline)
  }

  /** Register several extra predefined pipelines at once. */
  registerMany(pipelines: Iterable<Pipeline>): void {
    for (const pipeline of pipelines) this.register(pipeline)
  }

  /** The registered extra pipelines (registration order). */
  registered(): Pipeline[] {
    return [...this.extra]
  }

  /**
   * Merge the registered pipelines into a built-in list: a registered pipeline replaces a built-in
   * with the same id in place, new ones are appended (registration order).
   */
  merge(builtins: readonly Pipeline[]): Pipeline[] {
    const merged = [...builtins]
    for (const pipeline of this.extra) {
      const at = merged.findIndex((p) => p.id === pipeline.id)
      if (at >= 0) merged[at] = pipeline
      else merged.push(pipeline)
    }
    return merged
  }
}

/** A fresh, empty pipeline registry. Each facade news one and a deployment registers its pipelines on it. */
export function defaultPipelineRegistry(): PipelineRegistry {
  return new PipelineRegistry()
}
