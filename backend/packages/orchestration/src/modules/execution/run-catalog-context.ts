import type { AgentKindRegistry } from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/contracts'
import type {
  BinaryGeneratorSource,
  ExecutionInstance,
  InjectedContextFile,
  Logger,
  ResolvedBinaryGenerator,
  ResolvedServiceCredentials,
} from '@cat-factory/kernel'
import { memoizeBinaryGeneratorViews } from '@cat-factory/kernel'
import {
  type FoundationalDeclarationRecorder,
  type FoundationalServiceResolver,
  createFoundationalDeclarationRecorder,
  resolveFoundationalContext,
} from './run-foundational-services.js'
import { dispatchFoundationalCredentialsFor } from './run-foundational-credentials.js'
import {
  type BinaryOutputDeclarationRecorder,
  createBinaryOutputDeclarationRecorder,
  dispatchBinaryGeneratorsFor,
  dispatchBinaryStorageFor,
  resolveBinaryOutputContext,
} from './run-binary-output.js'

// ---------------------------------------------------------------------------
// The CATALOG-backed slices of one dispatch's context, extracted from `AgentContextBuilder` as a
// cohesive collaborator (the file-size ratchet's split trigger): the FOUNDATIONAL SERVICES pair
// (catalog for a design kind / declared contracts for a consumer kind) and the BINARY-OUTPUT
// brief + contracts for a generating kind, plus the two declaration read-backs recorded when
// such a step settles. All four ride the SAME resolver, registry and logger, and the
// optional-spread deps shape is easy to get subtly wrong four times — which is exactly why they
// live behind one object.
// ---------------------------------------------------------------------------

/**
 * Everything one dispatch takes from the CATALOG side, as {@link CatalogRunContext.sliceFor}
 * returns it: the two injected-file groups the agent reads, and the structured integration
 * projection the container executor turns into credentials on the job body.
 */
export interface CatalogRunSlice {
  foundationalContextFiles: InjectedContextFile[]
  binaryOutputContextFiles: InjectedContextFile[]
  binaryGenerators: ResolvedBinaryGenerator[]
  /**
   * The credential DECLARATIONS of every catalog service this dispatch was briefed on: the key
   * names the container executor resolves values for onto the job body. Empty when nothing this
   * dispatch reads or writes through needs authenticating, which is the ordinary case.
   */
  foundationalCredentials: ResolvedServiceCredentials[]
  /**
   * The catalog service this dispatch stores through, when it was briefed to store anything.
   * Pure (no I/O) and derived from the same trait gate as the two reads above, so it rides the
   * slice rather than becoming a fourth thing the builder has to remember to ask for.
   */
  binaryStorageServiceId?: string
}

export interface CatalogRunContextDeps {
  agentKindRegistry: AgentKindRegistry
  foundationalServiceResolver?: FoundationalServiceResolver
  /**
   * The deployment's generative binary integrations. It rides HERE, beside the catalog resolver,
   * because the binary-output brief describes both halves of one selection and the declaration
   * read-back resolves ids against both — keeping them apart would be two places for a dispatch
   * and its settlement to disagree about which integrations existed.
   */
  binaryGeneratorSource?: BinaryGeneratorSource
  logger?: Logger
}

export class CatalogRunContext {
  /**
   * The two read-back closures, bound ONCE. Each `create*Recorder` resolves the failure policy
   * and (for the foundational one) short-circuits to a no-op when no resolver is wired, so
   * rebuilding them per settlement re-did that work and made the no-op binding pointless.
   */
  private readonly recordFoundational: FoundationalDeclarationRecorder
  private readonly recordBinaryOutput: BinaryOutputDeclarationRecorder

  constructor(private readonly deps: CatalogRunContextDeps) {
    this.recordFoundational = createFoundationalDeclarationRecorder(deps)
    this.recordBinaryOutput = createBinaryOutputDeclarationRecorder(deps)
  }

