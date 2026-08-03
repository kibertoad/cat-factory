import type { BinaryOutputConfig, FoundationalServiceSelection } from '@cat-factory/contracts'
import type {
  BinaryGeneratorRegistry,
  FoundationalCatalogView,
  InjectedContextFile,
  ResolvedBinaryGeneratorSelection,
} from '@cat-factory/kernel'
import {
  BINARY_OUTPUT_BRIEF_FILE,
  FOUNDATIONAL_INDEX_FILE,
  binaryContextFileFor,
  binaryGeneratorContextFileFor,
  contextFileFor,
  renderBinaryOutputBrief,
  renderContractDocument,
  renderFoundationalIndex,
  resolveBinaryGeneratorSelection,
} from '@cat-factory/kernel'
import type { FoundationalServiceCatalogService } from './FoundationalServiceCatalogService.js'

/**
 * The engine-facing seam over the foundational-services catalog
 * (backend/docs/adr/0031-foundational-services.md). Two reads, deliberately separate, because they
 * serve the two halves of the feature:
 *
 * - {@link catalogFor} is the DESIGN-time read: identity, capabilities and operation names for
 *   every registered service, no document bodies. Folded into the Architect's prompt.
 * - {@link contextFilesFor} is the CONSUMER-time read: the full contract documents, for exactly
 *   the ids the design declared, materialised as `.cat-context/foundational-services/*` files.
 *
 * Implemented against the catalog SERVICE rather than the repositories so both reads go through
 * the same tier merge and the same cache — a consumer can never be handed the account's
 * document for a service the design chose at the workspace tier.
 */
export class FoundationalServiceRunResolver {
  constructor(private readonly catalog: FoundationalServiceCatalogService) {}

  /** The catalog the design step is shown. Empty array when nothing is registered. */
  async catalogFor(workspaceId: string): Promise<FoundationalCatalogView[]> {
    const resolved = await this.catalog.resolve(workspaceId)
    return resolved.map((service) => ({
      id: service.id,
      name: service.name,
      summary: service.summary,
      description: service.description,
      capabilities: service.capabilities,
      contracts: service.contracts,
    }))
  }

  /** Just the ids in the merged catalog — the check a settled design's declaration runs against. */
  async catalogIdsFor(workspaceId: string): Promise<string[]> {
    return (await this.catalog.resolve(workspaceId)).map((service) => service.id)
  }

  /**
   * The injected context files a consumer kind receives for a design's declared services: one
   * markdown file per service carrying its contract documents, plus an index.
   *
   * The INDEX is always produced, even when nothing was declared and nothing resolved. That is
   * the "degrade loudly" half: a coder handed no foundational context cannot otherwise tell
   * "the design decided none apply" from "the design step never ran" from "the design named a
   * service this deployment does not have", and those need three different reactions.
   *
   * A FOURTH state — the catalog could not be read at all, which a mothership-mode node's
   * remote `builtin` tier can produce — is not one this method can report, because the read
   * that failed is the one it would have reported through. It is rendered by
   * `resolveFoundationalContext`, the seam that owns the failure policy and is where the throw
   * becomes visible; the invariant holds for the injection path as a whole.
   */
  async contextFilesFor(
    workspaceId: string,
    selection: FoundationalServiceSelection | undefined,
  ): Promise<InjectedContextFile[]> {
    const declared = selection?.declared ?? []
    const unknown = selection?.unknown ?? []
    const noDeclaration = selection === undefined
    // Nothing to say and nothing to warn about: a run in a deployment that registers no
    // foundational services at all would otherwise pay for an index file on every dispatch
    // saying so. A declaration that resolved to nothing is DIFFERENT and does get the file.
    if (noDeclaration && unknown.length === 0 && !(await this.hasCatalog(workspaceId))) return []

    const documents = await this.catalog.contractsFor(workspaceId, declared)
    const resolved = await this.catalog.resolve(workspaceId)
    const byId = new Map(resolved.map((service) => [service.id, service]))
    const bundles = declared
      .map((id) => {
        const service = byId.get(id)
        if (!service) return null
        return {
          id: service.id,
          name: service.name,
          summary: service.summary,
          description: service.description,
          contracts: (documents.get(id) ?? []).map((doc) => ({
            contractId: doc.contractId,
            format: doc.format,
            title: doc.title,
            body: doc.body,
          })),
        }
      })
      .filter((bundle): bundle is NonNullable<typeof bundle> => bundle !== null)

    const files: InjectedContextFile[] = [
      {
        path: FOUNDATIONAL_INDEX_FILE,
        content: renderFoundationalIndex({ status: 'resolved', bundles, unknown, noDeclaration }),
      },
    ]
    for (const bundle of bundles) {
      files.push({ path: contextFileFor(bundle.id), content: renderContractDocument(bundle) })
    }
    return files
  }

