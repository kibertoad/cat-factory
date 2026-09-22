import {
  comparableCredentialInjectionName,
  uniqueCredentialInjectionNames,
} from '@cat-factory/contracts'
import {
  DELEGATED_WORK_BRANCH_POLICIES,
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
    if (!DELEGATED_WORK_BRANCH_POLICIES.includes(definition.workBranch)) {
      // Refused rather than treated as the safer of the two, because there is no safer one and a
      // misspelling reads as the opposite of what was meant: every `=== 'platform-creates'` test
      // in the engine skips an unrecognised value, so the deployment believes it opted in, the
      // platform writes no ref, and the failure surfaces hours later as a checkout against a
      // branch that is not there with nothing naming who was supposed to make it. A registration
      // from JavaScript, or from a composition module driven by JSON, reaches here with the type
      // having checked nothing.
      throw new DelegatedExecutorRegistrationError(
        `delegated executor ${JSON.stringify(id)} declares the work-branch policy ` +
          `${JSON.stringify(definition.workBranch)}, which this build does not know (expected ` +
          `${DELEGATED_WORK_BRANCH_POLICIES.map((p) => JSON.stringify(p)).join(' or ')}). The ` +
          `engine reads it to decide whether to create the branch each dispatch names, and an ` +
          `unrecognised value would silently mean "the executor makes its own".`,
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
    const credentials = definition.credentials ?? []
    if (!uniqueCredentialInjectionNames(credentials)) {
      // Refused rather than resolved, because there is no arbitration that makes it right. The bag
      // handed to `start`/`poll`/`cancel` is keyed by the name the EXECUTOR reads (`envName` when
      // declared, else the lookup key), so two declarations resolving to one name are one entry:
      // whichever the resolver answers last wins, silently, and the executor authenticates against
      // one system with another's credential. The same floor every other capability that claims a
      // name is held to (`uniqueCredentialInjectionNames`), applied here because a delegated
      // executor is registered in code and this is the moment the deployment is holding the
      // registry. Duplicate LOOKUP keys stay legitimate: one stored value delivered under two
      // names loses nothing.
      throw new DelegatedExecutorRegistrationError(
        `delegated executor ${JSON.stringify(id)} declares two credentials that arrive under one ` +
          `name (${duplicateInjectionNames(credentials).join(', ')}). Each credential is read by ` +
          `the executor under its \`envName\`, or its key when it declares none, so one name can ` +
          `carry only one value: rename one, or declare a single credential if they are the same ` +
          `secret.`,
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

/** The injection names claimed more than once, in the spelling the declaration wrote them. */
function duplicateInjectionNames(
  credentials: readonly NonNullable<DelegatedExecutorDefinition['credentials']>[number][],
): string[] {
  const seen = new Set<string>()
  const duplicated: string[] = []
  for (const credential of credentials) {
    const comparable = comparableCredentialInjectionName(credential)
    if (seen.has(comparable)) duplicated.push(credential.envName ?? credential.key)
    else seen.add(comparable)
  }
  return duplicated
}
