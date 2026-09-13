import {
  DelegatedExecutorRegistrationError,
  type DelegatedExecutorDefinition,
} from '../ports/delegated-executor.js'

// App-owned registry of the DELEGATED EXECUTORS a deployment ships in code: the external systems
// that do the implementing for a step while cat-factory keeps the orchestration around it. It
// mirrors the agent-kind / gate / judge / binary-store registries exactly: the composition root
// news one instance (`defaultDelegatedExecutorRegistry()`), a deployment registers its executors
// on it BY REFERENCE, and the dispatch path reads it back when a delegated kind runs.
//
// EMPTY by default, and deliberately so: the platform ships no executor of its own, because
// naming one would make the seam about that one. A kind naming an unregistered executor fails boot
// validation, exactly as a kind naming an unknown skill does.

/** What the palette and a step's status card show about a registered executor. */
export interface DelegatedExecutorView {
  id: string
  label: string
  icon: string
  description: string
  /** Whether this executor files its own LLM telemetry; drives the "usage not reported" copy. */
  telemetry: DelegatedExecutorDefinition['telemetry']
}

/**
 * Namespaced, lowercase, `<namespace>:<name>`. Constrained rather than normalised for the reason
 * every persisted id is: the value lands on each delegated step's record, so a registration that
 * silently changed shape would orphan the rows already pointing at it.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}:[a-z0-9][a-z0-9-]{0,62}$/

/**
 * App-owned registry of a deployment's external executors. One instance per app, threaded through
 * `CoreDependencies`; nothing here is a module global, so a `workspace:*` consumer that resolved a
 * second physical copy of this package cannot register into a registry the server never reads.
 */
export class DelegatedExecutorRegistry {
  private readonly definitions = new Map<string, DelegatedExecutorDefinition>()

  /**
   * Register an executor. A registration whose id matches an earlier one replaces it (the same
   * last-wins rule every other app-owned registry uses, so a deployment can override an executor
   * its own shared composition module registered).
   *
   * The id is REFUSED rather than normalised when it is not namespaced. An unnamespaced id is how
   * two deployments' shared composition modules collide on `executor`, and the loser's kinds then
   * dispatch to the winner's external system: a wrong run in the wrong company's CI, with nothing
   * anywhere reporting a conflict.
   */
  register(definition: DelegatedExecutorDefinition): void {
    const id = definition.id
    if (!ID_PATTERN.test(id)) {
      throw new DelegatedExecutorRegistrationError(
        `delegated executor id ${JSON.stringify(id)} is not usable: use a namespaced ` +
          `<namespace>:<name> of lowercase letters, digits and dashes (for example ` +
          `"acme:executor"). The id is persisted on every delegated step, so it is constrained ` +
          `rather than normalised.`,
      )
    }
    if (definition.poll.intervalMs <= 0 || definition.poll.maxDurationMs <= 0) {
      throw new DelegatedExecutorRegistrationError(
        `delegated executor ${JSON.stringify(id)} declares a non-positive poll policy ` +
          `(intervalMs=${definition.poll.intervalMs}, maxDurationMs=${definition.poll.maxDurationMs}). ` +
          `The driver derives its poll budget from the pair, and a zero there is a step that is ` +
          `failed as un-settled before its first poll.`,
      )
    }
    if (definition.poll.maxDurationMs < definition.poll.intervalMs) {
      throw new DelegatedExecutorRegistrationError(
        `delegated executor ${JSON.stringify(id)} would be given up on before its first poll ` +
          `(maxDurationMs=${definition.poll.maxDurationMs} is shorter than ` +
          `intervalMs=${definition.poll.intervalMs}).`,
      )
    }
    this.definitions.set(id, definition)
  }

  /** Register several executors at once. */
  registerAll(definitions: Iterable<DelegatedExecutorDefinition>): void {
    for (const definition of definitions) this.register(definition)
  }

  /** The registered definition for an id, or undefined when this build registers none. */
  get(id: string): DelegatedExecutorDefinition | undefined {
    return this.definitions.get(id)
  }

  /** Every registered id, in registration order. */
  ids(): string[] {
    return [...this.definitions.keys()]
  }

  /** How many executors are registered: the "does this deployment delegate at all" check. */
  get size(): number {
    return this.definitions.size
  }

  /** The presentation-facing projection: identity only, never the factory. */
  views(): DelegatedExecutorView[] {
    return [...this.definitions.values()].map((definition) => ({
      id: definition.id,
      label: definition.presentation.label,
      icon: definition.presentation.icon,
      description: definition.presentation.description,
      telemetry: definition.telemetry,
    }))
  }
}

/** A fresh, EMPTY registry. The platform ships no delegated executor of its own. */
export function defaultDelegatedExecutorRegistry(): DelegatedExecutorRegistry {
  return new DelegatedExecutorRegistry()
}
