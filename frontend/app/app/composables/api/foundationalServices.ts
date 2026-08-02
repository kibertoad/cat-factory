import {
  createFoundationalServiceContract,
  deleteFoundationalServiceContract,
  foundationalServiceSourceStatusContract,
  getFoundationalServiceContractsContract,
  linkFoundationalServiceSourceContract,
  listFoundationalServiceSourcesContract,
  listFoundationalServiceSuppressionsContract,
  listFoundationalServicesContract,
  resolvedFoundationalServicesContract,
  restoreFoundationalServiceContract,
  suppressFoundationalServiceContract,
  syncFoundationalServiceSourceContract,
  unlinkFoundationalServiceSourceContract,
  updateFoundationalServiceContract,
} from '@cat-factory/contracts'
import type {
  CreateFoundationalServiceInput,
  FoundationalServiceOwnerKind,
  LinkFoundationalServiceSourceInput,
  UpdateFoundationalServiceInput,
} from '~/types/domain'
import type { ApiContext } from './context'

/**
 * The foundational-services catalog (backend/docs/adr/0031-foundational-services.md) — the shared
 * capabilities an organisation already runs, which an Architect designs against instead of
 * proposing a rebuild.
 *
 * Tiered exactly like the prompt-fragment library (a deployment's code-registered `builtin`
 * services ⊕ `account` ⊕ `workspace`), so every route reuses the same `scope(kind, id)` prefix.
 * Only the merged catalog + the lazy document read are workspace-only, because a board is what
 * runs agents; the suppress/restore pair serves both scopes, since an account inherits the
 * deployment's registered tier exactly as a board inherits its account's.
 */
export function foundationalServicesApi({ send, ws, scope }: ApiContext) {
  return {
    // ---- one tier's registered services (raw — not merged) ----------------
    listFoundationalServices: (kind: FoundationalServiceOwnerKind, id: string) =>
      send(listFoundationalServicesContract, { pathPrefix: scope(kind, id) }),

    createFoundationalService: (
      kind: FoundationalServiceOwnerKind,
      id: string,
      body: CreateFoundationalServiceInput,
    ) => send(createFoundationalServiceContract, { pathPrefix: scope(kind, id), body }),

    updateFoundationalService: (
      kind: FoundationalServiceOwnerKind,
      id: string,
      serviceId: string,
      body: UpdateFoundationalServiceInput,
    ) =>
      send(updateFoundationalServiceContract, {
        pathPrefix: scope(kind, id),
        pathParams: { serviceId },
        body,
      }),

    deleteFoundationalService: (
      kind: FoundationalServiceOwnerKind,
      id: string,
      serviceId: string,
    ) =>
      send(deleteFoundationalServiceContract, {
        pathPrefix: scope(kind, id),
        pathParams: { serviceId },
      }),

    // ---- the merged catalog an agent actually sees (workspace only) -------
    getResolvedFoundationalServices: (workspaceId: string) =>
      send(resolvedFoundationalServicesContract, { pathPrefix: ws(workspaceId) }),

    /**
     * The LAZY contract read: one service's full documents, resolved through the same tier merge
     * a dispatch uses. Deliberately not folded into the catalog list — a document routinely runs
     * to hundreds of kilobytes, and this surface exists so a human can check what a consumer
     * would be handed, one service at a time.
     */
    getFoundationalServiceContracts: (workspaceId: string, serviceId: string) =>
      send(getFoundationalServiceContractsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { serviceId },
      }),

    // ---- opting a tier out of what it INHERITS ----------------------------
    // The LIST is what makes the pair usable: a suppressed id is by construction absent from the
    // merged catalog, so nothing else can tell the surface what to offer a restore for.
    listFoundationalServiceSuppressions: (kind: FoundationalServiceOwnerKind, id: string) =>
      send(listFoundationalServiceSuppressionsContract, { pathPrefix: scope(kind, id) }),

    suppressFoundationalService: (
      kind: FoundationalServiceOwnerKind,
      id: string,
      serviceId: string,
    ) =>
      send(suppressFoundationalServiceContract, {
        pathPrefix: scope(kind, id),
        pathParams: { serviceId },
      }),

    restoreFoundationalService: (
      kind: FoundationalServiceOwnerKind,
      id: string,
      serviceId: string,
    ) =>
      send(restoreFoundationalServiceContract, {
        pathPrefix: scope(kind, id),
        pathParams: { serviceId },
      }),

    // ---- repo sources of service definitions + contract files ------------
    listFoundationalSources: (kind: FoundationalServiceOwnerKind, id: string) =>
      send(listFoundationalServiceSourcesContract, { pathPrefix: scope(kind, id) }),

    linkFoundationalSource: (
      kind: FoundationalServiceOwnerKind,
      id: string,
      body: LinkFoundationalServiceSourceInput,
    ) => send(linkFoundationalServiceSourceContract, { pathPrefix: scope(kind, id), body }),

    unlinkFoundationalSource: (kind: FoundationalServiceOwnerKind, id: string, sourceId: string) =>
      send(unlinkFoundationalServiceSourceContract, {
        pathPrefix: scope(kind, id),
        pathParams: { id: sourceId },
      }),

    foundationalSourceStatus: (kind: FoundationalServiceOwnerKind, id: string, sourceId: string) =>
      send(foundationalServiceSourceStatusContract, {
        pathPrefix: scope(kind, id),
        pathParams: { id: sourceId },
      }),

    syncFoundationalSource: (kind: FoundationalServiceOwnerKind, id: string, sourceId: string) =>
      send(syncFoundationalServiceSourceContract, {
        pathPrefix: scope(kind, id),
        pathParams: { id: sourceId },
      }),
  }
}