  /**
   * The injected context files a BINARY-GENERATING kind receives for its step's selection
   * (`stepOptions.binaryOutput`): the brief naming the storage + context services, plus one
   * contract file per RESOLVED service under `binary-output/`.
   *
   * The brief is ALWAYS produced, even for a missing selection or ids the catalog no longer
   * resolves — that is the "degrade loudly" half: a generator handed nothing would guess at a
   * storage endpoint, and an asset stored against a guessed API lands where nobody can find it.
   * Run admission refuses the bad selections it can see up front; this read is what a run that
   * outlives a catalog edit still gets, so it re-states rather than assumes.
   */
  async binaryOutputContextFilesFor(
    workspaceId: string,
    config: BinaryOutputConfig | undefined,
    generatorRegistry?: BinaryGeneratorRegistry,
  ): Promise<InjectedContextFile[]> {
    if (!config) {
      return [
        {
          path: BINARY_OUTPUT_BRIEF_FILE,
          content: renderBinaryOutputBrief({
            config,
            storage: null,
            contextServices: [],
            unresolvedContextIds: [],
          }),
        },
      ]
    }
    // The GENERATIVE half comes from the deployment's code registry rather than the workspace
    // catalog, so it is resolved here in the same pass: one brief has to describe both, and a
    // step whose integrations resolved but whose storage did not (or the reverse) is exactly the
    // partial state the file must state rather than omit.
    const generators = resolveBinaryGeneratorSelection(config, generatorRegistry?.views() ?? [])
    const catalog = await this.catalogFor(workspaceId)
    const byId = new Map(catalog.map((service) => [service.id, service]))
    const storage = byId.get(config.storageServiceId) ?? null
    const contextIds = config.contextServiceIds ?? []
    const contextServices = contextIds
      .map((id) => byId.get(id))
      .filter((service): service is FoundationalCatalogView => service !== undefined)
    const unresolvedContextIds = contextIds.filter((id) => !byId.has(id))

    const involved = [...(storage ? [storage] : []), ...contextServices]
    const documents = await this.catalog.contractsFor(
      workspaceId,
      involved.map((service) => service.id),
    )
    const files: InjectedContextFile[] = [
      {
        path: BINARY_OUTPUT_BRIEF_FILE,
        content: renderBinaryOutputBrief({
          config,
          storage,
          contextServices,
          unresolvedContextIds,
          generators,
        }),
      },
      ...generatorContractFiles(generators, generatorRegistry),
    ]
    for (const service of involved) {
      const contracts = (documents.get(service.id) ?? []).map((doc) => ({
        contractId: doc.contractId,
        format: doc.format,
        title: doc.title,
        body: doc.body,
      }))
      // A service with no registered contract gets no file — the brief already states that
      // apart, and an empty document would read as an API with no operations.
      if (contracts.length === 0) continue
      files.push({
        path: binaryContextFileFor(service.id),
        content: renderContractDocument({
          id: service.id,
          name: service.name,
          summary: service.summary,
          description: service.description,
          contracts,
        }),
      })
    }
    return files
  }

  private async hasCatalog(workspaceId: string): Promise<boolean> {
    return (await this.catalog.resolve(workspaceId)).length > 0
  }
}

/**
 * One `.cat-context/binary-output/generators/<id>.md` per SELECTED integration that registers a
 * contract, rendered through the same `renderContractDocument` the catalog services use — an
 * agent reads one kind of contract file whatever registry it came from.
 *
 * An integration with no registered contract gets no file: the brief already states that case
 * (endpoint + notes are the whole interface), and an empty document would read as an API that
 * declares no operations.
 */
function generatorContractFiles(
  generators: ResolvedBinaryGeneratorSelection,
  registry: BinaryGeneratorRegistry | undefined,
): InjectedContextFile[] {
  if (!registry) return []
  const files: InjectedContextFile[] = []
  for (const generator of generators.selected) {
    const contracts = registry.documentsFor(generator.id).map((doc) => ({
      contractId: doc.contractId,
      format: doc.format,
      title: doc.title,
      body: doc.body,
    }))
    if (contracts.length === 0) continue
    files.push({
      path: binaryGeneratorContextFileFor(generator.id),
      content: renderContractDocument({
        id: generator.id,
        name: generator.name,
        summary: generator.summary,
        description: generator.description,
        contracts,
      }),
    })
  }
  return files
}
