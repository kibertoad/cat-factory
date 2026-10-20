// The answers to the prompt-fragment library's probe, for the surfaces that mount the library
// manager (the board's window and the account's tab): the tier's own fragments, its linked
// repositories and, for a board, the merged catalog. With `available: false` the first read
// fails, which is how the manager learns the library is off; the reads beside it are answered
// too.
import {
  listFragmentSourcesContract,
  listPromptFragmentsContract,
  resolvedFragmentsContract,
} from '@cat-factory/contracts'
import type { FragmentSource, PromptFragment, ResolvedFragment } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiFailure, apiResponse } from './api'
import { storyWorkspacePrefix } from './workspace'

export function fragmentLibraryApi(
  owner: { accountId: string } | 'workspace',
  seed: {
    fragments?: PromptFragment[]
    sources?: FragmentSource[]
    resolved?: ResolvedFragment[]
    available?: boolean
  } = {},
): HttpHandler[] {
  const pathPrefix = owner === 'workspace' ? storyWorkspacePrefix : `/accounts/${owner.accountId}`
  return [
    seed.available === false
      ? apiFailure(listPromptFragmentsContract, { pathPrefix })
      : apiResponse(listPromptFragmentsContract, { pathPrefix, body: seed.fragments ?? [] }),
    apiResponse(listFragmentSourcesContract, { pathPrefix, body: seed.sources ?? [] }),
    ...(owner === 'workspace'
      ? [apiResponse(resolvedFragmentsContract, { pathPrefix, body: seed.resolved ?? [] })]
      : []),
  ]
}
