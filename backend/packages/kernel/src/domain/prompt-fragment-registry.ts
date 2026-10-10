import type { PromptFragment, TaskType } from '@cat-factory/contracts'

// App-owned registry of the best-practice PROMPT FRAGMENTS (and the per-task-type default sets
// that select them) a deployment ships in code, mirroring the agent-kind / gate / pipeline /
// task-type / foundational-service registries: the composition root news one instance, a
// deployment registers its standards on it BY REFERENCE, and every reader is handed that same
// instance.
//
// It replaces two MODULE GLOBALS in `@cat-factory/prompt-fragments` (`registerPromptFragment`'s
// map and `registerTaskTypeDefaultFragments`' map). Those worked only while every reader resolved
// the same physical copy of that package, which the published dependency graph does not guarantee:
// a `workspace:*` dependency publishes as an EXACT version, so a consumer floating the range onto
// a newer patch gets two copies. The registration then lands in one and the readers see the other,
// and the failure is silent in the expensive direction: every task of the deployment's operation
// is seeded with fragment ids that fold nothing into the prompt, and the only trace anywhere is a
// boot warning that cannot be told apart from a typo.
//
// The platform's own catalog is NOT special-cased here. `defaultPromptFragmentRegistry()` is EMPTY
// and `@cat-factory/prompt-fragments` installs the shipped fragments through the same `registerAll`
// / `registerTaskTypeDefaults` calls a deployment uses (`promptFragmentRegistryWithBuiltins()`),
// which is the `defaultGateRegistry()` ⇄ `@cat-factory/gates` shape: one seam, exercised by the
// platform on every boot, so it cannot rot for consumers only.

/**
 * App-owned registry of deployment-registered prompt fragments.
 *
 * Registration order is preserved and a later registration of an id REPLACES the earlier one, so a
 * deployment refines a shipped standard in place by re-registering its id. That is the behaviour
 * the module-global pool had, and it is load-bearing: the built-ins are themselves registered
 * through this seam, so "override a built-in" and "the second of my own registrations wins" have to
 * be one rule.
 */
export class PromptFragmentRegistry {
  private readonly fragments = new Map<string, PromptFragment>()
  private readonly taskTypeDefaults = new Map<TaskType, readonly string[]>()

  /** Register a fragment into the universal pool. Re-registering an id replaces it. */
  register(fragment: PromptFragment): void {
    this.fragments.set(fragment.id, fragment)
  }

  /** Register several fragments at once, in order. */
  registerAll(fragments: Iterable<PromptFragment>): void {
    for (const fragment of fragments) this.register(fragment)
  }

  /**
   * Declare the fragment ids every NEW task of `taskType` is seeded with. Re-registering a task
   * type REPLACES its set (it does not accumulate), so a deployment's later call is its final
   * answer rather than a silent union with whatever ran before it.
   *
   * The ids are NOT resolved here. A default set may legitimately name an account- or
   * workspace-tier fragment that exists only as a row, so requiring resolution at registration
   * would refuse the tenant-tier reference that is currently the only supported path to an
   * org-wide living document. Boot reports what the CODE pool cannot resolve as a warning, and
   * `FragmentLibraryService` reports what a RUN could not resolve.
   */
  registerTaskTypeDefaults(taskType: TaskType, fragmentIds: Iterable<string>): void {
    this.taskTypeDefaults.set(taskType, [...fragmentIds])
  }

  /** The universal pool: every registered fragment, in registration order. */
  all(): PromptFragment[] {
    return [...this.fragments.values()]
  }

  /** Resolve one fragment by id, or `undefined`. */
  get(id: string): PromptFragment | undefined {
    return this.fragments.get(id)
  }

  /**
   * The default fragment ids a new task of `taskType` is seeded with, deduped and order-stable.
   * Empty when nothing is registered for the type.
   */
  defaultFragmentIdsFor(taskType: TaskType): string[] {
    return [...new Set(this.taskTypeDefaults.get(taskType) ?? [])]
  }

  /** Every task type carrying a registered default set. For boot reporting and tests. */
  taskTypesWithDefaults(): TaskType[] {
    return [...this.taskTypeDefaults.keys()]
  }
}

/**
 * A fresh, EMPTY prompt-fragment registry. The shipped catalog installs itself onto one through
 * the public seam (`@cat-factory/prompt-fragments`' `promptFragmentRegistryWithBuiltins()`), so a
 * facade that wants the platform's standards asks for them explicitly rather than inheriting them
 * from an import side effect.
 */
export function defaultPromptFragmentRegistry(): PromptFragmentRegistry {
  return new PromptFragmentRegistry()
}
