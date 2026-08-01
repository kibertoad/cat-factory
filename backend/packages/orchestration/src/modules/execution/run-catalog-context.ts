import type { AgentKindRegistry } from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/contracts'
import type { ExecutionInstance, InjectedContextFile, Logger } from '@cat-factory/kernel'
import {
  type FoundationalServiceResolver,
  createFoundationalDeclarationRecorder,
  resolveFoundationalContext,
} from './run-foundational-services.js'
import {
  createBinaryOutputDeclarationRecorder,
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

export interface CatalogRunContextDeps {
  agentKindRegistry: AgentKindRegistry
  foundationalServiceResolver?: FoundationalServiceResolver
  logger?: Logger
}

export class CatalogRunContext {
  constructor(private readonly deps: CatalogRunContextDeps) {}

  /**
   * The FOUNDATIONAL SERVICES slice of a dispatch's `.cat-context/` — the catalog for a design
   * kind, the declared services' contracts for a consumer kind, nothing for anything else. Reads
   * only the steps BEFORE the one being dispatched, so a re-dispatched design cannot read its
   * own prior round.
   */
  foundationalContextFor(
    workspaceId: string,
    agentKind: string,
    instance: ExecutionInstance,
  ): Promise<InjectedContextFile[]> {
    return resolveFoundationalContext({
      ...this.deps,
      workspaceId,
      agentKind,
      priorSteps: instance.steps.slice(0, instance.currentStep),
    })
  }

  /**
   * The BINARY-OUTPUT slice of a dispatch's `.cat-context/` — the storage/context brief +
   * contract files for a kind carrying the `binary-output` trait, resolved off the step's own
   * `stepOptions.binaryOutput` selection. Sibling of {@link foundationalContextFor}, off the
   * same resolver and failure policy.
   */
  binaryOutputContextFor(
    workspaceId: string,
    agentKind: string,
    step: PipelineStep,
  ): Promise<InjectedContextFile[]> {
    return resolveBinaryOutputContext({ ...this.deps, workspaceId, agentKind, step })
  }

  /**
   * Read back what a settled DESIGN step declared, and record it on the step — the counterpart
   * of {@link foundationalContextFor}, so the completion hub takes no dependency of its own for
   * it.
   */
  recordFoundationalDeclaration(
    workspaceId: string,
    step: PipelineStep,
    output: string | undefined,
  ): Promise<void> {
    return createFoundationalDeclarationRecorder(this.deps)(workspaceId, step, output)
  }

  /**
   * Read back what a settled BINARY-GENERATING step declared it stored, and record it on the
   * step — the counterpart of {@link binaryOutputContextFor}.
   */
  recordBinaryOutputDeclaration(
    workspaceId: string,
    step: PipelineStep,
    output: string | undefined,
  ): Promise<void> {
    return createBinaryOutputDeclarationRecorder(this.deps)(workspaceId, step, output)
  }
}
