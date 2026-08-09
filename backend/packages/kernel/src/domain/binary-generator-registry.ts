import type {
  ApiContractDocument,
  ApiContractSummary,
  BinaryGeneratorCapability,
  BinaryGeneratorCredential,
  BinaryGeneratorDefinition,
  BinaryModality,
} from '@cat-factory/contracts'
import { summarizeContract } from './foundational-services.js'

/**
 * The wire definition verbatim, re-exported so a deployment registering an integration imports
 * one name from the layer it is already wiring against (the same courtesy
 * `FoundationalServiceDefinition` does for the estate registry).
 */
export type { BinaryGeneratorDefinition }

// App-owned registry of the GENERATIVE BINARY INTEGRATIONS a deployment ships in code — the
// image / music / video generation APIs a binary-generating agent kind calls to produce its
// deliverable. It mirrors the agent-kind / gate / pipeline / foundational-service registries:
// the composition root news one instance (`defaultBinaryGeneratorRegistry()`), a deployment
// registers its integrations on it by reference, and the engine reads it back per dispatch.
//
// Why its OWN registry rather than a capability tag on the foundational catalog: a foundational
// service is a shared capability a DESIGN is expected to consume, and the Architect is shown the
// whole catalog for exactly that purpose. A metered vendor API that makes pictures is not
// something to design against — it is an instrument a specific step is pointed at. Keeping them
// apart also keeps their lifecycles apart: the catalog is tiered, tenant-editable state with
// rows behind it, while a generation integration is deployment code with a credential attached.
//
// Engine-level, not persistence: nothing here is stored, so both runtime facades (and mothership
// mode, which has no database for it to be absent from) get identical behaviour by building the
// same registry. Definitions are validated at BOOT (`validateRegistrations`), which is what makes
// code registration worth having — a malformed contract or an unusable credential name fails the
// deployment rather than a dispatch months later.

/**
 * A registered integration as the ENGINE reads it: identity, what it produces, how to reach it,
 * and its contracts SUMMARISED (operation names, sizes) — never the document bodies, which the
 * brief renderer fetches separately for exactly the ids a step selected.
 *
 * The credential appears here as its DECLARATION only (a key name and how to present it). The
 * value is resolved per dispatch, on the container executor's side of the seam, and travels on
 * the job body alone.
 */
export interface BinaryGeneratorView {
  id: string
  name: string
  summary: string
  description: string
  modalities: BinaryModality[]
  mediaTypes: string[]
  /**
   * What it can be ASKED FOR while generating. EMPTY means the definition declared none, which
   * the coverage rule reads as "only the coarse facts are known" rather than as a denial: the
   * same reading an empty {@link mediaTypes} gets, and the reason both are projected as arrays
   * here while the wire form omits them.
   */
  capabilities: BinaryGeneratorCapability[]
  endpoint?: string
  guidance?: string
  credential?: BinaryGeneratorCredential
  contracts: ApiContractSummary[]
}

/**
 * App-owned registry of the deployment's generative binary integrations. The composition root
 * news ONE instance and a deployment registers its integrations on it by reference; the engine
 * resolves a step's selection against it at admission and at every dispatch.
 */
export class BinaryGeneratorRegistry {
  private readonly definitions = new Map<string, BinaryGeneratorDefinition>()
  /**
   * Memoised projection, for the same reason the foundational registry memoises its own:
   * building it parses every registered contract document, and a step's brief is resolved per
   * dispatch (on the Worker, per isolate). Views and documents are built TOGETHER from one
   * summary per contract, so an agent can never be handed a document whose operation list
   * disagrees with the one its step was validated against.
   */
  private projection: {
    views: BinaryGeneratorView[]
    documents: Map<string, ApiContractDocument[]>
  } | null = null

  /** Register an integration. A registration whose id matches an earlier one replaces it. */
  register(definition: BinaryGeneratorDefinition): void {
    this.definitions.set(definition.id, definition)
    this.projection = null
  }

  /** Register several integrations at once. */
  registerAll(definitions: Iterable<BinaryGeneratorDefinition>): void {
    for (const definition of definitions) this.register(definition)
  }

  /** The registered definitions, contract bodies included (registration order). */
  all(): BinaryGeneratorDefinition[] {
    return [...this.definitions.values()]
  }

  /** Every registered id — what a step's selection and a settled step's declaration resolve against. */
  ids(): string[] {
    return [...this.definitions.keys()]
  }

  /** The engine-facing projection of every registered integration (no document bodies). */
  views(): BinaryGeneratorView[] {
    return this.build().views
  }

  /** The full contract documents of one registered integration, for its injected context file. */
  documentsFor(id: string): ApiContractDocument[] {
    return this.build().documents.get(id) ?? []
  }

  private build(): {
    views: BinaryGeneratorView[]
    documents: Map<string, ApiContractDocument[]>
  } {
    if (this.projection) return this.projection
    const views: BinaryGeneratorView[] = []
    const documents = new Map<string, ApiContractDocument[]>()
    for (const definition of this.definitions.values()) {
      const summarized = (definition.contracts ?? []).map((contract) => ({
        summary: summarizeContract({
          contractId: contract.contractId,
          format: contract.format,
          title: contract.title,
          // A registered definition has no repo provenance: its source of truth is the
          // deployment's own code, which no path of ours can name.
          path: null,
          body: contract.body,
        }),
        body: contract.body,
      }))
      views.push({
        id: definition.id,
        name: definition.name,
        summary: definition.summary,
        description: definition.description,
        modalities: [...definition.modalities],
        mediaTypes: [...(definition.mediaTypes ?? [])],
        capabilities: [...(definition.capabilities ?? [])],
        ...(definition.endpoint ? { endpoint: definition.endpoint } : {}),
        ...(definition.guidance ? { guidance: definition.guidance } : {}),
        ...(definition.credential ? { credential: definition.credential } : {}),
        contracts: summarized.map((c) => c.summary),
      })
      documents.set(
        definition.id,
        summarized.map((c) => ({ ...c.summary, body: c.body })),
      )
    }
    this.projection = { views, documents }
    return this.projection
  }
}

/**
 * A fresh, EMPTY generator registry. Each facade news one and a deployment registers its
 * integrations on it; the platform ships none (there is no image generator every organisation
 * runs, and every one of them is metered), so the default selection set stays empty and a step
 * that selects an id on such a deployment is refused at admission rather than dispatching an
 * agent that cannot generate.
 */
export function defaultBinaryGeneratorRegistry(): BinaryGeneratorRegistry {
  return new BinaryGeneratorRegistry()
}
