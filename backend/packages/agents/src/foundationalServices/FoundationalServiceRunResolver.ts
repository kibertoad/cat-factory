import type { FoundationalServiceSelection } from '@cat-factory/contracts'
import type { FoundationalCatalogView, InjectedContextFile } from '@cat-factory/kernel'
import {
  FOUNDATIONAL_INDEX_FILE,
  contextFileFor,
  renderContractDocument,
  renderFoundationalIndex,
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
        content: renderFoundationalIndex({ bundles, unknown, noDeclaration }),
      },
    ]
    for (const bundle of bundles) {
      files.push({ path: contextFileFor(bundle.id), content: renderContractDocument(bundle) })
    }
    return files
  }

  private async hasCatalog(workspaceId: string): Promise<boolean> {
    return (await this.catalog.resolve(workspaceId)).length > 0
  }
}
