import type {
  CreatePromptFragmentInput,
  FragmentOwnerKind,
  FragmentSource,
  FragmentSourceStatus,
  FragmentSyncResult,
  LinkFragmentSourceInput,
  PromptFragment,
  ResolvedFragment,
  UpdatePromptFragmentInput,
} from '~/types/domain'
import type { ApiContext } from './context'

/** Best-practice prompt-fragment catalog + the managed, tenant-scoped library. */
export function fragmentsApi({ http, ws, scope }: ApiContext) {
  return {
    // ---- prompt fragments (best-practice catalog) -------------------------
    getPromptFragments: () => http<PromptFragment[]>('/prompt-fragments'),

    // ---- prompt-fragment library (managed, tenant-scoped; ADR 0006) -------
    // The merged catalog an agent actually sees for a board (builtin∪account∪ws).
    getResolvedFragments: (workspaceId: string) =>
      http<ResolvedFragment[]>(`${ws(workspaceId)}/prompt-fragments/resolved`),

    // Per-tier management (scope = account or workspace).
    listFragments: (kind: FragmentOwnerKind, id: string) =>
      http<PromptFragment[]>(`${scope(kind, id)}/prompt-fragments`),

    createFragment: (kind: FragmentOwnerKind, id: string, body: CreatePromptFragmentInput) =>
      http<PromptFragment>(`${scope(kind, id)}/prompt-fragments`, { method: 'POST', body }),

    updateFragment: (
      kind: FragmentOwnerKind,
      id: string,
      fragmentId: string,
      body: UpdatePromptFragmentInput,
    ) =>
      http<PromptFragment>(
        `${scope(kind, id)}/prompt-fragments/${encodeURIComponent(fragmentId)}`,
        { method: 'PATCH', body },
      ),

    deleteFragment: (kind: FragmentOwnerKind, id: string, fragmentId: string) =>
      http(`${scope(kind, id)}/prompt-fragments/${encodeURIComponent(fragmentId)}`, {
        method: 'DELETE',
      }),

    // Repo sources of guideline Markdown.
    listFragmentSources: (kind: FragmentOwnerKind, id: string) =>
      http<FragmentSource[]>(`${scope(kind, id)}/fragment-sources`),

    linkFragmentSource: (kind: FragmentOwnerKind, id: string, body: LinkFragmentSourceInput) =>
      http<FragmentSource>(`${scope(kind, id)}/fragment-sources`, { method: 'POST', body }),

    unlinkFragmentSource: (kind: FragmentOwnerKind, id: string, sourceId: string) =>
      http(`${scope(kind, id)}/fragment-sources/${encodeURIComponent(sourceId)}`, {
        method: 'DELETE',
      }),

    fragmentSourceStatus: (kind: FragmentOwnerKind, id: string, sourceId: string) =>
      http<FragmentSourceStatus>(
        `${scope(kind, id)}/fragment-sources/${encodeURIComponent(sourceId)}/status`,
      ),

    syncFragmentSource: (kind: FragmentOwnerKind, id: string, sourceId: string) =>
      http<FragmentSyncResult>(
        `${scope(kind, id)}/fragment-sources/${encodeURIComponent(sourceId)}/sync`,
        { method: 'POST' },
      ),
  }
}
