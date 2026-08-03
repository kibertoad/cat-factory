import type { AgentKindRegistry } from '@cat-factory/agents'
import { BINARY_OUTPUT_TRAIT, hasTrait } from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/contracts'
import type {
  AgentKind,
  BinaryGeneratorSource,
  InjectedContextFile,
  Logger,
  ResolvedBinaryGenerator,
} from '@cat-factory/kernel'
import {
  dispatchBinaryGenerators,
  noopLogger,
  parseBinaryOutputDeclaration,
  resolveBinaryGeneratorSelection,
  runBestEffort,
} from '@cat-factory/kernel'
import type { FoundationalServiceResolver } from './run-foundational-services.js'

// ---------------------------------------------------------------------------
// The BINARY-OUTPUT slice of one dispatch's context
// (docs/initiatives/binary-output-foundational-storage.md).
//
// A sibling of `run-foundational-services.ts`, shaped identically on purpose: keyed off a
// TRAIT (never a kind id, so a deployment's image generator opts in by declaring one), reading
// the SAME catalog resolver (one tier merge, one cache), delivering injected `.cat-context/`
// files, and reading the agent's machine-readable declaration back onto the step when it
// settles. The difference is the join: a foundational-services consumer reads what a PRIOR
// design step declared, while a binary-output step reads its OWN step options — the human (or
// pipeline author) is the one who selected the storage and context services.
// ---------------------------------------------------------------------------

export interface ResolveBinaryOutputContextInput {
  workspaceId: string
  /** The EFFECTIVE dispatched kind (a gate helper dispatches its own kind, not the step's). */
  agentKind: AgentKind
  agentKindRegistry: AgentKindRegistry
  /** The step being dispatched — its `stepOptions.binaryOutput` is the selection. */
  step: PipelineStep
  foundationalServiceResolver?: FoundationalServiceResolver
  /** The deployment's generative integrations. Absent ⇒ none resolve, and the brief says so. */
  binaryGeneratorSource?: BinaryGeneratorSource
  logger?: Logger
}

/**
 * The `.cat-context/binary-output/` files this dispatch gets: the brief naming the selected
 * storage + context services plus their contract documents, for a kind carrying the
 * `binary-output` trait; nothing for anything else, and nothing on a deployment with no
 * catalog wired.
 *
 * BEST-EFFORT like the foundational reads: an unreachable catalog injects nothing, and the
 * trait guidance names the ABSENT brief as meaningful ("the platform could not provide
 * storage — do not attempt any upload; report it"), so the failure degrades into a stated
 * refusal rather than a guessed storage endpoint. The failure itself is logged with its cause.
 *
 * That disposition is what lets the GENERATIVE source be remote too. On a mothership-mode node
 * its read can throw, and the absent brief already means "the platform could not provide" —
 * which is true of an unreachable integration set exactly as it is of an unreachable catalog.
 * What must never happen is a brief that RESOLVES and reports the step's integrations as
 * unregistered, which is why the source throws instead of answering empty.
 */
export async function resolveBinaryOutputContext(
  input: ResolveBinaryOutputContextInput,
): Promise<InjectedContextFile[]> {
  const resolver = input.foundationalServiceResolver
  if (!resolver) return []
  if (!hasTrait(input.agentKind, BINARY_OUTPUT_TRAIT, input.agentKindRegistry)) return []
  const files = await runBestEffort(
    input.logger ?? noopLogger,
    'binaryOutput.context',
    () =>
      resolver.binaryOutputContextFilesFor(
        input.workspaceId,
        input.step.stepOptions?.binaryOutput,
        input.binaryGeneratorSource,
      ),
    { workspaceId: input.workspaceId, agentKind: input.agentKind },
  )
  return files ?? []
}

/**
 * The GENERATIVE INTEGRATIONS this dispatch carries on its `AgentRunContext` — the non-secret
 * projection (ids, content types, the credential's KEY NAME) the container executor needs to
 * resolve each declared credential onto the job body.
 *
 * Gated on the SAME condition as the brief — the effective kind carries the trait — because the
 * two are two halves of one hand-off: the brief tells the agent to read `$RD_TOKEN`, and this is
 * what puts a value there. A kind that gets one without the other is either an agent told to use
 * a credential nobody delivered, or a credential delivered to an agent with no idea it exists.
 *
 * BEST-EFFORT and independently of the brief, which is safe in BOTH directions precisely because
 * each half already defines its own absence. A brief with no credentials behind it is the state
 * the brief itself describes ("an unset variable means the platform could not provide the key —
 * report rather than call"); credentials with no brief reach an agent that was never told the
 * integrations exist and so never calls them. Sharing one read between the two would buy
 * consistency the failure modes do not need, at the price of a cache with no invalidation path.
 */
