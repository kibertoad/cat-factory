import type { AgentKindRegistry } from '@cat-factory/agents'
import {
  FOUNDATIONAL_CATALOG_TRAIT,
  FOUNDATIONAL_CONTRACTS_TRAIT,
  hasTrait,
} from '@cat-factory/agents'
import type {
  BinaryOutputConfig,
  FoundationalServiceSelection,
  PipelineStep,
} from '@cat-factory/contracts'
import type {
  AgentKind,
  BinaryGeneratorSource,
  FoundationalCatalogView,
  InjectedContextFile,
  Logger,
} from '@cat-factory/kernel'
import {
  FOUNDATIONAL_CATALOG_FILE,
  FOUNDATIONAL_INDEX_FILE,
  noopLogger,
  parseFoundationalDeclaration,
  renderFoundationalCatalog,
  renderFoundationalIndex,
  runBestEffort,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The FOUNDATIONAL SERVICES slice of one dispatch's context
// (backend/docs/adr/0031-foundational-services.md).
//
// Extracted from `AgentContextBuilder` as a cohesive collaborator, like `run-skills.ts`: it
// owns which of the two reads a dispatch gets, where a design's declaration is read from, and
// the failure policy — none of which the context builder's other ~40 resolutions need to see.
//
// The two reads are keyed off TRAITS, never off kind ids, so a deployment's own design kind
// gets the catalog (and its own implementer kinds get the contracts) by declaring the trait
// rather than by this module learning its name.
// ---------------------------------------------------------------------------

/**
 * The engine-facing seam over the catalog, implemented by
 * `FoundationalServiceRunResolver` (`@cat-factory/agents`) and wired only when the catalog is
 * configured. Absent ⇒ nothing is injected, which is exactly the prior behaviour.
 */
export interface FoundationalServiceResolver {
  catalogFor(workspaceId: string): Promise<FoundationalCatalogView[]>
  /**
   * Just the ids in the merged catalog — what a settled design's declaration is checked
   * against. Its own method rather than a `catalogFor().map()` at the call site because the
   * completion path has no use for the rest of a catalog entry, and reading the ids is what
   * lets an invented id be reported as unknown instead of silently accepted.
   */
  catalogIdsFor(workspaceId: string): Promise<string[]>
  contextFilesFor(
    workspaceId: string,
    selection: FoundationalServiceSelection | undefined,
  ): Promise<InjectedContextFile[]>
  /**
   * The BINARY-OUTPUT read (`run-binary-output.ts`): the brief + contract files for a
   * generating step's own selection (`stepOptions.binaryOutput`). On this interface rather
   * than its own seam because it is the same catalog behind the same tier merge and cache —
   * two resolvers would be two places for a workspace override to win differently.
   *
   * The GENERATIVE half of that selection resolves against the deployment's own integrations,
   * passed in rather than held by the resolver: they are a different kind of fact from the
   * workspace catalog (deployment code, no tenancy), so binding them to a catalog service would
   * misplace them. Absent ⇒ no integration resolves, and the brief states that rather than
   * implying the step has one. On a mothership-mode node the source is remote and can THROW,
   * which the caller's best-effort wrapper turns into an absent brief.
   */
  binaryOutputContextFilesFor(
    workspaceId: string,
    config: BinaryOutputConfig | undefined,
    generatorSource?: BinaryGeneratorSource,
  ): Promise<InjectedContextFile[]>
}

export interface ResolveFoundationalContextInput {
  workspaceId: string
  /** The EFFECTIVE dispatched kind (a gate helper dispatches its own kind, not the step's). */
  agentKind: AgentKind
  agentKindRegistry: AgentKindRegistry
  /** The run's steps BEFORE the one being dispatched, newest-last. */
  priorSteps: PipelineStep[]
  foundationalServiceResolver?: FoundationalServiceResolver
  logger?: Logger
}

/**
 * The `.cat-context/` files this dispatch gets from the foundational-services catalog:
 *
 * - a kind carrying `foundational-catalog` (the architect) gets the CATALOG — identity,
 *   capabilities and operation names for every registered service, no document bodies;
 * - a kind carrying `foundational-contracts` (the researcher, the coder) gets the full API
 *   CONTRACTS, for exactly the ids a prior design step declared;
 * - anything else gets nothing, and pays for nothing.
 *
 * BEST-EFFORT as a whole: the catalog is enrichment, and an unreachable store must not fail a
 * run that would otherwise proceed exactly as it did before the feature existed. A failure is
 * logged with its cause rather than swallowed.
 *
 * **A failed read still injects its file, saying so.** Best-effort is about not failing the RUN;
 * it is not licence to say nothing. The catalog read can genuinely fail now that a
 * mothership-mode node resolves the `builtin` tier over the machine API
 * (`ports/foundational-builtins.ts`), and that source throws rather than answering with an empty
 * tier precisely so the gap is not mistaken for an empty estate — a throw this seam swallowed
 * into an OMITTED file would have thrown that distinction away again one layer further out, and
 * left the trait guidance pointing at a `.cat-context/` path that does not exist. So the two
 * branches below each have a stated `unavailable` rendering, and the log line keeps the cause.
 */
export async function resolveFoundationalContext(
  input: ResolveFoundationalContextInput,
): Promise<InjectedContextFile[]> {
  const resolver = input.foundationalServiceResolver
  if (!resolver) return []
  const { agentKind, agentKindRegistry } = input
  if (hasTrait(agentKind, FOUNDATIONAL_CATALOG_TRAIT, agentKindRegistry)) {
    const files = await runBestEffort(
      input.logger ?? noopLogger,
      'foundationalServices.catalog',
      async () => {
        const catalog = await resolver.catalogFor(input.workspaceId)
        // Rendered even when EMPTY: the catalog file then states that none are registered,
        // which is the answer the design guidance asks the agent to act on. Omitting the file
        // would leave the prompt pointing at a path that does not exist, which reads as a
        // platform fault rather than as "there are none".
        return [
          {
            path: FOUNDATIONAL_CATALOG_FILE,
            content: renderFoundationalCatalog({ status: 'resolved', services: catalog }),
          },
        ]
      },
      { workspaceId: input.workspaceId, agentKind },
    )
    // …and rendered when the read FAILED, as a third thing again. `undefined` is the failure
    // (`runBestEffort` logged the cause); a successful empty catalog is `[]` above and never
    // reaches here.
    return (
      files ?? [
        {
          path: FOUNDATIONAL_CATALOG_FILE,
          content: renderFoundationalCatalog({ status: 'unavailable' }),
        },
      ]
    )
  }
  if (hasTrait(agentKind, FOUNDATIONAL_CONTRACTS_TRAIT, agentKindRegistry)) {
    const files = await runBestEffort(
      input.logger ?? noopLogger,
      'foundationalServices.contracts',
      () => resolver.contextFilesFor(input.workspaceId, declaredSelection(input.priorSteps)),
      { workspaceId: input.workspaceId, agentKind },
    )
    // A failed read still gets its index, stating that the contracts are missing rather than
    // that the design declared none — the resolver's own "the index is ALWAYS produced"
    // invariant, upheld here because this is where the failure becomes visible. A run in a
    // deployment with no catalog at all still returns a successful `[]` and no file.
    return (
      files ?? [
        {
          path: FOUNDATIONAL_INDEX_FILE,
          content: renderFoundationalIndex({ status: 'unavailable' }),
        },
      ]
    )
  }
  return []
}

/**
 * The declaration a consumer dispatch reads: the LAST prior step that recorded one.
 *
 * "Last" rather than "first" because a run can design more than once — a companion that bounces
 * the architect for rework re-runs it, and the rework's declaration is the current one. Reading
 * the persisted STEP (rather than re-parsing outputs here) is what makes this survive a durable
 * replay: the parse happened once, when the step settled.
 *
 * Returns `undefined` when no prior step declared anything at all, which the renderer states
 * as "nothing was checked" — distinct from an empty selection, which is a design that ran and
 * concluded no shared service applies.
 */
export function declaredSelection(
  priorSteps: PipelineStep[],
): FoundationalServiceSelection | undefined {
  for (let i = priorSteps.length - 1; i >= 0; i--) {
    const selection = priorSteps[i]?.foundationalServices
    if (selection) return selection
  }
  return undefined
}

/**
 * Read a settled design step's declaration out of the reply it just produced and record it on
 * the step. Called by the engine when a step whose kind carries `foundational-catalog` finishes.
 *
 * Recorded even when the agent declared NOTHING (an empty selection), because that is a real
 * and different answer from "no design step ran" — the two are what the consumer's index file
 * distinguishes, and only a written row can tell them apart later.
 *
 * BEST-EFFORT: the declaration is enrichment on top of a step that already succeeded, so a
 * catalog read that fails leaves the step unannotated (⇒ consumers read "nothing was checked")
 * rather than failing a completed design.
 */
export type FoundationalDeclarationRecorder = (
  workspaceId: string,
  step: PipelineStep,
  /** The reply the job just returned. Read from the RESULT, not `step.output`, which the
   *  completion paths downstream of this hook have not assigned yet. */
  output: string | undefined,
) => Promise<void>

/**
 * Bind a {@link FoundationalDeclarationRecorder} to the dispatcher's collaborators, so the
 * completion hub calls one function instead of restating the trait check, the catalog read and
 * the failure policy at its call site. An unwired catalog binds to a no-op.
 */
export function createFoundationalDeclarationRecorder(deps: {
  agentKindRegistry: AgentKindRegistry
  foundationalServiceResolver?: FoundationalServiceResolver
  logger?: Logger
}): FoundationalDeclarationRecorder {
  const resolver = deps.foundationalServiceResolver
  if (!resolver) return async () => {}
  return async (workspaceId, step, output) => {
    if (!hasTrait(step.agentKind, FOUNDATIONAL_CATALOG_TRAIT, deps.agentKindRegistry)) return
    await runBestEffort(
      deps.logger ?? noopLogger,
      'foundationalServices.recordDeclaration',
      async () => {
        const known = await resolver.catalogIdsFor(workspaceId)
        step.foundationalServices = parseFoundationalDeclaration(output, known)
      },
      { workspaceId, agentKind: step.agentKind },
    )
  }
}
