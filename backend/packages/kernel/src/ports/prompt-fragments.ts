import type { PromptFragment, TaskType } from '@cat-factory/contracts'
import type { PromptFragmentRegistry } from '../domain/prompt-fragment-registry.js'

// Where the UNIVERSAL fragment pool is READ from, the sibling of `foundational-builtins.ts` and
// `binary-generators.ts` and there for the same reason: a deployment is not always ONE process.
//
// The pool is state a deployment registers in CODE and a RUN resolves (the catalog merge folds it
// under the account and workspace tiers, and a task's `defaultFragmentIds` select from it), so it
// is org state, and in MOTHERSHIP mode the mothership owns it. A local node with no main database
// would otherwise resolve a run's standards from its OWN build, and a node one build behind the
// mothership is the normal state of running a pair: the run then folds a standard the pipeline
// builder never offered, or (worse) silently folds nothing where the mothership has a standard,
// which reads to a reviewer exactly like a deployment that never wrote one down.
//
// A read failure THROWS rather than answering with an empty pool, for the reason ADR 0031 states
// for the foundational tier: "the mothership is unreachable" and "this deployment registers no
// standards" are the same value and opposite facts. The caller keeps its best-effort disposition
// and must STATE the outage rather than fall through to nothing.

/**
 * The deployment-registered half of the fragment catalog, as its readers resolve it.
 *
 * Deliberately the two projections {@link PromptFragmentRegistry} already exposes, so a remote
 * implementation is a transport and never a second view of the data. Both are async because one
 * implementation crosses a network; an in-process source resolves immediately.
 */
export interface PromptFragmentSource {
  /**
   * Whether the pool this source answers from is THIS process's own registry.
   *
   * Read by anything that would otherwise judge a run's fragment ids against the local registry.
   * Boot validation is the one that matters: on a mothership-mode node the registry holds the
   * shipped catalog and nothing else (the deployment is told to register its standards on the
   * MOTHERSHIP's entry point, which is the only place they take effect), so checking a task
   * type's `defaultFragmentIds` against it would report every org standard as unresolvable on
   * every boot, for a configuration that resolves perfectly at run time. "The pool is empty" and
   * "the pool is somewhere this process cannot see" are the same value and opposite facts, which
   * is the rule this whole port exists to keep.
   */
  readonly inProcess: boolean
  /** The universal pool: every registered fragment, in registration order. */
  all(): Promise<PromptFragment[]>
  /**
   * The fragment ids a new task of `taskType` is seeded with.
   *
   * Its own method rather than something derived from {@link all}, because the default SET and the
   * fragments it names are two independent registrations: a default may name a tenant-tier id that
   * exists only as a row, so deriving the set from the pool would silently drop exactly the
   * reference a deployment is told to use.
   */
  defaultFragmentIdsFor(taskType: TaskType): Promise<string[]>
}

/**
 * The in-process source: this deployment's own registry, read directly. The default on every
 * facade that is not a mothership-mode node.
 */
export function registryPromptFragmentSource(
  registry: PromptFragmentRegistry,
): PromptFragmentSource {
  return {
    inProcess: true,
    all: async () => registry.all(),
    defaultFragmentIdsFor: async (taskType) => registry.defaultFragmentIdsFor(taskType),
  }
}