export async function dispatchBinaryGeneratorsFor(input: {
  agentKind: AgentKind
  agentKindRegistry: AgentKindRegistry
  step: PipelineStep
  binaryGeneratorSource?: BinaryGeneratorSource
  logger?: Logger
}): Promise<ResolvedBinaryGenerator[]> {
  const source = input.binaryGeneratorSource
  if (!source) return []
  if (!hasTrait(input.agentKind, BINARY_OUTPUT_TRAIT, input.agentKindRegistry)) return []
  const views = await runBestEffort(
    input.logger ?? noopLogger,
    'binaryOutput.generators',
    () => source.views(),
    { agentKind: input.agentKind },
  )
  if (!views) return []
  return dispatchBinaryGenerators(
    resolveBinaryGeneratorSelection(input.step.stepOptions?.binaryOutput, views),
  )
}

/**
 * Whether a SETTLED step may carry a binary-output declaration worth reading back — the
 * read-back's counterpart to {@link resolveBinaryOutputContext}'s trait check.
 *
 * The two cannot ask the same question, and getting that wrong loses records. Injection runs at
 * DISPATCH and keys off the EFFECTIVE kind, which it is handed; the read-back runs on the
 * durable completion path, which rebuilds everything from the STEP alone and so cannot know
 * that a gate helper or a PR-review override kind — not `step.agentKind` — is what actually
 * ran. Asking only `hasTrait(step.agentKind)` therefore drops the declaration of every
 * trait-carrying kind dispatched under an overriding kind, silently: the artifacts exist, the
 * step's record says nothing was stored, and nothing errors.
 *
 * So the condition is the UNION, and both halves are derivable from the step:
 * - its own kind carries the trait (the ordinary generator step), or
 * - it carries a `binaryOutput` SELECTION, which is the only thing a brief is ever built from —
 *   if one is present, some dispatch on this step was briefed and may have stored something.
 *
 * A step with neither was never handed a brief, so a block in its reply would be a coincidence,
 * not a declaration.
 */
export function stepMayDeclareBinaryOutputs(
  step: PipelineStep,
  agentKindRegistry: AgentKindRegistry,
): boolean {
  if (step.stepOptions?.binaryOutput !== undefined) return true
  return hasTrait(step.agentKind, BINARY_OUTPUT_TRAIT, agentKindRegistry)
}

/**
 * Read a settled binary-generating step's declaration out of the reply it just produced and
 * record it on the step (`step.binaryOutputs`). Called from the completion hub's job-facts
 * pass, BEFORE any early-returning path — a generator that parks on a decision must not lose
 * the record of what it already stored.
 *
 * Recorded even when the reply carried no block at all (`undeclared: true`) and even when the
 * catalog resolver is unwired — the ids are then checked against an EMPTY catalog, so every
 * claimed service lands in `unknownServices`, which is the honest answer on a deployment the
 * platform cannot resolve them for. BEST-EFFORT: the declaration is bookkeeping on a step that
 * already succeeded, so a failed catalog read leaves the step unannotated rather than failing
 * a completed generation.
 */
export type BinaryOutputDeclarationRecorder = (
  workspaceId: string,
  step: PipelineStep,
  /** The reply the job just returned. Read from the RESULT, not `step.output`, which the
   *  completion paths downstream of this hook have not assigned yet. */
  output: string | undefined,
) => Promise<void>

/** Bind a {@link BinaryOutputDeclarationRecorder} to the dispatcher's collaborators. */
export function createBinaryOutputDeclarationRecorder(deps: {
  agentKindRegistry: AgentKindRegistry
  foundationalServiceResolver?: FoundationalServiceResolver
  binaryGeneratorSource?: BinaryGeneratorSource
  logger?: Logger
}): BinaryOutputDeclarationRecorder {
  return async (workspaceId, step, output) => {
    if (!stepMayDeclareBinaryOutputs(step, deps.agentKindRegistry)) return
    await runBestEffort(
      deps.logger ?? noopLogger,
      'binaryOutput.recordDeclaration',
      async () => {
        const services = deps.foundationalServiceResolver
          ? await deps.foundationalServiceResolver.catalogIdsFor(workspaceId)
          : []
        // The generative ids resolve through the same source the dispatch did, so a run on a
        // mothership-mode node classifies its declaration against the set the mothership
        // registers rather than whatever this node's build happens to hold. An UNWIRED source
        // checks against an EMPTY set — the honest answer on a deployment that registers no
        // integrations, where every claimed id lands in `unknownGenerators` rather than being
        // quietly accepted. An unreachable one is different and must not read as that: the
        // throw propagates into the best-effort wrapper below, which leaves the step
        // unannotated, because "we could not check" may not be filed as "the agent invented it".
        const generators = deps.binaryGeneratorSource
          ? (await deps.binaryGeneratorSource.views()).map((view) => view.id)
          : []
        step.binaryOutputs = parseBinaryOutputDeclaration(output, { services, generators })
      },
      { workspaceId, agentKind: step.agentKind },
    )
  }
}
