import type {
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  ResolveRepoFilesForCoords,
  RunInitiatorScope,
  RunRepoContext,
  VcsProvider,
} from '@cat-factory/kernel'
import {
  NotFoundError,
  resolveInlineScope,
  resolveScopedModelProvider,
  UnavailableError,
} from '@cat-factory/kernel'
import { type InlineBlockModelDeps, resolveInlineBlockModelRef } from '../../inlineBlockModel.js'

// The reads shared by every inline caller that addresses a pull request by its coordinates
// (guided review, the public PR assessment): the linked repository, the VCS credential scope and
// the model a person or the workspace calls.

/** The linked repository for `owner/repo`, or the 503/404 naming why there is none. */
export async function resolveLinkedRepo(
  resolve: ResolveRepoFilesForCoords | undefined,
  workspaceId: string,
  coords: { owner: string; repo: string; provider?: VcsProvider },
): Promise<RunRepoContext> {
  if (!resolve) {
    throw new UnavailableError('No source control integration is configured', 'vcs_not_configured')
  }
  const context = await resolve(workspaceId, {
    owner: coords.owner,
    repo: coords.repo,
    ...(coords.provider ? { provider: coords.provider } : {}),
  })
  if (!context) {
    throw new NotFoundError('Repository', `${coords.owner}/${coords.repo}`, {
      reason: 'repo_not_linked',
    })
  }
  return context
}

/**
 * Run a VCS call under `userId`'s credential scope (the initiator-PAT policy applies), or
 * attributed to nobody when there is no person behind it.
 */
export function runAsInitiator<T>(
  scope: RunInitiatorScope | undefined,
  workspaceId: string,
  userId: string | null,
  fn: () => T,
): T {
  return scope ? scope({ workspaceId, initiatedBy: userId }, fn) : fn()
}

export interface InlinePrModelDeps extends InlineBlockModelDeps {
  modelProviderResolver?: ModelProviderResolver
  modelProvider?: ModelProvider
}

/** The model under `userId`'s scope, or the workspace's for nobody; null when none is wired. */
export async function resolveInlinePrModel(
  deps: InlinePrModelDeps,
  workspaceId: string,
  userId: string | null,
  agentKind: string,
): Promise<{ modelProvider: ModelProvider; ref: ModelRef } | null> {
  const scope = await resolveInlineScope(
    userId === null ? { kind: 'workspace', workspaceId } : { kind: 'user', workspaceId, userId },
  )
  const modelProvider = await resolveScopedModelProvider(scope, deps)
  const ref = await resolveInlineBlockModelRef(deps, workspaceId, agentKind, {})
  return modelProvider && ref ? { modelProvider, ref } : null
}
