import {
  linkSkillSourceContract,
  listAccountSkillsContract,
  listSkillSourcesContract,
  skillSourceStatusContract,
  syncSkillSourceContract,
  unlinkSkillSourceContract,
} from '@cat-factory/contracts'
import type { LinkSkillSourceInput } from '~/types/domain'
import type { ApiContext } from './context'

/**
 * The repo-sourced Claude Skills library (docs/initiatives/repo-skills.md). Skills live in ONE
 * tier — the account, shared across its workspaces — so every route is account-scoped
 * (`/accounts/:accountId/...`), unlike the two-tier fragment library.
 */
export function skillsApi({ send, acct }: ApiContext) {
  return {
    // ---- the account skill catalog (raw) ----------------------------------
    listAccountSkills: (accountId: string) =>
      send(listAccountSkillsContract, { pathPrefix: acct(accountId) }),

    // ---- repo sources -----------------------------------------------------
    listSkillSources: (accountId: string) =>
      send(listSkillSourcesContract, { pathPrefix: acct(accountId) }),

    linkSkillSource: (accountId: string, body: LinkSkillSourceInput) =>
      send(linkSkillSourceContract, { pathPrefix: acct(accountId), body }),

    unlinkSkillSource: (accountId: string, sourceId: string) =>
      send(unlinkSkillSourceContract, {
        pathPrefix: acct(accountId),
        pathParams: { id: sourceId },
      }),

    skillSourceStatus: (accountId: string, sourceId: string) =>
      send(skillSourceStatusContract, {
        pathPrefix: acct(accountId),
        pathParams: { id: sourceId },
      }),

    syncSkillSource: (accountId: string, sourceId: string) =>
      send(syncSkillSourceContract, {
        pathPrefix: acct(accountId),
        pathParams: { id: sourceId },
      }),
  }
}
