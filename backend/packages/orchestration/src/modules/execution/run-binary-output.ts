import type { AgentKindRegistry } from '@cat-factory/agents'
import { BINARY_OUTPUT_TRAIT, hasTrait } from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/contracts'
import type { AgentKind, InjectedContextFile, Logger } from '@cat-factory/kernel'
import { noopLogger, parseBinaryOutputDeclaration, runBestEffort } from '@cat-factory/kernel'
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
      resolver.binaryOutputContextFilesFor(input.workspaceId, input.step.stepOptions?.binaryOutput),
    { workspaceId: input.workspaceId, agentKind: input.agentKind },
  )
  return files ?? []
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
  logger?: Logger
}): BinaryOutputDeclarationRecorder {
  return async (workspaceId, step, output) => {
    if (!hasTrait(step.agentKind, BINARY_OUTPUT_TRAIT, deps.agentKindRegistry)) return
    await runBestEffort(
      deps.logger ?? noopLogger,
      'binaryOutput.recordDeclaration',
      async () => {
        const known = deps.foundationalServiceResolver
          ? await deps.foundationalServiceResolver.catalogIdsFor(workspaceId)
          : []
        step.binaryOutputs = parseBinaryOutputDeclaration(output, known)
      },
      { workspaceId, agentKind: step.agentKind },
    )
  }
}