  /**
   * ALL FOUR catalog-backed reads of one dispatch, resolved concurrently — the ONE entry the
   * context read wave takes, so the builder holds a single wave slot rather than four:
   *
   * - the FOUNDATIONAL SERVICES files (the catalog for a design kind, the declared services' API
   *   contracts for a consumer kind, nothing for anything else), read only from the steps BEFORE
   *   the one being dispatched so a re-dispatched design cannot read its own prior round;
   * - the BINARY-OUTPUT brief for a kind carrying the trait, off the step's own selection;
   * - the GENERATIVE INTEGRATIONS that selection names — the non-secret projection the container
   *   executor turns into credentials on the job body;
   * - the CREDENTIAL declarations of every catalog service this dispatch was briefed on, which is
   *   the same projection one layer over: what authenticates the storage and context services,
   *   where the integrations' half authenticates what MAKES the artifact.
   *
   * They belong together rather than merely being adjacent: all four go through this
   * collaborator, all four are BEST-EFFORT inside (each gap has a stated rendering — an
   * `unavailable` catalog file, an absent brief the trait guidance already defines as "do not
   * attempt any upload", no integrations to hand credentials for, an unset variable the briefs
   * define as "the platform could not provide it"), and on a mothership-mode node all four can
   * cross the machine API. That last point is why the generative half belongs in the wave at all
   * rather than after it, where it would serialise a round trip behind the others for nothing.
   *
   * Exposed as the WHOLE slice rather than four per-read methods, because the sharing below is
   * only correct within one dispatch: a caller that could take the halves separately could take
   * them at different times, which is the drift this collaborator exists to prevent.
   *
   * The two halves of the binary-output selection share ONE `views()` read
   * ({@link memoizeBinaryGeneratorViews}), scoped to this call and discarded with it. The brief
   * that tells an agent which integrations it has and the projection that puts a credential
   * behind each are answers about the same set, so reading it twice bought a second round trip
   * and a window in which they could disagree. Sharing costs no coherence: on a failure both
   * degrade, which is the pair's coherent state (an agent told nothing, handed nothing), and
   * each still applies its own disposition rather than one failing the other.
   */
  async sliceFor(
    workspaceId: string,
    agentKind: string,
    step: PipelineStep,
    instance: ExecutionInstance,
  ): Promise<CatalogRunSlice> {
    const deps = this.deps.binaryGeneratorSource
      ? {
          ...this.deps,
          binaryGeneratorSource: memoizeBinaryGeneratorViews(this.deps.binaryGeneratorSource),
        }
      : this.deps
    const priorSteps = instance.steps.slice(0, instance.currentStep)
    const [
      foundationalContextFiles,
      binaryOutputContextFiles,
      binaryGenerators,
      foundationalCredentials,
    ] = await Promise.all([
      resolveFoundationalContext({ ...deps, workspaceId, agentKind, priorSteps }),
      resolveBinaryOutputContext({ ...deps, workspaceId, agentKind, step }),
      dispatchBinaryGeneratorsFor({ ...deps, agentKind, step }),
      dispatchFoundationalCredentialsFor({ ...deps, workspaceId, agentKind, step, priorSteps }),
    ])
    const binaryStorageServiceId = dispatchBinaryStorageFor({ ...deps, agentKind, step })
    return {
      foundationalContextFiles,
      binaryOutputContextFiles,
      binaryGenerators,
      foundationalCredentials,
      ...(binaryStorageServiceId ? { binaryStorageServiceId } : {}),
    }
  }

  /**
   * Read back what a settled DESIGN step declared, and record it on the step — the counterpart
   * of the catalog half of {@link sliceFor}, so the completion hub takes no dependency of its own for
   * it.
   */
  recordFoundationalDeclaration(
    workspaceId: string,
    step: PipelineStep,
    output: string | undefined,
  ): Promise<void> {
    return this.recordFoundational(workspaceId, step, output)
  }

  /**
   * Read back what a settled BINARY-GENERATING step declared it stored, and record it on the
   * step — the counterpart of the binary-output half of {@link sliceFor}.
   */
  recordBinaryOutputDeclaration(
    workspaceId: string,
    step: PipelineStep,
    output: string | undefined,
  ): Promise<void> {
    return this.recordBinaryOutput(workspaceId, step, output)
  }
}
