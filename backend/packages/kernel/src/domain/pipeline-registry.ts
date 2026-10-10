import type { RetiredPipeline } from './seed.js'
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
  private readonly withdrawn: RetiredPipeline[] = []

  /**
   * Register an extra predefined pipeline. A registered pipeline whose id matches a built-in (or an
   * earlier registration) replaces it, so a deployment can both add new pipelines and customize the
   * built-in catalog.
   *
   * Registering an id this registry had {@link retire}d un-retires it: the two are opposite
   * assertions about the same id, so the later call wins and the id can never be both live and
   * withdrawn.
   */
  register(pipeline: Pipeline): void {
    const retiredAt = this.withdrawn.findIndex((p) => p.id === pipeline.id)
    if (retiredAt >= 0) this.withdrawn.splice(retiredAt, 1)
    const at = this.extra.findIndex((p) => p.id === pipeline.id)
    if (at >= 0) this.extra[at] = pipeline
    else this.extra.push(pipeline)
  }

  /**
   * Withdraw a pipeline from the catalog: it stops being seeded into new workspaces, and a
   * workspace that already stores it is offered a removal instead of a reseed (see
   * `retiredPipelines` / `PipelineService.remove`). Use it for a deployment's OWN pipeline that is
   * no longer relevant — retiring a BUILT-IN is done in kernel's `buildRetiredPipelines`.
   *
   * Retiring an id this registry had registered drops the registration (the inverse of
   * {@link register}), so a deployment can withdraw a pipeline by editing one line rather than
   * having to also delete its definition.
   *
   * Retiring an id the BUILT-IN catalog still ships has no effect — `retiredPipelines` keeps a live
   * pipeline, or a deployment could empty the curated palette one id at a time. That is deliberate,
   * but it must never be SILENT: `validateRegistrations` raises `retirement_of_live_pipeline` at
   * boot, so the deployment learns its call did nothing at startup rather than from a cleanup that
   * never appeared. Retiring an id NOTHING currently defines is legitimate by contrast — that is
   * exactly the tombstone for a pipeline an older version of the deployment's package shipped.
   */
  retire(id: string, options?: { replacedBy?: string }): void {
    const at = this.extra.findIndex((p) => p.id === id)
    if (at >= 0) this.extra.splice(at, 1)
    const entry: RetiredPipeline = {
      id,
      ...(options?.replacedBy ? { replacedBy: options.replacedBy } : {}),
    }
    const retiredAt = this.withdrawn.findIndex((p) => p.id === id)
    if (retiredAt >= 0) this.withdrawn[retiredAt] = entry
    else this.withdrawn.push(entry)
  }

  /** Register several extra predefined pipelines at once. */
  registerMany(pipelines: Iterable<Pipeline>): void {
    for (const pipeline of pipelines) this.register(pipeline)
  }

  /** The registered extra pipelines (registration order). */
  registered(): Pipeline[] {
    return [...this.extra]
  }

  /** The pipelines this registry withdrew from the catalog (retirement order). */
  retired(): RetiredPipeline[] {
    return [...this.withdrawn]
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

  /**
   * Merge this registry's retirements into the built-in tombstone list: a registry entry for an
   * already-retired built-in replaces it in place (so a deployment can point `replacedBy` at its
   * own pipeline), new ones are appended.
   */
  mergeRetired(builtins: readonly RetiredPipeline[]): RetiredPipeline[] {
    const merged = [...builtins]
    for (const pipeline of this.withdrawn) {
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
