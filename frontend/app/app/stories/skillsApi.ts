// The answers to the skill library's probe, for the surfaces that mount the library manager: the
// account's synced catalog and its linked sources. With `available: false` the catalog read
// fails, which is how the manager learns the library is off; with `sourcesAvailable: false` only
// the sources read fails, as it does when the deployment has no GitHub integration.
import { listAccountSkillsContract, listSkillSourcesContract } from '@cat-factory/contracts'
import type { AccountSkill, SkillSource } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiFailure, apiResponse } from './api'
import { orgAccount } from './accounts.stories.mocks'

export function skillLibraryApi(
  seed: {
    skills?: AccountSkill[]
    sources?: SkillSource[]
    available?: boolean
    sourcesAvailable?: boolean
  } = {},
): HttpHandler[] {
  const pathPrefix = `/accounts/${orgAccount.id}`
  if (seed.available === false) return [apiFailure(listAccountSkillsContract, { pathPrefix })]
  return [
    apiResponse(listAccountSkillsContract, { pathPrefix, body: seed.skills ?? [] }),
    seed.sourcesAvailable === false
      ? apiFailure(listSkillSourcesContract, { pathPrefix })
      : apiResponse(listSkillSourcesContract, { pathPrefix, body: seed.sources ?? [] }),
  ]
}
