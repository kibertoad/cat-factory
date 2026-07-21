import {
  createDocumentFragmentContract,
  createPromptFragmentContract,
  deletePromptFragmentContract,
  fragmentSourceStatusContract,
  generatePromptFragmentTitleContract,
  linkFragmentSourceContract,
  listFragmentCatalogContract,
  listFragmentSourcesContract,
  listPromptFragmentsContract,
  refreshPromptFragmentContract,
  resolvedFragmentsContract,
  syncFragmentSourceContract,
  unlinkFragmentSourceContract,
  updatePromptFragmentContract,
} from '@cat-factory/contracts'
import type {
  CreateDocumentFragmentInput,
  CreatePromptFragmentInput,
  FragmentOwnerKind,
  GenerateFragmentTitleInput,
  LinkFragmentSourceInput,
  UpdatePromptFragmentInput,
} from '~/types/domain'
import type { ApiContext } from './context'

/** Best-practice prompt-fragment catalog + the managed, tenant-scoped library. */
export function fragmentsApi({ send, ws, scope }: ApiContext) {
  return {
    // ---- prompt fragments (best-practice catalog) -------------------------
    getPromptFragments: () => send(listFragmentCatalogContract, {}),

    // ---- prompt-fragment library (managed, tenant-scoped; ADR 0006) -------
    // The merged catalog an agent actually sees for a board (builtin∪account∪ws).
    getResolvedFragments: (workspaceId: string) =>
      send(resolvedFragmentsContract, { pathPrefix: ws(workspaceId) }),

    // Per-tier management (scope = account or workspace).
    listFragments: (kind: FragmentOwnerKind, id: string) =>
      send(listPromptFragmentsContract, { pathPrefix: scope(kind, id) }),

    createFragment: (kind: FragmentOwnerKind, id: string, body: CreatePromptFragmentInput) =>
      send(createPromptFragmentContract, { pathPrefix: scope(kind, id), body }),

    updateFragment: (
      kind: FragmentOwnerKind,
      id: string,
      fragmentId: string,
      body: UpdatePromptFragmentInput,
    ) =>
      send(updatePromptFragmentContract, {
        pathPrefix: scope(kind, id),
        pathParams: { fragmentId },
        body,
      }),

    deleteFragment: (kind: FragmentOwnerKind, id: string, fragmentId: string) =>
      send(deletePromptFragmentContract, {
        pathPrefix: scope(kind, id),
        pathParams: { fragmentId },
      }),

    // Auto-generate a title for a hand-authored fragment from its content (an inline LLM call).
    // At the account scope the backend resolves the model against `viaWorkspaceId`'s scope;
    // ignored at the workspace scope (which uses the addressed workspace).
    generateFragmentTitle: (
      kind: FragmentOwnerKind,
      id: string,
      body: GenerateFragmentTitleInput,
      viaWorkspaceId?: string,
    ) =>
      send(generatePromptFragmentTitleContract, {
        pathPrefix: scope(kind, id),
        queryParams: { viaWorkspaceId },
        body,
      }),

    // Link an external document (Confluence/Notion/GitHub) as a living fragment.
    createDocumentFragment: (
      kind: FragmentOwnerKind,
      id: string,
      body: CreateDocumentFragmentInput,
    ) => send(createDocumentFragmentContract, { pathPrefix: scope(kind, id), body }),

    // Force an immediate live re-resolve of a document-backed fragment. At the
    // account scope the backend needs a `viaWorkspaceId` (the workspace whose
    // document-source connection to fetch through); it is ignored at workspace scope.
    refreshFragment: (
      kind: FragmentOwnerKind,
      id: string,
      fragmentId: string,
      viaWorkspaceId?: string,
    ) =>
      send(refreshPromptFragmentContract, {
        pathPrefix: scope(kind, id),
        pathParams: { fragmentId },
        queryParams: { viaWorkspaceId },
      }),

    // Repo sources of guideline Markdown.
    listFragmentSources: (kind: FragmentOwnerKind, id: string) =>
      send(listFragmentSourcesContract, { pathPrefix: scope(kind, id) }),

    linkFragmentSource: (kind: FragmentOwnerKind, id: string, body: LinkFragmentSourceInput) =>
      send(linkFragmentSourceContract, { pathPrefix: scope(kind, id), body }),

    unlinkFragmentSource: (kind: FragmentOwnerKind, id: string, sourceId: string) =>
      send(unlinkFragmentSourceContract, {
        pathPrefix: scope(kind, id),
        pathParams: { id: sourceId },
      }),

    fragmentSourceStatus: (kind: FragmentOwnerKind, id: string, sourceId: string) =>
      send(fragmentSourceStatusContract, {
        pathPrefix: scope(kind, id),
        pathParams: { id: sourceId },
      }),

    syncFragmentSource: (kind: FragmentOwnerKind, id: string, sourceId: string) =>
      send(syncFragmentSourceContract, {
        pathPrefix: scope(kind, id),
        pathParams: { id: sourceId },
      }),
  }
}
