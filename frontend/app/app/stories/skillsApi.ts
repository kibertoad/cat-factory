// The answers to the skill library's probe, for the surfaces that mount the library manager: the
// account's synced catalog and its linked sources. With `available: false` both reads answer the
// 503 a deployment without the library sends, which is how the manager learns the library is off;
// with `sourcesAvailable: false` only the sources read does, as it does when the deployment has no
// GitHub integration. The messages are the controller's (`SkillLibraryController`).
import { listAccountSkillsContract, listSkillSourcesContract } from '@cat-factory/contracts'
import type { AccountSkill, SkillSource } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiRefusal, apiResponse } from './api'
import { orgAccount } from './accounts.stories.mocks'

const LIBRARY_OFF = 'The Claude Skills library is not configured'
const SOURCES_OFF = 'Repo-sourced skills require the GitHub integration to be configured'

export function skillLibraryApi(
  seed: {
    skills?: AccountSkill[]
    sources?: SkillSource[]
    available?: boolean
    sourcesAvailable?: boolean
  } = {},
): HttpHandler[] {
  const pathPrefix = `/accounts/${orgAccount.id}`
  const unavailable = (contract: Parameters<typeof apiRefusal>[0], message: string) =>
    apiRefusal(contract, { pathPrefix, status: 503, error: { code: 'unavailable', message } })
  if (seed.available === false) {
    return [
      unavailable(listAccountSkillsContract, LIBRARY_OFF),
      unavailable(listSkillSourcesContract, LIBRARY_OFF),
    ]
  }
  return [
    apiResponse(listAccountSkillsContract, { pathPrefix, body: seed.skills ?? [] }),
    seed.sourcesAvailable === false
      ? unavailable(listSkillSourcesContract, SOURCES_OFF)
      : apiResponse(listSkillSourcesContract, { pathPrefix, body: seed.sources ?? [] }),
  ]
}
